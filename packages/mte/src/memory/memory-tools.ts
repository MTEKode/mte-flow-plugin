// Ported from spookfish:src/shared/mte/memory-tools.ts @ 4c059137f8e (zod replaced by validation driven by each tool's JSON Schema)
import { errorMessage } from '../error-message.ts'
import type { MemoryStore } from './memory-store.ts'

export type MemoryToolName =
  | 'record_decision'
  | 'get_decisions'
  | 'supersede_decision'
  | 'record_qa'
  | 'search_memory'
  | 'save_in_memory'
  | 'record_task'
  | 'search_tasks'
  | 'get_task'

export type MemoryToolDefinition = {
  name: MemoryToolName
  description: string
  /** Per-tool defaults for optional inputs; they win over INPUT_DEFAULTS. */
  defaults?: Record<string, unknown>
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: readonly string[]
  }
}

export type MemoryToolResult = { ok: true; data: unknown } | { ok: false; error: string }

// Defaults for optional inputs; the JSON Schemas stay free of `default` so clients see the same shapes as the fork.
const INPUT_DEFAULTS: Record<string, unknown> = {
  affected_files: [],
  limit: 5
}

class ToolInputError extends Error {}

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'array' : typeof value
}

function checkText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ToolInputError(`${field}: expected string, received ${describeValue(value)}`)
  }
  if (value.length === 0) {
    throw new ToolInputError(`${field}: must contain at least 1 character`)
  }
  return value
}

function checkInteger(value: unknown, field: string, schema: Record<string, unknown>): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolInputError(`${field}: expected integer, received ${describeValue(value)}`)
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    throw new ToolInputError(`${field}: must be >= ${schema.minimum}`)
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    throw new ToolInputError(`${field}: must be <= ${schema.maximum}`)
  }
  return value
}

function checkProperty(value: unknown, field: string, schema: Record<string, unknown>): unknown {
  switch (schema.type) {
    case 'string':
      return checkText(value, field)
    case 'integer':
      return checkInteger(value, field, schema)
    case 'array': {
      if (!Array.isArray(value)) {
        throw new ToolInputError(`${field}: expected array, received ${describeValue(value)}`)
      }
      return value.map((entry, index) => checkText(entry, `${field}.${index}`))
    }
    default:
      throw new ToolInputError(`${field}: unsupported schema type`)
  }
}

/** Validates tool input against the tool's own JSON Schema, applying defaults and dropping unknown keys. */
function parseToolInput(tool: MemoryToolDefinition, input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ToolInputError(`expected object, received ${describeValue(input)}`)
  }
  const record: Record<string, unknown> = { ...input }
  const parsed: Record<string, unknown> = {}
  for (const [field, schema] of Object.entries(tool.input_schema.properties)) {
    const value = record[field] ?? tool.defaults?.[field] ?? INPUT_DEFAULTS[field]
    if (value === undefined) {
      if (tool.input_schema.required.includes(field)) {
        throw new ToolInputError(`${field}: required`)
      }
      continue
    }
    const schemaRecord: Record<string, unknown> =
      typeof schema === 'object' && schema !== null ? { ...schema } : {}
    parsed[field] = checkProperty(value, field, schemaRecord)
  }
  return parsed
}

