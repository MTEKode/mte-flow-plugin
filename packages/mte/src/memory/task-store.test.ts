import { afterEach, beforeEach, describe, it } from 'node:test'
import { expect } from '../test-support/expect.ts'
import { openMemoryDatabase } from './memory-database.ts'
import { createMemoryStore } from './memory-store.ts'
import type { MemoryStore } from './memory-store.ts'
import { createMemoryToolHandlers } from './memory-tools.ts'
import type { SqliteConnection } from './sqlite-connection.ts'

describe('task memory', () => {
  let db: SqliteConnection
  let store: MemoryStore

  beforeEach(() => {
    db = openMemoryDatabase(':memory:')
    store = createMemoryStore(db)
  })

  afterEach(() => {
    store.close()
  })

  const setCreated = (taskId: string, createdAt: string) =>
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(createdAt, taskId)

  it('inserts, partially updates and gets a task by id', () => {
    expect(() => store.record_task({ task_id: 'T1' })).toThrow('title must be a non-empty string')
    const row = store.record_task({ task_id: 'T1', title: 'Add parser', files: ['src/a.ts'], run_id: 'run-1' })
    expect(row).toMatchObject({ task_id: 'T1', title: 'Add parser', files: ['src/a.ts'], run_id: 'run-1', goal: '' })
    const updated = store.record_task({ task_id: 'T1', what_was_done: 'wrote the parser', commit_sha: 'abc123' })
    expect(updated).toMatchObject({ title: 'Add parser', what_was_done: 'wrote the parser', commit_sha: 'abc123' })
    expect(updated.id).toBe(row.id)
    expect(store.get_task('T1')).toEqual(updated)
    expect(() => store.get_task('nope')).toThrow('task not found: nope')
  })

  it('searches by text with bm25 order and keeps the index in sync on update', () => {
    store.record_task({ task_id: 'A', title: 'Parser', what_was_done: 'sqlite parser' })
    store.record_task({ task_id: 'B', title: 'sqlite sqlite', what_was_done: 'sqlite sqlite sqlite migration' })
    store.record_task({ task_id: 'C', title: 'Unrelated', what_was_done: 'css tweak' })
    const hits = store.search_tasks({ query: 'sqlite' })
    expect(hits.map((hit) => hit.task_id)).toEqual(['B', 'A'])
    expect(hits[0]?.snippet).toContain('[sqlite]')
    store.record_task({ task_id: 'C', lessons: 'sqlite is fast' })
    expect(store.search_tasks({ query: 'sqlite lessons' })).toEqual([])
    expect(store.search_tasks({ query: 'fast' }).map((hit) => hit.task_id)).toEqual(['C'])
    expect(store.search_tasks({ query: '   ' })).toEqual([])
  })

  it('filters by file, run and date range, and caps the limit', () => {
    store.record_task({ task_id: 'A', title: 'a', run_id: 'r1', files: ['src/memory/x.ts'] })
    store.record_task({ task_id: 'B', title: 'b', run_id: 'r2', files: ['src/cli.ts'] })
    store.record_task({ task_id: 'C', title: 'c', run_id: 'r1', files: ['README.md'] })
    setCreated('A', '2026-01-01T10:00:00.000Z')
    setCreated('B', '2026-01-02T10:00:00.000Z')
    setCreated('C', '2026-01-03T10:00:00.000Z')
    const ids = (search: Parameters<MemoryStore['search_tasks']>[0]) => store.search_tasks(search).map((h) => h.task_id)
    expect(ids({ file: 'memory/' })).toEqual(['A'])
    expect(ids({ run_id: 'r1' })).toEqual(['C', 'A'])
    expect(ids({ since: '2026-01-02' })).toEqual(['C', 'B'])
    expect(ids({ until: '2026-01-02' })).toEqual(['B', 'A'])
    expect(ids({ since: '2026-01-02', until: '2026-01-02T09:00:00Z' })).toEqual([])
    expect(ids({ run_id: 'r1', file: 'README', since: '2026-01-01' })).toEqual(['C'])
    expect(() => store.search_tasks({ since: 'yesterday' })).toThrow('since must be an ISO date')
    for (let i = 0; i < 60; i += 1) {
      store.record_task({ task_id: `bulk-${i}`, title: `bulk ${i}`, what_was_done: 'bulk work' })
    }
    expect(store.search_tasks({ query: 'bulk', limit: 999 })).toHaveLength(50)
    expect(store.search_tasks({ query: 'bulk' })).toHaveLength(10)
  })

  it('exposes the task tools to the orchestrator and tasks in search_memory', () => {
    const tools = createMemoryToolHandlers(store, 'orchestrator')
    const recorded = tools.execute('record_task', { task_id: 'T9', title: 'Shared memory', what_was_done: 'one db per repo' })
    expect(recorded.ok).toBe(true)
    const partial = tools.execute('record_task', { task_id: 'T9', lessons: 'use git common dir' })
    expect(partial.ok && partial.data).toMatchObject({ title: 'Shared memory', lessons: 'use git common dir' })
    expect(tools.execute('record_task', { task_id: 'T10' }).ok).toBe(false)
    const found = tools.execute('search_tasks', { query: 'repo' })
    expect(found.ok && found.data).toMatchObject([{ task_id: 'T9' }])
    expect(tools.execute('get_task', { task_id: 'T9' }).ok).toBe(true)
    const memory = tools.execute('search_memory', { query: 'repo' })
    expect(memory.ok && memory.data).toMatchObject({ tasks: [{ kind: 'task', task_id: 'T9' }] })
    for (const role of ['coder', 'validator'] as const) {
      const scoped = createMemoryToolHandlers(store, role)
      expect(scoped.execute('record_task', { task_id: 'x', title: 'x' }).ok).toBe(false)
    }
  })
})
