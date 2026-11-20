import { describeIdentity, hasIdentity, readPlanner, removePlanner, sameCaller, writePlanner } from '../wiring/state.ts'
import { callerIdentity, resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/** `mte planner claim [--force] [--session-id id] [--terminal-handle h] [--opencode-session id]`: first claim wins, --force replaces; records every identity present. */
export const plannerClaimCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const who = callerIdentity(flags)
  if (!hasIdentity(who)) {
    return usageError('no caller identity: pass --session-id/--terminal-handle/--opencode-session (env ORCA_AGENT_SESSION_ID / ORCA_TERMINAL_HANDLE / MTE_OPENCODE_SESSION is empty)')
  }
  const current = readPlanner(root)
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
  const claim = readPlanner(root)
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
