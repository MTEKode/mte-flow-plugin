// Pure logic for the MTE Flow plugin. No Orca imports: every side effect comes in through `deps`
// ({ exec, host, settings }) so the tests can stub child_process and the host API.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

// agent.launch and workspace.create cap prompts at 4096 chars; stay well under it.
export const PROMPT_MAX = 4000
export const TRUNCATION_MARKER = '\n[goal truncated]'
/** The mte CLI version this plugin release is built for; the setup installs it when `mte` is missing or older. */
export const REQUIRED_MTE_VERSION = '0.3.0'
export const MIN_NODE_MAJOR = 24
export const tarballUrl = (version) =>
  `https://github.com/MTEKode/mte-flow-plugin/releases/download/mte-v${version}/mtekode-mte-${version}.tgz`
export const INSTALL_HINT = `npm i -g ${tarballUrl(REQUIRED_MTE_VERSION)} (Node >= ${MIN_NODE_MAJOR}; from a checkout: cd packages/mte && npm link)`

/** `/mte-flow <goal>` plus an optional trailing `note`, with the goal cut (and marked) so the whole prompt fits the host cap. */
export function buildBootstrapPrompt(goal, note = '') {
  const prefix = '/mte-flow '
  const suffix = note ? `\n\n${note}` : ''
  const text = String(goal).trim()
  if (prefix.length + text.length + suffix.length <= PROMPT_MAX) {
    return prefix + text + suffix
  }
  let cut = text.slice(0, PROMPT_MAX - prefix.length - TRUNCATION_MARKER.length - suffix.length)
  // Do not leave half a surrogate pair behind.
  if (/[\uD800-\uDBFF]$/.test(cut)) {
    cut = cut.slice(0, -1)
  }
  return prefix + cut + TRUNCATION_MARKER + suffix
}

const describeChoice = (agent, model, effort) => [agent, model || 'default model', effort].filter(Boolean).join(' · ')

/** One line the planner repeats in its first reply, so the chat itself says which models run the planner and the workers. */
export function setupNote(settings) {
  const planner = describeChoice(settings.plannerAgent, takesModel(settings.plannerAgent) ? settings.plannerModel : '', settings.plannerModel && effortsFor(settings.plannerAgent).length ? settings.plannerEffort : '')
  const worker = describeChoice(settings.workerAgent, takesModel(settings.workerAgent) ? settings.workerModel : '', settings.workerModel && effortsFor(settings.workerAgent).length ? settings.workerEffort : '')
  return `(Run setup from the MTE Flow panel. Orchestrator: ${planner}. Workers: ${worker}. State both in your first reply.)`
}

export class MteError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const mteMissingError = (bin) =>
  new MteError(
    'mte_missing',
    `The \`${bin}\` binary was not found. Install it with \`${INSTALL_HINT}\` or set "mte binary" in the plugin settings.`
  )

const WIN_META = /([()\][%!^"`<>&|;, *?])/g

/** One argument quoted for a `cmd.exe /c` line that runs a .cmd shim (cross-spawn's rules: the shim re-parses `%*`, so metacharacters are escaped twice). */
export function winQuote(arg) {
  const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(WIN_META, '^$1').replace(WIN_META, '^$1')
}

/**
 * How to start `file` on Windows, where npm-installed CLIs (`mte`, `npm`, `opencode`) are `.cmd` shims that Node will
 * not start by bare name: the full path of the .exe, or a verbatim `cmd.exe /d /s /c` line for a shim. Null when
 * nothing on PATH matches. Never goes through a shell with unquoted text: goals and model ids are user input.
 */
export function windowsSpawnPlan(file, args, { env = process.env, exists = existsSync } = {}) {
  const get = (name) => env[Object.keys(env).find((k) => k.toLowerCase() === name) ?? '']
  const exts = (get('pathext') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const dirs = /[\\/]/.test(file) ? [''] : (get('path') || '').split(';').filter(Boolean)
  let found = null
  for (const dir of dirs) {
    const base = dir ? win32.join(dir, file) : file
    found = [base, ...exts.map((e) => base + e)].find((c) => /\.[^\\/.]+$/.test(c) && exists(c)) ?? null
    if (found) {
      break
    }
  }
  if (!found) {
    return null
  }
  if (!/\.(cmd|bat)$/i.test(found)) {
    return { command: found, args, verbatim: false }
  }
  const line = [found.replace(WIN_META, '^$1'), ...args.map(winQuote)].join(' ')
  return { command: get('comspec') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/** execFile as a promise: resolves { code, stdout, stderr } (never rejects on a non-zero exit); rejects with ENOENT when the binary is missing. */
export function defaultExec(file, args, { cwd, env, timeoutMs = 60_000 } = {}) {
  let plan = { command: file, args, verbatim: false }
  if (process.platform === 'win32') {
    plan = windowsSpawnPlan(file, args, { env: { ...process.env, ...env } })
    if (!plan) {
      return Promise.reject(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }))
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      plan.command,
      plan.args,
      { cwd, env: env ? { ...process.env, ...env } : undefined, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsVerbatimArguments: plan.verbatim, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          reject(error)
        } else if (error) {
          resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout, stderr: stderr || error.message })
        } else {
          resolve({ code: 0, stdout, stderr })
        }
      }
    )
  })
}

