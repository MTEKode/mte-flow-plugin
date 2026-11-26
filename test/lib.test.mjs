import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBootstrapPrompt,
  checkMte,
  compareVersions,
  createPollPoster,
  dismissDepthReminder,
  ensureSetup,
  harnessList,
  isDepthReminderDismissed,
  REQUIRED_MTE_VERSION,
  tarballUrl,
  installInWorkspace,
  launchArgs,
  pinArgs,
  listHarnesses,
  listModels,
  listOrchestration,
  listOrchestrators,
  listAttention,
  plannerHome,
  releaseWorker,
  readClaim,
  resolveChoices,
  setupNote,
  parseGithubRepo,
  resolveOrcaCli,
  searchGoal,
  startRun,
  statusText,
  windowsSpawnPlan,
  winQuote,
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

test('windows: npm .cmd shims run through a quoted cmd.exe line, .exe files directly, and a missing command is null', () => {
  const env = { Path: 'C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.com;.exe;.bat;.cmd', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
  const files = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\mte.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\mte']
  const plan = (file, args) => windowsSpawnPlan(file, args, { env, exists: (p) => files.includes(p) })
  assert.deepEqual(plan('node', ['--version']), { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['--version'], verbatim: false })
  // the extensionless `mte` next to mte.cmd is a shell script for Git Bash: never picked
  assert.deepEqual(plan('mte', ['--version']), { command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '"C:\\Users\\me\\AppData\\Roaming\\npm\\mte.cmd ^^^"--version^^^""'], verbatim: true })
  assert.match(plan('npm', ['i', '-g', 'https://x/y.tgz']).args[3], /^"C:\\Program\^ Files\\nodejs\\npm\.cmd /)
  assert.equal(plan('agy', ['models']), null)
  // user text can never break out of its argument
  assert.equal(winQuote('a"b & calc.exe'), '^^^"a\\^^^"b^^^ ^^^&^^^ calc.exe^^^"')
  assert.equal(winQuote('ends with \\'), '^^^"ends^^^ with^^^ \\\\^^^"')
})

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
    ['mte planner show', 'mte install', 'mte pin set', '/App/Resources/bin/orca agent launch']
  )
  assert.deepEqual(seq[0].args, ['planner', 'show', '--json'])
  assert.deepEqual(seq[1].args, ['install'])
  assert.equal(seq[1].cwd, '/repo/feat')
  assert.deepEqual(seq[2].args, ['pin', 'set', '--agent', 'claude', '--model', 'claude-sonnet-5-5', '--effort', 'high'])
  assert.equal(seq[2].cwd, '/repo/feat')
  assert.deepEqual(seq[3].args, [
    'agent', 'launch', '--agent', 'claude', '--worktree', 'path:/repo/feat', '--surface', 'chat', '--focus',
    '--prompt', `/mte-flow build the thing\n\n${setupNote({ plannerAgent: 'claude', plannerModel: '', workerAgent: 'claude', workerModel: 'claude-sonnet-5-5', workerEffort: 'high', qaAgent: 'claude' })}`, '--json'
  ])
  assert.deepEqual(seq[3].env, { ORCA_USER_DATA_PATH: '/ud' })
  assert.ok(!calls.some((c) => c.method === 'agent.launch'))
})

test('start run passes the planner model to the launch and keeps the prompt under the cap', async () => {
  const { deps, calls } = stubs({ settings: { plannerModel: 'claude-opus-5-5' } })
  await startRun(deps, { goal: 'g'.repeat(9000) })
  const launch = calls.find((c) => c.args?.[0] === 'agent')
  assert.deepEqual(launch.args.slice(launch.args.indexOf('--model'), launch.args.indexOf('--model') + 2), ['--model', 'claude-opus-5-5'])
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
  assert.deepEqual(calls.find((c) => c.method === 'agent.launch').params, { workspaceId: 'wt-1', agent: 'claude', prompt: `/mte-flow x\n\n${setupNote({ plannerAgent: 'claude', workerAgent: 'claude', qaAgent: 'claude' })}` })
  const failing = stubs({ exec: async (file) => (file === 'mte' ? { code: 0, stdout: '{"claimed":false}', stderr: '' } : { code: 1, stdout: '', stderr: 'launch refused' }) })
  const res = await startRun(failing.deps, { goal: 'x' })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /launch refused/)
  assert.ok(!failing.calls.some((c) => c.method === 'agent.launch'))
})

