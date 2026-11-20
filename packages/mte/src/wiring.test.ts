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

  it('recognises every spelling of the orca executable and compound commands', () => {
    const ws = repo()
    writePlanner(ws, { sessionId: 'planner-1' })
    const other = { sessionId: 'worker-9' }
    const task = 'orchestration worker-start --task x'
    for (const cmd of [
      `orca ${task}`,
      `/Applications/Orca.app/Contents/Resources/bin/orca ${task}`,
      `./bin/orca ${task}`,
      `"$ORCA_CLI_COMMAND" ${task}`,
      '${ORCA_CLI_COMMAND} ' + task,
      `$ORCA_CLI_COMMAND ${task}`,
      `env FOO=1 orca ${task}`,
      `env -i /usr/local/bin/orca ${task}`,
      `cd x && orca ${task}`,
      `true; orca ${task}`,
      `echo hi | orca ${task}`,
      `(cd x; orca ${task})`,
      `echo "$(orca ${task})"`,
      `bash -c '"$ORCA_CLI_COMMAND" ${task}'`
    ]) {
      assert.equal(evaluateCommand(cmd, other, ws).allow, false, cmd)
      assert.deepEqual(evaluateCommand(cmd, { sessionId: 'planner-1' }, ws), { allow: true }, cmd)
    }
    for (const cmd of ['ls', 'echo orchestration worker-start', 'orca orchestration inbox', 'notorca orchestration worker-start --task x', 'echo "$ORCA_CLI_COMMAND" && ls']) {
      assert.deepEqual(evaluateCommand(cmd, other, ws), { allow: true }, cmd)
    }
  })

  it('builds the corrected command from the orca argv only, never leaking redirections', () => {
    const ws = repo()
    const planner = { sessionId: 'p' }
    writePlanner(ws, planner)
    writePin(ws, { agent: 'claude', model: 'sonnet', effort: 'high' })
    for (const tail of ['--json 2>&1; echo $?', '--json 2>/dev/null && echo done', '--json >out.txt 2>&1 | tee x', '--json &> /dev/null; echo "exit=$?"']) {
      const verdict = evaluateCommand(`orca orchestration worker-start --task x ${tail}`, planner, ws)
      assert.ok(!verdict.allow, tail)
      assert.match(verdict.reason, /run: orca orchestration worker-start --task x --json --agent claude --model sonnet --effort high/, tail)
      const corrected = verdict.reason.replace(/^.*run: /, '')
      assert.doesNotMatch(corrected, /2>|>|&|;|echo|tee|\$\?/, tail)
    }
    const viaVar = evaluateCommand('"$ORCA_CLI_COMMAND" orchestration worker-start --task x', planner, ws)
    assert.ok(!viaVar.allow)
    assert.match(viaVar.reason, /run: "\$ORCA_CLI_COMMAND" orchestration worker-start --task x --agent claude/)
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

describe('opencode session identity', () => {
  it('a planner claimed by opencode session id is allowed on its first gated command with no terminal handle', () => {
    const ws = repo()
    assert.equal(mte(ws, ['planner', 'claim', '--opencode-session', 'ses_1', '--terminal-handle', 'term_1']).status, 0)
    assert.deepEqual(JSON.parse(mte(ws, ['planner', 'show']).stdout), {
      claimed: true,
      terminalHandle: 'term_1',
      opencodeSessionId: 'ses_1',
      claimedAt: JSON.parse(mte(ws, ['planner', 'show']).stdout).claimedAt
    })
    assert.equal(mte(ws, ['guard', '--command', WORKER_START, '--opencode-session', 'ses_1']).status, 0)
    assert.equal(mte(ws, ['guard', '--command', WORKER_START, '--opencode-session', 'ses_2']).status, 2)
    // any identity matching is enough
    assert.equal(mte(ws, ['guard', '--command', WORKER_START, '--opencode-session', 'ses_2', '--terminal-handle', 'term_1']).status, 0)
  })

  it('claim picks the opencode session up from MTE_OPENCODE_SESSION', () => {
    const ws = repo()
    assert.equal(mte(ws, ['planner', 'claim'], { MTE_OPENCODE_SESSION: 'ses_env' }).status, 0)
    assert.equal(readPlanner(ws)?.opencodeSessionId, 'ses_env')
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

describe('dispatch executable', () => {
  it('uses ORCA_CLI_COMMAND when set, else orca on PATH', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const viaVar = mte(ws, ['dispatch', '--task', 'T-9'], { ORCA_CLI_COMMAND: join(bin, 'fake-orca'), ORCA_AGENT_SESSION_ID: 'p' })
    assert.equal(viaVar.stdout.trim(), 'ORCA orchestration worker-start --task T-9')
    const dir = mkdtempSync(join(root, 'path-'))
    writeFileSync(join(dir, 'orca'), '#!/bin/sh\necho "PATHORCA $@"\n')
    chmodSync(join(dir, 'orca'), 0o755)
    const viaPath = mte(ws, ['dispatch', '--task', 'T-9'], { PATH: `${dir}:${process.env.PATH}`, ORCA_CLI_COMMAND: '', ORCA_AGENT_SESSION_ID: 'p' })
    assert.equal(viaPath.stdout.trim(), 'PATHORCA orchestration worker-start --task T-9')
  })
})

describe('mte install', () => {
  const files = [
    '.claude/skills/mte-flow/SKILL.md',
    '.claude/skills/mte-flow/playbook.md',
    '.agents/skills/mte-flow/SKILL.md',
    '.agents/skills/mte-flow/playbook.md',
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
    assert.equal(readFileSync(join(ws, '.claude/skills/mte-flow/SKILL.md'), 'utf8'), readFileSync(join(ws, '.agents/skills/mte-flow/SKILL.md'), 'utf8'))
  })

  it('writes skills under mte-flow, removes only its own old mte skill, leaves a foreign one', () => {
    const ws = repo()
    const asset = (f: string) => readFileSync(join(ASSETS, 'skill', f), 'utf8')
    const ours = repo()
    const old = (dir: string, skill: string, playbook = 'old playbook') => {
      mkdirSync(join(dir, '.claude/skills/mte'), { recursive: true })
      writeFileSync(join(dir, '.claude/skills/mte/SKILL.md'), skill)
      writeFileSync(join(dir, '.claude/skills/mte/playbook.md'), playbook)
    }
    // a copy of the current generated SKILL.md counts as ours (marker); a hand-written one does not
    old(ours, asset('SKILL.md'), asset('playbook.md'))
    assert.equal(mte(ours, ['install', '--agents', 'claude']).status, 0)
    assert.ok(!existsSync(join(ours, '.claude/skills/mte')))
    assert.equal(readFileSync(join(ours, '.claude/skills/mte-flow/SKILL.md'), 'utf8'), asset('SKILL.md'))
    assert.match(asset('SKILL.md'), /^name: mte-flow$/m)
    assert.match(asset('SKILL.md'), /generated by mte install/)

    old(ws, '---\nname: mte\n---\nmy own skill\n')
    assert.equal(mte(ws, ['install', '--agents', 'claude,opencode']).status, 0)
    assert.equal(readFileSync(join(ws, '.claude/skills/mte/SKILL.md'), 'utf8'), '---\nname: mte\n---\nmy own skill\n')
    assert.equal(readFileSync(join(ws, '.claude/skills/mte/playbook.md'), 'utf8'), 'old playbook')
    assert.ok(existsSync(join(ws, '.claude/skills/mte-flow/SKILL.md')))
    assert.ok(existsSync(join(ws, '.agents/skills/mte-flow/playbook.md')))
    assert.ok(!existsSync(join(ws, '.agents/skills/mte')))
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

describe('opencode plugin cwd', () => {
  it('resolves the project dir from ctx.location.directory (execute.before input only has command) and denies', async () => {
    const ws = repo()
    mte(ws, ['install', '--agents', 'opencode'])
    mte(ws, ['planner', 'claim', '--session-id', 'planner-1'])
    const mod = await import(pathToFileURL(join(ws, '.opencode/plugins/mte-guard/index.js')).href)
    const hooks: Record<string, (e: unknown) => void> = {}
    const hook = (name: string, fn: (e: unknown) => void) => {
      hooks[name] = fn
    }
    // no ctx.directory, no input.cwd; run from a cwd that has no .mte (service cwd) so only ctx.location can find the workspace
    const prev = process.cwd()
    process.chdir(tmpdir())
    try {
      await mod.default.setup({ location: { directory: ws }, tool: { hook }, shell: { hook } })
      hooks['create.before']?.({ command: 'x', env: { ORCA_AGENT_SESSION_ID: 'someone-else' } })
      const exec = (command: string, sessionID: string) => hooks['execute.before']?.({ tool: 'shell', sessionID, input: { command } })
      assert.throws(() => exec('orca orchestration worker-start --task x', 'ses_other'), /planner/)
      assert.throws(() => exec('"$ORCA_CLI_COMMAND" orchestration worker-start --task x', 'ses_other'), /planner/)
    } finally {
      process.chdir(prev)
    }
  })

  it('allows the opencode-claimed planner before any shell create.before event fired', async () => {
    const ws = repo()
    mte(ws, ['install', '--agents', 'opencode'])
    mte(ws, ['planner', 'claim', '--terminal-handle', 'term_1', '--opencode-session', 'ses_planner'])
    const mod = await import(pathToFileURL(join(ws, '.opencode/plugins/mte-guard/index.js')).href)
    const hooks: Record<string, (e: unknown) => void> = {}
    await mod.default.setup({ location: { directory: ws }, tool: { hook: (n: string, f: (e: unknown) => void) => (hooks[n] = f) } })
    const exec = (sessionID: string) =>
      hooks['execute.before']?.({ tool: 'shell', sessionID, input: { command: 'orca orchestration worker-start --task x' } })
    assert.doesNotThrow(() => exec('ses_planner'))
    assert.throws(() => exec('ses_other'), /planner/)
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
