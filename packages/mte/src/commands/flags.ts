import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { identityFromEnv, withIdentity } from '../wiring/state.ts'
import type { Identity } from '../wiring/state.ts'
import { realMemoryWorkspacePath, resolveMemoryWorkspaceRoot } from '../memory/memory-workspace-root.ts'

export type Flags = Map<string, string | boolean>

export type CommandContext = {
  flags: Flags
  positionals: string[]
  cwd: string
  /** Tokens after a bare `--` (passed through verbatim). */
  rest?: string[]
}

/** Resolves an exit code for the process; commands never call process.exit themselves. */
export type Command = (ctx: CommandContext) => Promise<number> | number

/** Prints a usage failure on stderr and returns exit code 1. */
export function usageError(message: string): number {
  process.stderr.write(`${message}\n`)
  return 1
}

function gitToplevel(cwd: string): string | null {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  const top = res.status === 0 ? res.stdout.trim() : ''
  return top === '' ? null : top
}

/** --workspace, else the git toplevel of cwd, else the nearest .git/.mte ancestor. */
export function resolveWorkspaceRoot(flags: Flags, cwd: string): string | { error: string } {
  const flag = flags.get('workspace')
  if (flag !== undefined && (typeof flag !== 'string' || flag === '')) {
    return { error: '--workspace requires a path value' }
  }
  const root =
    typeof flag === 'string'
      ? resolve(cwd, flag)
      : (gitToplevel(cwd) ?? resolveMemoryWorkspaceRoot(cwd))
  return realMemoryWorkspacePath(root)
}

const IDENTITY_FLAGS = [
  ['sessionId', 'session-id', 'ORCA_AGENT_SESSION_ID'],
  ['terminalHandle', 'terminal-handle', 'ORCA_TERMINAL_HANDLE']
] as const

/**
 * The caller's environment identity wins; flags only fill gaps the env lacks, and a flag contradicting the env is an
 * error (no spoofing). One shared rule for every identity path: `mte planner claim` refuses with it, `mte guard` denies with it.
 */
export function resolveIdentity(flags: Flags): Identity | { error: string } {
  const fromEnv = identityFromEnv(process.env)
  const str = (name: string): string | undefined => {
    const value = flags.get(name)
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const given = withIdentity(str('session-id'), str('terminal-handle'))
  for (const [key, flag, envName] of IDENTITY_FLAGS) {
    if (fromEnv[key] !== undefined && given[key] !== undefined && fromEnv[key] !== given[key]) {
      return { error: `--${flag} ${given[key]} differs from the caller's own ${envName} (${fromEnv[key]})` }
    }
  }
  return { ...given, ...fromEnv }
}
