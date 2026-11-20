import { describeIdentity, hasIdentity, identityFromEnv, readPlanner, sameCaller, withIdentity, writePlanner } from '../wiring/state.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/** `mte planner claim [--force] [--session-id id] [--terminal-handle h]`: first claim wins, --force replaces. */
export const plannerClaimCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const session = flags.get('session-id')
  const handle = flags.get('terminal-handle')
  const who =
    typeof session === 'string' || typeof handle === 'string'
      ? withIdentity(typeof session === 'string' ? session : undefined, typeof handle === 'string' ? handle : undefined)
      : identityFromEnv(process.env)
  if (!hasIdentity(who)) {
    return usageError('no caller identity: pass --session-id/--terminal-handle (env ORCA_AGENT_SESSION_ID / ORCA_TERMINAL_HANDLE is empty)')
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
