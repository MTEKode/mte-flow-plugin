import { describeIdentity, hasIdentity, identityFromEnv, readPlanner, removePlanner, sameCaller, withIdentity, writePlanner } from '../wiring/state.ts'
import type { Identity } from '../wiring/state.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command, Flags } from './flags.ts'

const CLAIM_FLAGS = [
  ['sessionId', 'session-id', 'ORCA_AGENT_SESSION_ID'],
  ['terminalHandle', 'terminal-handle', 'ORCA_TERMINAL_HANDLE']
] as const

/** The caller's environment identity wins; a flag naming a different identity than the env's is refused (no spoofing), flags only fill gaps. */
function claimIdentity(flags: Flags): Identity | { error: string } {
  const fromEnv = identityFromEnv(process.env)
  const str = (name: string): string | undefined => {
    const value = flags.get(name)
    return typeof value === 'string' ? value : undefined
  }
  const given = withIdentity(str('session-id'), str('terminal-handle'))
  for (const [key, flag, envName] of CLAIM_FLAGS) {
    if (fromEnv[key] !== undefined && given[key] !== undefined && fromEnv[key] !== given[key]) {
      return { error: `--${flag} ${given[key]} differs from the caller's own ${envName} (${fromEnv[key]}); refusing to claim with another identity` }
    }
  }
  return { ...given, ...fromEnv }
}

/** `mte planner claim [--force] [--session-id id] [--terminal-handle h]`: first claim wins, --force replaces; records every identity present. */
export const plannerClaimCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const who = claimIdentity(flags)
  if ('error' in who) {
    return usageError(who.error)
  }
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

/** `mte planner release [--workspace p]`: drops the claim (a stale one blocks the next planner); the next `claim` needs no --force. */
export const plannerReleaseCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  console.log(JSON.stringify({ released: removePlanner(root) }))
  return 0
}
