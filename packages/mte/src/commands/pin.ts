import { readPin, writePin } from '../wiring/state.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/** `mte pin set --agent a --model m [--effort e]`: writes .mte/worker-pin.json. */
export const pinSetCommand: Command = ({ flags, cwd }) => {
  const agent = flags.get('agent')
  const model = flags.get('model')
  const effort = flags.get('effort')
  if (typeof agent !== 'string' || typeof model !== 'string') {
    return usageError('usage: mte pin set --agent <agent> --model <model> [--effort <effort>]')
  }
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const pin = writePin(root, { agent, model, ...(typeof effort === 'string' ? { effort } : {}) })
  console.log(JSON.stringify(pin))
  return 0
}

/** `mte pin get [--json]`: prints the pin, or `null` when none is set. */
export const pinGetCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  console.log(JSON.stringify(readPin(root)))
  return 0
}