export const MEMORY_TOOLS: readonly MemoryToolDefinition[] = [
  {
    name: 'record_decision',
    description:
      'Persist a durable architectural decision so later steps stay consistent. Include the feature, the decision, the rationale, and the affected files.',
    input_schema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature area the decision governs.' },
        decision: { type: 'string', description: 'The decision, stated as a short imperative.' },
        rationale: { type: 'string', description: 'Why this decision was made.' },
        affected_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File or directory paths the decision affects.'
        }
      },
      required: ['feature', 'decision', 'rationale']
    }
  },
  {
    name: 'get_decisions',
    description:
      'List active (non-superseded) architectural decisions, optionally filtered to decisions affecting a given file path.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File or directory path to filter by.' }
      },
      required: []
    }
  },
  {
    name: 'supersede_decision',
    description:
      'Mark an active architectural decision as superseded by decision id, so it stops appearing in get_decisions.',
    input_schema: {
      type: 'object',
      properties: {
        decision_id: { type: 'integer', minimum: 1, description: 'Id of the decision to supersede.' }
      },
      required: ['decision_id']
    }
  },
  {
    name: 'record_qa',
    description:
      'Persist a resolved question and its answer (between coder and orchestrator) under a step id and topic, for later recall.',
    input_schema: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: 'Task step the exchange belongs to.' },
        topic: { type: 'string', description: 'Short topic label for the exchange.' },
        question: { type: 'string', description: 'The question that was resolved.' },
        answer: { type: 'string', description: 'The resolved answer.' }
      },
      required: ['step_id', 'topic', 'question', 'answer']
    }
  },
  {
    name: 'search_memory',
    description:
      'Full-text search (FTS5) over the recorded Q&A history, saved notes and recorded tasks. Returns matching qa entries, notes and tasks (kind \'task\') ranked by relevance.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query; terms are combined with AND.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum number of entries to return.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'save_in_memory',
    description:
      'Save a durable note (lesson, constraint, context) that is not a decision or a Q&A entry. Notes are searchable via search_memory.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Free-form note kind, e.g. lesson or constraint.' },
        topic: { type: 'string', description: 'Short topic label for the note.' },
        content: { type: 'string', description: 'The note content.' }
      },
      required: ['kind', 'topic', 'content']
    }
  },
  {
    name: 'record_task',
    description:
      'Upsert the memory row of a task by task_id (call it after merging each task). Partial updates are allowed; title is required when the row does not exist yet. Empty strings are rejected, so fields cannot be cleared via record_task. Rows are searchable across tasks via search_tasks.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Orca task id; the upsert key.' },
        run_id: { type: 'string', description: 'Orchestration run the task belongs to.' },
        title: { type: 'string', description: 'Short task title.' },
        goal: { type: 'string', description: 'What the task was meant to achieve.' },
        what_was_done: { type: 'string', description: 'What was actually done, from the worker and validator reports.' },
        approach: { type: 'string', description: 'How it was done: mechanism and key technical choices.' },
        decisions: { type: 'string', description: 'Decisions taken while doing it.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files or directories touched.' },
        validation: { type: 'string', description: 'How it was validated and the outcome.' },
        lessons: { type: 'string', description: 'Lessons, traps and constraints for similar future work.' },
        agent_model: { type: 'string', description: 'Agent and model that did the work.' },
        commit_sha: { type: 'string', description: 'Merge or commit sha of the result.' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'search_tasks',
    description:
      'Search what was done in other tasks of this repo: optional FTS5 query plus filters, ranked by bm25 with a snippet. Use get_task for the full row.',
    defaults: { limit: 10 },
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query; terms are combined with AND. Omit to list newest first.' },
        run_id: { type: 'string', description: 'Only tasks of this run.' },
        file: { type: 'string', description: 'Only tasks whose files contain this substring.' },
        since: { type: 'string', description: 'ISO date (YYYY-MM-DD[THH:MM:SSZ]); tasks created at or after it.' },
        until: { type: 'string', description: 'ISO date; tasks created up to it (a bare date includes that whole day).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum rows to return (default 10).' }
      },
      required: []
    }
  },
  {
    name: 'get_task',
    description: 'Return the full memory row of a task by task_id.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Orca task id.' } },
      required: ['task_id']
    }
  }
]

const memoryToolRunners: Record<MemoryToolName, (store: MemoryStore, input: Record<string, any>) => unknown> = {
  record_decision: (store, i) => store.record_decision(i.feature, i.decision, i.rationale, i.affected_files),
  get_decisions: (store, i) => store.get_active_decisions(i.file_path),
  supersede_decision: (store, i) => store.supersede_decision(i.decision_id),
  record_qa: (store, i) => store.record_qa(i.step_id, i.topic, i.question, i.answer),
  search_memory: (store, i) => ({
    qa: store.search_qa(i.query, i.limit),
    notes: store.search_notes(i.query, i.limit),
    tasks: store.search_tasks({ query: i.query, limit: i.limit }).map((task) => ({ kind: 'task', ...task }))
  }),
  save_in_memory: (store, i) => store.save_note(i.kind, i.topic, i.content),
  record_task: (store, i) => {
    const { task_id, ...rest } = i
    return store.record_task({ task_id, ...rest })
  },
  search_tasks: (store, i) => store.search_tasks(i),
  get_task: (store, i) => store.get_task(i.task_id)
}

export function createMemoryToolHandlers(store: MemoryStore): {
  tools: readonly MemoryToolDefinition[]
  execute(name: string, input: unknown): MemoryToolResult
} {
  const execute = (name: string, input: unknown): MemoryToolResult => {
    const tool = MEMORY_TOOLS.find((candidate) => candidate.name === name)
    if (tool === undefined) {
      return { ok: false, error: `unknown tool: ${name}` }
    }
    try {
      const parsed = parseToolInput(tool, input)
      return { ok: true, data: memoryToolRunners[tool.name](store, parsed) }
    } catch (error) {
      if (error instanceof ToolInputError) {
        return { ok: false, error: `${tool.name}: invalid input: ${error.message}` }
      }
      return { ok: false, error: errorMessage(error) }
    }
  }
  return { tools: MEMORY_TOOLS, execute }
}
