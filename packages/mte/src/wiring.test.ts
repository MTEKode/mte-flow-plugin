import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
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

  it('matches by terminal handle; a caller with no identity is denied once a planner is claimed', () => {
    const ws = repo()
    writePlanner(ws, { terminalHandle: 'term_1' })
    assert.deepEqual(evaluateCommand(WORKER_START, { terminalHandle: 'term_1' }, ws), { allow: true })
    assert.equal(evaluateCommand(WORKER_START, { terminalHandle: 'term_2' }, ws).allow, false)
    assert.equal(evaluateCommand(WORKER_START, {}, ws).allow, false)
  })

  it('auto-claims only when allowed (hook path); plain evaluation is read-only; worker-start on an unclaimed workspace is denied', () => {
    const ws = repo()
    const first = { sessionId: 'a' }
    assert.equal(evaluateCommand(WORKER_START, first, ws).allow, false)
    assert.deepEqual(evaluateCommand('orca orchestration run-create', first, ws), { allow: true })
    assert.equal(readPlanner(ws), null) // AC1: read-only probes never write the claim
    assert.deepEqual(evaluateCommand('orca orchestration run-create', first, ws, { allowClaim: true }), { allow: true })
    assert.equal(readPlanner(ws)?.sessionId, 'a') // AC2: the hook path claims the first identified caller
    assert.equal(evaluateCommand('orca orchestration run-create', { sessionId: 'b' }, ws).allow, false)
  })

  it('planner-gate deny leaks neither the holder ids nor the --force recipe (AC4)', () => {
    const ws = repo()
    writePlanner(ws, { sessionId: 'ses_secret', terminalHandle: 'term_secret' })
    const verdict = evaluateCommand(WORKER_START, { sessionId: 'intruder' }, ws)
    assert.ok(!verdict.allow)
    assert.ok(!verdict.reason.includes('ses_secret'), verdict.reason)
    assert.ok(!verdict.reason.includes('term_secret'), verdict.reason)
    assert.ok(!verdict.reason.includes('--force'), verdict.reason)
    assert.match(verdict.reason, /workers must not dispatch/)
    assert.match(verdict.reason, /orca orchestration ask/)
    assert.match(verdict.reason, /mte planner show/)
    const anon = evaluateCommand(WORKER_START, {}, ws)
    assert.ok(!anon.allow && anon.reason.includes('(caller presented no identity)'))
  })

  it('sudo/xargs/nice-wrapped worker-start is recognised and still pin-checked (AC5)', () => {
    const ws = repo()
    writePlanner(ws, { sessionId: 'p' })
    writePin(ws, { agent: 'claude', model: 'sonnet', effort: 'high' })
    for (const prefix of ['sudo', 'xargs', 'nice']) {
      const bad = evaluateCommand(`${prefix} orca orchestration worker-start --task x`, { sessionId: 'p' }, ws)
      assert.ok(!bad.allow, prefix)
      assert.match(bad.reason, /--agent claude --model sonnet --effort high/, prefix)
      assert.deepEqual(
        evaluateCommand(`${prefix} orca orchestration worker-start --task x --agent claude --model sonnet --effort high`, { sessionId: 'p' }, ws),
        { allow: true },
        prefix
      )
    }
  })

  it('readPlanner spawns one git rev-parse --absolute-git-dir per call (AC9)', () => {
    const ws = repo()
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    const stubDir = mkdtempSync(join(root, 'gitstub-'))
    const calls = join(stubDir, 'calls.log')
    writeFileSync(join(stubDir, 'git'), `#!/bin/sh\necho "$1 $2" >> "${calls}"\nexec "${realGit}" "$@"\n`)
    chmodSync(join(stubDir, 'git'), 0o755)
    const prevPath = process.env.PATH
    try {
      process.env.PATH = `${stubDir}:${prevPath}`
      readPlanner(ws)
      readPlanner(ws)
    } finally {
      process.env.PATH = prevPath
    }
    const revParses = readFileSync(calls, 'utf8').split('\n').filter((line) => line.includes('--absolute-git-dir'))
    assert.equal(revParses.length, 2) // exactly one per readPlanner call, not two
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
})

