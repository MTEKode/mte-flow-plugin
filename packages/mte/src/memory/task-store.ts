import { toFtsMatchQuery } from './fts-query.ts'
import type { SqliteConnection, SqliteRow } from './sqlite-connection.ts'

export type TaskRow = {
  id: number
  task_id: string
  run_id: string
  title: string
  goal: string
  what_was_done: string
  approach: string
  decisions: string
  files: string[]
  validation: string
  lessons: string
  agent_model: string
  commit_sha: string
  created_at: string
  updated_at: string
}

export type TaskInput = Partial<Omit<TaskRow, 'id' | 'created_at' | 'updated_at'>> & { task_id: string }

export type TaskSearch = {
  query?: string
  run_id?: string
  file?: string
  since?: string
  until?: string
  limit?: number
}

export type TaskHit = Pick<
  TaskRow,
  'task_id' | 'run_id' | 'title' | 'files' | 'agent_model' | 'commit_sha' | 'created_at' | 'updated_at'
> & { snippet: string }

export type TaskStore = {
  record_task(input: TaskInput): TaskRow
  get_task(task_id: string): TaskRow
  search_tasks(search: TaskSearch): TaskHit[]
}

const TEXT_FIELDS = [
  'run_id', 'title', 'goal', 'what_was_done', 'approach', 'decisions',
  'validation', 'lessons', 'agent_model', 'commit_sha'
] as const
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/
const HIT_COLUMNS = 't.task_id, t.run_id, t.title, t.files, t.agent_model, t.commit_sha, t.created_at, t.updated_at'

const text = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new TypeError('memory DB column value is not text')
  }
  return value
}

function parseFiles(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(text(value))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function toTaskRow(row: SqliteRow): TaskRow {
  if (typeof row.id !== 'number') {
    throw new TypeError('memory DB id column value is not a number')
  }
  return {
    id: row.id,
    task_id: text(row.task_id),
    run_id: text(row.run_id),
    title: text(row.title),
    goal: text(row.goal),
    what_was_done: text(row.what_was_done),
    approach: text(row.approach),
    decisions: text(row.decisions),
    files: parseFiles(row.files),
    validation: text(row.validation),
    lessons: text(row.lessons),
    agent_model: text(row.agent_model),
    commit_sha: text(row.commit_sha),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at)
  }
}

function toTaskHit(row: SqliteRow): TaskHit {
  return {
    task_id: text(row.task_id),
    run_id: text(row.run_id),
    title: text(row.title),
    files: parseFiles(row.files),
    agent_model: text(row.agent_model),
    commit_sha: text(row.commit_sha),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
    snippet: text(row.snippet)
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

function requireDate(value: string, field: string): string {
  if (!DATE_PREFIX.test(value)) {
    throw new TypeError(`${field} must be an ISO date (YYYY-MM-DD[THH:MM...])`)
  }
  return value
}

export function createTaskStore(db: SqliteConnection): TaskStore {
  const getTask = (task_id: string): TaskRow => {
    const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(task_id)
    if (!row) {
      throw new Error(`task not found: ${task_id}`)
    }
    return toTaskRow(row)
  }

  return {
    record_task(input) {
      const taskId = requireText(input.task_id, 'task_id')
      const provided: [string, string][] = TEXT_FIELDS.flatMap((field) =>
        input[field] === undefined ? [] : [[field, requireText(input[field], field)] as [string, string]]
      )
      if (input.files !== undefined) {
        provided.push(['files', JSON.stringify(input.files.map((entry) => requireText(entry, 'files')))])
      }
      const exists = db.prepare('SELECT 1 AS found FROM tasks WHERE task_id = ?').get(taskId) !== undefined
      if (!exists) {
        requireText(input.title, 'title')
        const columns = ['task_id', ...provided.map(([field]) => field)]
        db.prepare(`INSERT INTO tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
          taskId,
          ...provided.map(([, value]) => value)
        )
      } else {
        const sets = [...provided.map(([field]) => `${field} = ?`), "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"]
        db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...provided.map(([, v]) => v), taskId)
      }
      return getTask(taskId)
    },

    get_task(task_id) {
      return getTask(requireText(task_id, 'task_id'))
    },

    search_tasks(search) {
      const where: string[] = []
      const params: (string | number)[] = []
      const match = search.query === undefined ? '' : toFtsMatchQuery(search.query)
      if (search.query !== undefined && match === '') {
        return []
      }
      if (match !== '') {
        where.push('tasks_fts MATCH ?')
        params.push(match)
      }
      if (search.run_id !== undefined) {
        where.push('t.run_id = ?')
        params.push(search.run_id)
      }
      if (search.file !== undefined) {
        where.push('instr(t.files, ?) > 0')
        params.push(search.file)
      }
      if (search.since !== undefined) {
        where.push('t.created_at >= ?')
        params.push(requireDate(search.since, 'since'))
      }
      if (search.until !== undefined) {
        // Compare at the precision the caller gave: until=2026-01-02 includes the whole day.
        const until = requireDate(search.until, 'until')
        where.push('substr(t.created_at, 1, length(?)) <= ?')
        params.push(until, until)
      }
      const limit = Math.min(50, Math.max(1, Math.trunc(search.limit ?? 10)))
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      const sql =
        match === ''
          ? `SELECT ${HIT_COLUMNS}, substr(t.what_was_done, 1, 160) AS snippet FROM tasks AS t ${clause}
             ORDER BY t.created_at DESC, t.id DESC LIMIT ?`
          : `SELECT ${HIT_COLUMNS}, snippet(tasks_fts, -1, '[', ']', '…', 12) AS snippet
             FROM tasks_fts JOIN tasks AS t ON t.id = tasks_fts.rowid ${clause}
             ORDER BY bm25(tasks_fts), t.id LIMIT ?`
      return db.prepare(sql).all(...params, limit).map(toTaskHit)
    }
  }
}