/**
 * The `orca` CLI and profile of the Orca app that hosts this worker. The host forks the worker from
 * its own Electron binary (`process.execPath`, ELECTRON_RUN_AS_NODE) and scrubs ORCA_* from its env,
 * and an installed plugin lives at `<userData>/plugins/<pluginKey>/<contentHash>/`; so the app bundle
 * and the profile can both be derived without guessing. With no `ORCA_USER_DATA_PATH` the CLI would
 * talk to the default profile, which is the wrong app whenever two Orca apps are installed.
 * Dev-linked plugins sit outside `<userData>/plugins`: they get the bundle's CLI and its default profile.
 */
export function resolveOrcaCli({
  execPath = process.execPath,
  platform = process.platform,
  moduleUrl = import.meta.url,
  exists = existsSync
} = {}) {
  const exeDir = dirname(execPath)
  const candidates =
    platform === 'darwin'
      ? [join(exeDir, '..', 'Resources', 'bin', 'orca')]
      : platform === 'win32'
        ? [join(exeDir, 'resources', 'bin', 'orca.exe')]
        : [join(exeDir, 'resources', 'bin', 'orca-ide'), join(exeDir, 'resources', 'bin', 'orca')]
  const bundled = candidates.map((c) => resolve(c)).find((c) => exists(c))
  let env = {}
  try {
    const here = moduleUrl.startsWith('file:') ? fileURLToPath(moduleUrl) : moduleUrl
    const match = /^(.*)[\\/]plugins[\\/][^\\/]+[\\/][0-9a-f]{32,}[\\/]/.exec(here)
    if (match?.[1]) {
      env = { ORCA_USER_DATA_PATH: match[1] }
    }
  } catch {
    // not a file URL: no profile to pin
  }
  return { bin: bundled ?? 'orca', env }
}

/** Agents whose launch/worker-start accept `--effort`, and the values each takes (panel-v2 feasibility report, section E). */
export const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // Orca's own antigravity catalog offers these three for `--effort`
  antigravity: ['low', 'medium', 'high']
}
export const effortsFor = (agent) => EFFORTS[agent] ?? []
/** Harnesses that refuse launch-time `--model`/`--effort` (they run the model from their own config). */
export const NO_MODEL_AGENTS = ['opencode2', 'droid']
export const takesModel = (agent) => !NO_MODEL_AGENTS.includes(agent)
export const SURFACES = ['chat', 'terminal']

/** Reads the plugin settings, with their defaults. */
export async function readSettings(host) {
  const raw = (await host.settings()) ?? {}
  const str = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
  return {
    plannerAgent: str(raw.plannerAgent, 'claude'),
    plannerModel: str(raw.plannerModel),
    plannerSurface: SURFACES.includes(raw.plannerSurface) ? raw.plannerSurface : 'chat',
    plannerEffort: str(raw.plannerEffort),
    workerAgent: str(raw.workerAgent, 'claude'),
    workerModel: str(raw.workerModel),
    workerEffort: str(raw.workerEffort),
    mteBin: str(raw.mteBin, 'mte')
  }
}

/** The focused workspace as `workspace.list` knows it (its id is what the other workspace methods take), or null. */
export async function resolveWorkspace(host) {
  const ctx = await host.call('workspace.readContext', {})
  if (!ctx) {
    return null
  }
  const { workspaces } = await host.call('workspace.list', {})
  const row =
    workspaces.find((w) => ctx.workspaceId && w.id === ctx.workspaceId) ??
    workspaces.find((w) => w.branch === ctx.branch && w.name === ctx.displayName)
  return row ? { id: row.id, name: row.name, path: row.path, branch: row.branch } : null
}

const fail = (stage, code, message) => ({ ok: false, error: { stage, code, message } })