describe('review fixes', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })

  it('prose that merely mentions orchestration commands is never a fake invocation (quotes, backticks, heredocs)', () => {
    const ws = repo()
    const planner = { sessionId: 'p' }
    const worker = { sessionId: 'w' }
    writePlanner(ws, planner)
    writePin(ws, { agent: 'claude', model: 'sonnet' })
    const prose = [
      "orca orchestration task-create --spec 'Out of scope: never call `orca orchestration worker-start --task 3` yourself'",
      'orca orchestration task-create --spec "never call `orca orchestration worker-start --task 3` or orca orchestration run-create"',
      "orca orchestration ask --question 'should I run `orca orchestration run-create`?'",
      'git commit -m "$(cat <<\'EOF\'\nfix: stop denying orca orchestration run-create in prose (it\'s fine)\n\norca orchestration worker-start --task 3\nEOF\n)"',
      "cat <<EOF\norca orchestration run-create\nEOF",
      "cat <<-'X' > notes.md\n`orca orchestration worker-start --task 1`\nX\necho done"
    ]
    for (const cmd of prose) {
      assert.deepEqual(evaluateCommand(cmd, planner, ws), { allow: true }, cmd)
      assert.deepEqual(evaluateCommand(cmd, worker, ws), { allow: true }, cmd)
    }
    // real invocations still count
    for (const cmd of [
      'bash -c "orca orchestration worker-start --task x"',
      "sh -lc 'orca orchestration run-create'",
      'eval "orca orchestration worker-start --task x"',
      'echo $(orca orchestration worker-start --task x)',
      'echo `orca orchestration worker-start --task x`',
      'echo "$(orca orchestration worker-start --task x)"',
      'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" && orca orchestration worker-start --task x',
      "cat <<EOF\nhello\nEOF\norca orchestration run-create"
    ]) {
      assert.equal(evaluateCommand(cmd, worker, ws).allow, false, cmd)
    }
  })

  it('dispatch with no identity is denied once a planner is claimed, and never spawns orca', () => {
    const ws = repo()
    const orca = { ORCA_CLI_COMMAND: join(bin, 'fake-orca') }
    writePlanner(ws, { sessionId: 'p' })
    const res = mte(ws, ['dispatch', '--task', 'T-1'], orca)
    assert.equal(res.status, 2)
    assert.doesNotMatch(res.stdout, /ORCA/)
    // unclaimed + no identity stays allowed
    const free = repo()
    assert.match(mte(free, ['dispatch', '--task', 'T-1'], orca).stdout, /ORCA orchestration worker-start/)
  })

  it('install ignores the SQLite sidecar files', () => {
    const ws = repo()
    assert.equal(mte(ws, ['install']).status, 0)
    assert.ok(readFileSync(join(ws, '.gitignore'), 'utf8').split('\n').includes('.mte/memory.db*'))
  })

  it('each worktree has its own planner claim; an old .mte/planner.json is migrated', () => {
    const a = repo()
    git(a, 'commit', '--allow-empty', '-m', 'init')
    const b = join(root, `wt-${repos.length}`)
    assert.equal(git(a, 'worktree', 'add', '-q', b, '-b', 'feat').status, 0)
    // legacy claim in A is moved into A's git dir on first read
    mkdirSync(join(a, '.mte'))
    writeFileSync(join(a, '.mte', 'planner.json'), JSON.stringify({ sessionId: 'planner-1', claimedAt: 't' }))
    assert.equal(readPlanner(a)?.sessionId, 'planner-1')
    assert.equal(existsSync(join(a, '.mte', 'planner.json')), false)
    // B is independent: a second planner claims it without --force and A keeps its own
    assert.equal(readPlanner(b), null)
    assert.equal(mte(b, ['planner', 'claim', '--session-id', 'planner-2']).status, 0)
    assert.equal(readPlanner(a)?.sessionId, 'planner-1')
    assert.equal(readPlanner(b)?.sessionId, 'planner-2')
    // a worker in A (the Run home) still cannot start workers there
    const aGuard = (command: string, id: string) => mte(a, ['guard', '--command', command, '--session-id', id])
    assert.equal(aGuard(WORKER_START, 'worker-9').status, 2)
    assert.equal(aGuard('orca orchestration run-create', 'worker-9').status, 2)
    assert.equal(aGuard(WORKER_START, 'planner-1').status, 0)
    assert.equal(aGuard(WORKER_START, 'planner-2').status, 2)
    assert.match(git(a, 'status', '--porcelain', '--untracked-files=all').stdout, /^$/)
    // releasing B leaves A claimed
    assert.deepEqual(JSON.parse(mte(b, ['planner', 'release']).stdout), { released: true })
    assert.equal(readPlanner(a)?.sessionId, 'planner-1')
  })
})

