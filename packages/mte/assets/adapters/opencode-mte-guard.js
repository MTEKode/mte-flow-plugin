// MTE guard adapter for opencode 2.x (V2 plugin API; V1 `tool.execute.before` is ignored by 2.x).
// All policy lives in `mte guard`; this file only forwards shell commands and who is calling.
import { spawnSync } from 'node:child_process'

export default {
  id: 'mte-guard',
  async setup(ctx) {
    // The plugin runs inside a shared opencode service: its own process.env is stale/foreign, so identity comes
    // only from the client env seen by the shell plus the opencode session id. The shell hook fires AFTER the
    // first `execute.before`, so the opencode session id is always passed too; `mte guard` allows on ANY match.
    let shellIdentity = {}
    try {
      await ctx.shell?.hook?.('create.before', (e) => {
        const env = e?.env ?? {}
        shellIdentity = { sessionId: env.ORCA_AGENT_SESSION_ID, terminalHandle: env.ORCA_TERMINAL_HANDLE }
        // lets `mte planner claim` run from this shell record the opencode session id (best effort)
        if (e?.sessionID && e.env) {
          e.env.MTE_OPENCODE_SESSION = e.sessionID
        }
      })
    } catch {
      // no shell hook in this opencode build: fall back to the session id
    }
    await ctx.tool.hook('execute.before', (e) => {
      const command = e?.input?.command
      if (e?.tool !== 'shell' || typeof command !== 'string' || !command.includes('orchestration')) {
        return
      }
      const args = [
        'guard',
        '--command',
        command,
        '--session-id',
        shellIdentity.sessionId || '',
        '--terminal-handle',
        shellIdentity.terminalHandle || '',
        '--opencode-session',
        e.sessionID || ''
      ]
      const env = { ...process.env }
      delete env.ORCA_AGENT_SESSION_ID
      delete env.ORCA_TERMINAL_HANDLE
      delete env.MTE_OPENCODE_SESSION
      // opencode 2.x: `execute.before` input only has `command` and `ctx.directory` is undefined; the project dir is `ctx.location.directory`
      const cwd = ctx.location?.directory || e.input.workdir || e.input.cwd || ctx.directory || process.cwd()
      let res
      try {
        res = spawnSync('mte', args, { cwd, env, encoding: 'utf8', timeout: 10_000 })
      } catch {
        return // fail open
      }
      if (res.status === 2) {
        throw new Error((res.stderr || '').trim() || 'denied by mte guard')
      }
    })
  }
}
