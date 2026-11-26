import { findInvocations, getFlag, removeFlags, renderBin, shellQuote } from './shell-parse.ts'
import type { GateKind, Invocation } from './shell-parse.ts'
import { hasIdentity, readPin, readPlanner, sameCaller, writePlanner } from './state.ts'
import type { Identity, WorkerPin } from './state.ts'

/** Deny reason for git calls that skip hooks; applies to every caller, planner included. */
export const GIT_HOOK_BYPASS =
  'git hooks must not be skipped (--no-verify, commit -n, core.hooksPath): fix what the hook reports instead, or ask the user to run it themselves'

export type Verdict = { allow: true } | { allow: false; reason: string }

const ALLOW: Verdict = { allow: true }
const deny = (reason: string): Verdict => ({ allow: false, reason })

/** The flags a worker-start must carry for this pin. */
export function pinFlags(pin: WorkerPin): string[] {
  return ['--agent', pin.agent, '--model', pin.model, ...(pin.effort ? ['--effort', pin.effort] : [])]
}

function checkPin(inv: Invocation, pin: WorkerPin): Verdict {
  const effort = getFlag(inv.args, 'effort')
  const effortOk = pin.effort === undefined || effort === pin.effort
  if (getFlag(inv.args, 'agent') === pin.agent && getFlag(inv.args, 'model') === pin.model && effortOk) {
    return ALLOW
  }
  const rest = removeFlags(inv.args, ['agent', 'model', 'effort'])
  const corrected = [renderBin(inv.bin), ...['orchestration', 'worker-start', ...rest, ...pinFlags(pin)].map(shellQuote)].join(' ')
  const task = getFlag(inv.args, 'task')
  const tip = task ? ` (or: mte dispatch --task ${task})` : ''
  return deny(`worker-start must use the worker pin; run: ${corrected}${tip}`)
}

export type GateOptions = {
  /** Write the auto-claim on the first identified run-create. True only in `--claude-hook` mode; a `--command` probe is read-only. */
  allowClaim?: boolean
}

export function gatePlanner(kind: GateKind, who: Identity, ws: string, opts: GateOptions = {}): Verdict {
  const planner = readPlanner(ws)
  if (planner === null) {
    if (kind === 'run-create') {
      if (hasIdentity(who) && opts.allowClaim === true) {
        writePlanner(ws, who) // hook interception only: the first caller claims the workspace
      }
      return ALLOW
    }
    if (!hasIdentity(who)) {
      return ALLOW // nothing claimed and nobody to compare: never brick the shell
    }
    return deny('no MTE planner claimed in this workspace; the planner starts with `orca orchestration run-create` or `mte planner claim`')
  }
  if (sameCaller(planner, who)) {
    return ALLOW
  }
  const caller = hasIdentity(who) ? '' : ' (caller presented no identity)'
  // No holder details and no --force recipe here: the deny reaches every worker's tool output.
  return deny(
    `only the claimed MTE planner may run \`${kind}\`${caller}; workers must not dispatch, use \`orca orchestration ask\` to ask the orchestrator (run \`mte planner show\` to see who holds the claim)`
  )
}

export function evaluateCommand(command: string, who: Identity, ws: string, opts: GateOptions = {}): Verdict {
  for (const inv of findInvocations(command)) {
    const planner = gatePlanner(inv.kind, who, ws, opts)
    if (!planner.allow) {
      return planner
    }
    if (inv.kind === 'worker-start') {
      // the coder pin names the corrected command; a worker-start carrying the qa pin passes too
      const pin = readPin(ws)
      const qa = readPin(ws, 'qa')
      const verdict = pin === null ? ALLOW : qa !== null && checkPin(inv, qa).allow ? ALLOW : checkPin(inv, pin)
      if (!verdict.allow) {
        return verdict
      }
    }
  }
  return ALLOW
}