test('start run: planner overrides from the form beat the settings', async () => {
  const { deps, calls } = stubs({ settings: { plannerAgent: 'claude', workerAgent: 'claude' } })
  await startRun(deps, { goal: 'x', plannerAgent: 'antigravity' })
  assert.equal(calls.find((c) => c.args?.[0] === 'agent').args[3], 'antigravity')
  assert.deepEqual(calls.find((c) => c.kind === 'exec' && c.args[0] === 'install').args, ['install'])
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
    assert.ok(result.error.message.includes(`npm i -g ${tarballUrl(REQUIRED_MTE_VERSION)}`), result.error.message)
    assert.doesNotMatch(result.error.message, /@mtekode\/mte/)
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

const fullWorker = (dispatchId, runId, outcome, verdict, ws = 'r::/repo/wt') => ({
  dispatchId, taskId: `t-${dispatchId}`, runId, workerState: 'ready',
  projection: { stage: { worker: 'ready', activity: 'unknown' }, outcome, liveness: { verdict }, workspace: { id: ws }, attention: { requiresAction: false } }
})

test('orchestration listing keeps only running workers: finished, exited and dead ones are dropped', async () => {
  const seen = []
  const exec = async (file, args) => {
    seen.push(args)
    const out = args.includes('worker-list')
      ? { ok: true, result: { workers: [fullWorker('d1', 'run_1', 'in_progress', 'alive'), fullWorker('d2', 'run_1', 'succeeded', 'alive'), fullWorker('d3', 'run_1', 'in_progress', 'exited'), fullWorker('d4', 'run_2', 'in_progress', 'dead')] } }
      : { ok: true, result: { runs: [{ id: 'run_1', objective: 'goal' }] } }
    return { code: 0, stdout: JSON.stringify(out), stderr: '' }
  }
  const listing = await listOrchestration({ exec })
  assert.equal(listing.error, null)
  assert.deepEqual(listing.workers.map((w) => [w.dispatchId, w.runId, w.state, w.workspace]), [['d1', 'run_1', 'ready', 'r::/repo/wt']])
  assert.ok(seen.find((a) => a.includes('worker-list')).join(' ').includes('--terminal-state active'))
  assert.deepEqual(statusText(listing.workers), { n: 1, text: 'MTE 1', tone: 'accent', attention: 0 })
  assert.equal(statusText([]).text, 'MTE')
})

test('AC2: active workers needing attention turn the status tone to warning', () => {
  const w = (attention) => ({ dispatchId: 'd', taskId: 't', runId: 'r', state: 'ready', activity: 'unknown', outcome: 'in_progress', liveness: 'alive', workspace: 'r::/p', attention })
  assert.deepEqual(statusText([w(true), w(false), w(true)]), { n: 3, text: 'MTE 3', tone: 'warning', attention: 2 })
  assert.deepEqual(statusText([w(false)]), { n: 1, text: 'MTE 1', tone: 'accent', attention: 0 })
  assert.deepEqual(statusText([]), { n: 0, text: 'MTE', tone: 'neutral', attention: 0 })
})

test('AC1: the poll poster posts state.changed only when the observable state changed', () => {
  const posts = []
  const post = createPollPoster(() => posts.push(1))
  const state = [[{ dispatchId: 'd1' }], { status: 'idle', message: '' }, 'MTE 1', 'accent', null]
  assert.equal(post(state), true)
  assert.equal(post(JSON.parse(JSON.stringify(state))), false)
  assert.equal(post(state), false)
  assert.equal(posts.length, 1)
  assert.equal(post([[{ dispatchId: 'd1' }, { dispatchId: 'd2' }], { status: 'idle', message: '' }, 'MTE 2', 'accent', null]), true)
  assert.equal(posts.length, 2)
})

test('orchestrators: workers are grouped under their run and tied to the planner that started it; a planner without workers still shows; closed planners are forgotten', async () => {
  const mem = new Map([['launches', {
    s1: { goal: 'ship it', workspacePath: '/repo', plannerAgent: 'claude', plannerModel: 'opus', workerAgent: 'antigravity', workerModel: 'p/m' },
    s2: { goal: 'second goal', workspacePath: '/other', plannerAgent: 'antigravity', plannerModel: '' },
    gone: { goal: 'closed', workspacePath: '/x', plannerAgent: 'claude' }
  }]])
  const { deps } = stubs({
    exec: async (file, args) => {
      const ok = (result) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
      if (args.includes('worker-list')) return ok({ workers: [fullWorker('d1', 'run_1', 'in_progress', 'alive'), fullWorker('d2', 'run_1', 'in_progress', 'alive'), fullWorker('d9', 'run_9', 'in_progress', 'alive', 'r2::/elsewhere/wt')] })
      if (args.includes('run-list')) return ok({ runs: [{ id: 'run_1', objective: 'Ship the thing' }] })
      if (args[0] === 'agent' && args[1] === 'show') return ok({ places: args[2] === 'gone' ? [] : [{ kind: 'chat' }] })
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const base = deps.exec
  deps.exec = async (file, args, opts) => (args[0] === 'planner' ? { code: 0, stdout: JSON.stringify(opts?.cwd === '/repo/wt' ? { claimed: true, sessionId: 's1' } : { claimed: false }), stderr: '' } : base(file, args, opts))
  deps.storage = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v) }
  const { orchestrators, activeWorkers, error } = await listOrchestrators(deps)
  assert.equal(error, null)
  assert.equal(activeWorkers, 3)
  assert.deepEqual(orchestrators.map((o) => [o.id, o.title, o.launch?.plannerModel ?? null, o.workers.map((w) => w.dispatchId)]), [
    ['run_1', 'Ship the thing', 'opus', ['d1', 'd2']],
    ['run_9', 'run_9', null, ['d9']],
    ['s2', 'second goal', '', []]
  ])
  assert.deepEqual(Object.keys(mem.get('launches')), ['s1', 's2'])
})

test('start run records the launch under the planner session and tells the planner the setup in the prompt', async () => {
  const mem = new Map()
  const { deps, calls } = stubs({ settings: { plannerAgent: 'claude', plannerModel: 'opus', plannerEffort: 'high', workerAgent: 'antigravity', workerModel: 'p/m', workerEffort: '' } })
  const base = deps.exec
  deps.exec = async (file, args, opts) => (args[0] === 'agent' && args[1] === 'launch' ? (calls.push({ kind: 'exec', file, args }), { code: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'structured', handle: 'structured-agent-session-abc', sessionId: 'abc' } } }), stderr: '' }) : base(file, args, opts))
  deps.storage = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v) }
  const result = await startRun(deps, { goal: 'build it' })
  assert.equal(result.ok, true)
  const launch = mem.get('launches').abc
  assert.deepEqual([launch.goal, launch.workspacePath, launch.plannerModel, launch.workerAgent, launch.workerModel, launch.workerEffort], ['build it', '/repo/feat', 'opus', 'antigravity', 'p/m', ''])
  const prompt = calls.find((c) => c.args?.[1] === 'launch').args.at(-2)
  assert.ok(prompt.startsWith('/mte-flow build it\n\n(Run setup'))
  assert.match(prompt, /Orchestrator: claude · opus · high\. Coder workers: antigravity · p\/m\. QA and validator workers: claude · default model\. State all three/)
  assert.match(setupNote({ plannerAgent: 'antigravity', plannerModel: '', plannerEffort: 'high', workerAgent: 'claude', workerModel: '' }), /Orchestrator: antigravity · default model\. Coder workers: claude · default model\./)
})

test('orchestration listing reports a missing orca CLI instead of throwing', async () => {
  const exec = async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const listing = await listOrchestration({ exec })
  assert.equal(listing.error.code, 'orca_missing')
  assert.deepEqual(listing.workers, [])
})

