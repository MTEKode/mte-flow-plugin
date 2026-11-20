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
export const INSTALL_HINT = 'npm i -g @mtekode/mte'

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

/** Start a run with a terminal planner: `mte install`, `mte pin set`, then the planner launch with `/mte-flow <goal>`. */
export async function startRun(deps, { goal, plannerAgent, plannerModel } = {}) {
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

/** `mte` present? ENOENT is the only "missing" signal; any exit status means the binary ran. */
export async function checkMte(deps, settings) {
  try {
    await deps.exec(settings.mteBin, ['--version'], { timeoutMs: 15_000 })
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
