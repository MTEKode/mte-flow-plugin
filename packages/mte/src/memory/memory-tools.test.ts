// Ported from spookfish:src/shared/mte/memory-tools.test.ts @ 4c059137f8e
import { afterEach, beforeEach, describe, it } from 'node:test'
import { expect } from '../test-support/expect.ts'
import { openMemoryStore } from './memory-database.ts'
import type { MemoryStore } from './memory-store.ts'
import { createMemoryToolHandlers, MEMORY_TOOLS } from './memory-tools.ts'
import type { MemoryToolResult } from './memory-tools.ts'

function resultRows(result: MemoryToolResult): unknown[] {
  if (!result.ok || !Array.isArray(result.data)) {
    throw new Error(`expected ok rows, received: ${JSON.stringify(result)}`)
  }
  return result.data
}

function resultBuckets(result: MemoryToolResult): { qa: unknown[]; notes: unknown[] } {
  if (!result.ok) {
    throw new Error(`expected ok buckets, received: ${JSON.stringify(result)}`)
  }
  const data = result.data
  if (typeof data !== 'object' || data === null || !('qa' in data) || !('notes' in data)) {
    throw new Error(`expected qa and notes buckets, received: ${JSON.stringify(result)}`)
  }
  if (!Array.isArray(data.qa) || !Array.isArray(data.notes)) {
    throw new Error(`expected array buckets, received: ${JSON.stringify(result)}`)
  }
  return { qa: data.qa, notes: data.notes }
}

function resultError(result: MemoryToolResult): string {
  if (result.ok) {
    throw new Error(`expected failed result, received: ${JSON.stringify(result)}`)
  }
  return result.error
}

describe('MEMORY_TOOLS definitions', () => {
  it('exposes exactly nine uniquely named object tools', () => {
    expect(MEMORY_TOOLS).toHaveLength(9)
    expect(new Set(MEMORY_TOOLS.map((tool) => tool.name)).size).toBe(9)
    for (const tool of MEMORY_TOOLS) {
      expect(tool.input_schema.type).toBe('object')
      for (const field of tool.input_schema.required) {
        expect(Object.keys(tool.input_schema.properties)).toContain(field)
      }
    }
  })

  it('keeps the durable toolkit and drops the retired question queue', () => {
    const names = MEMORY_TOOLS.map((tool) => tool.name)
    for (const name of [
      'record_decision',
      'get_decisions',
      'supersede_decision',
      'record_qa',
      'search_memory',
      'save_in_memory',
      'record_task',
      'search_tasks',
      'get_task'
    ]) {
      expect(names).toContain(name)
    }
    for (const retired of ['ask_orq', 'answer_orq', 'get_pending_questions']) {
      expect(names).not.toContain(retired)
    }
    for (const tool of MEMORY_TOOLS) {
      expect('roles' in tool).toBe(false)
    }
  })

  it('describes array items and limit bounds consistently in both schemas', () => {
    const recordDecision = MEMORY_TOOLS.find((tool) => tool.name === 'record_decision')
    expect(recordDecision?.input_schema.properties.affected_files).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: expect.any(String)
    })
    const searchMemory = MEMORY_TOOLS.find((tool) => tool.name === 'search_memory')
    expect(searchMemory?.input_schema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50
    })
    const store = openMemoryStore(':memory:')
    const handlers = createMemoryToolHandlers(store)
    expect(handlers.execute('search_memory', { query: 'q', limit: 50 }).ok).toBe(true)
    expect(handlers.execute('search_memory', { query: 'q', limit: 51 }).ok).toBe(false)
    store.close()
  })
})

