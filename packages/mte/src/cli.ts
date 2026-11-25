#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { checkCommand } from './commands/check.ts'
import { dispatchCommand } from './commands/dispatch.ts'
import { deployCheckConfigCommand, deployCheckValidatedCommand } from './commands/deploy-check.ts'
import type { Command, Flags } from './commands/flags.ts'
import { guardCommand } from './commands/guard.ts'
import { installCommand } from './commands/install.ts'
import { memoryCommand } from './commands/memory.ts'
import { pinGetCommand, pinSetCommand } from './commands/pin.ts'
import { plannerClaimCommand, plannerReleaseCommand, plannerShowCommand } from './commands/planner.ts'
import { readPackageVersion } from './version.ts'

/**
 * Command table keyed by "<command>" or "<command> <subcommand>" (longest key wins).
 * Extension point: later commands (guard, dispatch, pin, planner, install) register here.
 */
export const COMMANDS: Record<string, Command> = {
  memory: memoryCommand,
  check: checkCommand,
  'deploy-check config': deployCheckConfigCommand,
  'deploy-check validated': deployCheckValidatedCommand,
  guard: guardCommand,
  dispatch: dispatchCommand,
  'pin set': pinSetCommand,
  'pin get': pinGetCommand,
  'planner claim': plannerClaimCommand,
  'planner show': plannerShowCommand,
  'planner release': plannerReleaseCommand,
  install: installCommand
}

/** Flags that never take a value, so `--json config` does not swallow the next token. */
export const BOOLEAN_FLAGS: Set<string> = new Set(['json', 'failed', 'detect', 'help', 'version', 'force', 'claude-hook', 'user'])

const HELP = `mte - MTE Flow engine

Usage:
  mte memory [--role orchestrator] [--workspace <path>]                  stdio MCP memory server (planner-only; coder/validator roles removed)
  mte check [--json]                                                      run lint/typecheck/test; exit code = failing groups
  mte deploy-check config [--json]                                        show deploy-check config (never the password)
  mte deploy-check validated --summary <text> [--failed]                  report on the linked Linear issue
  mte guard --command <cmd> [--session-id <id>] [--terminal-handle <h>] [--claude-hook]   planner gate + worker pin (exit 2 = deny)
  mte dispatch --task <id> [--role qa] [-- <extra worker-start args>]     worker-start with the role's worker pin applied
  mte pin set --agent <a> --model <m> [--effort <e>] [--role coder|qa] | mte pin get --json [--role qa]
  mte planner claim [--force] [--session-id <id>] [--terminal-handle <h>] | mte planner show --json
  mte planner release [--workspace <path>]                                drop the planner claim (next claim needs no --force)
  mte install [--workspace <path>]                                        wire skill, Claude hook and memory MCP
  mte install --user                                                      install the mte-flow skill in ~/.claude/skills
  mte --version | mte help
`

export function parseArgs(argv: readonly string[]): { positionals: string[]; flags: Flags; rest: string[] } {
  const positionals: string[] = []
  const flags: Flags = new Map()
  let rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--') {
      rest = argv.slice(i + 1)
      break
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('--')) {
      flags.set(name, true)
    } else {
      flags.set(name, next)
      i++
    }
  }
  return { positionals, flags, rest }
}

/** Runs one invocation and returns the process exit code. */
export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  const { positionals, flags, rest } = parseArgs(argv)
  if (flags.get('version') === true || positionals[0] === 'version') {
    console.log(readPackageVersion())
    return 0
  }
  if (positionals.length === 0 || positionals[0] === 'help' || flags.get('help') === true) {
    process.stdout.write(HELP)
    return 0
  }
  const [first = '', second = ''] = positionals
  const key = `${first} ${second}`
  const command = COMMANDS[key] ?? COMMANDS[first]
  if (command === undefined) {
    process.stderr.write(`mte: unknown command: ${positionals.join(' ')}\n\n${HELP}`)
    return 1
  }
  return command({ flags, positionals, cwd, rest })
}

// Direct execution only (tests import main without running it).
const entry = process.argv[1]
if (entry !== undefined && import.meta.filename === realpathSync(entry)) {
  process.exitCode = await main(process.argv.slice(2))
}