/** Refuses targets that must never receive MTE files: the home directory or anything that is not a git checkout. */
export function checkWorkspaceTarget(deps, ws) {
  const exists = deps.exists ?? existsSync
  const home = resolve(deps.homedir ?? homedir())
  if (!ws.path || resolve(ws.path) === home) {
    return fail('workspace', 'workspace_is_home', 'The focused workspace is the home directory; open a project workspace first.')
  }
  if (!exists(join(ws.path, '.git'))) {
    return fail('workspace', 'not_git_repo', `${ws.path} is not a git repository; open a project workspace first.`)
  }
  return null
}

/** Runs `bin args` and maps ENOENT / non-zero exits to a result error. Returns null on success. */
async function runMte(deps, settings, stage, args, cwd) {
  let res
  try {
    res = await deps.exec(settings.mteBin, args, { cwd })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fail(stage, 'mte_missing', mteMissingError(settings.mteBin).message)
    }
    return fail(stage, 'exec_failed', String(error?.message ?? error))
  }
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 500)
    return fail(stage, 'mte_failed', `\`mte ${args.slice(0, 2).join(' ')}\` exited with ${res.code}${detail ? `: ${detail}` : ''}`)
  }
  return null
}

/** Always wire both agents: the planner and worker agents are chosen per run, and install is idempotent. */
export function installArgs() {
  return ['install', '--agents', 'claude,opencode']
}

export function pinArgs(settings) {
  if (!settings.workerModel || !takesModel(settings.workerAgent)) {
    return null
  }
  const args = ['pin', 'set', '--agent', settings.workerAgent, '--model', settings.workerModel]
  // only the EFFORTS harnesses take an effort: drop it for the rest
  if (effortsFor(settings.workerAgent).length && settings.workerEffort) {
    args.push('--effort', settings.workerEffort)
  }
  return args
}

/** Install MTE in the focused workspace. */
export async function installInWorkspace(deps) {
  const settings = await readSettings(deps.host)
  const ws = await resolveWorkspace(deps.host)
  if (!ws) {
    return fail('workspace', 'no_workspace', 'No workspace is focused.')
  }
  const refused = checkWorkspaceTarget(deps, ws)
  if (refused) {
    return refused
  }
  const err = await runMte(deps, settings, 'install', installArgs(), ws.path)
  return err ?? { ok: true, workspace: ws }
}

/** Human-readable holder of a planner claim (`mte planner show --json`). */
export function describeClaim(claim) {
  const parts = [
    claim.sessionId && `session ${claim.sessionId}`,
    claim.terminalHandle && `terminal ${claim.terminalHandle}`,
    claim.opencodeSessionId && `opencode session ${claim.opencodeSessionId}`
  ].filter(Boolean)
  return parts.join(' / ') || 'an unknown caller'
}

/** `mte planner show --json`: { claimed: false } or the claim; a result error when it cannot be read. */
async function readClaim(deps, settings, cwd) {
  let res
  try {
    res = await deps.exec(settings.mteBin, ['planner', 'show', '--json'], { cwd })
  } catch (error) {
    return error?.code === 'ENOENT'
      ? fail('planner', 'mte_missing', mteMissingError(settings.mteBin).message)
      : fail('planner', 'exec_failed', String(error?.message ?? error))
  }
  try {
    if (res.code !== 0) {
      throw new Error(`exited with ${res.code}`)
    }
    return { ok: true, claim: JSON.parse(res.stdout) }
  } catch (error) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 300)
    return fail('planner', 'mte_failed', `\`mte planner show\` failed (${error.message})${detail ? `: ${detail}` : ''}`)
  }
}

/**
 * True only when Orca positively reports the claiming session as closed (`orca agent show` lists no place for it).
 * ponytail: session-id claims only; a terminal-handle-only claim still asks (add `orca terminal show` if that bites).
 */
async function isClaimStale(deps, claim) {
  if (!claim.sessionId) {
    return false
  }
  try {
    const shown = await orcaJson(deps, ['agent', 'show', claim.sessionId])
    return Array.isArray(shown?.places) && shown.places.length === 0
  } catch {
    return false
  }
}

/**
 * Start a run with a terminal planner: `mte planner show` (a live claim stops the run), `mte install`, `mte pin set`,
 * `mte planner release`, then the planner launch with `/mte-flow <goal>`. With `replace: true` an existing claim is
 * released instead of stopping the run.
 */