describe('planner claim identity', () => {
  it('claim refuses a flag identity that differs from the caller env; accepts flags when env lacks it', () => {
    const ws = repo()
    const refused = mte(ws, ['planner', 'claim', '--terminal-handle', 'X'], { ORCA_TERMINAL_HANDLE: 'Y' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /terminal-handle X differs from the caller's own ORCA_TERMINAL_HANDLE \(Y\)/)
    assert.equal(readPlanner(ws), null)
    assert.equal(mte(ws, ['planner', 'claim', '--terminal-handle', 'Y'], { ORCA_TERMINAL_HANDLE: 'Y' }).status, 0)
    const ws2 = repo()
    assert.equal(mte(ws2, ['planner', 'claim', '--terminal-handle', 'X']).status, 0)
    assert.equal(readPlanner(ws2)?.terminalHandle, 'X')
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

  it('denies a caller with no identity once a planner is claimed; an identified probe is read-only', () => {
    const ws = repo()
    const RUN_CREATE = 'orca orchestration run-create'
    assert.equal(mte(ws, ['guard', '--command', RUN_CREATE]).status, 0)
    assert.equal(readPlanner(ws), null) // nobody to claim for
    assert.equal(mte(ws, ['guard', '--command', RUN_CREATE, '--session-id', 'p']).status, 0)
    assert.equal(readPlanner(ws), null) // AC1: the probe never writes the claim, hook mode does
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'p']).status, 0)
    for (const command of [WORKER_START, RUN_CREATE]) {
      const res = mte(ws, ['guard', '--command', command])
      assert.equal(res.status, 2, command)
      assert.match(res.stderr, /no identity/)
    }
    assert.equal(mte(ws, ['guard', '--command', 'ls']).status, 0)
  })

  it('denies git hook bypasses for every caller, planner included, in probe and hook mode', () => {
    const ws = repo()
    writePlanner(ws, { sessionId: 'p' })
    const probe = mte(ws, ['guard', '--command', 'git commit --no-verify -m x'], { ORCA_AGENT_SESSION_ID: 'p' })
    assert.equal(probe.status, 2)
    assert.match(probe.stderr, /git hooks must not be skipped/)
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git -c core.hooksPath=/dev/null commit -m x' }, cwd: ws })
    const hook = mte(ws, ['guard', '--claude-hook'], {}, payload)
    assert.equal(hook.status, 0)
    assert.match(hook.stdout, /"permissionDecision":"deny"/)
    assert.equal(mte(ws, ['guard', '--command', 'git commit -m x']).status, 0)
  })

  it('hook mode auto-claims the first identified run-create caller (AC2)', () => {
    const ws = repo()
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'orca orchestration run-create --objective x' }, cwd: ws })
    const first = mte(ws, ['guard', '--claude-hook'], { ORCA_AGENT_SESSION_ID: 'hook-1' }, payload)
    assert.equal(first.status, 0)
    assert.equal(first.stdout.trim(), '') // allowed: no deny JSON
    assert.equal(readPlanner(ws)?.sessionId, 'hook-1')
    const second = mte(ws, ['guard', '--claude-hook'], { ORCA_AGENT_SESSION_ID: 'hook-2' }, payload)
    assert.equal(second.status, 0) // the hook path always exits 0
    const out = JSON.parse(second.stdout).hookSpecificOutput
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.hookEventName, 'PreToolUse')
  })

  it('empty flag values are usage errors, never silent passes (AC11)', () => {
    const ws = repo()
    assert.equal(mte(ws, ['guard', '--command=']).status, 1)
    assert.match(mte(ws, ['guard', '--command=']).stderr, /--command <shell command> is required/)
    assert.equal(mte(ws, ['guard', '--command', '']).status, 1)
    assert.equal(mte(ws, ['dispatch', '--task=']).status, 1)
    assert.match(mte(ws, ['dispatch', '--task=']).stderr, /usage: mte dispatch --task/)
    assert.equal(mte(ws, ['guard', '--claude-hook', '--command='], {}, '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"' + ws + '"}').status, 0) // hook stays fail-open
  })

  it('guard identity: env wins, flags fill gaps, contradicting flags are denied (AC3)', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p', '--terminal-handle', 't'])
    // flag equal to env
    assert.equal(mte(ws, ['guard', '--command', WORKER_START, '--session-id', 'p'], { ORCA_AGENT_SESSION_ID: 'p' }).status, 0)
    // flag contradicting env: denied even though the env identity alone would pass
    const bad = mte(ws, ['guard', '--command', WORKER_START, '--session-id', 'q'], { ORCA_AGENT_SESSION_ID: 'p' })
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /session-id q differs from the caller's own ORCA_AGENT_SESSION_ID \(p\)/)
    const hook = mte(ws, ['guard', '--claude-hook', '--session-id', 'q'], { ORCA_AGENT_SESSION_ID: 'p' }, JSON.stringify({ tool_name: 'Bash', tool_input: { command: WORKER_START }, cwd: ws }))
    assert.equal(hook.status, 0)
    const out = JSON.parse(hook.stdout).hookSpecificOutput
    assert.equal(out.permissionDecision, 'deny')
    assert.match(out.permissionDecisionReason, /differs/)
    // flag filling an env gap: env carries the terminal handle, the flag adds the session id
    const ws2 = repo()
    mte(ws2, ['planner', 'claim', '--terminal-handle', 't'])
    assert.equal(mte(ws2, ['guard', '--command', WORKER_START, '--session-id', 'unrelated'], { ORCA_TERMINAL_HANDLE: 't' }).status, 0)
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
    mte(ws, ['pin', 'set', '--agent', 'antigravity', '--model', 'm', '--effort', 'high'])
    assert.deepEqual(JSON.parse(mte(ws, ['pin', 'get', '--json']).stdout), { agent: 'antigravity', model: 'm', effort: 'high' })
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'a']).status, 0)
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'b']).status, 1)
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'b', '--force']).status, 0)
    const show = JSON.parse(mte(ws, ['planner', 'show', '--json']).stdout)
    assert.equal(show.sessionId, 'b')
  })

  it('planner release removes the claim so the next claim needs no --force', () => {
    const ws = repo()
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'a']).status, 0)
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'b']).status, 1)
    assert.deepEqual(JSON.parse(mte(ws, ['planner', 'release']).stdout), { released: true })
    assert.equal(existsSync(join(ws, '.mte', 'planner.json')), false)
    assert.equal(mte(ws, ['planner', 'claim', '--session-id', 'b']).status, 0)
    assert.equal(readPlanner(ws)?.sessionId, 'b')
    mte(ws, ['planner', 'release'])
    assert.deepEqual(JSON.parse(mte(ws, ['planner', 'release']).stdout), { released: false })
  })

  it('dispatch applies the pin, lets extra flags win, denies non-planners, passes orca exit code', () => {
    const ws = repo()
    const orca = { ORCA_CLI_COMMAND: join(bin, 'fake-orca'), ORCA_AGENT_SESSION_ID: 'p' }
    mte(ws, ['pin', 'set', '--agent', 'claude', '--model', 'sonnet', '--effort', 'high'])
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const plain = mte(ws, ['dispatch', '--task', 'T-1'], orca)
    assert.equal(plain.stdout.trim(), 'ORCA orchestration worker-start --task T-1 --worktree new-child --agent claude --model sonnet --effort high')
    const esc = mte(ws, ['dispatch', '--task', 'T-1', '--', '--model', 'opus'], orca)
    assert.equal(esc.stdout.trim(), 'ORCA orchestration worker-start --task T-1 --worktree new-child --agent claude --effort high --model opus')
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, ORCA_AGENT_SESSION_ID: 'w' }).status, 2)
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1', '--', '--worktree', 'current'], orca).stdout.trim(), 'ORCA orchestration worker-start --task T-1 --agent claude --model sonnet --effort high --worktree current')
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, FAKE_ORCA_EXIT: '7' }).status, 7)
  })

  it('qa pin: dispatch --role qa applies it (coder pin as fallback), the guard accepts either pin', () => {
    const ws = repo()
    const orca = { ORCA_CLI_COMMAND: join(bin, 'fake-orca'), ORCA_AGENT_SESSION_ID: 'p' }
    mte(ws, ['pin', 'set', '--agent', 'claude', '--model', 'sonnet'])
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1', '--role', 'qa'], orca).stdout.trim(), 'ORCA orchestration worker-start --task T-1 --agent claude --model sonnet')
    assert.match(mte(ws, ['dispatch', '--task', 'T-1', '--role', 'qa'], orca).stderr, /QA worker runs on the coder's model/)
    mte(ws, ['pin', 'set', '--role', 'qa', '--agent', 'claude', '--model', 'haiku', '--effort', 'low'])
    assert.deepEqual(JSON.parse(mte(ws, ['pin', 'get', '--json', '--role', 'qa']).stdout), { agent: 'claude', model: 'haiku', effort: 'low' })
    assert.deepEqual(JSON.parse(mte(ws, ['pin', 'get', '--json']).stdout), { agent: 'claude', model: 'sonnet' })
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1', '--role', 'qa'], orca).stdout.trim(), 'ORCA orchestration worker-start --task T-1 --agent claude --model haiku --effort low')
    assert.doesNotMatch(mte(ws, ['dispatch', '--task', 'T-1', '--role', 'qa'], orca).stderr, /coder's model/)
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1'], orca).stdout.trim(), 'ORCA orchestration worker-start --task T-1 --worktree new-child --agent claude --model sonnet')
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1', '--role', 'boss'], orca).status, 1)
    const guard = (cmd) => mte(ws, ['guard', '--command', cmd, '--session-id', 'p']).status
    assert.equal(guard('orca orchestration worker-start --task T-1 --agent claude --model haiku --effort low'), 0)
    assert.equal(guard('orca orchestration worker-start --task T-1 --agent claude --model sonnet'), 0)
    assert.equal(guard('orca orchestration worker-start --task T-1 --agent claude --model opus'), 2)
  })
})

