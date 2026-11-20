import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Who is calling: Orca session id (native chat) and/or terminal handle (terminal agents). */
export type Identity = { sessionId?: string; terminalHandle?: string }
export type WorkerPin = { agent: string; model: string; effort?: string }
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
  return { ...(session ? { sessionId: session } : {}), ...(handle ? { terminalHandle: handle } : {}) }
}

export function hasIdentity(identity: Identity): boolean {
  return identity.sessionId !== undefined || identity.terminalHandle !== undefined
}

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

const pinPath = (ws: string): string => join(ws, MTE_DIR, 'worker-pin.json')
const plannerPath = (ws: string): string => join(ws, MTE_DIR, 'planner.json')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Missing file → null. Unreadable/invalid file throws (callers decide: guard fails open, CLI reports). */
function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
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

export function readPin(ws: string): WorkerPin | null {
  const raw = readJsonFile(pinPath(ws))
  const agent = optString(raw?.agent)
  const model = optString(raw?.model)
  if (agent === undefined || model === undefined) {
    return null
  }
  const effort = optString(raw?.effort)
  return { agent, model, ...(effort ? { effort } : {}) }
}

/** opencode does not support --effort, so a pin for it never carries one. */
export function writePin(ws: string, pin: WorkerPin): WorkerPin {
  const clean: WorkerPin = {
    agent: pin.agent,
    model: pin.model,
    ...(pin.effort && pin.agent !== 'opencode' ? { effort: pin.effort } : {})
  }
  writeJsonFile(pinPath(ws), clean)
  return clean
}

export function readPlanner(ws: string): PlannerClaim | null {
  const raw = readJsonFile(plannerPath(ws))
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

/** Best-effort diagnostics; the guard must never fail because logging failed. */
export function logGuard(ws: string, message: string): void {
  try {
    mkdirSync(join(ws, MTE_DIR), { recursive: true })
    appendFileSync(join(ws, MTE_DIR, 'guard.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // ponytail: no log, no problem
  }
}
