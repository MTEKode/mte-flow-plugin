import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { evaluateCommand } from './wiring/guard-logic.ts'
import { readPlanner, writePin, writePlanner } from './wiring/state.ts'

const CLI = new URL('./cli.ts', import.meta.url).pathname
const ASSETS = new URL('../assets/', import.meta.url).pathname
let root: string
let bin: string
const repos: string[] = []

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mte-wiring-'))
  bin = join(root, 'bin')
  mkdirSync(bin)
  // `mte` shim so real hook commands (`mte guard ...`) resolve on PATH.
  writeFileSync(join(bin, 'mte'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
  chmodSync(join(bin, 'mte'), 0o755)
  // Fake orca: prints its args, so dispatch never touches a real orchestration.
  writeFileSync(join(bin, 'fake-orca'), '#!/bin/sh\necho "ORCA $@"\nexit "${FAKE_ORCA_EXIT:-0}"\n')
  chmodSync(join(bin, 'fake-orca'), 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
})
after(() => rmSync(root, { recursive: true, force: true }))

function repo(): string {
  const dir = mkdtempSync(join(root, 'repo-'))
  spawnSync('git', ['init', '-q'], { cwd: dir })
  repos.push(dir)
  return dir
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean = { ...process.env }
  delete clean.ORCA_AGENT_SESSION_ID
  delete clean.ORCA_TERMINAL_HANDLE
  return { ...clean, ...extra }
}

function mte(cwd: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  return spawnSync('mte', args, { cwd, encoding: 'utf8', env: env(extra), input })
}

const WORKER_START = 'orca orchestration worker-start --task T-1'

describe('guard logic', () => {
  it('allows the planner, denies others, ignores unrelated commands', () => {
    const ws = repo()
    writePlanner(ws, { sessionId: 'planner-1' })
    const planner = { sessionId: 'planner-1' }
    const other = { sessionId: 'worker-9' }
    for (const cmd of ['orca orchestration run-create', WORKER_START]) {
      assert.deepEqual(evaluateCommand(cmd, planner, ws), { allow: true })
      const verdict = evaluateCommand(cmd, other, ws)
      assert.equal(verdict.allow, false)
    }
    for (const cmd of ['ls -la', 'orca orchestration inbox', 'git status && echo worker-start']) {
      assert.deepEqual(evaluateCommand(cmd, other, ws), { allow: true })
    }
    // wrapped / chained / bash -c forms are still gated
    for (const cmd of [`cd x && ${WORKER_START}`, `bash -c "${WORKER_START}"`, `FOO=1 orca-dev orchestration run-create`]) {
      assert.equal(evaluateCommand(cmd, other, ws).allow, false)
    }
  })

  it('matches by terminal handle and ignores callers with no identity', () => {
    const ws = repo()
    writePlanner(ws, { terminalHandle: 'term_1' })
    assert.deepEqual(evaluateCommand(WORKER_START, { terminalHandle: 'term_1' }, ws), { allow: true })
    assert.equal(evaluateCommand(WORKER_START, { terminalHandle: 'term_2' }, ws).allow, false)
    assert.deepEqual(evaluateCommand(WORKER_START, {}, ws), { allow: true })
  })

  it('auto-claims on the first run-create; worker-start on an unclaimed workspace is denied', () => {
    const ws = repo()
    const first = { sessionId: 'a' }
    assert.equal(evaluateCommand(WORKER_START, first, ws).allow, false)
    assert.deepEqual(evaluateCommand('orca orchestration run-create', first, ws), { allow: true })
    assert.equal(readPlanner(ws)?.sessionId, 'a')
    assert.equal(evaluateCommand('orca orchestration run-create', { sessionId: 'b' }, ws).allow, false)
  })

  it('denies worker-start missing the pin with the corrected command', () => {
    const ws = repo()
    const planner = { sessionId: 'p' }
    writePlanner(ws, planner)
    writePin(ws, { agent: 'claude', model: 'sonnet', effort: 'high' })
    const verdict = evaluateCommand('orca orchestration worker-start --task T-1 --model opus', planner, ws)
    assert.ok(!verdict.allow)
    assert.match(verdict.reason, /orca orchestration worker-start --task T-1 --agent claude --model sonnet --effort high/)
    const ok = 'orca orchestration worker-start --task T-1 --agent claude --model sonnet --effort high'
    assert.deepEqual(evaluateCommand(ok, planner, ws), { allow: true })
  })

  it('never includes --effort for an opencode pin', () => {
    const ws = repo()
    const planner = { sessionId: 'p' }
    writePlanner(ws, planner)
    const pin = writePin(ws, { agent: 'opencode', model: 'qwen/x', effort: 'high' })
    assert.equal(pin.effort, undefined)
    const verdict = evaluateCommand('orca orchestration worker-start --task T-1 --effort high', planner, ws)
    assert.ok(!verdict.allow)
    assert.match(verdict.reason, /--agent opencode --model qwen\/x/)
    assert.doesNotMatch(verdict.reason, /--effort/)
    const ok = 'orca orchestration worker-start --task T-1 --agent opencode --model qwen/x'
    assert.deepEqual(evaluateCommand(ok, planner, ws), { allow: true })
  })
})

describe('mte guard cli', () => {
  it('exits 2 with a one-line reason for a non-planner, 0 otherwise', () => {
    const ws = repo()
    writePlanner(ws, { sessionId: 'p' })
    const deny = mte(ws, ['guard', '--command', WORKER_START, '--session-id', 'x'])
    assert.equal(deny.status, 2)
    assert.equal(deny.stderr.trim().split('\n').length, 1)
    assert.equal(mte(ws, ['guard', '--command', WORKER_START], { ORCA_AGENT_SESSION_ID: 'orca_session_id:p' }).status, 0)
    assert.equal(mte(ws, ['guard', '--command', 'ls', '--session-id', 'x']).status, 0)
  })

  it('fails open and logs on internal errors', () => {
    const ws = repo()
    mkdirSync(join(ws, '.mte'))
    writeFileSync(join(ws, '.mte', 'planner.json'), '{not json')
    const res = mte(ws, ['guard', '--command', WORKER_START, '--session-id', 'x'])
    assert.equal(res.status, 0)
    assert.match(readFileSync(join(ws, '.mte', 'guard.log'), 'utf8'), /failed open/)
  })
})

describe('pin, planner and dispatch cli', () => {
  it('pin set/get and planner claim/show', () => {
    const ws = repo()
    mte(ws, ['pin', 'set', '--agent', 'opencode', '--model', 'm', '--effort', 'high'])
    assert.deepEqual(JSON.parse(mte(ws, ['pin', 'get', '--json']).stdout), { agent: 'opencode', model: 'm' })
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'a']).status, 0)
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'b']).status, 1)
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'b', '--force']).status, 0)
    const show = JSON.parse(mte(ws, ['planner', 'show', '--json']).stdout)
    assert.equal(show.sessionId, 'b')
  })

  it('dispatch applies the pin, lets extra flags win, denies non-planners, passes orca exit code', () => {
    const ws = repo()
    const orca = { ORCA_CLI_COMMAND: join(bin, 'fake-orca'), ORCA_AGENT_SESSION_ID: 'p' }
    mte(ws, ['pin', 'set', '--agent', 'claude', '--model', 'sonnet', '--effort', 'high'])
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const plain = mte(ws, ['dispatch', '--task', 'T-1'], orca)
    assert.equal(plain.stdout.trim(), 'ORCA orchestration worker-start --task T-1 --agent claude --model sonnet --effort high')
    const esc = mte(ws, ['dispatch', '--task', 'T-1', '--', '--model', 'opus'], orca)
    assert.equal(esc.stdout.trim(), 'ORCA orchestration worker-start --task T-1 --agent claude --effort high --model opus')
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, ORCA_AGENT_SESSION_ID: 'w' }).status, 2)
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, FAKE_ORCA_EXIT: '7' }).status, 7)
    mte(ws, ['pin', 'set', '--agent', 'opencode', '--model', 'm'])
    const oc = mte(ws, ['dispatch', '--task', 'T-1', '--', '--effort', 'high'], orca)
    assert.equal(oc.stdout.trim(), 'ORCA orchestration worker-start --task T-1 --agent opencode --model m')
  })
})