export async function startRun(deps, input = {}) {
  const { goal, replace = false } = input
  const settings = await readSettings(deps.host)
  // the panel's selection beats the settings (which only seed it)
  for (const key of ['plannerAgent', 'plannerModel', 'plannerSurface', 'plannerEffort', 'workerAgent', 'workerModel', 'workerEffort']) {
    if (typeof input[key] === 'string') {
      settings[key] = input[key].trim()
    }
  }
  if (!SURFACES.includes(settings.plannerSurface)) {
    settings.plannerSurface = 'chat'
  }
  if (!String(goal ?? '').trim()) {
    return fail('input', 'empty_goal', 'Write a goal first.')
  }
  const ws = await resolveWorkspace(deps.host)
  if (!ws) {
    return fail('workspace', 'no_workspace', 'No workspace is focused.')
  }
  const refused = checkWorkspaceTarget(deps, ws)
  if (refused) {
    return refused
  }
  // a live planner may be mid-run in this workspace: never drop its claim (or change its worker pin) unasked
  const existing = await readClaim(deps, settings, ws.path)
  if (!existing.ok) {
    return existing
  }
  // a claim whose chat/terminal is closed can never dispatch again: drop it without asking
  const stale = existing.claim?.claimed && !replace && (await isClaimStale(deps, existing.claim))
  if (existing.claim?.claimed && !replace && !stale) {
    const holder = describeClaim(existing.claim)
    return {
      ...fail(
        'planner',
        'planner_claimed',
        `A planner already holds this workspace (${holder}). Replace it only if that planner is gone.`
      ),
      claim: { holder, claimedAt: existing.claim.claimedAt ?? '' }
    }
  }
  const installErr = await runMte(deps, settings, 'install', installArgs(), ws.path)
  if (installErr) {
    return installErr
  }
  const pin = pinArgs(settings)
  if (pin) {
    const pinErr = await runMte(deps, settings, 'pin', pin, ws.path)
    if (pinErr) {
      return pinErr
    }
  }
  if (existing.claim?.claimed) {
    const releaseErr = await runMte(deps, settings, 'release', ['planner', 'release'], ws.path)
    if (releaseErr) {
      return releaseErr
    }
  }
  const prompt = buildBootstrapPrompt(goal, setupNote(settings))
  try {
    const launched = await launchPlanner(deps, ws, settings, prompt)
    // Orca does not record who coordinates a run or which model a worker runs: remember it for the panel
    await recordLaunch(deps, launched.sessionId ?? launched.terminalId, {
      goal: String(goal).trim().slice(0, 200),
      workspacePath: ws.path,
      at: Date.now(),
      ...Object.fromEntries(['plannerAgent', 'plannerModel', 'plannerEffort', 'plannerSurface', 'workerAgent', 'workerModel', 'workerEffort'].map((k) => [k, settings[k]]))
    })
    return { ok: true, workspace: ws, ...launched, pinned: Boolean(pin), truncated: prompt.includes(TRUNCATION_MARKER), replacedStale: Boolean(stale) }
  } catch (error) {
    return fail('launch', String(error?.code ?? 'action_failed'), String(error?.message ?? error))
  }
}

/** argv of `orca agent launch` for the planner (without `--json`, which orcaJson appends); `--focus` so the person sees it start (or fail). `--effort` needs `--model` and an agent that takes one. */
export function launchArgs(ws, settings, prompt) {
  const args = ['agent', 'launch', '--agent', settings.plannerAgent, '--worktree', `path:${ws.path}`, '--surface', settings.plannerSurface, '--focus']
  if (settings.plannerModel && takesModel(settings.plannerAgent)) {
    args.push('--model', settings.plannerModel)
    if (settings.plannerEffort && effortsFor(settings.plannerAgent).length) {
      args.push('--effort', settings.plannerEffort)
    }
  }
  args.push('--prompt', prompt)
  return args
}

/**
 * Starts the planner with its prompt through the orca CLI's single `agent launch --prompt` call (the host's
 * `agent.launch` sends the prompt in a fire-and-forget second call, so it is only the terminal-only fallback when
 * the CLI cannot be found). Resolves { terminalId: handle, surface: outcome.kind, fallback }: `fallback` is true
 * when the host opened a different surface than the one asked for (chat -> terminal).
 */
