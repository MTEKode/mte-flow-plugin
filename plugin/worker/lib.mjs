// Pure logic for the MTE Flow plugin. No Orca imports: every side effect comes in through `deps`
// ({ exec, host, settings }) so the tests can stub child_process and the host API.
import { execFile } from 'node:child_process'

// agent.launch and workspace.create cap prompts at 4096 chars; stay well under it.
export const PROMPT_MAX = 4000
export const TRUNCATION_MARKER = '\n[goal truncated]'
export const INSTALL_HINT = 'npm i -g @mtekode/mte'
export const ORCA_APP_BIN = '/Applications/Orca.app/Contents/Resources/bin/orca'

/** `/mte <goal>`, with the goal cut (and marked) so the whole prompt fits the host cap. */
export function buildBootstrapPrompt(goal) {
  const prefix = '/mte '
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
export function defaultExec(file, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
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

export function installArgs(settings, agents) {
  const list = [...new Set(agents ?? [settings.plannerAgent, settings.workerAgent])]
  return ['install', '--agents', list.join(',')]
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
  const err = await runMte(deps, settings, 'install', installArgs(settings), ws.path)
  return err ?? { ok: true, workspace: ws }
}

/** Start a run with a terminal planner: `mte install`, `mte pin set`, then `agent.launch` with `/mte <goal>`. */
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
  const installErr = await runMte(deps, settings, 'install', installArgs(settings), ws.path)
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
    const { terminalId } = await deps.host.call('agent.launch', {
      workspaceId: ws.id,
      agent: settings.plannerAgent,
      prompt
    })
    return { ok: true, workspace: ws, terminalId, pinned: Boolean(pin), truncated: prompt.endsWith(TRUNCATION_MARKER) }
  } catch (error) {
    return fail('launch', String(error?.code ?? 'action_failed'), String(error?.message ?? error))
  }
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

/** Runs the stock `orca` CLI (it finds the app through its own runtime file, so the scrubbed worker env is fine). */
async function orcaJson(deps, args) {
  let res
  for (const bin of deps.orcaBins ?? ['orca', ORCA_APP_BIN]) {
    try {
      res = await deps.exec(bin, [...args, '--json'], { timeoutMs: 20_000 })
      break
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  if (!res) {
    throw new MteError('orca_missing', 'The `orca` CLI was not found on PATH.')
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
