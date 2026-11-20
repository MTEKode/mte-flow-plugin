import { findInvocations, getFlag, hasFlag, removeFlags, shellQuote } from './shell-parse.ts'
import type { GateKind, Invocation } from './shell-parse.ts'
import {
  describeIdentity,
  hasIdentity,
  readPin,
  readPlanner,
  sameCaller,
  writePlanner
} from './state.ts'
import type { Identity, WorkerPin } from './state.ts'

export type Verdict = { allow: true } | { allow: false; reason: string }

const ALLOW: Verdict = { allow: true }
const deny = (reason: string): Verdict => ({ allow: false, reason })

/** The flags a worker-start must carry for this pin (never --effort for opencode). */
export function pinFlags(pin: WorkerPin): string[] {
  return [
    '--agent',
    pin.agent,
    '--model',
    pin.model,
    ...(pin.effort && pin.agent !== 'opencode' ? ['--effort', pin.effort] : [])
  ]
}

function checkPin(inv: Invocation, pin: WorkerPin): Verdict {
  const effort = getFlag(inv.args, 'effort')
  const effortOk =
    pin.agent === 'opencode'
      ? !hasFlag(inv.args, 'effort')
      : pin.effort === undefined || effort === pin.effort
  if (getFlag(inv.args, 'agent') === pin.agent && getFlag(inv.args, 'model') === pin.model && effortOk) {
    return ALLOW
  }
  const rest = removeFlags(inv.args, ['agent', 'model', 'effort'])
  const corrected = [inv.bin, 'orchestration', 'worker-start', ...rest, ...pinFlags(pin)].map(shellQuote).join(' ')
  const task = getFlag(inv.args, 'task')
  const tip = task ? ` (or: mte dispatch --task ${task})` : ''
  return deny(`worker-start must use the worker pin; run: ${corrected}${tip}`)
}

export function gatePlanner(kind: GateKind, who: Identity, ws: string): Verdict {
  if (!hasIdentity(who)) {
    return ALLOW // unidentifiable caller: nothing to compare, never brick the shell
  }
  const planner = readPlanner(ws)
  if (planner === null) {
    if (kind === 'run-create') {
      writePlanner(ws, who) // first caller claims the workspace
      return ALLOW
    }
    return deny('no MTE planner claimed in this workspace; the planner starts with `orca orchestration run-create` or `mte planner claim`')
  }
  if (sameCaller(planner, who)) {
    return ALLOW
  }
  return deny(
    `only the claimed MTE planner (${describeIdentity(planner)}) may run \`${kind}\`; workers must not dispatch, use \`orca orchestration ask\` to ask the orchestrator (replace the planner: mte planner claim --force)`
  )
}

export function evaluateCommand(command: string, who: Identity, ws: string): Verdict {
  for (const inv of findInvocations(command)) {
    const planner = gatePlanner(inv.kind, who, ws)
    if (!planner.allow) {
      return planner
    }
    if (inv.kind === 'worker-start') {
      const pin = readPin(ws)
      const verdict = pin === null ? ALLOW : checkPin(inv, pin)
      if (!verdict.allow) {
        return verdict
      }
    }
  }
  return ALLOW
}
