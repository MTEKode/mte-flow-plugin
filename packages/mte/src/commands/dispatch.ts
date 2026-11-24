import { spawnSync } from 'node:child_process'
import { gatePlanner, pinFlags } from '../wiring/guard-logic.ts'
import { getFlag, hasFlag } from '../wiring/shell-parse.ts'
import { identityFromEnv, readPin } from '../wiring/state.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/** Concurrent workers per Run; the next dispatch waits. Override with MTE_MAX_WORKERS. */
export const DEFAULT_MAX_WORKERS = 3
const SETTLED = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'abandoned'])

/** Live, unsettled workers in the Run bound to this terminal, or null when orca cannot tell (fail open). */
function activeWorkers(orca: string, cwd: string): number | null {
  const args = ['orchestration', 'worker-list', '--json', '--terminal-state', 'active', '--limit', '100']
  const res = spawnSync(orca, args, { cwd, encoding: 'utf8' })
  try {
    const workers: { state?: string }[] = JSON.parse(res.stdout).result.workers
    return workers.filter((w) => !SETTLED.has(w.state ?? '')).length
  } catch {
    return null
  }
}

/**
 * `mte dispatch --task <id> [-- <extra worker-start args>]`: `orca orchestration worker-start --task <id>` plus the
 * pin flags. Explicit extra flags win over the pin (escalation). Refuses (exit 3) while
 * MTE_MAX_WORKERS (default 3) workers are already running in the Run. Exit code = orca's.
 */
export const dispatchCommand: Command = ({ flags, cwd, rest = [] }) => {
  const task = flags.get('task')
  if (typeof task !== 'string') {
    return usageError('usage: mte dispatch --task <id> [-- <extra worker-start args>]')
  }
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
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
  const max = Number(process.env.MTE_MAX_WORKERS) || DEFAULT_MAX_WORKERS
  const active = activeWorkers(orca, cwd)
  if (active !== null && active >= max) {
    process.stderr.write(
      `mte dispatch: ${active} workers already running (limit ${max}); wait for one to finish (orca orchestration inbox) and dispatch again\n`
    )
    return 3
  }
  const pin = readPin(root)
  const effectiveAgent = getFlag(rest, 'agent') ?? pin?.agent
  let pinned: string[] = []
  if (pin !== null && effectiveAgent === pin.agent) {
    const all = pinFlags(pin)
    for (let i = 0; i < all.length; i += 2) {
      const name = (all[i] ?? '').slice(2)
      pinned = hasFlag(rest, name) ? pinned : [...pinned, ...all.slice(i, i + 2)]
    }
  }
  const args = ['orchestration', 'worker-start', '--task', task, ...pinned, ...rest]
  const res = spawnSync(orca, args, { stdio: 'inherit', cwd })
  if (res.error) {
    return usageError(`mte dispatch: cannot run orca: ${res.error.message}`)
  }
  return res.status ?? 1
}