describe('dispatch concurrency limit', () => {
  it('refuses while the Run already has the max live workers; settled ones do not count', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const fake = join(root, 'busy-orca')
    const workers = JSON.stringify({ ok: true, result: { workers: [{ state: 'running' }, { state: 'running' }, { state: 'queued' }, { state: 'succeeded' }] } })
    writeFileSync(fake, `#!/bin/sh\nif [ "$2" = worker-list ]; then echo '${workers}'; else echo "ORCA $@"; fi\n`)
    chmodSync(fake, 0o755)
    const orca = { ORCA_CLI_COMMAND: fake, ORCA_AGENT_SESSION_ID: 'p' }
    const full = mte(ws, ['dispatch', '--task', 'T-1'], orca)
    assert.equal(full.status, 3)
    assert.match(full.stderr, /3 workers already running \(limit 3\)/)
    assert.doesNotMatch(full.stdout, /worker-start/)
    const raised = mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, MTE_MAX_WORKERS: '4' })
    assert.equal(raised.stdout.trim(), 'ORCA orchestration worker-start --task T-1 --worktree new-child')
    const lowered = mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, MTE_MAX_WORKERS: '2' })
    assert.equal(lowered.status, 3) // AC6: a valid MTE_MAX_WORKERS=2 is honored
    assert.equal(mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, MTE_MAX_WORKERS: '' }).status, 3) // empty falls back to the default 3
  })

  it('rejects a bogus MTE_MAX_WORKERS with a usage error before any worker-start (AC6)', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const orca = { ORCA_CLI_COMMAND: join(bin, 'fake-orca'), ORCA_AGENT_SESSION_ID: 'p' }
    for (const value of ['0', '-1', 'abc', '2.5', 'NaN']) {
      const res = mte(ws, ['dispatch', '--task', 'T-1'], { ...orca, MTE_MAX_WORKERS: value })
      assert.equal(res.status, 1, value)
      assert.match(res.stderr, /MTE_MAX_WORKERS must be a positive integer/, value)
      assert.doesNotMatch(res.stdout, /ORCA/, value)
    }
  })

  it('logs one guard line and still dispatches when worker-list output is unparseable (AC12)', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const junk = join(root, 'junk-orca')
    writeFileSync(junk, '#!/bin/sh\nif [ "$2" = worker-list ]; then echo "not json at all"; else echo "ORCA $@"; fi\n')
    chmodSync(junk, 0o755)
    const res = mte(ws, ['dispatch', '--task', 'T-1'], { ORCA_CLI_COMMAND: junk, ORCA_AGENT_SESSION_ID: 'p' })
    assert.match(res.stdout, /ORCA orchestration worker-start --task T-1/) // fail open: the dispatch went through
    const log = readFileSync(join(ws, '.mte', 'guard.log'), 'utf8')
    assert.equal(log.split('\n').filter((line) => line.includes('worker-list failed open')).length, 1)
  })
})