async function launchPlanner(deps, ws, settings, prompt) {
  try {
    const result = await orcaJson(deps, launchArgs(ws, settings, prompt))
    const handle = result?.outcome?.handle
    if (!handle) {
      throw new MteError('orca_failed', 'The orca CLI did not report the launched session.')
    }
    // real Orca reports a chat session as kind 'structured' (handle `structured-agent-session-<uuid>`)
    const kind = result.outcome.kind
    const surface = kind === 'structured' || kind === 'chat' ? 'chat' : kind === 'terminal' ? 'terminal' : settings.plannerSurface
    return { terminalId: handle, sessionId: result.outcome.sessionId, surface, fallback: surface !== settings.plannerSurface }
  } catch (error) {
    if (error?.code !== 'orca_missing') {
      throw error
    }
  }
  const { terminalId } = await deps.host.call('agent.launch', { workspaceId: ws.id, agent: settings.plannerAgent, prompt })
  return { terminalId, surface: 'terminal', fallback: settings.plannerSurface !== 'terminal' }
}

/** `mte` usable? ENOENT means missing; a non-zero `--version` exit (e.g. a global npm install that Node cannot type-strip) means unusable. */
export async function checkMte(deps, settings) {
  try {
    const res = await deps.exec(settings.mteBin, ['--version'], { timeoutMs: 15_000 })
    if (res?.code) {
      const line = (res.stderr || res.stdout || '').trim().split('\n')[0] || `exited with ${res.code}`
      return {
        missing: true,
        unusable: true,
        message: `\`${settings.mteBin} --version\` failed: ${line}. Install it: ${INSTALL_HINT}.`
      }
    }
    return { missing: false }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { missing: true, message: mteMissingError(settings.mteBin).message }
    }
    return { missing: false }
  }
}

/** Runs the `orca` CLI of the hosting app, on the hosting app's profile (see resolveOrcaCli). */
async function orcaJson(deps, args) {
  const { bin, env } = deps.orcaCli ?? { bin: 'orca', env: {} }
  let res
  try {
    res = await deps.exec(bin, [...args, '--json'], { timeoutMs: 20_000, env })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new MteError('orca_missing', `The orca CLI (${bin}) was not found.`)
    }
    throw error
  }
  if (res.code !== 0) {
    throw new MteError('orca_failed', (res.stderr || res.stdout || 'orca failed').trim().slice(0, 300))
  }
  const parsed = JSON.parse(res.stdout)
  return parsed.result ?? parsed
}

// a worker whose process Orca reports gone is not running, whatever its dispatch still says
const GONE = ['exited', 'dead']
export const isActiveWorker = (w) => w.outcome === 'in_progress' && !GONE.includes(w.liveness)

/** Active workers (with the run each belongs to) and recent runs from the stock orchestration CLI. Never throws: failures come back as `error`. */
export async function listOrchestration(deps) {
  try {
    const [workers, runs] = await Promise.all([
      orcaJson(deps, ['orchestration', 'worker-list', '--terminal-state', 'active', '--limit', '100', '--full']),
      orcaJson(deps, ['orchestration', 'run-list'])
    ])
    return {
      workers: (workers.workers ?? [])
        .map((w) => {
          const p = w.projection ?? {}
          return {
            dispatchId: w.dispatchId,
            taskId: w.taskId ?? '',
            runId: w.runId ?? '',
            state: p.stage?.worker ?? w.workerState ?? '',
            activity: p.stage?.activity ?? '',
            outcome: p.outcome ?? '',
            liveness: p.liveness?.verdict ?? '',
            workspace: p.workspace?.id ?? w.resource?.worktreeId ?? '',
            attention: p.attention?.requiresAction === true
          }
        })
        .filter(isActiveWorker),
      runs: (runs.runs ?? []).map((r) => ({ id: r.id, objective: r.objective ?? '' })),
      error: null
    }
  } catch (error) {
    return { workers: [], runs: [], error: { code: error?.code ?? 'orca_failed', message: String(error?.message ?? error) } }
  }
}

const LAUNCHES_KEY = 'launches'
const workspacePath = (id) => (id.includes('::') ? id.split('::').slice(1).join('::') : id)

/** Remembers what a planner was started with, keyed by its Orca session id (chat) or terminal handle. */
export async function recordLaunch(deps, key, record) {
  if (!deps.storage || !key) {
    return
  }
  await deps.storage.set(LAUNCHES_KEY, { ...((await deps.storage.get(LAUNCHES_KEY)) ?? {}), [key]: record })
}

/** Launch records whose planner is still open; closed ones are forgotten. A failed liveness check keeps the record. */
async function liveLaunches(deps) {
  const stored = (await deps.storage?.get(LAUNCHES_KEY)) ?? {}
  const keys = Object.keys(stored)
  if (!keys.length) {
    return {}
  }
  const terminals = keys.some((k) => k.startsWith('term_'))
    ? await orcaJson(deps, ['terminal', 'list']).then((r) => (r.terminals ?? []).map((t) => t.handle)).catch(() => null)
    : null
  const live = {}
  await Promise.all(
    keys.map(async (key) => {
      const closed = key.startsWith('term_') ? terminals !== null && !terminals.includes(key) : await isClaimStale(deps, { sessionId: key })
      if (!closed) {
        live[key] = stored[key]
      }
    })
  )
  if (Object.keys(live).length !== keys.length) {
    await deps.storage.set(LAUNCHES_KEY, live)
  }
  return live
}

