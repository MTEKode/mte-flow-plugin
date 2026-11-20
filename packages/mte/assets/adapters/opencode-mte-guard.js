// MTE guard adapter for opencode 2.x (V2 plugin API; V1 `tool.execute.before` is ignored by 2.x).
// All policy lives in `mte guard`; this file only forwards shell commands and who is calling.
//
// opencode 2.3.2 event shapes: `execute.before` = {tool, sessionID, agent, messageID, id, input:{command}} and fires FIRST;
// the shell `create.before` = {command, cwd, timeout, shell, env} has NO sessionID but carries the client env.
// So: execute.before stashes `command -> sessionID`, create.before pairs them and decides there.
import { spawnSync } from 'node:child_process'

const STASH_TTL_MS = 30_000
const STASH_MAX = 64

export default {
  id: 'mte-guard',
  async setup(ctx) {
    // One opencode service serves many sessions: never keep identity in a single variable, and never trust process.env.
    const stash = [] // [{command, sessionID, at}], oldest first
    const identities = new Map() // sessionID -> {sessionId, terminalHandle}

    const guard = (command, sessionID, identity, dir) => {
      const args = [
        'guard',
        '--command',
        command,
        '--session-id',
        identity.sessionId || '',
        '--terminal-handle',
        identity.terminalHandle || '',
        '--opencode-session',
        sessionID || ''
      ]
      const env = { ...process.env }
      delete env.ORCA_AGENT_SESSION_ID
      delete env.ORCA_TERMINAL_HANDLE
      delete env.MTE_OPENCODE_SESSION
      // opencode 2.x: `ctx.directory` is undefined; the project dir is `ctx.location.directory`
      const cwd = ctx.location?.directory || dir || ctx.directory || process.cwd()
      let res
      try {
        res = spawnSync('mte', args, { cwd, env, encoding: 'utf8', timeout: 10_000 })
      } catch {
        return // fail open
      }
      if (res.status === 2) {
        const reason = (res.stderr || '').trim() || 'denied by mte guard'
        // fallback mode never injects MTE_OPENCODE_SESSION, so the planner must claim by this session id
        throw new Error(
          hasShellHook || !sessionID
            ? reason
            : `${reason} (opencode session ${sessionID}; planners claim with: mte planner claim --opencode-session ${sessionID})`
        )
      }
    }

    let hasShellHook = true
    try {
      await ctx.shell.hook('create.before', (e) => {
        const command = e?.command
        // newest unconsumed stash entry with the same command text (same text may run in two sessions at once)
        const now = Date.now()
        let match
        for (let i = stash.length - 1; i >= 0; i--) {
          if (now - stash[i].at > STASH_TTL_MS) {
            stash.splice(0, i + 1) // everything older is stale too
            break
          }
          if (stash[i].command === command) {
            match = stash.splice(i, 1)[0]
            break
          }
        }
        const sessionID = match?.sessionID
        const env = e?.env ?? {}
        const seen = sessionID ? identities.get(sessionID) : undefined
        const identity = {
          sessionId: env.ORCA_AGENT_SESSION_ID || seen?.sessionId,
          terminalHandle: env.ORCA_TERMINAL_HANDLE || seen?.terminalHandle
        }
        if (sessionID) {
          identities.set(sessionID, identity)
        }
        if (e?.env) {
          // lets `mte planner claim` run from this shell record the opencode session id; never keep a client-supplied value
          if (sessionID) {
            e.env.MTE_OPENCODE_SESSION = sessionID
          } else {
            delete e.env.MTE_OPENCODE_SESSION
          }
        }
        if (typeof command === 'string' && command.includes('orchestration')) {
          guard(command, sessionID, identity, e.cwd)
        }
      })
    } catch {
      // No shell hook in this opencode build: decide in execute.before with the session id only. Nothing is injected into
      // the shell (no env to verify against), so a planner claims with `mte planner claim --opencode-session <id>` and
      // claim and guard both key on that session id.
      hasShellHook = false
    }

    await ctx.tool.hook('execute.before', (e) => {
      const command = e?.input?.command
      if (e?.tool !== 'shell' || typeof command !== 'string') {
        return
      }
      if (!hasShellHook) {
        if (command.includes('orchestration')) {
          guard(command, e.sessionID, identities.get(e.sessionID) ?? {}, e.input.workdir || e.input.cwd)
        }
        return
      }
      stash.push({ command, sessionID: e.sessionID, at: Date.now() })
      if (stash.length > STASH_MAX) {
        stash.shift()
      }
    })
  }
}
