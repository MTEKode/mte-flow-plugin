import { spawnSync } from 'node:child_process'
import { gatePlanner, pinFlags } from '../wiring/guard-logic.ts'
import { getFlag, hasFlag, removeFlags } from '../wiring/shell-parse.ts'
import { identityFromEnv, readPin } from '../wiring/state.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/**
 * `mte dispatch --task <id> [-- <extra worker-start args>]`: `orca orchestration worker-start --task <id>` plus the
 * pin flags. Explicit extra flags win over the pin (escalation); opencode never gets --effort. Exit code = orca's.
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
  const extra = effectiveAgent === 'opencode' ? removeFlags(rest, ['effort']) : rest
  const args = ['orchestration', 'worker-start', '--task', task, ...pinned, ...extra]
  const res = spawnSync(process.env.ORCA_CLI_COMMAND || 'orca', args, { stdio: 'inherit', cwd })
  if (res.error) {
    return usageError(`mte dispatch: cannot run orca: ${res.error.message}`)
  }
  return res.status ?? 1
}