describe('memory tool handlers', () => {
  let store: MemoryStore
  let handlers: ReturnType<typeof createMemoryToolHandlers>

  beforeEach(() => {
    store = openMemoryStore(':memory:')
    handlers = createMemoryToolHandlers(store)
  })

  afterEach(() => {
    store.close()
  })

  it('exposes the full toolkit without role filtering', () => {
    expect(handlers.tools).toEqual(MEMORY_TOOLS)
    expect(handlers.tools).toHaveLength(9)
  })

  it('records, lists and supersedes decisions end to end', () => {
    const recorded = handlers.execute('record_decision', {
      feature: 'memory layer',
      decision: 'sqlite over flat files',
      rationale: 'queryable with zero new dependencies',
      affected_files: ['src/shared/mte']
    })
    expect(recorded).toEqual({
      ok: true,
      data: {
        id: 1,
        feature: 'memory layer',
        decision: 'sqlite over flat files',
        rationale: 'queryable with zero new dependencies',
        affected_files: ['src/shared/mte'],
        status: 'active',
        created_at: expect.any(String)
      }
    })
    const listed = resultRows(
      handlers.execute('get_decisions', { file_path: 'src/shared/mte/memory-store.ts' })
    )
    expect(listed).toHaveLength(1)
    expect(resultRows(handlers.execute('get_decisions', {}))).toHaveLength(1)
    expect(handlers.execute('supersede_decision', { decision_id: 1 }).ok).toBe(true)
    expect(resultRows(handlers.execute('get_decisions', {}))).toEqual([])
  })

  it('records and full-text searches Q&A end to end', () => {
    const recorded = handlers.execute('record_qa', {
      step_id: 'T-0001:s1',
      topic: 'storage',
      question: 'Where does the memory db live?',
      answer: 'Under .mte/memory.db inside each workspace.'
    })
    expect(recorded.ok).toBe(true)
    const buckets = resultBuckets(handlers.execute('search_memory', { query: 'workspace memory' }))
    expect(buckets.qa).toHaveLength(1)
    expect(buckets.notes).toEqual([])
  })

  it('reports invalid inputs with the offending field name', () => {
    const missing = resultError(
      handlers.execute('record_decision', { decision: 'd', rationale: 'r' })
    )
    expect(missing).toContain('record_decision')
    expect(missing).toContain('feature')
    const wrongType = resultError(handlers.execute('supersede_decision', { decision_id: 'three' }))
    expect(wrongType).toContain('decision_id')
    expect(resultError(handlers.execute('record_qa', 'not-an-object'))).toContain('record_qa')
  })

  it('rejects unknown tools and surfaces store errors without throwing', () => {
    expect(handlers.execute('nonexistent', {})).toEqual({
      ok: false,
      error: 'unknown tool: nonexistent'
    })
    expect(handlers.execute('supersede_decision', { decision_id: 999 })).toEqual({
      ok: false,
      error: 'decision not found: 999'
    })
  })

  it('defaults omitted affected_files to an empty array', () => {
    expect(
      handlers.execute('record_decision', { feature: 'f', decision: 'd', rationale: 'r' }).ok
    ).toBe(true)
    expect(resultRows(handlers.execute('get_decisions', {}))).toEqual([
      {
        id: 1,
        feature: 'f',
        decision: 'd',
        rationale: 'r',
        affected_files: [],
        status: 'active',
        created_at: expect.any(String)
      }
    ])
  })

  it('returns saved notes only in the notes bucket', () => {
    expect(
      handlers.execute('save_in_memory', {
        kind: 'lesson',
        topic: 'release',
        content: 'run the targeted vitest suite first'
      }).ok
    ).toBe(true)
    const buckets = resultBuckets(handlers.execute('search_memory', { query: 'vitest' }))
    expect(buckets.notes).toEqual([expect.objectContaining({ kind: 'lesson', topic: 'release' })])
    expect(buckets.qa).toEqual([])
  })

  it('returns recorded Q&A only in the qa bucket', () => {
    expect(
      handlers.execute('record_qa', {
        step_id: 's1',
        topic: 'testing',
        question: 'vitest or jest?',
        answer: 'vitest'
      }).ok
    ).toBe(true)
    const buckets = resultBuckets(handlers.execute('search_memory', { query: 'vitest' }))
    expect(buckets.qa).toEqual([expect.objectContaining({ step_id: 's1', topic: 'testing' })])
    expect(buckets.notes).toEqual([])
  })
})
