// Ported from spookfish:src/shared/mte/memory-store.ts @ 4c059137f8e
import { toFtsMatchQuery } from './fts-query.ts'
import { createTaskStore } from './task-store.ts'
import type { TaskStore } from './task-store.ts'
import type { SqliteConnection, SqliteRow } from './sqlite-connection.ts'

export type DecisionStatus = 'active' | 'superseded'

export type DecisionRow = {
  id: number
  feature: string
  decision: string
  rationale: string
  affected_files: string[]
  status: DecisionStatus
  created_at: string
}

export type QaRow = {
  id: number
  step_id: string
  topic: string
  question: string
  answer: string
  timestamp: string
}

export type NoteRow = {
  id: number
  kind: string
  topic: string
  content: string
  created_at: string
}

export type MemoryStore = TaskStore & {
  record_decision(
    feature: string,
    decision: string,
    rationale: string,
    affected_files: string[]
  ): DecisionRow
  get_active_decisions(file_path?: string): DecisionRow[]
  supersede_decision(decision_id: number): DecisionRow
  record_qa(step_id: string, topic: string, question: string, answer: string): QaRow
  search_qa(query: string, limit?: number): QaRow[]
  save_note(kind: string, topic: string, content: string): NoteRow
  search_notes(query: string, limit?: number): NoteRow[]
  close(): void
}

const DECISION_COLUMNS = 'id, feature, decision, rationale, affected_files, status, created_at'
const SELECT_DECISION_BY_ID = `SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`
const SELECT_ACTIVE_DECISIONS = `SELECT ${DECISION_COLUMNS} FROM decisions
WHERE status = 'active' ORDER BY created_at DESC, id DESC`
const SELECT_QA_BY_ID =
  'SELECT id, step_id, topic, question, answer, timestamp FROM qa_log WHERE id = ?'
const SEARCH_QA = `SELECT q.id, q.step_id, q.topic, q.question, q.answer, q.timestamp
FROM qa_fts JOIN qa_log AS q ON q.id = qa_fts.rowid
WHERE qa_fts MATCH ? ORDER BY qa_fts.rank LIMIT ?`
const SELECT_NOTE_BY_ID = 'SELECT id, kind, topic, content, created_at FROM notes WHERE id = ?'
const INSERT_DECISION =
  'INSERT INTO decisions (feature, decision, rationale, affected_files) VALUES (?, ?, ?, ?)'
const SEARCH_NOTES = `SELECT n.id, n.kind, n.topic, n.content, n.created_at
FROM notes_fts JOIN notes AS n ON n.id = notes_fts.rowid
WHERE notes_fts MATCH ? ORDER BY notes_fts.rank LIMIT ?`

function asTextColumn(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('memory DB column value is not text')
  }
  return value
}

function asIdColumn(value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError('memory DB id column value is not a number')
  }
  return value
}

const DECISION_STATUSES = ['active', 'superseded'] as const

// Exhaustive member scan keeps enum columns assertion-free.
function asEnumMember<T extends string>(value: unknown, members: readonly T[]): T {
  for (const member of members) {
    if (member === value) {
      return member
    }
  }
  throw new TypeError('memory DB enum column value is unknown')
}

function requireTextField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

// Object shorthand keeps each field name attached to its value for the error message.
function requireTextFields(fields: Record<string, unknown>): string[] {
  return Object.entries(fields).map(([field, value]) => requireTextField(value, field))
}

function requireTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of non-empty strings`)
  }
  return value.map((entry) => requireTextField(entry, field))
}

function parseAffectedFiles(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(asTextColumn(value))
    const entries: unknown[] = Array.isArray(parsed) ? parsed : []
    return entries.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    // Hand-edited rows must never break reads.
    return []
  }
}

function toDecisionRow(row: SqliteRow): DecisionRow {
  return {
    id: asIdColumn(row.id),
    feature: asTextColumn(row.feature),
    decision: asTextColumn(row.decision),
    rationale: asTextColumn(row.rationale),
    affected_files: parseAffectedFiles(row.affected_files),
    status: asEnumMember(row.status, DECISION_STATUSES),
    created_at: asTextColumn(row.created_at)
  }
}

function toQaRow(row: SqliteRow): QaRow {
  return {
    id: asIdColumn(row.id),
    step_id: asTextColumn(row.step_id),
    topic: asTextColumn(row.topic),
    question: asTextColumn(row.question),
    answer: asTextColumn(row.answer),
    timestamp: asTextColumn(row.timestamp)
  }
}

function toNoteRow(row: SqliteRow): NoteRow {
  return {
    id: asIdColumn(row.id),
    kind: asTextColumn(row.kind),
    topic: asTextColumn(row.topic),
    content: asTextColumn(row.content),
    created_at: asTextColumn(row.created_at)
  }
}

export { toFtsMatchQuery }

export function createMemoryStore(db: SqliteConnection): MemoryStore {
  const selectById = <Row>(
    sql: string,
    toRow: (row: SqliteRow) => Row,
    notFoundLabel: string,
    id: number | bigint
  ): Row => {
    const row = db.prepare(sql).get(id)
    if (!row) {
      throw new Error(`${notFoundLabel} not found: ${String(id)}`)
    }
    return toRow(row)
  }

  const ftsSearch = <T>(
    sql: string,
    toRow: (row: SqliteRow) => T,
    query: string,
    limit: number
  ): T[] => {
    const match = toFtsMatchQuery(query)
    if (match === '') {
      return []
    }
    return db
      .prepare(sql)
      .all(match, Math.min(50, Math.max(1, Math.trunc(limit))))
      .map(toRow)
  }

  return {
    ...createTaskStore(db),

    record_decision(feature, decision, rationale, affected_files) {
      const texts = requireTextFields({ feature, decision, rationale })
      const files = requireTextArray(affected_files, 'affected_files')
      const result = db.prepare(INSERT_DECISION).run(...texts, JSON.stringify(files))
      return selectById(SELECT_DECISION_BY_ID, toDecisionRow, 'decision', result.lastInsertRowid)
    },

    get_active_decisions(file_path) {
      const rows = db.prepare(SELECT_ACTIVE_DECISIONS).all().map(toDecisionRow)
      if (file_path === undefined) {
        return rows
      }
      return rows.filter((row) =>
        row.affected_files.some(
          (entry) =>
            entry === file_path || file_path.startsWith(entry.endsWith('/') ? entry : `${entry}/`)
        )
      )
    },

    supersede_decision(decision_id) {
      if (!Number.isInteger(decision_id) || decision_id <= 0) {
        throw new TypeError('decision_id must be a positive integer')
      }
      // Zero changes means already superseded; only a missing row throws in selectById.
      db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ? AND status = 'active'").run(decision_id)
      return selectById(SELECT_DECISION_BY_ID, toDecisionRow, 'decision', decision_id)
    },

    record_qa(step_id, topic, question, answer) {
      const result = db
        .prepare('INSERT INTO qa_log (step_id, topic, question, answer) VALUES (?, ?, ?, ?)')
        .run(...requireTextFields({ step_id, topic, question, answer }))
      return selectById(SELECT_QA_BY_ID, toQaRow, 'qa entry', result.lastInsertRowid)
    },

    search_qa(query, limit = 5) {
      return ftsSearch(SEARCH_QA, toQaRow, query, limit)
    },

    save_note(kind, topic, content) {
      const result = db
        .prepare('INSERT INTO notes (kind, topic, content) VALUES (?, ?, ?)')
        .run(...requireTextFields({ kind, topic, content }))
      return selectById(SELECT_NOTE_BY_ID, toNoteRow, 'note', result.lastInsertRowid)
    },

    search_notes(query, limit = 5) {
      return ftsSearch(SEARCH_NOTES, toNoteRow, query, limit)
    },

    close() {
      db.close()
    }
  }
}
