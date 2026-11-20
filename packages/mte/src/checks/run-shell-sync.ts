// Ported from spookfish:src/shared/mte/checks/run-shell-sync.ts @ 4c059137f8e (the fork process-host call is replaced by node:child_process)
import { spawnSync } from 'node:child_process'

export type ShellResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs one shell command line through the platform shell and never throws. */
export function runShellSync(
  command: string,
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number }
): ShellResult {
  const windows = process.platform === 'win32'
  const res = spawnSync(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
    windows ? ['/d', '/s', '/c', command] : ['-c', command],
    {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: 'utf8',
      // cmd.exe parses the single command line itself; Node must not re-quote it.
      windowsVerbatimArguments: windows
    }
  )
  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  const spawnError = res.error && !timedOut ? `${res.error.message}\n` : ''
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: `${res.stderr ?? ''}${spawnError}`,
    timedOut
  }
}