/**
 * Running orchestrators, each with its active workers: one entry per run that has active workers, plus planners
 * started from the panel that have none yet. A run is tied to its planner through the planner claim of the repo its
 * workers run in; `launch` (what the planner and its workers were started with) is null for planners not started here.
 */
export async function listOrchestrators(deps) {
  const settings = await readSettings(deps.host)
  const { workers, runs, error } = await listOrchestration(deps)
  const launches = await liveLaunches(deps).catch(() => ({}))
  const byRun = new Map()
  for (const w of workers) {
    byRun.set(w.runId, [...(byRun.get(w.runId) ?? []), w])
  }
  const used = new Set()
  const orchestrators = await Promise.all(
    [...byRun].map(async ([runId, list]) => {
      const claim = await readClaim(deps, settings, workspacePath(list[0].workspace)).catch(() => null)
      const key = [claim?.claim?.sessionId, claim?.claim?.terminalHandle].find((k) => k && launches[k])
      if (key) {
        used.add(key)
      }
      return { id: runId, title: runs.find((r) => r.id === runId)?.objective || runId, launch: key ? launches[key] : null, workers: list }
    })
  )
  for (const [key, launch] of Object.entries(launches)) {
    if (!used.has(key)) {
      orchestrators.push({ id: key, title: launch.goal, launch, workers: [] })
    }
  }
  return { orchestrators, activeWorkers: workers.length, error }
}

/** Focus a worker's workspace: its id is `<repo>::<path>`; resolve it against workspace.list. */
export async function focusWorkspace(host, workerWorkspace) {
  const { workspaces } = await host.call('workspace.list', {})
  const path = workerWorkspace.includes('::') ? workerWorkspace.split('::').slice(1).join('::') : workerWorkspace
  const row = workspaces.find((w) => w.id === workerWorkspace) ?? workspaces.find((w) => w.path === path)
  if (!row) {
    return fail('focus', 'workspace_not_found', `Workspace ${path} is not open in Orca.`)
  }
  await host.call('workspace.open', { workspaceId: row.id })
  return { ok: true }
}

/** Opens the plugin's panel through the stock CLI; falls back to toggling the right sidebar. */
export async function openPanel(deps) {
  try {
    const { plugins } = await orcaJson(deps, ['plugin', 'list'])
    const mine = plugins.find((p) => p.pluginKey.endsWith('.mte-flow'))
    if (mine) {
      await orcaJson(deps, ['plugin', 'open', mine.pluginKey, '--panel', 'mte'])
      return { ok: true }
    }
  } catch {
    // fall through to the sidebar toggle
  }
  await deps.host.call('commands.run', { action: 'sidebar.right.toggle' })
  return { ok: true, fallback: true }
}

export const statusText = (workers) => {
  const n = workers.length
  return { n, text: n > 0 ? `MTE ${n}` : 'MTE', tone: n > 0 ? 'accent' : 'neutral' }
}

/** Numeric `x.y.z` of a version string (`mte --version` prints just that); null when it is not one. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** <0, 0, >0 like a comparator; compares parsed `x.y.z` triples. */
export function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < 3; i++) {
    const d = (pa?.[i] ?? 0) - (pb?.[i] ?? 0)
    if (d) {
      return d
    }
  }
  return 0
}

const setupKey = (version) => `setup:${version}`
const DEPTH_REMINDER_KEY = 'depthReminderDismissed'

/** Runs `file args`; ENOENT comes back as `{ missing: true }` instead of throwing. */
async function tryExec(deps, file, args, opts) {
  try {
    return await deps.exec(file, args, opts)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { missing: true, code: 127, stdout: '', stderr: '' }
    }
    throw error
  }
}

const firstLine = (res) => ((res.stderr || res.stdout || '').trim().split('\n')[0] ?? '').slice(0, 300)

/**
 * First-run setup: make sure `mte` >= REQUIRED_MTE_VERSION exists (installing the release tarball with the user's
 * own npm, never sudo), then `mte install --user` for the user-level skill. Remembered per mte version in plugin
 * storage; `force` (the Repair setup button) ignores that memory. `deps.progress(text)` reports each step.
 */
