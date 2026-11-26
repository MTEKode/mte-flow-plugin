import { spawnSync } from 'node:child_process'
import { gatePlanner, pinFlags } from '../wiring/guard-logic.ts'
import { getFlag, hasFlag } from '../wiring/shell-parse.ts'
import { identityFromEnv, logGuard, readPin } from '../wiring/state.ts'
import type { WorkerPin } from '../wiring/state.ts'
import { pinRole } from './pin.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/** Concurrent workers per Run; the next dispatch waits. Override with MTE_MAX_WORKERS (must be a positive integer; anything else is a usage error). */
export const DEFAULT_MAX_WORKERS = 3
const SETTLED = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'abandoned'])

/**
 * Live, unsettled workers in the Run bound to this terminal, or null when orca cannot tell (fail open, logged once
 * to .mte/guard.log). ponytail: --limit 100 caps the probe; a Run with more than 100 unsettled workers would
 * under-count and loosen the cap — impossible in practice, since one planner dispatches a handful.
 */
function activeWorkers(orca: string, cwd: string, ws: string): number | null {
  const args = ['orchestration', 'worker-list', '--json', '--terminal-state', 'active', '--limit', '100']
  const res = spawnSync(orca, args, { cwd, encoding: 'utf8' })
  try {
    const workers: { state?: string }[] = JSON.parse(res.stdout).result.workers
    return workers.filter((w) => !SETTLED.has(w.state ?? '')).length
  } catch (error) {
    logGuard(ws, `dispatch: worker-list failed open: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * `mte dispatch --task <id> [--role qa] [-- <extra worker-start args>]`: `orca orchestration worker-start --task <id>` plus
 * the role's pin flags (`qa` falls back to the coder pin when no qa pin is set). Explicit extra flags win over the pin (escalation). Refuses (exit 3) while
 * MTE_MAX_WORKERS (default 3) workers are already running in the Run. Exit code = orca's.
 */
const sameModel = (a: WorkerPin, b: WorkerPin | null): boolean => b !== null && a.agent === b.agent && a.model === b.model

export const dispatchCommand: Command = ({ flags, cwd, rest = [] }) => {
  const task = flags.get('task')
  if (typeof task !== 'string' || task === '') {
    return usageError('usage: mte dispatch --task <id> [--role coder|qa] [-- <extra worker-start args>]')
  }
  const role = pinRole(flags)
  if (typeof role !== 'string') {
    return usageError(role.error)
  }
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const rawMax = process.env.MTE_MAX_WORKERS
  let max = DEFAULT_MAX_WORKERS
  if (rawMax !== undefined && rawMax.trim() !== '') {
    const parsed = Number(rawMax)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return usageError(`mte dispatch: MTE_MAX_WORKERS must be a positive integer (got "${rawMax}")`)
    }
    max = parsed
  }
  try {
    const who = identityFromEnv(process.env)
    const verdict = gatePlanner('worker-start', who, root)
    if (!verdict.allow) {
      process.stderr.write(`${verdict.reason}\n`)
      return 2
    }
  } catch {
    // fail open like the guard
  }
  const orca = process.env.ORCA_CLI_COMMAND || 'orca'
  const active = activeWorkers(orca, cwd, root)
  if (active !== null && active >= max) {
    process.stderr.write(
      `mte dispatch: ${active} workers already running (limit ${max}); wait for one to finish (orca orchestration inbox) and dispatch again\n`
    )
    return 3
  }
  const own = readPin(root, role)
  const pin = own ?? readPin(root)
  if (role === 'qa' && pin !== null && (own === null || sameModel(own, readPin(root)))) {
    // warning only: the reviewer should not be the model that wrote the code
    process.stderr.write(
      `mte dispatch: warning: the QA worker runs on the coder's model (${pin.agent}/${pin.model}); set a different one with: mte pin set --role qa --agent <a> --model <m>\n`
    )
  }
  const effectiveAgent = getFlag(rest, 'agent') ?? pin?.agent
  let pinned: string[] = []
  if (pin !== null && effectiveAgent === pin.agent) {
    const all = pinFlags(pin)
    for (let i = 0; i < all.length; i += 2) {
      const name = (all[i] ?? '').slice(2)
      pinned = hasFlag(rest, name) ? pinned : [...pinned, ...all.slice(i, i + 2)]
    }
  }
  // a coder gets its own child worktree unless told otherwise, so its branch is reviewed and merged, never committed on the planner's
  const worktree = role === 'coder' && !hasFlag(rest, 'worktree') ? ['--worktree', 'new-child'] : []
  const args = ['orchestration', 'worker-start', '--task', task, ...worktree, ...pinned, ...rest]
  const res = spawnSync(orca, args, { stdio: 'inherit', cwd })
  if (res.error) {
    return usageError(`mte dispatch: cannot run orca: ${res.error.message}`)
  }
  return res.status ?? 1
}