test('install wires the workspace the same way whatever the settings say', async () => {
  for (const settings of [{}, { plannerAgent: 'antigravity', workerAgent: 'antigravity' }, { plannerAgent: 'claude', workerAgent: 'claude' }]) {
    const { deps, calls } = stubs({ settings })
    assert.equal((await installInWorkspace(deps)).ok, true)
    assert.deepEqual(calls.find((c) => c.kind === 'exec').args, ['install'])
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
    resolveOrcaCli({ execPath: '/x/Orca', platform: 'darwin', moduleUrl: 'file:///dev/mte-flow/worker/lib.mjs', exists: () => false }),
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

test('a claim whose session Orca reports closed is released without asking; an open one still blocks', async () => {
  const run = async (places) => {
    const calls = []
    const { deps } = stubs({
      exec: async (file, args) => {
        calls.push(args.slice(0, 2).join(' '))
        if (args[0] === 'planner' && args[1] === 'show') return { code: 0, stdout: JSON.stringify({ claimed: true, sessionId: 's1' }), stderr: '' }
        if (args[0] === 'agent' && args[1] === 'show') return { code: 0, stdout: JSON.stringify({ ok: true, result: { orcaSessionId: args[2], places } }), stderr: '' }
        if (args[0] === 'agent') return { code: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'structured', handle: 'h' } } }), stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    return { result: await startRun(deps, { goal: 'x' }), calls }
  }
  const closed = await run([])
  assert.equal(closed.result.ok, true)
  assert.equal(closed.result.replacedStale, true)
  assert.deepEqual(closed.calls, ['planner show', 'agent show', 'install', 'planner release', 'agent launch'])
  const open = await run([{ kind: 'chat' }])
  assert.equal(open.result.error.code, 'planner_claimed')
  assert.deepEqual(open.calls, ['planner show', 'agent show'])
})

test('Replace path releases the claim, then launches, in order', async () => {
  const { deps, calls } = stubs({ claim: { claimed: true, sessionId: 's1' }, settings: { workerModel: 'm' } })
  const result = await startRun(deps, { goal: 'x', replace: true })
  assert.equal(result.ok, true)
  assert.deepEqual(
    calls.filter((c) => c.kind === 'exec').map((c) => c.args.slice(0, 2).join(' ')),
    ['planner show', 'install', 'pin set', 'planner release', 'agent launch']
  )
})

test('checkMte: a non-zero --version exit is unusable, with the stderr first line', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING\nmore' })
  const res = await checkMte({ exec }, { mteBin: 'mte' })
  assert.equal(res.missing, true)
  assert.equal(res.unusable, true)
  assert.match(res.message, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/)
  assert.doesNotMatch(res.message, /more/)
  assert.deepEqual(await checkMte({ exec: async () => ({ code: 0, stdout: `${REQUIRED_MTE_VERSION}\n`, stderr: '' }) }, { mteBin: 'mte' }), { missing: false, version: REQUIRED_MTE_VERSION, required: REQUIRED_MTE_VERSION, drift: false })
})

test('AC3: checkMte reports the detected version and drift below REQUIRED', async () => {
  const newer = await checkMte({ exec: async () => ({ code: 0, stdout: '0.9.1\n', stderr: '' }) }, { mteBin: 'mte' })
  assert.deepEqual(newer, { missing: false, version: '0.9.1', required: REQUIRED_MTE_VERSION, drift: false })
  const older = await checkMte({ exec: async () => ({ code: 0, stdout: 'mte 0.7.0', stderr: '' }) }, { mteBin: 'mte' })
  assert.deepEqual([older.version, older.drift], ['0.7.0', true])
})

test('AC4: a checkMte failure that is not ENOENT is reported, never silently healthy', async () => {
  const res = await checkMte({ exec: async () => { throw new Error('spawn mte EPERM') } }, { mteBin: 'mte' })
  assert.equal(res.missing, true)
  assert.equal(res.unusable, true)
  assert.match(res.message, /EPERM/)
  assert.match(res.message, /npm i -g/)
})

test('AC3: harness.list reports a failed listing instead of swallowing it', async () => {
  const gone = { exec: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, orcaCli: { bin: 'orca', env: {} } }
  const res = await harnessList(gone)
  assert.deepEqual(res.harnesses, [])
  assert.match(res.error, /orca CLI/)
  const { deps } = stubs({ exec: async () => orcaOut({ agents: [{ id: 'claude', name: 'Claude', default: true }] }) })
  assert.deepEqual(await harnessList(deps), { harnesses: [{ id: 'claude', name: 'Claude', default: true }], error: null })
})

test('AC3: a failed models probe surfaces as error', async () => {
  const { deps } = stubs({ exec: async () => ({ code: 1, stdout: '', stderr: 'agy: account offline\nnoise' }) })
  const res = await listModels(deps, { agent: 'antigravity' })
  assert.deepEqual(res.models, [])
  assert.match(res.error, /account offline/)
  const enoent = stubs({ exec: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } })
  assert.match((await listModels(enoent.deps, { agent: 'antigravity' })).error, /not on PATH/)
})

test('AC5: readClaim reports a corrupt claim as an actionable error (T-0004 exit)', async () => {
  const { deps } = stubs({ exec: async () => ({ code: 1, stdout: '', stderr: 'mte: claim file .mte/planner.json is corrupt: expected \'{\'; run `mte planner release` to clear it' }) })
  const res = await readClaim(deps, { mteBin: 'mte' }, '/repo/feat')
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'mte_failed')
  assert.match(res.error.message, /corrupt/)
})

test('AC6: a settings change re-seeds the choices; unchanged settings keep stored overrides', async () => {
  const mem = new Map()
  const storage = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v) }
  const s1 = { plannerAgent: 'claude', workerModel: 'sonnet' }
  assert.deepEqual(await resolveChoices(storage, s1), {})
  assert.deepEqual(mem.get('settingsSeed'), s1)
  await storage.set('choices', { plannerAgent: 'antigravity' })
  assert.deepEqual(await resolveChoices(storage, s1), { plannerAgent: 'antigravity' })
  const s2 = { ...s1, workerModel: 'opus' }
  assert.deepEqual(await resolveChoices(storage, s2), {})
  assert.deepEqual(mem.get('settingsSeed'), s2)
  assert.deepEqual(mem.get('choices'), {})
})

// ---- first-run setup ----

const TARBALL = tarballUrl(REQUIRED_MTE_VERSION)

/** In-memory plugin storage plus an exec stub driven by `env` ({ mte, node, npm, npmInstall }); records every call. */
function setupStubs({ mte = null, node = 'v24.14.0', npm = '10.9.0', npmInstall = { code: 0 }, userInstall = { code: 0 }, storage = new Map() } = {}) {
  const calls = []
  let mteVersion = mte
  const deps = {
    storage: { get: async (k) => storage.get(k) ?? null, set: async (k, v) => void storage.set(k, v) },
    host: { settings: async () => ({}) },
    progress: (m) => calls.push({ progress: m }),
    exec: async (file, args) => {
      calls.push({ file, args })
      const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      if (file === 'mte' && args[0] === '--version') {
        if (mteVersion === null) throw enoent()
        return { code: 0, stdout: `${mteVersion}\n`, stderr: '' }
      }
      if (file === 'mte' && args[0] === 'install') return { code: 0, stderr: '', stdout: '', ...userInstall }
      if (file === 'node') {
        if (node === null) throw enoent()
        return { code: 0, stdout: `${node}\n`, stderr: '' }
      }
      if (file === 'npm' && args[0] === '--version') {
        if (npm === null) throw enoent()
        return { code: 0, stdout: `${npm}\n`, stderr: '' }
      }
      if (file === 'npm') {
        const res = { code: 0, stdout: '', stderr: '', ...npmInstall }
        if (res.code === 0) mteVersion = REQUIRED_MTE_VERSION
        return res
      }
      throw new Error(`unexpected exec ${file}`)
    }
  }
  return { deps, calls, storage }
}
const npmInstalls = (calls) => calls.filter((c) => c.file === 'npm' && c.args?.[0] === 'i')

