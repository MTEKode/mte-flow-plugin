// Pure logic for the MTE Flow plugin. No Orca imports: every side effect comes in through `deps`
// ({ exec, host, settings }) so the tests can stub child_process and the host API.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

/** `/mte-flow <goal>`, with the goal cut (and marked) so the whole prompt fits the host cap. */
export function buildBootstrapPrompt(goal) {
  const prefix = '/mte-flow '
  const text = String(goal).trim()
  if (prefix.length + text.length <= PROMPT_MAX) {
    return prefix + text
  }
  let cut = text.slice(0, PROMPT_MAX - prefix.length - TRUNCATION_MARKER.length)
  // Do not leave half a surrogate pair behind.
  if (/[\uD800-\uDBFF]$/.test(cut)) {
    cut = cut.slice(0, -1)
  }
  return prefix + cut + TRUNCATION_MARKER
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

/** execFile as a promise: resolves { code, stdout, stderr } (never rejects on a non-zero exit); rejects with ENOENT when the binary is missing. */
export function defaultExec(file, args, { cwd, env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, env: env ? { ...process.env, ...env } : undefined, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
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

/** Reads the six plugin settings, with their defaults. */
export async function readSettings(host) {
  const raw = (await host.settings()) ?? {}
  const str = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
  return {
    plannerAgent: str(raw.plannerAgent, 'claude'),
    plannerModel: str(raw.plannerModel),
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
  if (!settings.workerModel) {
    return null
  }
  const args = ['pin', 'set', '--agent', settings.workerAgent, '--model', settings.workerModel]
  // opencode has no reasoning-effort knob: drop it.
  if (settings.workerAgent !== 'opencode' && settings.workerEffort) {
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
 * Start a run with a terminal planner: `mte planner show` (a live claim stops the run), `mte install`, `mte pin set`,
 * `mte planner release`, then the planner launch with `/mte-flow <goal>`. With `replace: true` an existing claim is
 * released instead of stopping the run.
 */
export async function startRun(deps, { goal, plannerAgent, plannerModel, replace = false } = {}) {
  const settings = await readSettings(deps.host)
  if (plannerAgent) {
    settings.plannerAgent = plannerAgent
  }
  if (plannerModel !== undefined) {
    settings.plannerModel = plannerModel
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
  if (existing.claim?.claimed && !replace) {
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
  const prompt = buildBootstrapPrompt(goal)
  try {
    const terminalId = await launchPlanner(deps, ws, settings, prompt)
    return { ok: true, workspace: ws, terminalId, pinned: Boolean(pin), truncated: prompt.endsWith(TRUNCATION_MARKER) }
  } catch (error) {
    return fail('launch', String(error?.code ?? 'action_failed'), String(error?.message ?? error))
  }
}

/**
 * Starts the planner terminal with its prompt. The host's `agent.launch` opens the terminal and then
 * sends the prompt in a second, fire-and-forget call whose failure is only logged (QA: the prompt never
 * arrived), so the orca CLI's single `agent launch --prompt` call is the primary path. The host API is
 * only the fallback when the CLI cannot be found.
 */
async function launchPlanner(deps, ws, settings, prompt) {
  const args = ['agent', 'launch', '--agent', settings.plannerAgent, '--worktree', `path:${ws.path}`, '--surface', 'terminal', '--prompt', prompt]
  if (settings.plannerModel) {
    args.push('--model', settings.plannerModel)
  }
  try {
    const result = await orcaJson(deps, args)
    const handle = result?.outcome?.handle
    if (!handle) {
      throw new MteError('orca_failed', 'The orca CLI did not report the launched terminal.')
    }
    return handle
  } catch (error) {
    if (error?.code !== 'orca_missing') {
      throw error
    }
  }
  const { terminalId } = await deps.host.call('agent.launch', { workspaceId: ws.id, agent: settings.plannerAgent, prompt })
  return terminalId
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

export const isActiveWorker = (w) => w.outcome === 'in_progress' && w.liveness !== 'dead'

/** Runs and workers from the stock orchestration CLI. Never throws: failures come back as `error`. */
export async function listOrchestration(deps) {
  try {
    const [workers, runs] = await Promise.all([
      orcaJson(deps, ['orchestration', 'worker-list', '--limit', '100']),
      orcaJson(deps, ['orchestration', 'run-list'])
    ])
    return {
      workers: (workers.workers ?? []).map((w) => ({
        dispatchId: w.dispatchId,
        taskId: w.taskId ?? '',
        agent: w.agent ?? '',
        state: w.state ?? '',
        outcome: w.outcome ?? '',
        liveness: w.liveness ?? '',
        workspace: w.workspace ?? '',
        active: isActiveWorker(w)
      })),
      runs: (runs.runs ?? []).slice(0, 10).map((r) => ({ id: r.id, objective: r.objective ?? '' })),
      error: null
    }
  } catch (error) {
    return { workers: [], runs: [], error: { code: error?.code ?? 'orca_failed', message: String(error?.message ?? error) } }
  }
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
  const n = workers.filter((w) => w.active).length
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
