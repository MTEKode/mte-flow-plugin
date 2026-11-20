// Adapted from spookfish:src/cli/handlers/mte-check.ts @ 4c059137f8e
import { detectChecks } from '../checks/detect-checks.ts'
import type { DetectedChecks } from '../checks/detect-checks.ts'
import {
  DEFAULT_TAIL_LINES,
  DEFAULT_TIMEOUT_SECONDS,
  failedGroupCount,
  runChecks
} from '../checks/run-checks.ts'
import type { CheckGroup, CheckGroupResult, RunChecksOptions } from '../checks/run-checks.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command, Flags } from './flags.ts'

const CHECK_GROUPS: readonly CheckGroup[] = ['lint', 'typecheck', 'test']

// Returns the parsed count (0 = flag absent), or the usage-error message for a non-positive-integer value.
function parseCountFlag(flags: Flags, name: string, error: string): number | string {
  const value = flags.get(name)
  if (value === undefined) {
    return 0
  }
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : error
}

function parseOnly(flags: Flags): CheckGroup[] | string {
  const flag = flags.get('only')
  if (flag === undefined) {
    return []
  }
  if (typeof flag !== 'string' || flag === '') {
    return '--only requires a group value (lint, typecheck, or test)'
  }
  const only: CheckGroup[] = []
  for (const raw of flag.split(',')) {
    const group = CHECK_GROUPS.find((candidate) => candidate === raw)
    if (group === undefined) {
      return '--only must be one of: lint, typecheck, test (comma-separated)'
    }
    only.push(group)
  }
  return only
}

function describeGroup(result: CheckGroupResult): string {
  const exitText = result.exitCode === null ? '-' : String(result.exitCode)
  const seconds = (result.durationMs / 1000).toFixed(1)
  const note = result.timedOut ? ' (timed out)' : ''
  return `${result.group}=${result.command} ${result.status} (exit ${exitText}, ${seconds}s)${note}`
}

function printFailureTail(result: CheckGroupResult): void {
  if (result.status !== 'failed' || result.tail === '') {
    return
  }
  const lines = result.tail.split('\n').map((line) => `  ${line}`)
  process.stderr.write(
    `  ---- ${result.group} (${result.command}) last lines ----\n${lines.join('\n')}\n`
  )
}

export type CheckDeps = {
  detect?: (workspaceRoot: string) => DetectedChecks
  run?: (options: RunChecksOptions) => CheckGroupResult[]
}

/** `mte check [--json] [--detect] [--only g,g] [--timeout s] [--tail n] [--workspace p]`; exit code = failed groups. */
export function createCheckCommand(deps: CheckDeps = {}): Command {
  return ({ flags, cwd }) => {
    const root = resolveWorkspaceRoot(flags, cwd)
    if (typeof root !== 'string') {
      return usageError(root.error)
    }
    const timeout = parseCountFlag(flags, 'timeout', '--timeout requires a positive integer of seconds')
    if (typeof timeout === 'string') {
      return usageError(timeout)
    }
    const tail = parseCountFlag(flags, 'tail', '--tail requires a positive integer of lines')
    if (typeof tail === 'string') {
      return usageError(tail)
    }
    const only = parseOnly(flags)
    if (typeof only === 'string') {
      return usageError(only)
    }
    const detect = deps.detect ?? detectChecks
    if (flags.get('detect') === true) {
      const detected = detect(root)
      console.log(`LINT=${detected.lint}\nTYPECHECK=${detected.typecheck}\nTEST=${detected.test}`)
      return 0
    }
    const results = (deps.run ?? runChecks)({
      workspaceRoot: root,
      timeoutSeconds: timeout || DEFAULT_TIMEOUT_SECONDS,
      tailLines: tail || DEFAULT_TAIL_LINES,
      only
    })
    const failed = failedGroupCount(results)
    if (flags.get('json') === true) {
      console.log(
        JSON.stringify(
          { workspaceRoot: root, detected: detect(root), results, failedGroups: failed },
          null,
          2
        )
      )
    } else {
      for (const result of results) {
        console.log(describeGroup(result))
        printFailureTail(result)
      }
    }
    return failed
  }
}

export const checkCommand: Command = createCheckCommand()