test('version sites stay aligned: REQUIRED === CLI package.json === plugin manifest, and every install URL derives from it', async () => {
  const { readFile } = await import('node:fs/promises')
  const cliPkg = JSON.parse(await readFile(new URL('../packages/mte/package.json', import.meta.url), 'utf8'))
  const manifestText = await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')
  const readmeText = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const libText = await readFile(new URL('../worker/lib.mjs', import.meta.url), 'utf8')
  assert.equal(REQUIRED_MTE_VERSION, cliPkg.version, 'packages/mte/package.json must match REQUIRED_MTE_VERSION')
  assert.equal(REQUIRED_MTE_VERSION, JSON.parse(manifestText).version, 'orca-plugin.json must match REQUIRED_MTE_VERSION')
  const mteBin = JSON.parse(manifestText).contributes.settings.find((s) => s.key === 'mteBin')
  assert.ok(mteBin.description.includes(TARBALL), 'manifest mteBin description must carry the REQUIRED tarball URL')
  assert.ok(readmeText.includes(TARBALL), 'README install commands must carry the REQUIRED tarball URL')
  // no stale tarball URL may survive anywhere the person reads it
  for (const [name, text] of [['orca-plugin.json', manifestText], ['README.md', readmeText], ['worker/lib.mjs', libText]]) {
    for (const m of text.matchAll(/releases\/download\/mte-v([\d.]+)\/mtekode-mte-([\d.]+)\.tgz/g)) {
      assert.deepEqual([m[1], m[2]], [REQUIRED_MTE_VERSION, REQUIRED_MTE_VERSION], `${name} references tarball ${m[1]}, expected ${REQUIRED_MTE_VERSION}`)
    }
  }
  assert.equal(tarballUrl('1.2.3'), 'https://github.com/MTEKode/mte-flow-plugin/releases/download/mte-v1.2.3/mtekode-mte-1.2.3.tgz')
  assert.ok(compareVersions('0.2.0', REQUIRED_MTE_VERSION) < 0 && compareVersions(REQUIRED_MTE_VERSION, REQUIRED_MTE_VERSION) === 0 && compareVersions('0.10.0', '0.9.0') > 0)
})

test('setup: mte missing -> npm i -g <exact tarball>, then mte install --user, then remembered', async () => {
  const { deps, calls, storage } = setupStubs({ mte: null })
  const res = await ensureSetup(deps, { force: true })
  assert.deepEqual([res.ok, res.installed, res.version], [true, true, REQUIRED_MTE_VERSION])
  assert.deepEqual(npmInstalls(calls).map((c) => c.args), [['i', '-g', TARBALL]])
  assert.deepEqual(calls.filter((c) => c.args?.[0] === 'install').map((c) => c.args), [['install', '--user']])
  assert.ok(storage.has(`setup:${REQUIRED_MTE_VERSION}`))
  assert.ok(calls.some((c) => c.progress))
})

test('setup: older mte -> same install; current mte -> no npm install but still installs the user skill', async () => {
  const old = setupStubs({ mte: '0.2.0' })
  assert.equal((await ensureSetup(old.deps, { force: true })).installed, true)
  assert.deepEqual(npmInstalls(old.calls).map((c) => c.args), [['i', '-g', TARBALL]])

  const current = setupStubs({ mte: REQUIRED_MTE_VERSION })
  const res = await ensureSetup(current.deps)
  assert.deepEqual([res.ok, res.installed, res.version], [true, false, REQUIRED_MTE_VERSION])
  assert.equal(npmInstalls(current.calls).length, 0)
  assert.ok(current.calls.some((c) => c.args?.join(' ') === 'install --user'))
})

test('setup: node < 24, node missing or npm missing -> error and no npm install', async () => {
  for (const [opts, code] of [[{ node: 'v22.11.0' }, 'node_old'], [{ node: null }, 'node_missing'], [{ npm: null }, 'npm_missing']]) {
    const { deps, calls, storage } = setupStubs({ mte: null, ...opts })
    const res = await ensureSetup(deps, { force: true })
    assert.equal(res.ok, false)
    assert.equal(res.error.code, code)
    assert.match(res.error.message, /Node|npm/)
    assert.equal(npmInstalls(calls).length, 0)
    assert.equal(storage.size, 0)
  }
})

test('setup: a failing npm surfaces its error text, mentions no sudo retry and is not remembered', async () => {
  const { deps, calls, storage } = setupStubs({ mte: null, npmInstall: { code: 243, stderr: 'npm error code EACCES\nnpm error path /usr/local/lib' } })
  const res = await ensureSetup(deps, { force: true })
  assert.equal(res.error.code, 'npm_failed')
  assert.match(res.error.message, /EACCES/)
  assert.match(res.error.message, /never use sudo/)
  assert.equal(npmInstalls(calls).length, 1)
  assert.ok(calls.every((c) => c.file !== 'sudo'))
  assert.equal(storage.size, 0)
})

test('setup runs once per mte version; force (Repair setup) runs it again', async () => {
  const { deps, calls } = setupStubs({ mte: null })
  assert.equal((await ensureSetup(deps, { force: true })).ok, true)
  const after = calls.length
  const again = await ensureSetup(deps)
  assert.deepEqual([again.ok, again.skipped, again.version], [true, true, REQUIRED_MTE_VERSION])
  // the skipped activation only probes the CLI version: it installs nothing
  assert.deepEqual(calls.slice(after).filter((c) => c.file === 'npm' || c.args?.[0] === 'install'), [])
  assert.equal(calls.slice(after).length, 1, 'only the version probe runs')
  const forced = await ensureSetup(deps, { force: true })
  assert.equal(forced.skipped, undefined)
  assert.ok(calls.length > after)
  // a different stored version does not count
  const other = setupStubs({ mte: REQUIRED_MTE_VERSION, storage: new Map([['setup:0.2.0', { at: 'x' }]]) })
  assert.equal((await ensureSetup(other.deps)).skipped, undefined)
})

test('AC3: a skipped setup reports the detected version (newer manual installs included)', async () => {
  const { deps, calls } = setupStubs({ mte: '0.9.0', storage: new Map([[`setup:${REQUIRED_MTE_VERSION}`, { at: 'x' }]]) })
  const res = await ensureSetup(deps)
  assert.deepEqual([res.ok, res.skipped, res.version], [true, true, '0.9.0'])
  assert.equal(calls.length, 1, 'read-only --version probe only')
})

test('AC7: activation never runs npm unattended: needs-consent, a dismissal stays silent, force (Run/Repair setup) installs', async () => {
  const ask = setupStubs({ mte: null })
  const res = await ensureSetup(ask.deps)
  assert.deepEqual([res.ok, res.needsConsent], [true, true])
  assert.match(res.message, /npm i -g/)
  assert.match(res.message, /Run setup/)
  assert.equal(npmInstalls(ask.calls).length, 0)
  assert.equal(ask.storage.size, 0)
  const declined = setupStubs({ mte: null, storage: new Map([['setupDeclined', { version: REQUIRED_MTE_VERSION }]]) })
  const d = await ensureSetup(declined.deps)
  assert.deepEqual([d.ok, d.needsConsent, d.declined], [true, undefined, true])
  assert.equal(npmInstalls(declined.calls).length, 0)
  const forced = setupStubs({ mte: null })
  assert.equal((await ensureSetup(forced.deps, { force: true })).ok, true)
  assert.equal(npmInstalls(forced.calls).length, 1)
})

test('depth reminder dismissal is stored', async () => {
  const storage = new Map()
  const api = { get: async (k) => storage.get(k) ?? null, set: async (k, v) => void storage.set(k, v) }
  assert.equal(await isDepthReminderDismissed(api), false)
  await dismissDepthReminder(api)
  assert.equal(await isDepthReminderDismissed(api), true)
})

