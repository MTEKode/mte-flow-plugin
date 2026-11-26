import { readFileSync } from 'node:fs'
import { evaluateCommand, GIT_HOOK_BYPASS } from '../wiring/guard-logic.ts'
import { findGitHookBypass } from '../wiring/shell-parse.ts'
import { logGuard } from '../wiring/state.ts'
import { resolveIdentity, resolveWorkspaceRoot, usageError } from './flags.ts'
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

/** Hook mode: deny JSON on stdout, exit 0. Probe mode: reason on stderr, exit 2. */
function deny(hook: boolean, reason: string): number {
  if (hook) {
    console.log(claudeDeny(reason))
    return 0
  }
  process.stderr.write(`${reason}\n`)
  return 2
}

/**
 * `mte guard --command <cmd> [--session-id id] [--terminal-handle h] [--workspace p]` (exit 2 = deny, reason on stderr;
 * read-only probe: it never writes the planner claim)
 * or `mte guard --claude-hook` (PreToolUse JSON on stdin, deny JSON on stdout, always exit 0; this interception path
 * is where the first identified run-create caller is auto-claimed).
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
    if (typeof command !== 'string' || command === '') {
      return hook ? 0 : usageError('--command <shell command> is required')
    }
    if (!command.includes('orchestration') && !command.includes('git')) {
      return 0 // fast path: no git/fs work for the vast majority of shell calls
    }
    if (command.includes('git') && findGitHookBypass(command)) {
      return deny(hook, GIT_HOOK_BYPASS)
    }
    if (!command.includes('orchestration')) {
      return 0
    }
    const root = resolveWorkspaceRoot(flags, baseCwd)
    if (typeof root !== 'string') {
      return hook ? 0 : usageError(root.error)
    }
    logRoot = root
    const who = resolveIdentity(flags)
    if ('error' in who) {
      // A flag contradicting the env is a deny here, not a silent override (probe exit 2, hook deny JSON).
      return deny(hook, `guard: ${who.error}; a flag may not contradict the caller's own environment identity`)
    }
    // Read-only probe outside hook mode: only the real interception path auto-claims.
    const verdict = evaluateCommand(command, who, root, { allowClaim: hook })
    return verdict.allow ? 0 : deny(hook, verdict.reason)
  } catch (error) {
    logGuard(logRoot, `guard failed open: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
}
