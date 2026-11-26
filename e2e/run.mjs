// `npm run e2e` (from e2e/): resets the fixture repo, installs MTE with cheap pins, opens an Orca terminal on the
// fixture running driver.mjs (real planner + simulated user + real Orca workers), waits for result.json, runs the
// hidden acceptance check on the pushed branch, and exits 1 when any rule of the flow was broken.
// Needs: Orca running, `mte` and `claude` on PATH (logged in). Costs real tokens; nothing runs in `mte check`.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = process.env.MTE_E2E_REPO || join(homedir(), 'orca', 'mte-e2e-fixture')
const REMOTE = `${FIXTURE}.git`
const OUT = join(HERE, 'out', new Date().toISOString().replace(/[:.]/g, '-'))
const TIMEOUT_MIN = Number(process.env.MTE_E2E_TIMEOUT_MIN || 90)
const WORKER_MODEL = process.env.MTE_E2E_WORKER_MODEL || 'haiku'
const QA_MODEL = process.env.MTE_E2E_QA_MODEL || 'sonnet'
const ORCA = process.env.ORCA_CLI_COMMAND || 'orca'

function sh(cmd, args, cwd = FIXTURE, { allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}): ${(res.stderr || res.stdout || res.error?.message || '').trim()}`)
  }
  return res.stdout.trim()
}
const orcaJson = (args) => JSON.parse(sh(ORCA, [...args, '--json'], HERE)).result
const git = (...args) => sh('git', args)
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

const SEED = {
  'package.json': `${JSON.stringify({ name: 'mte-e2e-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'src/math.mjs': 'export function add(a, b) {\n  return a + b\n}\n',
  'test/math.test.mjs': "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { add } from '../src/math.mjs'\n\nit('adds', () => assert.equal(add(2, 3), 5))\n",
  'README.md': '# mte-e2e-fixture\n\nThrowaway repo for the MTE Flow end-to-end run. Reset on every run.\n'
}

/** Creates the fixture once (repo + bare origin + Orca registration); afterwards resets it to the `e2e-seed` tag. */
function prepareFixture() {
  if (!existsSync(join(FIXTURE, '.git'))) {
    for (const [file, text] of Object.entries(SEED)) {
      mkdirSync(dirname(join(FIXTURE, file)), { recursive: true })
      writeFileSync(join(FIXTURE, file), text)
    }
    sh('git', ['init', '-q', '--bare', REMOTE], HERE)
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'seed')
    git('tag', 'e2e-seed')
    git('remote', 'add', 'origin', REMOTE)
  }
  const repos = orcaJson(['repo', 'list']).repos
  let repo = repos.find((r) => r.path === FIXTURE)
  if (!repo) {
    sh(ORCA, ['repo', 'add', '--path', FIXTURE], HERE)
    repo = orcaJson(['repo', 'list']).repos.find((r) => r.path === FIXTURE)
  }
  for (const wt of orcaJson(['worktree', 'list']).worktrees) {
    if (wt.repoId === repo.id && wt.path !== FIXTURE) {
      sh(ORCA, ['worktree', 'rm', '--worktree', `path:${wt.path}`, '--force', '--delete-branch'], HERE, { allowFail: true })
    }
  }
  git('worktree', 'prune')
  git('checkout', '-q', '-f', 'main')
  git('reset', '-q', '--hard', 'e2e-seed')
  git('clean', '-qfdx')
  for (const branch of git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter((b) => b && b !== 'main')) {
    git('branch', '-q', '-D', branch)
  }
  sh('rm', ['-rf', join(FIXTURE, '.git', 'mte')], HERE) // memory DB + planner claim: every run starts blank
  sh('rm', ['-rf', REMOTE], HERE)
  sh('git', ['init', '-q', '--bare', REMOTE], HERE)
  git('push', '-q', 'origin', 'main')
  sh('mte', ['install'])
  sh('mte', ['pin', 'set', '--agent', 'claude', '--model', WORKER_MODEL])
  sh('mte', ['pin', 'set', '--role', 'qa', '--agent', 'claude', '--model', QA_MODEL])
}

/** A `gh` stand-in: logs every call, pretends a PR exists. The run never reaches GitHub. */
function fakeGh() {
  mkdirSync(join(OUT, 'bin'), { recursive: true })
  const gh = join(OUT, 'bin', 'gh')
  writeFileSync(gh, `#!/bin/sh\necho "$*" >> ${quote(join(OUT, 'gh.log'))}\ncase "$*" in\n  "pr create"*) echo "https://example.invalid/mte-e2e/pull/1" ;;\n  *) echo "{}" ;;\nesac\n`)
  chmodSync(gh, 0o755)
}

/** The user's hidden expectation, checked on the branch the planner pushed (not on what the planner claims). */
function hiddenCheck() {
  git('fetch', '-q', 'origin')
  const branches = git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin').split('\n').filter((b) => b && !/\/(main|HEAD)$/.test(b) && b !== 'origin')
  if (branches.length === 0) {
    return ['hidden check: no branch pushed to origin']
  }
  const dir = join(OUT, 'pushed')
  git('worktree', 'add', '-q', '--detach', dir, branches[0])
  const failures = []
  if (spawnSync('node', ['--test'], { cwd: dir, encoding: 'utf8' }).status !== 0) {
    failures.push(`hidden check: tests fail on ${branches[0]}`)
  }
  const probe = "const m = await import('./src/math.mjs'); if (m.subtract(5, 3) !== 2) throw new Error('5-3'); try { m.subtract('5', 3) } catch (e) { if (e instanceof TypeError) process.exit(0) } throw new Error('no TypeError')"
  const res = spawnSync('node', ['--input-type=module', '-e', probe], { cwd: dir, encoding: 'utf8' })
  if (res.status !== 0) {
    failures.push(`hidden check: subtract does not meet the user's expectation on ${branches[0]}: ${res.stderr.trim().split('\n').at(-1)}`)
  }
  git('worktree', 'remove', '--force', dir)
  return failures
}

/** Workers settle but Orca keeps their terminals: release the fixture's, so runs do not pile up idle terminals. */
function releaseFixtureWorkers() {
  for (const state of ['retained', 'reclaimable']) {
    const { workers = [] } = orcaJson(['orchestration', 'worker-list', '--terminal-state', state, '--limit', '100', '--full'])
    for (const w of workers.filter((w) => String(w.resource?.worktreeId ?? '').includes(`/${basename(FIXTURE)}`))) { // worker worktrees live under ~/orca/workspaces/<fixture name>/
      sh(ORCA, ['orchestration', 'worker-release', '--dispatch', w.dispatchId], HERE, { allowFail: true })
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

mkdirSync(OUT, { recursive: true })
prepareFixture()
fakeGh()
const env = {
  PATH: `${join(OUT, 'bin')}:${process.env.PATH}`,
  MTE_E2E_OUT: OUT,
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^MTE_E2E_(PLANNER_MODEL|USER_MODEL|MAX_TURNS|USER_SETTINGS)$/.test(k)))
}
const command = `${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' ')} node ${quote(join(HERE, 'driver.mjs'))}`
const terminal = orcaJson(['terminal', 'create', '--worktree', `path:${FIXTURE}`, '--title', 'MTE e2e', '--command', command])
const handle = terminal.terminal.handle
console.log(`e2e: planner running in Orca terminal ${handle}; transcript: ${join(OUT, 'transcript.jsonl')}`)

const deadline = Date.now() + TIMEOUT_MIN * 60_000
while (!existsSync(join(OUT, 'result.json')) && Date.now() < deadline) {
  await sleep(10_000)
}
const result = existsSync(join(OUT, 'result.json'))
  ? JSON.parse(readFileSync(join(OUT, 'result.json'), 'utf8'))
  : { failures: [`driver: no result after ${TIMEOUT_MIN} min`], turns: null, costUsd: null }
result.failures.push(...hiddenCheck())
// the Stop hook, not the model, records the phase: after the PR it must read 8
const recorded = JSON.parse(sh('mte', ['phase', 'show', '--json'], FIXTURE, { allowFail: true }) || '{}')
if (recorded.phase !== 8) {
  result.failures.push(`phase hook: recorded phase ${recorded.phase ?? 'none'}, expected 8`)
}
releaseFixtureWorkers()
writeFileSync(join(OUT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
sh('mte', ['planner', 'release'], FIXTURE, { allowFail: true })
if (handle) {
  sh(ORCA, ['terminal', 'close', '--terminal', handle], HERE, { allowFail: true })
}

console.log(`e2e: ${result.turns ?? '?'} user turns, ~$${result.costUsd ?? '?'} (planner + simulated user; workers bill separately)`)
if (result.failures.length === 0) {
  console.log('e2e: PASSED — every phase in order, questions only in grill-me, QA after the coder, draft PR, phase hook at 8, hidden check green')
} else {
  console.log(`e2e: FAILED\n${result.failures.map((f) => `  - ${f}`).join('\n')}\nartifacts: ${OUT}`)
}
process.exit(result.failures.length === 0 ? 0 : 1)