test('manifest defaults: claude planner, claude worker, sonnet model, no effort; storage declared', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  const defaults = Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s.default]))
  assert.deepEqual([defaults.plannerAgent, defaults.workerAgent, defaults.workerModel, defaults.workerEffort], ['claude', 'claude', 'sonnet', ''])
  assert.ok(manifest.capabilities.some((c) => c.kind === 'storage:own'))
  assert.equal(manifest.contributes.panels[0].ui, 'html')
  assert.equal(defaults.plannerSurface, 'chat')
})

test('AC11: mte.startRun is gone from the manifest and the worker; mte.openPanel remains', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.contributes.commands.map((c) => c.id), ['mte.install', 'mte.openPanel'])
  const main = await readFile(new URL('../worker/main.mjs', import.meta.url), 'utf8')
  assert.ok(!main.includes('mte.startRun'), 'worker still references mte.startRun')
  assert.match(main, /commands\.register\('mte\.openPanel'/)
})

// ---- panel v2 ----

const orcaOut = (result) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
const ORCA = '/App/Resources/bin/orca'

test('AC2: launch argv for chat/terminal, with and without model/effort; effort needs model and a supporting agent', () => {
  const ws = { path: '/w' }
  const base = { plannerAgent: 'claude', plannerSurface: 'chat', plannerModel: '', plannerEffort: 'high' }
  assert.deepEqual(launchArgs(ws, base, 'P'), ['agent', 'launch', '--agent', 'claude', '--worktree', 'path:/w', '--surface', 'chat', '--focus', '--prompt', 'P'])
  assert.deepEqual(launchArgs(ws, { ...base, plannerSurface: 'terminal', plannerModel: 'opus' }, 'P'), ['agent', 'launch', '--agent', 'claude', '--worktree', 'path:/w', '--surface', 'terminal', '--focus', '--model', 'opus', '--effort', 'high', '--prompt', 'P'])
  assert.ok(!launchArgs(ws, { ...base, plannerAgent: 'someday', plannerModel: 'p/m' }, 'P').includes('--effort'))
})