export async function ensureSetup(deps, { force = false } = {}) {
  const required = REQUIRED_MTE_VERSION
  const progress = (text) => deps.progress?.(text)
  if (!force && (await deps.storage.get(setupKey(required)))) {
    return { ok: true, skipped: true, version: required }
  }
  const settings = await readSettings(deps.host)
  progress('Checking the mte CLI…')
  let current = await tryExec(deps, settings.mteBin, ['--version'], { timeoutMs: 15_000 })
  let installed = false
  if (current.missing || current.code !== 0 || compareVersions(current.stdout, required) < 0) {
    const node = await tryExec(deps, 'node', ['--version'], { timeoutMs: 15_000 })
    const major = parseVersion(node.stdout)?.[0]
    if (node.missing || node.code !== 0 || major === undefined) {
      return fail('setup', 'node_missing', `Node.js >= ${MIN_NODE_MAJOR} and npm are required to install mte, but \`node\` was not found on PATH. Install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org, then press Repair setup.`)
    }
    if (major < MIN_NODE_MAJOR) {
      return fail('setup', 'node_old', `Node ${node.stdout.trim()} is too old: mte needs Node >= ${MIN_NODE_MAJOR}. Upgrade Node (https://nodejs.org), then press Repair setup.`)
    }
    const npm = await tryExec(deps, 'npm', ['--version'], { timeoutMs: 15_000 })
    if (npm.missing || npm.code !== 0) {
      return fail('setup', 'npm_missing', `\`npm\` was not found on PATH. Install it with Node, then run \`npm i -g ${tarballUrl(required)}\` yourself or press Repair setup.`)
    }
    progress(`Installing mte ${required} with npm…`)
    const res = await tryExec(deps, 'npm', ['i', '-g', tarballUrl(required)], { timeoutMs: 300_000 })
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout || '').trim().slice(0, 600)
      return fail('setup', 'npm_failed', `\`npm i -g\` failed${detail ? `: ${detail}` : ''}. If it is a permissions error, point npm's global prefix at a folder you own (\`npm config set prefix ~/.npm-global\` and add its bin to PATH); never use sudo.`)
    }
    current = await tryExec(deps, settings.mteBin, ['--version'], { timeoutMs: 15_000 })
    if (current.missing || current.code !== 0 || compareVersions(current.stdout, required) < 0) {
      return fail('setup', 'mte_not_on_path', `mte ${required} was installed but \`${settings.mteBin} --version\` still fails${current.missing ? ' (not on PATH: add npm\'s global bin folder, see `npm bin -g`, to PATH)' : `: ${firstLine(current)}`}.`)
    }
    installed = true
  }
  progress('Installing the mte-flow skill…')
  const skill = await tryExec(deps, settings.mteBin, ['install', '--user'], { timeoutMs: 30_000 })
  if (skill.code !== 0) {
    return fail('setup', 'user_install_failed', `\`mte install --user\` failed${firstLine(skill) ? `: ${firstLine(skill)}` : ''}.`)
  }
  await deps.storage.set(setupKey(required), { at: new Date().toISOString() })
  return { ok: true, version: required, installed }
}

export const isDepthReminderDismissed = async (storage) => Boolean(await storage.get(DEPTH_REMINDER_KEY))
export const dismissDepthReminder = (storage) => storage.set(DEPTH_REMINDER_KEY, true)

// ---- panel v2: harness / model lists and goal search ----

/** Installed harnesses: `orca agent installed --json` -> [{ id, name, default }]. */
export async function listHarnesses(deps) {
  const res = await orcaJson(deps, ['agent', 'installed'])
  return (res.agents ?? []).map((a) => ({ id: a.id, name: a.name ?? a.id, default: Boolean(a.default) }))
}

// No stock API lists models: seed the stable ids and always let the person type one.
export const MODEL_SEEDS = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2-codex']
}
const MODELS_TTL_MS = 10 * 60_000

/** `opencode models` prints one `provider/id` per line. */
export const parseModelLines = (stdout) =>
  [...new Set(String(stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)))]

/** `agy models` prints `<id>\t<label>` per line (after a "Fetching…" line). */
export const parseAgyModels = (stdout) =>
  String(stdout ?? '').split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 2 && /^\S+$/.test(c[0])).map(([id, label]) => ({ id, label: label.trim() }))

/** `pi --list-models` prints a `provider  model  …` table under a header row; Orca takes `provider/id`. */
export const parsePiModels = (stdout) =>
  String(stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0] !== 'provider').map((c) => ({ id: `${c[0]}/${c[1]}` }))

