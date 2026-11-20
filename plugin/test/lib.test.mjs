import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBootstrapPrompt,
  checkMte,
  installInWorkspace,
  listOrchestration,
  resolveOrcaCli,
  startRun,
  statusText,
  TRUNCATION_MARKER
} from '../worker/lib.mjs'

const WS = { id: 'wt-1', kind: 'worktree', name: 'feat', path: '/repo/feat', branch: 'feat', hostId: 'local' }

/** Stubbed child_process + host API; records every call in order. */
function stubs({ settings = {}, exec, ws = WS, home = '/home/me', gitPaths, claim = { claimed: false } } = {}) {
  const calls = []
  const deps = {
    exists: (p) => (gitPaths ? gitPaths.includes(p) : true),
    homedir: home,
    orcaCli: { bin: '/App/Resources/bin/orca', env: { ORCA_USER_DATA_PATH: '/ud' } },
    exec:
      exec ??
      (async (file, args, opts) => {
        calls.push({ kind: 'exec', file, args, cwd: opts?.cwd, env: opts?.env })
        if (file === '/App/Resources/bin/orca') {
          return { code: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal', handle: 'term-1' } } }), stderr: '' }
        }
        if (args[0] === 'planner' && args[1] === 'show') {
          return { code: 0, stdout: JSON.stringify(claim), stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }),
    host: {
      settings: async () => settings,
      call: async (method, params) => {
        calls.push({ kind: 'host', method, params })
        if (method === 'workspace.readContext') {
          return { workspaceId: ws.id, branch: ws.branch, displayName: ws.name, terminals: [] }
        }
        if (method === 'workspace.list') {
          return { workspaces: [ws], truncated: false }
        }
        if (method === 'agent.launch') {
          return { terminalId: 'term-1' }
        }
        return {}
      }
    }
  }
  return { deps, calls }
}

test('bootstrap prompt is `/mte-flow <goal>` for short goals', () => {
  assert.equal(buildBootstrapPrompt('ship it'), '/mte-flow ship it')
  assert.equal(buildBootstrapPrompt('  ship it \n'), '/mte-flow ship it')
})

test('bootstrap prompt stays under 4096 chars for a 3000-char goal', () => {
  const goal = 'a'.repeat(3000)
  const prompt = buildBootstrapPrompt(goal)
  assert.ok(prompt.length < 4096)
  assert.equal(prompt, `/mte-flow ${goal}`)
})

test('bootstrap prompt truncates an oversized goal with a marker', () => {
  const prompt = buildBootstrapPrompt('b'.repeat(10_000))
  assert.ok(prompt.length < 4096)
  assert.ok(prompt.startsWith('/mte-flow b'))
  assert.ok(prompt.endsWith(TRUNCATION_MARKER))
  // never splits a surrogate pair
  const emoji = buildBootstrapPrompt('😀'.repeat(5000))
  assert.ok(emoji.length < 4096)
  assert.ok(!/[\uD800-\uDBFF]\n\[goal truncated\]$/.test(emoji))
})

test('start run: planner show, install, pin set, then the orca CLI launch with /mte-flow <goal>, in that order (no release without a claim)', async () => {
  const { deps, calls } = stubs({
    settings: { plannerAgent: 'claude', workerAgent: 'claude', workerModel: 'claude-sonnet-5-5', workerEffort: 'high', mteBin: 'mte' }
  })
  const result = await startRun(deps, { goal: 'build the thing' })
  assert.equal(result.ok, true)
  assert.equal(result.terminalId, 'term-1')
  const seq = calls.filter((c) => c.kind === 'exec')
  assert.deepEqual(
    seq.map((c) => `${c.file} ${c.args.slice(0, 2).join(' ')}`),
    ['mte planner show', 'mte install --agents', 'mte pin set', '/App/Resources/bin/orca agent launch']
  )
  assert.deepEqual(seq[0].args, ['planner', 'show', '--json'])
  assert.deepEqual(seq[1].args, ['install', '--agents', 'claude,opencode'])
  assert.equal(seq[1].cwd, '/repo/feat')
  assert.deepEqual(seq[2].args, ['pin', 'set', '--agent', 'claude', '--model', 'claude-sonnet-5-5', '--effort', 'high'])
  assert.equal(seq[2].cwd, '/repo/feat')
  assert.deepEqual(seq[3].args, [
    'agent', 'launch', '--agent', 'claude', '--worktree', 'path:/repo/feat', '--surface', 'terminal',
    '--prompt', '/mte-flow build the thing', '--json'
  ])
  assert.deepEqual(seq[3].env, { ORCA_USER_DATA_PATH: '/ud' })
  assert.ok(!calls.some((c) => c.method === 'agent.launch'))
})

test('start run passes the planner model to the launch and keeps the prompt under the cap', async () => {
  const { deps, calls } = stubs({ settings: { plannerModel: 'claude-opus-5-5' } })
  await startRun(deps, { goal: 'g'.repeat(9000) })
  const launch = calls.find((c) => c.args?.[0] === 'agent')
  assert.deepEqual(launch.args.slice(-3, -1), ['--model', 'claude-opus-5-5'])
  const prompt = launch.args[launch.args.indexOf('--prompt') + 1]
  assert.ok(prompt.length < 4096)
  assert.ok(prompt.startsWith('/mte-flow g'))
})

test('start run falls back to the host agent.launch only when the orca CLI is missing', async () => {
  const { deps, calls } = stubs({
    exec: async (file) => {
      if (file === '/App/Resources/bin/orca') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { code: 0, stdout: '{"claimed":false}', stderr: '' }
    }
  })
  const result = await startRun(deps, { goal: 'x' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.find((c) => c.method === 'agent.launch').params, { workspaceId: 'wt-1', agent: 'claude', prompt: '/mte-flow x' })
  const failing = stubs({ exec: async (file) => (file === 'mte' ? { code: 0, stdout: '{"claimed":false}', stderr: '' } : { code: 1, stdout: '', stderr: 'launch refused' }) })
  const res = await startRun(failing.deps, { goal: 'x' })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /launch refused/)
  assert.ok(!failing.calls.some((c) => c.method === 'agent.launch'))
})

test('start run with an opencode worker drops effort', async () => {
  const { deps, calls } = stubs({
    settings: { plannerAgent: 'opencode', workerAgent: 'opencode', workerModel: 'qwen3.6-flash', workerEffort: 'high' }
  })
  const result = await startRun(deps, { goal: 'x' })
  assert.equal(result.ok, true)
  const pin = calls.find((c) => c.kind === 'exec' && c.args[0] === 'pin')
  assert.deepEqual(pin.args, ['pin', 'set', '--agent', 'opencode', '--model', 'qwen3.6-flash'])
  assert.ok(!pin.args.includes('--effort'))
  assert.equal(calls.find((c) => c.args?.[0] === 'agent').args[3], 'opencode')
})

test('start run: planner overrides from the form beat the settings', async () => {
  const { deps, calls } = stubs({ settings: { plannerAgent: 'claude', workerAgent: 'claude' } })
  await startRun(deps, { goal: 'x', plannerAgent: 'opencode' })
  assert.equal(calls.find((c) => c.args?.[0] === 'agent').args[3], 'opencode')
  assert.deepEqual(calls.find((c) => c.kind === 'exec' && c.args[0] === 'install').args, ['install', '--agents', 'claude,opencode'])
})

test('start run skips the pin when no worker model is set', async () => {
  const { deps, calls } = stubs()
  const result = await startRun(deps, { goal: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.pinned, false)
  assert.ok(!calls.some((c) => c.kind === 'exec' && c.args[0] === 'pin'))
})

test('start run stops at the first failing step and never launches', async () => {
  const exec = async () => ({ code: 2, stdout: '', stderr: 'boom' })
  const { deps, calls } = stubs({ exec })
  const result = await startRun(deps, { goal: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.error.stage, 'planner')
  assert.match(result.error.message, /boom/)
  assert.ok(!calls.some((c) => c.args?.[0] === 'agent'))
})

test('missing mte binary yields the mte_missing error with install instructions', async () => {
  const exec = async () => {
    throw Object.assign(new Error('spawn mte ENOENT'), { code: 'ENOENT' })
  }
  const { deps, calls } = stubs({ exec })
  for (const result of [await startRun(deps, { goal: 'x' }), await installInWorkspace(deps)]) {
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'mte_missing')
    assert.match(result.error.message, /npm link/)
    assert.doesNotMatch(result.error.message, /npm i\s+-g/)
  }
  assert.ok(!calls.some((c) => c.args?.[0] === 'agent' || c.method === 'agent.launch'))
  assert.deepEqual(await checkMte(deps, { mteBin: 'mte' }).then((r) => r.missing), true)
})

test('empty goal and missing workspace are refused before running anything', async () => {
  const a = stubs()
  assert.equal((await startRun(a.deps, { goal: '  ' })).error.code, 'empty_goal')
  const b = stubs()
  b.deps.host.call = async (m) => (m === 'workspace.readContext' ? null : {})
  assert.equal((await startRun(b.deps, { goal: 'x' })).error.code, 'no_workspace')
  assert.equal(a.calls.length, 0)
})

test('orchestration listing maps the stock CLI JSON and counts active workers', async () => {
  const exec = async (file, args) => {
    const out = args.includes('worker-list')
      ? { ok: true, result: { workers: [
          { dispatchId: 'd1', taskId: 't1', agent: 'claude/sonnet', state: 'ready', outcome: 'in_progress', liveness: 'live', workspace: 'r::/p' },
          { dispatchId: 'd2', taskId: 't2', agent: 'claude/sonnet', state: 'done', outcome: 'succeeded', liveness: 'live', workspace: 'r::/q' }
        ] } }
      : { ok: true, result: { runs: [{ id: 'run_1', objective: 'goal' }] } }
    return { code: 0, stdout: JSON.stringify(out), stderr: '' }
  }
  const listing = await listOrchestration({ exec })
  assert.equal(listing.error, null)
  assert.equal(listing.runs[0].id, 'run_1')
  assert.deepEqual(statusText(listing.workers), { n: 1, text: 'MTE 1', tone: 'accent' })
  assert.equal(statusText([]).text, 'MTE')
})

test('orchestration listing reports a missing orca CLI instead of throwing', async () => {
  const exec = async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const listing = await listOrchestration({ exec })
  assert.equal(listing.error.code, 'orca_missing')
  assert.deepEqual(listing.workers, [])
})

test('install always wires both agents, whatever the settings say', async () => {
  for (const settings of [{}, { plannerAgent: 'opencode', workerAgent: 'opencode' }, { plannerAgent: 'claude', workerAgent: 'claude' }]) {
    const { deps, calls } = stubs({ settings })
    assert.equal((await installInWorkspace(deps)).ok, true)
    assert.deepEqual(calls.find((c) => c.kind === 'exec').args, ['install', '--agents', 'claude,opencode'])
  }
})

test('home dir, non-git and unfocused targets are refused at press time, before running anything', async () => {
  const home = stubs({ ws: { ...WS, path: '/home/me' } })
  for (const run of [() => installInWorkspace(home.deps), () => startRun(home.deps, { goal: 'x' })]) {
    const r = await run()
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'workspace_is_home')
  }
  const plain = stubs({ gitPaths: [] })
  for (const run of [() => installInWorkspace(plain.deps), () => startRun(plain.deps, { goal: 'x' })]) {
    assert.equal((await run()).error.code, 'not_git_repo')
  }
  assert.equal(home.calls.filter((c) => c.kind === 'exec').length, 0)
  assert.equal(plain.calls.filter((c) => c.kind === 'exec').length, 0)
})

test('the focused workspace is re-read on every press, never cached', async () => {
  const a = { ...WS, id: 'wt-a', path: '/repo/a' }
  const b = { ...WS, id: 'wt-b', path: '/repo/b' }
  let current = a
  const { deps, calls } = stubs()
  deps.host.call = async (method) =>
    method === 'workspace.readContext'
      ? { workspaceId: current.id, branch: 'feat', displayName: 'feat', terminals: [] }
      : { workspaces: [a, b] }
  const cwdOf = () => calls.filter((c) => c.kind === 'exec').at(-1).cwd
  await installInWorkspace(deps)
  assert.equal(cwdOf(), '/repo/a')
  current = b
  await installInWorkspace(deps)
  assert.equal(cwdOf(), '/repo/b')
})

test('orca CLI and profile are derived from the hosting app (execPath + install path)', () => {
  const cli = resolveOrcaCli({
    execPath: '/Apps/Orca 2.app/Contents/MacOS/Orca',
    platform: 'darwin',
    moduleUrl: 'file:///Users/me/Library/Application%20Support/orca-stock/plugins/local.mte-flow/' + 'a'.repeat(64) + '/worker/lib.mjs',
    exists: (p) => p === '/Apps/Orca 2.app/Contents/Resources/bin/orca'
  })
  assert.deepEqual(cli, {
    bin: '/Apps/Orca 2.app/Contents/Resources/bin/orca',
    env: { ORCA_USER_DATA_PATH: '/Users/me/Library/Application Support/orca-stock' }
  })
  const linux = resolveOrcaCli({
    execPath: '/opt/Orca/orca',
    platform: 'linux',
    moduleUrl: 'file:///home/me/.config/orca/plugins/local.mte-flow/' + 'b'.repeat(64) + '/worker/lib.mjs',
    exists: (p) => p === '/opt/Orca/resources/bin/orca-ide'
  })
  assert.equal(linux.bin, '/opt/Orca/resources/bin/orca-ide')
  assert.equal(linux.env.ORCA_USER_DATA_PATH, '/home/me/.config/orca')
  // dev-linked plugin (outside <userData>/plugins) and missing bundle: PATH `orca`, default profile
  assert.deepEqual(
    resolveOrcaCli({ execPath: '/x/Orca', platform: 'darwin', moduleUrl: 'file:///dev/plugin/worker/lib.mjs', exists: () => false }),
    { bin: 'orca', env: {} }
  )
})

test('start run with a live planner claim does not release it: it reports the holder', async () => {
  const { deps, calls } = stubs({ claim: { claimed: true, terminalHandle: 'term_9', claimedAt: '2026-01-01T00:00:00Z' } })
  const result = await startRun(deps, { goal: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'planner_claimed')
  assert.match(result.error.message, /terminal term_9/)
  assert.equal(result.claim.holder, 'terminal term_9')
  const execs = calls.filter((c) => c.kind === 'exec')
  assert.deepEqual(execs.map((c) => c.args.slice(0, 2).join(' ')), ['planner show'])
})

test('Replace path releases the claim, then launches, in order', async () => {
  const { deps, calls } = stubs({ claim: { claimed: true, sessionId: 's1' }, settings: { workerModel: 'm' } })
  const result = await startRun(deps, { goal: 'x', replace: true })
  assert.equal(result.ok, true)
  assert.deepEqual(
    calls.filter((c) => c.kind === 'exec').map((c) => c.args.slice(0, 2).join(' ')),
    ['planner show', 'install --agents', 'pin set', 'planner release', 'agent launch']
  )
})

test('checkMte: a non-zero --version exit is unusable, with the stderr first line', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING\nmore' })
  const res = await checkMte({ exec }, { mteBin: 'mte' })
  assert.equal(res.missing, true)
  assert.equal(res.unusable, true)
  assert.match(res.message, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/)
  assert.doesNotMatch(res.message, /more/)
  assert.deepEqual(await checkMte({ exec: async () => ({ code: 0, stdout: '0.1.0', stderr: '' }) }, { mteBin: 'mte' }), { missing: false })
})
