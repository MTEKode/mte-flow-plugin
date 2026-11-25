import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Who is calling: Orca session id (native chat) and/or terminal handle (terminal agents). */
export type Identity = { sessionId?: string; terminalHandle?: string }
export type WorkerPin = { agent: string; model: string; effort?: string }
/** Which worker a pin applies to: `coder` (also the fallback for every other worker) or `qa` (validator and QA workers). */
export type PinRole = 'coder' | 'qa'
export const PIN_ROLES: readonly PinRole[] = ['coder', 'qa']
export type PlannerClaim = Identity & { claimedAt: string }

export const MTE_DIR = '.mte'

/** The orca CLI prints/accepts `orca_session_id:<id>`; the env var holds the bare id. Compare bare ids. */
export function normalizeSessionId(raw: string | undefined): string | undefined {
  const id = raw?.trim().replace(/^orca_session_id:/i, '')
  return id === undefined || id === '' ? undefined : id
}

export function normalizeHandle(raw: string | undefined): string | undefined {
  const handle = raw?.trim()
  return handle === undefined || handle === '' ? undefined : handle
}

export function identityFromEnv(env: NodeJS.ProcessEnv): Identity {
  return withIdentity(env.ORCA_AGENT_SESSION_ID, env.ORCA_TERMINAL_HANDLE)
}

export function withIdentity(sessionId: string | undefined, terminalHandle: string | undefined): Identity {
  const session = normalizeSessionId(sessionId)
  const handle = normalizeHandle(terminalHandle)
  return {
    ...(session ? { sessionId: session } : {}),
    ...(handle ? { terminalHandle: handle } : {})
  }
}

export function hasIdentity(identity: Identity): boolean {
  return identity.sessionId !== undefined || identity.terminalHandle !== undefined
}

/** Any shared identity (terminal handle, agent session) is the same caller. */
export function sameCaller(claim: Identity, caller: Identity): boolean {
  return (
    (claim.sessionId !== undefined && claim.sessionId === caller.sessionId) ||
    (claim.terminalHandle !== undefined && claim.terminalHandle === caller.terminalHandle)
  )
}

export function describeIdentity(identity: Identity): string {
  return [identity.sessionId && `session ${identity.sessionId}`, identity.terminalHandle && `terminal ${identity.terminalHandle}`]
    .filter(Boolean)
    .join(' / ')
}

const pinPath = (ws: string, role: PinRole = 'coder'): string => join(ws, MTE_DIR, role === 'coder' ? 'worker-pin.json' : `worker-pin-${role}.json`)
const legacyPlannerPath = (ws: string): string => join(ws, MTE_DIR, 'planner.json')

/** Absolute `git rev-parse --git-common-dir` of `ws` (shared by every worktree of a repo), or null outside git. */
export function gitCommonDir(ws: string): string | null {
  const res = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: ws, encoding: 'utf8' })
  const dir = res.status === 0 ? res.stdout.trim() : ''
  if (dir === '') {
    return null
  }
  const abs = resolve(ws, dir)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/**
 * The planner claim belongs to one worktree, so parallel runs in sibling worktrees never fight over it:
 * `<git-dir>/mte/planner.json` (`.git/worktrees/<name>/` for a linked worktree; inside `.git`, never committed).
 * Workers run in the Run home worktree, so they still meet their planner's claim. Outside git: `<ws>/.mte/`.
 */
function plannerPath(ws: string): string {
  const res = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ws, encoding: 'utf8' })
  const dir = res.status === 0 ? res.stdout.trim() : ''
  return dir === '' ? legacyPlannerPath(ws) : join(dir, 'mte', 'planner.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Missing file → null. Unreadable/invalid file throws with its path (callers decide: guard fails open, CLI reports). */
function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must hold a JSON object`)
  }
  return parsed
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

const optString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

export function readPin(ws: string, role: PinRole = 'coder'): WorkerPin | null {
  const raw = readJsonFile(pinPath(ws, role))
  const agent = optString(raw?.agent)
  const model = optString(raw?.model)
  if (agent === undefined || model === undefined) {
    return null
  }
  const effort = optString(raw?.effort)
  return { agent, model, ...(effort ? { effort } : {}) }
}

export function writePin(ws: string, pin: WorkerPin, role: PinRole = 'coder'): WorkerPin {
  const clean: WorkerPin = { agent: pin.agent, model: pin.model, ...(pin.effort ? { effort: pin.effort } : {}) }
  writeJsonFile(pinPath(ws, role), clean)
  return clean
}

/** One-time move of an old `<ws>/.mte/planner.json` into the worktree's git dir (only when no claim exists there). Takes the already-resolved claim path: one rev-parse per call, not one per helper. */
function migrateLegacyPlanner(ws: string, shared: string): void {
  const legacy = legacyPlannerPath(ws)
  if (legacy === shared || !existsSync(legacy)) {
    return
  }
  if (!existsSync(shared)) {
    const raw = readJsonFile(legacy)
    if (raw !== null) {
      writeJsonFile(shared, raw)
    }
  }
  rmSync(legacy, { force: true })
}

export function readPlanner(ws: string): PlannerClaim | null {
  const path = plannerPath(ws)
  migrateLegacyPlanner(ws, path)
  const raw = readJsonFile(path)
  if (raw === null) {
    return null
  }
  const identity = withIdentity(optString(raw.sessionId), optString(raw.terminalHandle))
  return hasIdentity(identity) ? { ...identity, claimedAt: optString(raw.claimedAt) ?? '' } : null
}

export function writePlanner(ws: string, identity: Identity): PlannerClaim {
  const claim = { ...identity, claimedAt: new Date().toISOString() }
  writeJsonFile(plannerPath(ws), claim)
  return claim
}

/** Removes the planner claim; true when there was one. Works on a corrupt file (it removes without parsing). */
export function removePlanner(ws: string): boolean {
  const path = plannerPath(ws)
  migrateLegacyPlanner(ws, path)
  const had = existsSync(path)
  rmSync(path, { force: true })
  return had
}

/** Best-effort diagnostics; the guard must never fail because logging failed. */
export function logGuard(ws: string, message: string): void {
  try {
    mkdirSync(join(ws, MTE_DIR), { recursive: true })
    appendFileSync(join(ws, MTE_DIR, 'guard.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // ponytail: no log, no problem
  }
}