describe('corrupt claim file', () => {
  it('show and claim exit 1 naming the path and the release remedy; release removes it (AC8)', () => {
    const ws = repo()
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ws, encoding: 'utf8' }).stdout.trim()
    const claim = join(gitDir, 'mte', 'planner.json')
    mkdirSync(join(claim, '..'), { recursive: true })
    writeFileSync(claim, '{oops')
    const show = mte(ws, ['planner', 'show'])
    assert.equal(show.status, 1)
    assert.ok(show.stderr.includes(claim), show.stderr)
    assert.ok(show.stderr.includes('mte planner release'), show.stderr)
    const claimRes = mte(ws, ['planner', 'claim', '--session-id', 'x'])
    assert.equal(claimRes.status, 1)
    assert.ok(claimRes.stderr.includes(claim), claimRes.stderr)
    assert.ok(claimRes.stderr.includes('mte planner release'), claimRes.stderr)
    assert.deepEqual(JSON.parse(mte(ws, ['planner', 'release']).stdout), { released: true })
    assert.equal(existsSync(claim), false)
    assert.deepEqual(JSON.parse(mte(ws, ['planner', 'show']).stdout), { claimed: false })
  })
})

describe('dispatch executable', () => {
  it('uses ORCA_CLI_COMMAND when set, else orca on PATH', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const viaVar = mte(ws, ['dispatch', '--task', 'T-9'], { ORCA_CLI_COMMAND: join(bin, 'fake-orca'), ORCA_AGENT_SESSION_ID: 'p' })
    assert.equal(viaVar.stdout.trim(), 'ORCA orchestration worker-start --task T-9 --worktree new-child')
    const dir = mkdtempSync(join(root, 'path-'))
    writeFileSync(join(dir, 'orca'), '#!/bin/sh\necho "PATHORCA $@"\n')
    chmodSync(join(dir, 'orca'), 0o755)
    const viaPath = mte(ws, ['dispatch', '--task', 'T-9'], { PATH: `${dir}:${process.env.PATH}`, ORCA_CLI_COMMAND: '', ORCA_AGENT_SESSION_ID: 'p' })
    assert.equal(viaPath.stdout.trim(), 'PATHORCA orchestration worker-start --task T-9 --worktree new-child')
  })
})

