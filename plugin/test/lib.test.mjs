import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBootstrapPrompt,
  checkMte,
  installInWorkspace,
  listOrchestration,
  startRun,
  statusText,
  TRUNCATION_MARKER
} from '../worker/lib.mjs'

const WS = { id: 'wt-1', kind: 'worktree', name: 'feat', path: '/repo/feat', branch: 'feat', hostId: 'local' }

/** Stubbed child_process + host API; records every call in order. */
function stubs({ settings = {}, exec } = {}) {
  const calls = []
  const deps = {
    exec:
      exec ??
      (async (file, args, opts) => {
        calls.push({ kind: 'exec', file, args, cwd: opts?.cwd })
        return { code: 0, stdout: '', stderr: '' }
      }),
    host: {
      settings: async () => settings,
      call: async (method, params) => {
        calls.push({ kind: 'host', method, params })
        if (method === 'workspace.readContext') {
          return { workspaceId: 'wt-1', branch: 'feat', displayName: 'feat', terminals: [] }
        }
        if (method === 'workspace.list') {
          return { workspaces: [WS], truncated: false }
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

test('bootstrap prompt is `/mte <goal>` for short goals', () => {
  assert.equal(buildBootstrapPrompt('ship it'), '/mte ship it')
  assert.equal(buildBootstrapPrompt('  ship it \n'), '/mte ship it')
})

test('bootstrap prompt stays under 4096 chars for a 3000-char goal', () => {
  const goal = 'a'.repeat(3000)
  const prompt = buildBootstrapPrompt(goal)
  assert.ok(prompt.length < 4096)
  assert.equal(prompt, `/mte ${goal}`)
})

test('bootstrap prompt truncates an oversized goal with a marker', () => {
  const prompt = buildBootstrapPrompt('b'.repeat(10_000))
  assert.ok(prompt.length < 4096)
  assert.ok(prompt.startsWith('/mte b'))
  assert.ok(prompt.endsWith(TRUNCATION_MARKER))
  // never splits a surrogate pair
  const emoji = buildBootstrapPrompt('😀'.repeat(5000))
  assert.ok(emoji.length < 4096)
  assert.ok(!/[\uD800-\uDBFF]\n\[goal truncated\]$/.test(emoji))
})

test('start run: install, pin set, then agent.launch, in that order', async () => {
  const { deps, calls } = stubs({
    settings: { plannerAgent: 'claude', workerAgent: 'claude', workerModel: 'claude-sonnet-5-5', workerEffort: 'high', mteBin: 'mte' }
  })
  const result = await startRun(deps, { goal: 'build the thing' })
  assert.equal(result.ok, true)
  assert.equal(result.terminalId, 'term-1')
  const seq = calls.filter((c) => c.kind === 'exec' || c.method === 'agent.launch')
  assert.deepEqual(
    seq.map((c) => (c.kind === 'exec' ? `${c.file} ${c.args.slice(0, 2).join(' ')}` : c.method)),
    ['mte install --agents', 'mte pin set', 'agent.launch']
  )
  assert.deepEqual(seq[0].args, ['install', '--agents', 'claude'])
  assert.equal(seq[0].cwd, '/repo/feat')
  assert.deepEqual(seq[1].args, ['pin', 'set', '--agent', 'claude', '--model', 'claude-sonnet-5-5', '--effort', 'high'])
  assert.equal(seq[1].cwd, '/repo/feat')
  assert.deepEqual(seq[2].params, { workspaceId: 'wt-1', agent: 'claude', prompt: '/mte build the thing' })
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
  assert.equal(calls.find((c) => c.method === 'agent.launch').params.agent, 'opencode')
})

test('start run: planner overrides from the form beat the settings', async () => {
  const { deps, calls } = stubs({ settings: { plannerAgent: 'claude', workerAgent: 'claude' } })
  await startRun(deps, { goal: 'x', plannerAgent: 'opencode' })
  assert.equal(calls.find((c) => c.method === 'agent.launch').params.agent, 'opencode')
  assert.deepEqual(calls.find((c) => c.kind === 'exec').args, ['install', '--agents', 'opencode,claude'])
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
  assert.equal(result.error.stage, 'install')
  assert.match(result.error.message, /boom/)
  assert.ok(!calls.some((c) => c.method === 'agent.launch'))
})

test('missing mte binary yields the mte_missing error with install instructions', async () => {
  const exec = async () => {
    throw Object.assign(new Error('spawn mte ENOENT'), { code: 'ENOENT' })
  }
  const { deps, calls } = stubs({ exec })
  for (const result of [await startRun(deps, { goal: 'x' }), await installInWorkspace(deps)]) {
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'mte_missing')
    assert.match(result.error.message, /npm i -g @mtekode\/mte/)
  }
  assert.ok(!calls.some((c) => c.method === 'agent.launch'))
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