describe('mte install', () => {
  const files = [
    '.claude/skills/mte/SKILL.md',
    '.claude/skills/mte/playbook.md',
    '.agents/skills/mte/SKILL.md',
    '.agents/skills/mte/playbook.md',
    '.claude/settings.json',
    '.mcp.json',
    'opencode.json',
    '.opencode/plugins/mte-guard/index.js',
    '.gitignore'
  ]
  const snapshot = (ws: string): string[] => files.map((f) => readFileSync(join(ws, f), 'utf8'))

  it('creates everything, is idempotent, and preserves unrelated keys', () => {
    const ws = repo()
    mkdirSync(join(ws, '.claude'))
    writeFileSync(
      join(ws, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }], Stop: [] } })
    )
    writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    writeFileSync(join(ws, 'opencode.json'), JSON.stringify({ model: 'a/b', mcp: { servers: { other: { type: 'local', command: ['x'] } } } }))
    writeFileSync(join(ws, '.gitignore'), 'node_modules')
    const first = mte(ws, ['install'])
    assert.equal(first.status, 0, first.stderr)
    for (const f of files) {
      assert.ok(existsSync(join(ws, f)), f)
    }
    const before = snapshot(ws)
    assert.equal(mte(ws, ['install']).status, 0)
    assert.deepEqual(snapshot(ws), before)

    const settings = JSON.parse(readFileSync(join(ws, '.claude/settings.json'), 'utf8'))
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] })
    assert.deepEqual(settings.hooks.Stop, [])
    assert.equal(settings.hooks.PreToolUse.length, 2)
    const mcp = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8'))
    assert.deepEqual(Object.keys(mcp.mcpServers), ['other', 'mte-memory'])
    assert.deepEqual(mcp.mcpServers['mte-memory'], { command: 'mte', args: ['memory', '--role', 'orchestrator'] })
    const oc = JSON.parse(readFileSync(join(ws, 'opencode.json'), 'utf8'))
    assert.equal(oc.model, 'a/b')
    assert.deepEqual(oc.mcp.servers['mte-memory'], { type: 'local', command: ['mte', 'memory', '--role', 'orchestrator'] })
    assert.ok(oc.mcp.servers.other)
    assert.deepEqual(readFileSync(join(ws, '.gitignore'), 'utf8').split('\n').slice(0, 2), ['node_modules', '.mte/memory.db'])
    assert.equal(readFileSync(join(ws, '.claude/skills/mte/SKILL.md'), 'utf8'), readFileSync(join(ws, '.agents/skills/mte/SKILL.md'), 'utf8'))
  })

  it('refuses to clobber an invalid JSON file', () => {
    const ws = repo()
    writeFileSync(join(ws, '.mcp.json'), '{oops')
    assert.equal(mte(ws, ['install', '--agents', 'claude']).status, 1)
    assert.equal(readFileSync(join(ws, '.mcp.json'), 'utf8'), '{oops')
  })

  it('claude hook command denies a non-planner worker-start and allows other things', () => {
    const ws = repo()
    mte(ws, ['install'])
    mte(ws, ['planner', 'claim', '--session-id', 'planner-1'])
    const settings = JSON.parse(readFileSync(join(ws, '.claude/settings.json'), 'utf8'))
    const entry = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash')
    const command: string = entry.hooks[0].command
    const run = (cmd: string, session: string) =>
      spawnSync('sh', ['-c', command], {
        cwd: ws,
        encoding: 'utf8',
        env: env({ ORCA_AGENT_SESSION_ID: session }),
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: ws })
      })
    const denied = run('orca orchestration worker-start --task x', 'someone-else')
    assert.equal(denied.status, 0)
    const out = JSON.parse(denied.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /planner/)
    assert.equal(run('ls', 'someone-else').stdout, '')
    assert.equal(run('orca orchestration worker-start --task x', 'planner-1').stdout, '')
  })

  it('opencode plugin throws for a non-planner worker-start, not for ls', async () => {
    const ws = repo()
    mte(ws, ['install'])
    mte(ws, ['planner', 'claim', '--session-id', 'planner-1'])
    const mod = await import(pathToFileURL(join(ws, '.opencode/plugins/mte-guard/index.js')).href)
    const hooks: Record<string, (e: unknown) => void> = {}
    const hook = (name: string, fn: (e: unknown) => void) => {
      hooks[name] = fn
    }
    await mod.default.setup({ directory: ws, tool: { hook }, shell: { hook } })
    assert.equal(mod.default.id, 'mte-guard')
    const exec = (command: string, sessionID = 'ses_x') => hooks['execute.before']?.({ tool: 'shell', sessionID, input: { command } })
    hooks['create.before']?.({ command: 'x', env: { ORCA_AGENT_SESSION_ID: 'someone-else' } })
    assert.throws(() => exec('orca orchestration worker-start --task x'), /planner/)
    assert.doesNotThrow(() => exec('ls'))
    hooks['create.before']?.({ command: 'x', env: { ORCA_AGENT_SESSION_ID: 'planner-1' } })
    assert.doesNotThrow(() => exec('orca orchestration worker-start --task x'))
  })
})

describe('skill assets', () => {
  it('SKILL.md is short and points to the Spanish playbook with all personas', () => {
    const skill = readFileSync(join(ASSETS, 'skill/SKILL.md'), 'utf8')
    const playbook = readFileSync(join(ASSETS, 'skill/playbook.md'), 'utf8')
    assert.ok(skill.length < 4000)
    assert.match(skill, /playbook\.md/)
    for (const marker of ['# Arquitecto', '# MTE Coder', '# MTE Validator', '# MTE QA', '# MTE Poller de Review de PR', '# MTE Procesador de Review']) {
      assert.ok(playbook.includes(marker), marker)
    }
    assert.ok(!/orca mte/.test(skill + playbook))
    assert.match(playbook, /mte dispatch/)
  })
})
