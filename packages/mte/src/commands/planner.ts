import { describeIdentity, hasIdentity, readPlanner, removePlanner, sameCaller, writePlanner } from '../wiring/state.ts'
import type { PlannerClaim } from '../wiring/state.ts'
import { resolveIdentity, resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/** Reads the claim; a corrupt file comes back as its usage-error text (show and claim report it, release removes it unparsed). */
function readClaimOrUsageError(root: string): PlannerClaim | null | string {
  try {
    return readPlanner(root)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}; remove it with: mte planner release`
  }
}

/** `mte planner claim [--force] [--session-id id] [--terminal-handle h]`: first claim wins, --force replaces; records every identity present. */
export const plannerClaimCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const who = resolveIdentity(flags)
  if ('error' in who) {
    return usageError(`${who.error}; refusing to claim with another identity`)
  }
  if (!hasIdentity(who)) {
    return usageError('no caller identity: pass --session-id/--terminal-handle (env ORCA_AGENT_SESSION_ID / ORCA_TERMINAL_HANDLE is empty)')
  }
  const current = readClaimOrUsageError(root)
  if (typeof current === 'string') {
    return usageError(current)
  }
  if (current !== null && !sameCaller(current, who) && flags.get('force') !== true) {
    return usageError(`planner already claimed by ${describeIdentity(current)}; use --force to replace it`)
  }
  console.log(JSON.stringify(writePlanner(root, who)))
  return 0
}

/** `mte planner show [--json]`: prints the claim, or `{"claimed":false}`. */
export const plannerShowCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const claim = readClaimOrUsageError(root)
  if (typeof claim === 'string') {
    return usageError(claim)
  }
  console.log(JSON.stringify(claim === null ? { claimed: false } : { claimed: true, ...claim }))
  return 0
}

/** `mte planner release [--workspace p]`: drops the claim (a stale one blocks the next planner); the next `claim` needs no --force. */
export const plannerReleaseCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  console.log(JSON.stringify({ released: removePlanner(root) }))
  return 0
}
