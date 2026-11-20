// MTE guard adapter for opencode 2.x (V2 plugin API; V1 `tool.execute.before` is ignored by 2.x).
// All policy lives in `mte guard`; this file only forwards shell commands and who is calling.
import { spawnSync } from 'node:child_process'

export default {
  id: 'mte-guard',
  async setup(ctx) {
    // The plugin runs inside a shared opencode service: its own process.env is stale/foreign, so identity comes
    // only from the client env seen by the shell, else from the opencode session id.
    let shellIdentity = {}
    try {
      await ctx.shell?.hook?.('create.before', (e) => {
        const env = e?.env ?? {}
        shellIdentity = { sessionId: env.ORCA_AGENT_SESSION_ID, terminalHandle: env.ORCA_TERMINAL_HANDLE }
      })
    } catch {
      // no shell hook in this opencode build: fall back to the session id
    }
    await ctx.tool.hook('execute.before', (e) => {
      const command = e?.input?.command
      if (e?.tool !== 'shell' || typeof command !== 'string' || !command.includes('orchestration')) {
        return
      }
      const sessionId = shellIdentity.sessionId || e.sessionID || ''
      const args = ['guard', '--command', command, '--session-id', sessionId, '--terminal-handle', shellIdentity.terminalHandle || '']
      const env = { ...process.env }
      delete env.ORCA_AGENT_SESSION_ID
      delete env.ORCA_TERMINAL_HANDLE
      const cwd = e.input.workdir || e.input.cwd || ctx.directory || process.cwd()
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
