import { PIN_ROLES, readPin, writePin } from '../wiring/state.ts'
import type { PinRole } from '../wiring/state.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command, Flags } from './flags.ts'

/** `--role coder|qa` (default coder), or an error message. */
export function pinRole(flags: Flags): PinRole | { error: string } {
  const role = flags.get('role') ?? 'coder'
  return PIN_ROLES.includes(role as PinRole) ? (role as PinRole) : { error: `--role must be one of: ${PIN_ROLES.join(', ')}` }
}

/** `mte pin set --agent a --model m [--effort e] [--role coder|qa]`: writes .mte/worker-pin.json (qa: worker-pin-qa.json). */
export const pinSetCommand: Command = ({ flags, cwd }) => {
  const agent = flags.get('agent')
  const model = flags.get('model')
  const effort = flags.get('effort')
  const role = pinRole(flags)
  if (typeof agent !== 'string' || typeof model !== 'string' || typeof role !== 'string') {
    return usageError(typeof role === 'string' ? 'usage: mte pin set --agent <agent> --model <model> [--effort <effort>] [--role coder|qa]' : role.error)
  }
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const pin = writePin(root, { agent, model, ...(typeof effort === 'string' ? { effort } : {}) }, role)
  console.log(JSON.stringify(pin))
  return 0
}

/** `mte pin get [--json] [--role coder|qa]`: prints the pin, or `null` when none is set. */
export const pinGetCommand: Command = ({ flags, cwd }) => {
  const role = pinRole(flags)
  if (typeof role !== 'string') {
    return usageError(role.error)
  }
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  console.log(JSON.stringify(readPin(root, role)))
  return 0
}