describe('mte install', () => {
  const files = [
    '.claude/skills/mte-flow/SKILL.md',
    '.claude/skills/mte-flow/playbook.md',
    '.claude/settings.json',
    '.mcp.json',
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
    assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'mte phase --claude-hook' }] }])
    assert.equal(settings.hooks.PreToolUse.length, 2)
    const mcp = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8'))
    assert.deepEqual(Object.keys(mcp.mcpServers), ['other', 'mte-memory'])
    // Runnable entry: the node that ran the install plus the real CLI file, independent of PATH.
    assert.deepEqual(mcp.mcpServers['mte-memory'], { command: process.execPath, args: [realpathSync(CLI), 'memory'] })
    assert.deepEqual(readFileSync(join(ws, '.gitignore'), 'utf8').split('\n').slice(0, 2), ['node_modules', '.mte/memory.db*'])
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
    assert.equal(mte(ours, ['install']).status, 0)
    assert.ok(!existsSync(join(ours, '.claude/skills/mte')))
    assert.equal(readFileSync(join(ours, '.claude/skills/mte-flow/SKILL.md'), 'utf8'), asset('SKILL.md'))
    assert.match(asset('SKILL.md'), /^name: mte-flow$/m)
    assert.match(asset('SKILL.md'), /generated by mte install/)

    old(ws, '---\nname: mte\n---\nmy own skill\n')
    assert.equal(mte(ws, ['install']).status, 0)
    assert.equal(readFileSync(join(ws, '.claude/skills/mte/SKILL.md'), 'utf8'), '---\nname: mte\n---\nmy own skill\n')
    assert.equal(readFileSync(join(ws, '.claude/skills/mte/playbook.md'), 'utf8'), 'old playbook')
    assert.ok(existsSync(join(ws, '.claude/skills/mte-flow/SKILL.md')))
    assert.ok(!existsSync(join(ws, '.agents')))
  })

  it('--user writes the skill into ~/.claude/skills, idempotent, foreign skills untouched', () => {
    const home = mkdtempSync(join(root, 'home-'))
    const cwd = mkdtempSync(join(root, 'nogit-')) // --user needs no repo
    const asset = (f: string) => readFileSync(join(ASSETS, 'skill', f), 'utf8')
    const foreign = join(home, '.claude/skills/mte/SKILL.md')
    mkdirSync(join(home, '.claude/skills/mte'), { recursive: true })
    writeFileSync(foreign, '---\nname: mte\n---\nOrca bundled\n')
    const first = mte(cwd, ['install', '--user'], { HOME: home })
    assert.equal(first.status, 0, first.stderr)
    for (const f of ['SKILL.md', 'playbook.md']) {
      assert.equal(readFileSync(join(home, '.claude/skills/mte-flow', f), 'utf8'), asset(f))
    }
    assert.ok(!existsSync(join(home, '.agents')))
    assert.equal(readFileSync(foreign, 'utf8'), '---\nname: mte\n---\nOrca bundled\n')
    const before = statSync(join(home, '.claude/skills/mte-flow/SKILL.md')).mtimeMs
    assert.equal(mte(cwd, ['install', '--user'], { HOME: home }).status, 0)
    assert.equal(statSync(join(home, '.claude/skills/mte-flow/SKILL.md')).mtimeMs, before)
    // an older generated copy is upgraded; a hand-written mte-flow is left alone
    writeFileSync(join(home, '.claude/skills/mte-flow/SKILL.md'), '<!-- generated by mte install; do not edit -->\nold')
    assert.equal(mte(cwd, ['install', '--user'], { HOME: home }).status, 0)
    assert.equal(readFileSync(join(home, '.claude/skills/mte-flow/SKILL.md'), 'utf8'), asset('SKILL.md'))
    writeFileSync(join(home, '.claude/skills/mte-flow/SKILL.md'), 'mine')
    assert.equal(mte(cwd, ['install', '--user'], { HOME: home }).status, 0)
    assert.equal(readFileSync(join(home, '.claude/skills/mte-flow/SKILL.md'), 'utf8'), 'mine')
  })

  it('SKILL.md starts with `mte install` and stays under 4000 chars', () => {
    const skill = readFileSync(join(ASSETS, 'skill', 'SKILL.md'), 'utf8')
    assert.ok(skill.length < 4000, String(skill.length))
    assert.match(skill.split('## Si eres el planner')[1] ?? '', /^[^]*?\n1\. Instala MTE[^\n]*`mte install`/)
  })

  it('refuses to clobber an invalid JSON file', () => {
    const ws = repo()
    writeFileSync(join(ws, '.mcp.json'), '{oops')
    assert.equal(mte(ws, ['install']).status, 1)
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
    assert.match(playbook, /Tras fusionar cada tarea\*\* llama `record_task`/)
    assert.match(playbook, /Revisión autónoma[\s\S]*search_tasks/)
    // the 8 run phases, in order
    const phases = ['1. **Exploración.**', '2. **Brainstorming.**', '3. **Grill me.**', '4. **Write spec.**', '5. **Coder.**', '6. **QA.**', '7. **Resumen.**', '8. **PR en draft.**']
    const at = phases.map((p) => playbook.indexOf(p))
    assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), JSON.stringify(at))
    assert.match(playbook, /3 workers Explorador[\s\S]*sin conexión entre ellos/)
    assert.match(playbook, /Al llegar a 10 preguntas, para y pregunta si quiere relanzar la exploración/)
    assert.match(playbook, /despacha 2 workers con `--role qa`/)
    assert.ok(playbook.includes('# MTE Explorador'))
    for (const text of [skill, playbook]) {
      assert.match(text, /~\/\.mte\/bin\/mte\.mjs/)
      assert.match(text, /planner already claimed/)
      assert.match(text, /--force/)
    }
  })
})

