import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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