/** Harnesses whose models are account-scoped: ask their own CLI. */
const MODEL_PROBES = {
  opencode: { file: 'opencode', args: ['models'], parse: (out) => parseModelLines(out).map((id) => ({ id })) },
  antigravity: { file: 'agy', args: ['models'], parse: parseAgyModels },
  pi: { file: 'pi', args: ['--list-models'], parse: parsePiModels }
}

/**
 * Extra model ids per harness from the person's own `~/.mte/models.json` (`{ "claude": ["gateway/model", …] }`):
 * ids no CLI can list, such as models a custom launch command routes to another provider. Missing or invalid: none.
 */
export function readExtraModels(deps, agent) {
  try {
    const read = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
    const ids = JSON.parse(read(join(deps.homedir ?? homedir(), '.mte', 'models.json')))[agent]
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id && !/\s/.test(id)) : []
  } catch {
    return []
  }
}

/** Models + effort values for one harness; probed lists are cached in plugin storage. */
export async function listModels(deps, { agent }) {
  let models = (MODEL_SEEDS[agent] ?? []).map((id) => ({ id }))
  const probe = MODEL_PROBES[agent]
  if (probe) {
    const key = `models:${agent}`
    const cached = await deps.storage?.get(key)
    if (cached?.models && Date.now() - cached.at < MODELS_TTL_MS) {
      models = cached.models
    } else {
      const res = await tryExec(deps, probe.file, probe.args, { timeoutMs: 30_000 })
      models = res.code === 0 ? probe.parse(res.stdout) : []
      if (models.length) {
        await deps.storage?.set(key, { at: Date.now(), models })
      }
    }
  }
  const extra = readExtraModels(deps, agent).filter((id) => !models.some((m) => m.id === id))
  return { models: [...models, ...extra.map((id) => ({ id }))], efforts: effortsFor(agent), takesModel: takesModel(agent) }
}

/** `owner/repo` of a GitHub remote url (https or ssh), else null. */
export function parseGithubRepo(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(String(url ?? ''))
  return m ? `${m[1]}/${m[2]}` : null
}

const LIMIT = 5

/**
 * One merged suggestion list for the goal box: Linear issues (`orca linear search`) plus GitHub PRs and issues
 * (`gh search`, scoped to the workspace's GitHub remote). A source that fails is omitted and named in `hints`.
 * `isStale()` is checked after the awaits: a superseded call resolves { stale: true } and the panel drops it.
 */
export async function searchGoal(deps, { q }, { isStale = () => false } = {}) {
  const query = String(q ?? '').trim()
  if (query.length < 2) {
    return { items: [], hints: [] }
  }
  const ws = await resolveWorkspace(deps.host).catch(() => null)
  const hints = []
  const linear = async () => {
    try {
      const res = await orcaJson(deps, ['linear', 'search', query, '--limit', String(LIMIT), '--workspace', 'all'])
      return (res.issues ?? []).slice(0, LIMIT).map((i) => ({ kind: 'linear', id: i.identifier, title: i.title, url: i.url }))
    } catch {
      hints.push('Linear is not connected (or unavailable): connect it in Orca to search issues.')
      return []
    }
  }
  const github = async () => {
    const remote = ws && (await tryExec(deps, 'git', ['-C', ws.path, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 }).catch(() => null))
    const repo = remote?.code === 0 ? parseGithubRepo(remote.stdout) : null
    if (!repo) {
      hints.push('No GitHub remote found in this workspace: PRs and issues are not searched.')
      return []
    }
    const one = async (kind, sub) => {
      const res = await tryExec(deps, 'gh', ['search', sub, query, '--repo', repo, '--limit', String(LIMIT), '--json', 'number,title,url'], { timeoutMs: 15_000 })
      if (res.missing || res.code !== 0) {
        throw new Error('gh')
      }
      return JSON.parse(res.stdout).map((r) => ({ kind, id: `#${r.number}`, title: r.title, url: r.url }))
    }
    const [prs, issues] = await Promise.allSettled([one('pr', 'prs'), one('issue', 'issues')])
    if (prs.status === 'rejected' || issues.status === 'rejected') {
      hints.push('GitHub search failed: is `gh` installed and logged in (`gh auth login`)?')
    }
    return [...(prs.value ?? []), ...(issues.value ?? [])]
  }
  const [lin, gh] = await Promise.all([linear(), github()])
  if (isStale()) {
    return { stale: true, items: [], hints: [] }
  }
  return { items: [...lin, ...gh], hints }
}