describe('mte phase', () => {
  const transcript = (ws: string, ...texts: string[]): string => {
    const path = join(ws, 'transcript.jsonl')
    const rows = texts.map((text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }))
    writeFileSync(path, ['{"cut line', JSON.stringify({ type: 'user', message: { content: '## Fase 8 — not the planner' } }), ...rows].join('\n'))
    return path
  }
  const hook = (ws: string, path: string, session: string) =>
    mte(ws, ['phase', '--claude-hook'], { ORCA_AGENT_SESSION_ID: session }, JSON.stringify({ transcript_path: path, cwd: ws }))
  const show = (ws: string) => JSON.parse(mte(ws, ['phase', 'show', '--json']).stdout)

  it('records the claimed planner\'s latest phase header; ignores other callers; a new claim clears it', () => {
    const ws = repo()
    assert.deepEqual(show(ws), { phase: null })
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const path = transcript(ws, '## Fase 2 — Brainstorming\nIdeas', 'texto\n\n## Fase 3 — Grill me (cierre)\nmás')
    const res = hook(ws, path, 'w')
    assert.equal(res.status, 0)
    assert.equal(res.stdout, '') // a Stop hook that prints nothing never blocks the stop
    assert.deepEqual(show(ws), { phase: null }) // a worker's transcript never moves the run
    assert.equal(hook(ws, path, 'p').status, 0)
    assert.deepEqual({ ...show(ws), at: '' }, { phase: 3, name: 'Grill me', at: '' })
    mte(ws, ['planner', 'claim', '--session-id', 'p2', '--force'])
    assert.deepEqual(show(ws), { phase: null })
  })

  it('prefers the payload\'s last assistant message: the transcript can lag behind the Stop hook', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    const path = transcript(ws, '## Fase 6 — QA')
    const payload = JSON.stringify({ transcript_path: path, cwd: ws, last_assistant_message: '## Fase 7 — Resumen\nhecho\n\n## Fase 8 — PR en draft\nurl' })
    assert.equal(mte(ws, ['phase', '--claude-hook'], { ORCA_AGENT_SESSION_ID: 'p' }, payload).status, 0)
    assert.equal(show(ws).phase, 8)
    const plain = JSON.stringify({ transcript_path: path, cwd: ws, last_assistant_message: 'sin cabecera' })
    mte(ws, ['phase', '--claude-hook'], { ORCA_AGENT_SESSION_ID: 'p' }, plain)
    assert.equal(show(ws).phase, 6) // no header in the last message: the transcript decides
  })

  it('fails open on a missing transcript and refuses to run without --claude-hook', () => {
    const ws = repo()
    mte(ws, ['planner', 'claim', '--session-id', 'p'])
    assert.equal(hook(ws, join(ws, 'nope.jsonl'), 'p').status, 0)
    assert.equal(mte(ws, ['phase']).status, 1)
  })
})
