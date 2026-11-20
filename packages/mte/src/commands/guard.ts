import { readFileSync } from 'node:fs'
import { evaluateCommand } from '../wiring/guard-logic.ts'
import { logGuard } from '../wiring/state.ts'
import { callerIdentity, resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command, Flags } from './flags.ts'

function claudeDeny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  })
}

/**
 * `mte guard --command <cmd> [--session-id id] [--terminal-handle h] [--opencode-session id] [--workspace p]` (exit 2 = deny, reason on stderr)
 * or `mte guard --claude-hook` (PreToolUse JSON on stdin, deny JSON on stdout, always exit 0).
 * Internal errors fail OPEN (logged to .mte/guard.log): the guard must never brick an agent's shell.
 */
export const guardCommand: Command = ({ flags, cwd }) => {
  const hook = flags.get('claude-hook') === true
  let command: unknown = flags.get('command')
  let baseCwd = cwd
  let logRoot = cwd
  try {
    if (hook) {
      const payload: { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown } = JSON.parse(
        readFileSync(0, 'utf8')
      )
      if (payload.tool_name !== undefined && payload.tool_name !== 'Bash') {
        return 0
      }
      command = payload.tool_input?.command
      baseCwd = typeof payload.cwd === 'string' ? payload.cwd : cwd
    }
    if (typeof command !== 'string') {
      return hook ? 0 : usageError('--command <shell command> is required')
    }
    if (!command.includes('orchestration')) {
      return 0 // fast path: no git/fs work for the vast majority of shell calls
    }
    const root = resolveWorkspaceRoot(flags, baseCwd)
    if (typeof root !== 'string') {
      return hook ? 0 : usageError(root.error)
    }
    logRoot = root
    const verdict = evaluateCommand(command, callerIdentity(flags), root)
    if (verdict.allow) {
      return 0
    }
    if (hook) {
      console.log(claudeDeny(verdict.reason))
      return 0
    }
    process.stderr.write(`${verdict.reason}\n`)
    return 2
  } catch (error) {
    logGuard(logRoot, `guard failed open: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
}