test('AC2: start run uses the panel selection, reports a chat->terminal fallback and pins the worker selection', async () => {
  const { deps, calls } = stubs({
    exec: async (file, args, opts) => {
      calls.push({ kind: 'exec', file, args, cwd: opts?.cwd })
      if (file === ORCA) return orcaOut({ outcome: { kind: 'terminal', handle: 'term-9' } })
      if (args[0] === 'planner') return { code: 0, stdout: '{"claimed":false}', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const res = await startRun(deps, { goal: 'x', plannerAgent: 'claude', plannerSurface: 'chat', plannerModel: 'opus', plannerEffort: 'xhigh', workerAgent: 'antigravity', workerModel: 'a/b', workerEffort: 'low' })
  assert.equal(res.ok, true)
  assert.deepEqual([res.surface, res.fallback, res.terminalId], ['terminal', true, 'term-9'])
  const launch = calls.find((c) => c.file === ORCA)
  assert.deepEqual(launch.args.slice(0, 8), ['agent', 'launch', '--agent', 'claude', '--worktree', 'path:/repo/feat', '--surface', 'chat'])
  assert.ok(launch.args.join(' ').includes('--model opus --effort xhigh'))
  assert.deepEqual(calls.find((c) => c.args?.[0] === 'pin').args, ['pin', 'set', '--agent', 'antigravity', '--model', 'a/b', '--effort', 'low'])
})

test('AC2: a chat handle (orca_session_id) is returned as-is with no fallback', async () => {
  const { deps } = stubs({
    exec: async (file, args) => (file === ORCA ? orcaOut({ outcome: { kind: 'chat', handle: 'orca_session_id:abc' } }) : { code: 0, stdout: args[0] === 'planner' ? '{"claimed":false}' : '', stderr: '' })
  })
  const res = await startRun(deps, { goal: 'x' })
  assert.deepEqual([res.terminalId, res.surface, res.fallback], ['orca_session_id:abc', 'chat', false])
})

// real Orca 2 shape (T22 L3): chat sessions report kind 'structured' with a structured-agent-session handle
const STRUCTURED = { outcome: { kind: 'structured', handle: 'structured-agent-session-0d6c1f2e-1111-4222-8333-444455556666' } }

test('AC1: real structured outcome is the chat surface with no fallback; a terminal outcome for a chat request falls back', async () => {
  const run = (result) => stubs({ exec: async (file, args) => (file === ORCA ? orcaOut(result) : { code: 0, stdout: args[0] === 'planner' ? '{"claimed":false}' : '', stderr: '' }) })
  const chat = await startRun(run(STRUCTURED).deps, { goal: 'x', plannerSurface: 'chat' })
  assert.deepEqual([chat.surface, chat.fallback, chat.terminalId], ['chat', false, STRUCTURED.outcome.handle])
  const fb = await startRun(run({ outcome: { kind: 'terminal', handle: 'term-1' } }).deps, { goal: 'x', plannerSurface: 'chat' })
  assert.deepEqual([fb.surface, fb.fallback], ['terminal', true])
})

test('AC1: harness.list keeps only claude and antigravity; models.list seeds claude', async () => {
  const agents = { agents: [{ id: 'claude', name: 'Claude', default: true }, { id: 'aider', name: 'Aider', default: false }, { id: 'antigravity', name: 'Antigravity', default: false }] }
  const { deps } = stubs({ exec: async (file) => (file === ORCA ? orcaOut(agents) : { code: 0, stdout: '', stderr: '' }) })
  deps.storage = { get: async () => null, set: async () => undefined }
  assert.deepEqual(await listHarnesses(deps), [{ id: 'claude', name: 'Claude', default: true }, { id: 'antigravity', name: 'Antigravity', default: false }])
  const cl = await listModels(deps, { agent: 'claude' })
  assert.deepEqual(cl.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku'])
  assert.ok(cl.efforts.includes('max'))
})

test('antigravity models come from its own CLI; antigravity takes an effort', async () => {
  const out = { agy: 'Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n' }
  const { deps } = stubs({ exec: async (file) => ({ code: 0, stdout: out[file] ?? '', stderr: '' }) })
  const agy = await listModels(deps, { agent: 'antigravity' })
  assert.deepEqual(agy.models, [{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' }, { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' }])
  assert.deepEqual(agy.efforts, ['low', 'medium', 'high'])
  assert.ok(launchArgs({ path: '/w' }, { plannerAgent: 'antigravity', plannerSurface: 'chat', plannerModel: 'gemini-4-neon-high', plannerEffort: 'low' }, 'P').includes('--effort'))
})

test('~/.mte/models.json adds ids to its harness only, without duplicates; a missing or broken file adds none', async () => {
  const { deps } = stubs()
  deps.readFile = (p) => (assert.equal(p, '/home/me/.mte/models.json'), JSON.stringify({ claude: ['coder/qwen3.7-plus', 'sonnet', 'two words', 7], antigravity: 'nope' }))
  assert.deepEqual((await listModels(deps, { agent: 'claude' })).models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku', 'coder/qwen3.7-plus'])
  deps.readFile = () => { throw new Error('ENOENT') }
  assert.equal((await listModels(deps, { agent: 'claude' })).models.length, 4)
})

test('AC1: antigravity models are cached in storage', async () => {
  let probes = 0
  const mem = new Map()
  const { deps } = stubs({ exec: async () => (probes++, { code: 0, stdout: 'm\tM\n', stderr: '' }) })
  deps.storage = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v) }
  await listModels(deps, { agent: 'antigravity' })
  await listModels(deps, { agent: 'antigravity' })
  assert.equal(probes, 1)
})

function searchStubs({ linear, gh = {}, remote = 'git@github.com:MTEKode/mte-flow-plugin.git' } = {}) {
  const calls = []
  const { deps } = stubs({
    exec: async (file, args) => {
      calls.push([file, ...args])
      if (file === ORCA) return linear ? orcaOut(linear) : { code: 1, stdout: '', stderr: 'Linear not connected' }
      if (file === 'git') return remote ? { code: 0, stdout: remote + '\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }
      if (file === 'gh') {
        if (gh.missing) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return args[1] === 'prs' ? (gh.prs ?? { code: 0, stdout: '[{"number":7,"title":"Fix","url":"u7"}]', stderr: '' }) : (gh.issues ?? { code: 0, stdout: '[{"number":3,"title":"Bug","url":"u3"}]', stderr: '' })
      }
    }
  })
  return { deps, calls }
}
const LINEAR = { issues: [{ identifier: 'ENG-1', title: 'Linear one', url: 'lu' }] }

test('AC1: goal.search merges Linear + GitHub PRs/issues with the exact CLI calls', async () => {
  const { deps, calls } = searchStubs({ linear: LINEAR })
  const res = await searchGoal(deps, { q: 'fix' })
  assert.deepEqual(res.items.map((i) => `${i.kind}:${i.id}`), ['linear:ENG-1', 'pr:#7', 'issue:#3'])
  assert.deepEqual(res.hints, [])
  assert.deepEqual(calls.find((c) => c[0] === ORCA), [ORCA, 'linear', 'search', 'fix', '--limit', '5', '--workspace', 'all', '--json'])
  assert.deepEqual(calls.find((c) => c[0] === 'gh' && c[2] === 'prs'), ['gh', 'search', 'prs', 'fix', '--repo', 'MTEKode/mte-flow-plugin', '--limit', '5', '--json', 'number,title,url'])
  assert.deepEqual(calls.find((c) => c[2] === 'issues').slice(0, 3), ['gh', 'search', 'issues'])
})

test('AC1: goal.search degrades: no Linear, no gh, no remote -> that source omitted with a hint', async () => {
  const noLinear = await searchGoal(searchStubs({}).deps, { q: 'fix' })
  assert.deepEqual(noLinear.items.map((i) => i.kind), ['pr', 'issue'])
  assert.match(noLinear.hints[0], /Linear/)
  const noGh = await searchGoal(searchStubs({ linear: LINEAR, gh: { missing: true } }).deps, { q: 'fix' })
  assert.deepEqual(noGh.items.map((i) => i.kind), ['linear'])
  assert.match(noGh.hints[0], /gh/)
  const noRemote = await searchGoal(searchStubs({ linear: LINEAR, remote: '' }).deps, { q: 'fix' })
  assert.deepEqual(noRemote.items.map((i) => i.kind), ['linear'])
  assert.match(noRemote.hints[0], /GitHub remote/)
  const partial = await searchGoal(searchStubs({ linear: LINEAR, gh: { prs: { code: 1, stdout: '', stderr: 'x' } } }).deps, { q: 'fix' })
  assert.deepEqual(partial.items.map((i) => i.kind), ['linear', 'issue'])
})

test('AC1: a stale goal.search resolves { stale: true }; short queries do no work', async () => {
  const { deps, calls } = searchStubs({ linear: LINEAR })
  assert.equal((await searchGoal(deps, { q: 'fix' }, { isStale: () => true })).stale, true)
  const before = calls.length
  assert.deepEqual(await searchGoal(deps, { q: 'a' }), { items: [], hints: [] })
  assert.equal(calls.length, before)
})

test('parseGithubRepo handles ssh and https remotes', () => {
  assert.equal(parseGithubRepo('git@github.com:a/b.git'), 'a/b')
  assert.equal(parseGithubRepo('https://github.com/a/b'), 'a/b')
  assert.equal(parseGithubRepo('https://gitlab.com/a/b'), null)
})

// ---- run links: attached to the run's workspace at start ----

test('run links: each kind attaches to the focused workspace after the pins; never read back from it', async () => {
  const { deps, calls } = newWsStubs({ settings: { workerModel: 'm' } })
  const refs = ['#45', 'ENG-123', 'https://github.com/a/b/pull/7', 'https://linear.app/acme/issue/ABC-9', 'https://gitlab.com/a/b/-/merge_requests/3']
  const result = await startRun(deps, { goal: 'x', links: refs })
  assert.equal(result.ok, true)
  assert.deepEqual(result.linkFailures, [])
  assert.deepEqual(calls.filter((c) => c.file === ORCA && c.args[0] !== 'agent').map((c) => c.args), [
    ['worktree', 'set', '--worktree', 'wt-1', '--issue', '45', '--json'],
    ['worktree', 'set', '--worktree', 'wt-1', '--linear-issue', 'ENG-123', '--json'],
    ['worktree', 'set', '--worktree', 'wt-1', '--pr', '7', '--json'],
    ['worktree', 'set', '--worktree', 'wt-1', '--linear-issue', 'https://linear.app/acme/issue/ABC-9', '--json'],
    ['reference', 'add', 'https://gitlab.com/a/b/-/merge_requests/3', '--worktree', 'wt-1', '--json']
  ])
  assert.equal(orcaArgs(calls, 'worktree', 'show').length, 0, 'the workspace links are never read: only what the person added goes in')
})

test('run links: free text fails before anything runs; a failing attach is reported, not fatal', async () => {
  const a = newWsStubs()
  const bad = await startRun(a.deps, { goal: 'x', links: ['#45', 'fix login'] })
  assert.equal(bad.error.code, 'bad_link')
  assert.match(bad.error.message, /fix login/)
  assert.equal(a.calls.filter((c) => c.kind === 'exec').length, 0)
  const b = newWsStubs()
  const base = b.deps.exec
  b.deps.exec = async (file, args, opts) => (file === ORCA && args[0] === 'worktree' ? { code: 1, stdout: '', stderr: 'Linear is not connected' } : base(file, args, opts))
  const res = await startRun(b.deps, { goal: 'x', links: ['ENG-123'] })
  assert.equal(res.ok, true)
  assert.deepEqual(res.linkFailures, ['ENG-123 (Linear is not connected)'])
})

test('qa pin: set with --role qa next to the coder pin; skipped without a qa model', async () => {
  assert.deepEqual(pinArgs({ qaAgent: 'claude', qaModel: 'haiku', qaEffort: 'low' }, 'qa'), ['pin', 'set', '--agent', 'claude', '--model', 'haiku', '--role', 'qa', '--effort', 'low'])
  assert.equal(pinArgs({ qaAgent: 'claude', qaModel: '' }, 'qa'), null)
  const { deps, calls } = newWsStubs({ settings: { workerModel: 'sonnet', qaModel: 'haiku' } })
  const result = await startRun(deps, { goal: 'x' })
  assert.equal(result.pinned, true)
  assert.deepEqual(calls.filter((c) => c.args?.[0] === 'pin').map((c) => c.args), [
    ['pin', 'set', '--agent', 'claude', '--model', 'sonnet'],
    ['pin', 'set', '--agent', 'claude', '--model', 'haiku', '--role', 'qa']
  ])
  assert.match(setupNote({ plannerAgent: 'claude', workerAgent: 'claude', workerModel: 'sonnet', qaAgent: 'claude', qaModel: 'haiku' }), /QA and validator workers: claude · haiku/)
})

// ---- panel v4: start run in a new workspace ----

/** stubs() whose orca answers the create flow; `show` carries repoId + linkedItems, `create` a worktree receipt. */
function newWsStubs({ show, create, launch = { outcome: { kind: 'structured', handle: 'h1', sessionId: 's1' } }, addRef = {}, settings = {} } = {}) {
  const { deps, calls } = stubs({
    settings,
    exec: async (file, args, opts) => {
      calls.push({ kind: 'exec', file, args, cwd: opts?.cwd })
      if (file !== ORCA) {
        return args[0] === 'planner' && args[1] === 'show' ? { code: 0, stdout: '{"claimed":false}', stderr: '' } : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'show') return show ? orcaOut(show) : { code: 1, stdout: '', stderr: 'show refused' }
      if (args[0] === 'worktree' && args[1] === 'create') return create ?? orcaOut({ worktree: { id: 'r-9::/new/ws', path: '/new/ws', displayName: 'shown' } })
      if (args[0] === 'reference') return orcaOut(addRef)
      if (args[0] === 'worktree' && args[1] === 'set') return orcaOut({})
      if (args[0] === 'agent' && args[1] === 'launch') return orcaOut(launch)
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const mem = new Map()
  deps.storage = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v) }
  return { deps, calls, mem }
}
// the focused workspace's own links (here an observed PR) are never copied: only the run's links go in
const FOCUS_ROW = { worktree: { repoId: 'r-9', linkedItems: [{ provider: 'github', type: 'pr', number: 2, url: 'https://github.com/a/b/pull/2', origins: [{ kind: 'observed', tabId: 't' }] }] } }
const RUN_LINKS = ['#45', 'ENG-123', 'https://gitlab.com/a/b/-/merge_requests/3']
const orcaArgs = (calls, ...head) => calls.filter((c) => c.file === ORCA && head.every((a, i) => c.args[i] === a)).map((c) => c.args)

test('AC1: the toggle off keeps the 0.8.1 argv and step sequence exactly (no worktree show/create)', async () => {
  const { deps, calls } = newWsStubs({ settings: { workerModel: 'm' } })
  const result = await startRun(deps, { goal: 'build the thing' })
  assert.equal(result.ok, true)
  assert.equal(result.createdWorkspace, undefined)
  assert.deepEqual(calls.filter((c) => c.kind === 'exec').map((c) => c.args.slice(0, 2).join(' ')), ['planner show', 'install', 'pin set', 'agent launch'])
  assert.equal(orcaArgs(calls, 'worktree', 'show').length, 0)
  assert.equal(orcaArgs(calls, 'worktree', 'create').length, 0)
  assert.ok(orcaArgs(calls, 'agent', 'launch')[0].includes('path:/repo/feat'), 'the focused launch still uses path:')
})

test('AC2: the toggle on creates with the typed name, base flag, --no-parent, the focused repo id and one slot flag per link kind', async () => {
  const { deps, calls } = newWsStubs({ show: FOCUS_ROW })
  const result = await startRun(deps, { goal: 'build the thing', newWorkspace: true, workspaceName: 'my-run', baseBranch: ' origin/main ', links: RUN_LINKS })
  assert.equal(result.ok, true)
  assert.deepEqual(orcaArgs(calls, 'worktree', 'create'), [['worktree', 'create', '--name', 'my-run', '--repo', 'id:r-9', '--no-parent', '--base-branch', 'origin/main', '--issue', '45', '--linear-issue', 'ENG-123', '--json']])
  assert.deepEqual(orcaArgs(calls, 'reference', 'add'), [['reference', 'add', 'https://gitlab.com/a/b/-/merge_requests/3', '--worktree', 'r-9::/new/ws', '--json']])
})

test('AC2: an empty name falls back to the goal slug; an unsluggable goal to mte-run', async () => {
  const a = newWsStubs({ show: { worktree: { repoId: 'r-9', linkedItems: [] } } })
  await startRun(a.deps, { goal: 'Build the thing!', newWorkspace: true, workspaceName: '', baseBranch: '' })
  const argv = orcaArgs(a.calls, 'worktree', 'create')[0]
  assert.deepEqual(argv.slice(0, 4), ['worktree', 'create', '--name', 'build-the-thing'])
  assert.ok(!argv.includes('--base-branch'), 'empty base: the repo default, no flag')
  const b = newWsStubs({ show: { worktree: { repoId: 'r-9', linkedItems: [] } } })
  await startRun(b.deps, { goal: '???', newWorkspace: true })
  assert.equal(orcaArgs(b.calls, 'worktree', 'create')[0][3], 'mte-run')
})

test('AC3: install and pin run against the NEW path; the launch takes the raw created id and records it', async () => {
  const { deps, calls, mem } = newWsStubs({ show: { worktree: { repoId: 'r-9', linkedItems: [] } }, settings: { workerAgent: 'antigravity', workerModel: 'a/b' } })
  const result = await startRun(deps, { goal: 'x', newWorkspace: true, plannerModel: 'opus', plannerEffort: 'high' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.createdWorkspace, { id: 'r-9::/new/ws', name: 'shown' })
  assert.deepEqual(result.workspace.path, '/new/ws')
  const installs = calls.filter((c) => c.kind === 'exec' && c.file !== ORCA && c.args[0] === 'install')
  assert.deepEqual(installs.map((c) => c.cwd), ['/new/ws'])
  assert.deepEqual(calls.find((c) => c.args?.[0] === 'pin').cwd, '/new/ws')
  const launch = orcaArgs(calls, 'agent', 'launch')[0]
  assert.deepEqual(launch.slice(0, 8), ['agent', 'launch', '--agent', 'claude', '--worktree', 'r-9::/new/ws', '--surface', 'chat'])
  assert.ok(!launch.some((a) => a.startsWith('id:')), 'the raw receipt id, never an id:-prefixed selector')
  assert.ok(!launch.includes('path:/new/ws'))
  assert.ok(launch.join(' ').includes('--model opus --effort high'))
  assert.equal(mem.get('launches').s1.workspacePath, '/new/ws')
  assert.equal(orcaArgs(calls, 'planner', 'show').length, 0, 'a brand-new worktree skips the claim pre-check')
})

test('AC4: a creation failure stops before install/launch and does not name a workspace', async () => {
  const { deps, calls } = newWsStubs({ show: { worktree: { repoId: 'r-9', linkedItems: [] } }, create: { code: 1, stdout: '', stderr: 'branch exists' } })
  const result = await startRun(deps, { goal: 'x', newWorkspace: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'create_failed')
  assert.match(result.error.message, /branch exists/)
  assert.ok(!result.error.message.includes('was created'))
  assert.equal(calls.filter((c) => c.kind === 'exec' && (c.args[0] === 'install' || c.args[0] === 'pin' || c.args[0] === 'agent')).length, 0)
})

test('AC4: a post-creation failure names the created workspace; a failed reference link is reported, not swallowed', async () => {
  const install = newWsStubs({ show: FOCUS_ROW })
  const base = install.deps.exec
  install.deps.exec = async (file, args, opts) => (file !== ORCA && args[0] === 'install' ? { code: 3, stdout: '', stderr: 'disk full' } : base(file, args, opts))
  const r1 = await startRun(install.deps, { goal: 'x', newWorkspace: true, links: RUN_LINKS })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'mte_failed')
  assert.match(r1.error.message, /^New workspace “shown” was created and stays; /)
  assert.match(r1.error.message, /disk full/)
  assert.equal(orcaArgs(install.calls, 'agent', 'launch').length, 0)

  const launch = newWsStubs({ show: { worktree: { repoId: 'r-9', linkedItems: [] } }, launch: null })
  const base2 = launch.deps.exec
  launch.deps.exec = async (file, args, opts) => (file === ORCA && args[0] === 'agent' && args[1] === 'launch' ? { code: 1, stdout: '', stderr: 'refused' } : base2(file, args, opts))
  const r2 = await startRun(launch.deps, { goal: 'x', newWorkspace: true })
  assert.equal(r2.error.code, 'orca_failed')
  assert.match(r2.error.message, /New workspace “shown” was created and stays; refused/)

  const badRef = newWsStubs({ show: FOCUS_ROW, addRef: null })
  const base3 = badRef.deps.exec
  badRef.deps.exec = async (file, args, opts) => (args[0] === 'reference' ? { code: 1, stdout: '', stderr: 'bad url' } : base3(file, args, opts))
  const r3 = await startRun(badRef.deps, { goal: 'x', newWorkspace: true, links: RUN_LINKS })
  assert.equal(r3.ok, true)
  assert.deepEqual(r3.linkFailures, ['https://gitlab.com/a/b/-/merge_requests/3 (bad url)'])
})

test('AC4: an unreadable focused workspace fails the create step, not silently', async () => {
  const { deps, calls } = newWsStubs({})
  const result = await startRun(deps, { goal: 'x', newWorkspace: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'worktree_read_failed')
  assert.match(result.error.message, /show refused/)
  assert.equal(calls.filter((c) => c.kind === 'exec').length, 1)
})

test('a coder in a child worktree is tied to its planner through the parent worktree: claim and phase come from there', async () => {
  const ok = (result) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
  const seen = []
  const { deps } = stubs({
    exec: async (file, args, opts) => {
      seen.push({ args, cwd: opts?.cwd })
      if (args[0] === 'worktree') return ok({ worktrees: [{ id: 'r::/repo', path: '/repo', parentWorktreeId: null }, { id: 'r::/wt/coder', path: '/wt/coder', parentWorktreeId: 'r::/repo' }] })
      if (args.includes('worker-list') && args.includes('active')) return ok({ workers: [fullWorker('d1', 'run_1', 'in_progress', 'alive', 'r::/wt/coder')] })
      if (args.includes('worker-list')) return ok({ workers: [] })
      if (args.includes('run-list')) return ok({ runs: [{ id: 'run_1', objective: 'Ship' }] })
      if (args.includes('inbox')) return ok({ messages: [{ id: 'm1', type: 'ask', to: 'run:run_1', handled: false, subject: 'Which table?' }, { id: 'm2', type: 'ask', to: 'run:run_1', handled: true, subject: 'old' }, { id: 'm3', type: 'worker_done', to: 'run:run_1', handled: false, subject: 'done' }] })
      if (args.includes('gate-list')) return ok({ gates: [{ id: 'g1', question: 'Deploy now?' }] })
      if (args[0] === 'phase') return { code: 0, stdout: JSON.stringify(opts?.cwd === '/repo' ? { phase: 5, name: 'Coder', at: 'x' } : { phase: null }), stderr: '' }
      if (args[0] === 'planner') return { code: 0, stdout: JSON.stringify({ claimed: false }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  deps.storage = { get: async () => null, set: async () => undefined }
  const { orchestrators, attention } = await listOrchestrators(deps)
  assert.deepEqual(orchestrators.map((o) => [o.id, o.phase, o.home]), [['run_1', { phase: 5, name: 'Coder' }, 'r::/repo']])
  assert.ok(seen.some((c) => c.args[0] === 'planner' && c.cwd === '/repo'))
  assert.deepEqual(attention.map((a) => [a.kind, a.text, a.run, a.workspace]), [['ask', 'Which table?', 'Ship', 'r::/repo'], ['gate', 'Deploy now?', 'Ship', 'r::/repo']])
  assert.deepEqual(plannerHome(new Map(), 'r::/solo'), { id: 'r::/solo', path: '/solo' })
})

test('attention lists settled workers whose terminal is still kept; every source fails soft', async () => {
  const ok = (result) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
  const deps = {
    orcaCli: { bin: 'orca', env: {} },
    exec: async (file, args) => {
      if (args.includes('retained')) return ok({ workers: [{ dispatchId: 'ctx_a1', taskId: 'task_1', runId: 'run_1', workerState: 'succeeded' }, { dispatchId: 'ctx_a2', runId: 'run_1', workerState: 'running' }] })
      if (args.includes('reclaimable')) return { code: 1, stdout: '', stderr: 'boom' }
      return { code: 1, stdout: '', stderr: 'no' }
    }
  }
  const items = await listAttention(deps, ['run_1'], [{ id: 'run_1', objective: 'Ship' }], [])
  assert.deepEqual(items.map((i) => [i.kind, i.dispatchId, i.run]), [['release', 'ctx_a1', 'Ship']])
})

test('release re-checks the dispatch id before calling orca', async () => {
  const calls = []
  const deps = { orcaCli: { bin: 'orca', env: {} }, exec: async (file, args) => (calls.push(args), { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' }) }
  assert.equal((await releaseWorker(deps, 'ctx_; rm -rf /')).error.code, 'bad_dispatch')
  assert.equal(calls.length, 0)
  assert.equal((await releaseWorker(deps, 'ctx_abc123')).ok, true)
  assert.deepEqual(calls[0], ['orchestration', 'worker-release', '--dispatch', 'ctx_abc123', '--json'])
})
