import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { errorMessage } from '../error-message.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

const ASSETS = new URL('../../assets/', import.meta.url)
const AGENTS = ['claude', 'opencode'] as const
type Agent = (typeof AGENTS)[number]

const MEMORY_ARGS = ['memory', '--role', 'orchestrator']
const GITIGNORE_LINES = ['.mte/memory.db', '.mte/planner.json', '.mte/guard.log']

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asset = (path: string): string => readFileSync(new URL(path, ASSETS), 'utf8')

/** Writes only when the content differs, so a second run touches nothing. */
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function readJsonObject(path: string): Json {
  if (!existsSync(path)) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is not valid JSON; fix or remove it before running mte install`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must hold a JSON object`)
  }
  return parsed
}

/** Returns `parent[key]` as an object, creating it when absent; refuses to replace a foreign non-object value. */
function child(parent: Json, key: string, path: string): Json {
  const existing = parent[key]
  if (existing === undefined) {
    const created: Json = {}
    parent[key] = created
    return created
  }
  if (!isRecord(existing)) {
    throw new Error(`${path}: "${key}" must be an object`)
  }
  return existing
}

function mergeJson(path: string, edit: (doc: Json) => void): void {
  const doc = readJsonObject(path)
  edit(doc)
  writeIfChanged(path, `${JSON.stringify(doc, null, 2)}\n`)
}

function installSkill(ws: string, dir: string): void {
  for (const file of ['SKILL.md', 'playbook.md']) {
    writeIfChanged(join(ws, dir, 'mte', file), asset(`skill/${file}`))
  }
}

function installClaude(ws: string): void {
  installSkill(ws, '.claude/skills')
  const settingsPath = join(ws, '.claude', 'settings.json')
  const hook: unknown = JSON.parse(asset('adapters/claude-hook.json'))
  mergeJson(settingsPath, (doc) => {
    const hooks = child(doc, 'hooks', settingsPath)
    const list = hooks.PreToolUse ?? []
    if (!Array.isArray(list)) {
      throw new Error(`${settingsPath}: hooks.PreToolUse must be an array`)
    }
    if (!JSON.stringify(list).includes('mte guard --claude-hook')) {
      list.push(hook)
    }
    hooks.PreToolUse = list
  })
  mergeJson(join(ws, '.mcp.json'), (doc) => {
    child(doc, 'mcpServers', '.mcp.json')['mte-memory'] = { command: 'mte', args: MEMORY_ARGS }
  })
}

function installOpencode(ws: string): void {
  installSkill(ws, '.agents/skills')
  writeIfChanged(join(ws, '.opencode', 'plugins', 'mte-guard', 'index.js'), asset('adapters/opencode-mte-guard.js'))
  const path = join(ws, 'opencode.json')
  mergeJson(path, (doc) => {
    child(child(doc, 'mcp', path), 'servers', path)['mte-memory'] = { type: 'local', command: ['mte', ...MEMORY_ARGS] }
  })
}

function installGitignore(ws: string): void {
  const path = join(ws, '.gitignore')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const present = new Set(text.split('\n').map((line) => line.trim()))
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line))
  if (missing.length > 0) {
    writeIfChanged(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`)
  }
}

/** `mte install [--agents claude,opencode] [--workspace p]`: idempotent, merges JSON without clobbering unrelated keys. */
export const installCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const flag = flags.get('agents')
  const names = typeof flag === 'string' ? flag.split(',').map((name) => name.trim()) : [...AGENTS]
  const agents = names.filter((name): name is Agent => AGENTS.some((agent) => agent === name))
  if (agents.length === 0 || agents.length !== names.length) {
    return usageError('--agents must be a comma-separated list of: claude, opencode')
  }
  try {
    if (agents.includes('claude')) {
      installClaude(root)
    }
    if (agents.includes('opencode')) {
      installOpencode(root)
    }
    installGitignore(root)
  } catch (error) {
    return usageError(`mte install: ${errorMessage(error)}`)
  }
  console.log(`mte install: ${agents.join(', ')} wired in ${root}`)
  return 0
}
