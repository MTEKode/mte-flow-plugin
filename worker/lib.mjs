// Pure logic for the MTE Flow plugin. No Orca imports: every side effect comes in through `deps`
// ({ exec, host, settings }) so the tests can stub child_process and the host API.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkspaceArgs, goalSlug, parseRef } from '../panel/logic.mjs'

// agent.launch and workspace.create cap prompts at 4096 chars; stay well under it.
export const PROMPT_MAX = 4000
export const TRUNCATION_MARKER = '\n[goal truncated]'
/** The mte CLI version this plugin release is built for; the setup installs it when `mte` is missing or older. */
export const REQUIRED_MTE_VERSION = '0.8.15'
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
  const planner = describeChoice(settings.plannerAgent, settings.plannerModel, settings.plannerModel && effortsFor(settings.plannerAgent).length ? settings.plannerEffort : '')
  const worker = describeChoice(settings.workerAgent, settings.workerModel, settings.workerModel && effortsFor(settings.workerAgent).length ? settings.workerEffort : '')
  const qa = describeChoice(settings.qaAgent, settings.qaModel, settings.qaModel && effortsFor(settings.qaAgent).length ? settings.qaEffort : '')
  return `(Run setup from the MTE Flow panel. Orchestrator: ${planner}. Coder workers: ${worker}. QA and validator workers: ${qa}. State all three in your first reply.)`
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
 * How to start `file` on Windows, where npm-installed CLIs (`mte`, `npm`) are `.cmd` shims that Node will
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
  // Orca's own antigravity catalog offers these three for `--effort`
  antigravity: ['low', 'medium', 'high']
}
export const effortsFor = (agent) => EFFORTS[agent] ?? []
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
    qaAgent: str(raw.qaAgent, 'claude'),
    qaModel: str(raw.qaModel),
    qaEffort: str(raw.qaEffort),
    mteBin: str(raw.mteBin, 'mte')
  }
}

/** The focused workspace as `workspace.list` knows it (its id is what the other workspace methods take), or null. */
export async function resolveWorkspace(host) {
  const ctx = (await host.call('workspace.readContext', {})) ?? host.lastContext?.() ?? null
  if (!ctx) {
    return null
  }
  const { workspaces } = await host.call('workspace.list', {})
  const row =
    workspaces.find((w) => ctx.workspaceId && w.id === ctx.workspaceId) ??
    workspaces.find((w) => w.branch === ctx.branch && w.name === ctx.displayName)
  if (row) {
    return { id: row.id, name: row.name, path: row.path, branch: row.branch }
  }
  // not on this machine: a workspace of a paired Orca server (shown in this sidebar) is found on that server
  return host.findRemote ? host.findRemote(ctx) : null
}

const stripRef = (b) => String(b ?? '').replace(/^refs\/heads\//, '')

/**
 * The focused workspace when it lives on a paired Orca server: each server's `worktree list` is searched for the same
 * instance id (the last segment of Orca's `identity:wt2:<host>:<instance>` ids), then for the same name and branch.
 * `env` marks it remote: mte runs there through an Orca terminal, never on this machine. null when no server has it.
 */
export async function findRemoteWorkspace(deps, ctx) {
  const instance = String(ctx?.workspaceId ?? '').split(':').pop()
  const envs = (await orcaJson(deps, ['environment', 'list']).catch(() => null))?.environments ?? []
  for (const e of envs) {
    const rows = (await orcaJson(deps, ['worktree', 'list', '--environment', e.id]).catch(() => null))?.worktrees ?? []
    const hit =
      rows.find((w) => instance && (w.instanceId === instance || w.identity?.instanceId === instance)) ??
      rows.find((w) => (w.displayName ?? w.name) === ctx.displayName && stripRef(w.branch) === stripRef(ctx.branch))
    if (hit) {
      return { id: hit.id, name: hit.displayName ?? ctx.displayName, path: hit.path, branch: stripRef(hit.branch), env: e.id, host: e.name || e.id, selector: hit.id }
    }
  }
  return null
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

/** Wires the Claude skill, hook and memory MCP; install is idempotent. */
export function installArgs() {
  return ['install']
}

/** `mte pin set` argv for one worker role (`coder` reads the worker* settings, `qa` the qa* ones); null without a model. */
export function pinArgs(settings, role = 'coder') {
  const k = role === 'qa' ? 'qa' : 'worker'
  if (!settings[`${k}Model`]) {
    return null
  }
  const args = ['pin', 'set', '--agent', settings[`${k}Agent`], '--model', settings[`${k}Model`], ...(role === 'qa' ? ['--role', 'qa'] : [])]
  // only the EFFORTS harnesses take an effort: drop it for the rest
  if (effortsFor(settings[`${k}Agent`]).length && settings[`${k}Effort`]) {
    args.push('--effort', settings[`${k}Effort`])
  }
  return args
}

/** Pins the coder and the qa worker in `cwd`: the first error result, or { pinned } (whether any pin was set). */
async function applyPins(deps, settings, cwd) {
  let pinned = false
  for (const role of ['coder', 'qa']) {
    const pin = pinArgs(settings, role)
    if (pin) {
      const err = await runMte(deps, settings, 'pin', pin, cwd)
      if (err) {
        return { err }
      }
      pinned = true
    }
  }
  return { pinned }
}

const CHOICE_SETTINGS = ['plannerAgent', 'plannerModel', 'plannerSurface', 'plannerEffort', 'workerAgent', 'workerModel', 'workerEffort', 'qaAgent', 'qaModel', 'qaEffort']

/** The run's links: each ref parsed (trust boundary: the panel's text is re-parsed here), or an error naming the bad one. */
/** A goal written from the run's links when the person wrote none: the planner reads each linked item. */
export function goalFromLinks(refs) {
  const list = (Array.isArray(refs) ? refs : []).map((r) => String(r).trim()).filter(Boolean)
  return list.length === 1 ? `Work on the linked item: ${list[0]}` : `Work on the linked items: ${list.join(', ')}`
}

/** The run's links plus the Linear issues and GitHub PRs/issues the goal itself names by URL (a goal that is just a ticket URL links that ticket). */
export function withGoalLinks(links, goal) {
  const out = [...links]
  for (const url of String(goal ?? '').match(/https?:\/\/\S+/gi) ?? []) {
    const ref = parseRef(url)
    if (ref && ref.kind !== 'reference' && !out.some((l) => l.kind === ref.kind && l.value === ref.value)) {
      out.push(ref)
    }
  }
  return out
}

export function parseLinks(refs) {
  const parsed = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    const link = parseRef(ref)
    if (!link) {
      return { error: `“${String(ref).slice(0, 60)}” is not an identifier or URL.` }
    }
    parsed.push(link)
  }
  return { links: parsed }
}

/** Attaches the run's links to `ws`; failures come back as text, never stop the run. */
async function attachLinks(deps, ws, links) {
  const failures = []
  for (const link of links) {
    try {
      await orcaJson(deps, linkAddArgs(ws, link))
    } catch (error) {
      failures.push(`${link.value} (${String(error?.message ?? error)})`)
    }
  }
  return failures
}

/** Install MTE in the focused workspace. */
export async function installInWorkspace(deps) {
  const settings = await readSettings(deps.host)
  const ws = await resolveWorkspace(deps.host)
  if (!ws) {
    return fail('workspace', 'no_workspace', 'No workspace is focused.')
  }
  if (ws.env) {
    // a paired server's workspace: install there, in an Orca terminal of that workspace
    deps.progress?.(`Installing mte on ${ws.host}…`)
    const err = await remoteSetup(deps, ws, settings)
    return err ? fail('setup', err.code, err.message) : { ok: true, workspace: ws }
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
    claim.terminalHandle && `terminal ${claim.terminalHandle}`
  ].filter(Boolean)
  return parts.join(' / ') || 'an unknown caller'
}

/** `mte planner show --json`: { claimed: false } or the claim; a result error when it cannot be read. */
export async function readClaim(deps, settings, cwd) {
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
  let { goal } = input
  const { replace = false, newWorkspace = false } = input
  const settings = await readSettings(deps.host)
  // the panel's selection beats the settings (which only seed it)
  for (const key of CHOICE_SETTINGS) {
    if (typeof input[key] === 'string') {
      settings[key] = input[key].trim()
    }
  }
  if (!SURFACES.includes(settings.plannerSurface)) {
    settings.plannerSurface = 'chat'
  }
  const { links: chips, error: linkError } = parseLinks(input.links)
  if (linkError) {
    return fail('input', 'bad_link', linkError)
  }
  if (!String(goal ?? '').trim() && !chips.length) {
    return fail('input', 'empty_goal', 'Write a goal or add a link.')
  }
  // the links are the goal when none is written: the planner reads the linked tickets first anyway
  const written = String(goal ?? '').trim()
  goal = written || goalFromLinks(input.links)
  // a generated goal names the workspace by its links (eng-1091), not by the "Work on…" wrapper
  input = { ...input, goal, slugSource: written || (input.links ?? []).join(' ') }
  const links = withGoalLinks(chips, goal)
  const ws = await resolveWorkspace(deps.host)
  if (newWorkspace) {
    // a new workspace needs a repo, not a focused workspace: the panel's repo choice wins, the focused one is the fallback
    return startRunInNewWorkspace(deps, settings, ws, input, links)
  }
  if (!ws) {
    return fail('workspace', 'no_workspace', 'No workspace is focused.')
  }
  if (ws.env) {
    return startRunOnRemote(deps, settings, ws, input, links)
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
  const { err: pinErr, pinned } = await applyPins(deps, settings, ws.path)
  if (pinErr) {
    return pinErr
  }
  const linkFailures = await attachLinks(deps, ws, links)
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
    await recordLaunch(deps, launched.sessionId ?? launched.terminalId, launchRecord(goal, ws, settings))
    return { ok: true, workspace: ws, ...launched, pinned, truncated: prompt.includes(TRUNCATION_MARKER), replacedStale: Boolean(stale), linkFailures }
  } catch (error) {
    return fail('launch', String(error?.code ?? 'action_failed'), String(error?.message ?? error))
  }
}

/**
 * Start run in a focused workspace of a paired Orca server: mte cannot run here, so the setup line (install, user
 * skill, pins) runs in an Orca terminal of that workspace, then the planner launches there. The planner claim check
 * stays with the planner itself (its skill claims first and stops on a live claim), since `mte planner show` cannot run here.
 */
async function startRunOnRemote(deps, settings, ws, input, links) {
  deps.progress?.(`Preparing mte on ${ws.host}…`)
  const setupErr = await remoteSetup(deps, ws, settings)
  if (setupErr) {
    return fail('setup', setupErr.code, setupErr.message)
  }
  const linkFailures = await attachLinks(deps, ws, links)
  const prompt = buildBootstrapPrompt(input.goal, setupNote(settings))
  try {
    const launched = await launchPlanner(deps, ws, settings, prompt)
    await recordLaunch(deps, launched.sessionId ?? launched.terminalId, launchRecord(input.goal, ws, settings))
    return { ok: true, workspace: ws, ...launched, pinned: Boolean(pinArgs(settings, 'coder') || pinArgs(settings, 'qa')), truncated: prompt.includes(TRUNCATION_MARKER), linkFailures }
  } catch (error) {
    return fail('launch', String(error?.code ?? 'action_failed'), String(error?.message ?? error))
  }
}

/** What recordLaunch remembers about a planner start. */
function launchRecord(goal, ws, settings) {
  return {
    goal: String(goal).trim().slice(0, 200),
    workspacePath: ws.path,
    at: Date.now(),
    ...Object.fromEntries(CHOICE_SETTINGS.map((k) => [k, settings[k]]))
  }
}

const envArgs = (env) => (env ? ['--environment', env] : [])

const iconCache = new Map()

/**
 * A project icon as a data: URL (the panel frame cannot be trusted to load remote images), fetched once per src.
 * null on any failure, too-large image or non-image answer: the panel then draws the letter badge.
 */
async function iconData(deps, src) {
  if (!/^https:\/\//.test(String(src ?? ''))) {
    return null
  }
  if (!iconCache.has(src)) {
    iconCache.set(
      src,
      (async () => {
        try {
          const res = await (deps.fetch ?? globalThis.fetch)(src, { signal: AbortSignal.timeout(5_000) })
          const type = res.headers.get('content-type') ?? ''
          const buf = Buffer.from(await res.arrayBuffer())
          return res.ok && type.startsWith('image/') && buf.length <= 256 * 1024 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null
        } catch {
          return null
        }
      })()
    )
  }
  return iconCache.get(src)
}

/**
 * Git repos the new-workspace picker offers, on every host Orca reaches: this machine and its SSH targets (`project
 * setups`), plus each paired Orca server (`project setups --environment <id>`). Each row carries what the picker
 * draws like Orca does: the project icon (or its badge color), the host's platform and whether it is a server. `key`
 * (`<env|local>|<setup id>`) is what the panel sends back; a server that does not answer is skipped. Older Orca
 * without project setups: `repo list`.
 */
export async function listRepos(deps) {
  const soft = (p) => p.catch(() => null)
  const [setups, environments, hosts, projects] = await Promise.all([
    soft(orcaJson(deps, ['project', 'setups'])),
    soft(orcaJson(deps, ['environment', 'list'])),
    soft(orcaJson(deps, ['host', 'list'])),
    soft(orcaJson(deps, ['project', 'list']))
  ])
  const hostRow = (id) => (hosts?.hosts ?? []).find((h) => h.id === id)
  const rows = async (list, projectList, { env = null, envName = '', envPlatform = null } = {}) =>
    Promise.all(
      (list ?? [])
        .filter((r) => (r.kind ?? 'git') === 'git' && (r.setupState ?? 'ready') === 'ready')
        .map(async (r) => {
          const hostId = r.hostId ?? 'local'
          const project = (projectList ?? []).find((p) => p.id === r.projectId)
          const icon = project?.repoIcon?.type === 'image' ? await iconData(deps, project.repoIcon.src) : null
          const sshName = hostId === 'local' ? null : hostRow(hostId)?.name ?? hostId.replace(/^ssh:/, '')
          return {
            key: `${env ?? 'local'}|${r.id}`,
            env,
            setupId: r.id,
            repoId: r.repoId ?? null,
            hostId,
            name: r.displayName || project?.displayName || String(r.path ?? '').split(/[\\/]/).pop(),
            host: env ? (sshName ? `${envName} › ${sshName}` : envName) : sshName ?? 'this machine',
            platform: (env ? (sshName ? null : envPlatform) : (hostRow(hostId)?.platform ?? (hostId === 'local' ? process.platform : null))) || null,
            server: Boolean(env) || hostId !== 'local',
            icon,
            color: project?.badgeColor ?? null,
            path: r.path ?? ''
          }
        })
    )
  if (!setups) {
    const legacy = await soft(orcaJson(deps, ['repo', 'list']))
    return (legacy?.repos ?? [])
      .filter((r) => (r.kind ?? 'git') === 'git')
      .map((r) => ({ key: `local|${r.id}`, env: null, setupId: null, repoId: r.id, hostId: 'local', name: r.displayName || r.path.split(/[\\/]/).pop(), host: 'this machine', platform: process.platform, server: false, icon: null, color: r.badgeColor ?? null, path: r.path }))
  }
  const remote = await Promise.all(
    (environments?.environments ?? []).map(async (e) => {
      const [envSetups, envProjects, envHost] = await Promise.all([
        soft(orcaJson(deps, ['project', 'setups', '--environment', e.id])),
        soft(orcaJson(deps, ['project', 'list', '--environment', e.id])),
        soft(orcaJson(deps, ['host', 'name', '--environment', e.id]))
      ])
      return rows(envSetups?.setups, envProjects?.projects, { env: e.id, envName: e.name || envHost?.machineName || e.id, envPlatform: envHost?.platform ?? null })
    })
  )
  return [...(await rows(setups.setups, projects?.projects)), ...remote.flat()]
}

/** True when work for this picker entry runs on this machine (so `mte` can be run here directly). */
export const isLocalRepo = (repo) => !repo.env && (repo.hostId ?? 'local') === 'local'

/** The picker entry a focused (local) workspace belongs to: Orca ids are `<repoId>::<path>`; the path prefix is the fallback. */
export function repoOfWorkspace(repos, ws) {
  if (!ws) {
    return null
  }
  const local = repos.filter(isLocalRepo)
  return local.find((r) => r.repoId && String(ws.id ?? '').startsWith(`${r.repoId}::`)) ?? local.find((r) => ws.path === r.path || String(ws.path ?? '').startsWith(`${r.path}/`)) ?? null
}

/** `worktree show`'s row for the focused workspace: the repo id (`worktree create --repo` needs it; path: only resolves main checkouts, live-probed). */
export async function workspaceRow(deps, ws) {
  const shown = await orcaJson(deps, ['worktree', 'show', ...worktreeTarget(ws)])
  return { repoId: shown?.worktree?.repoId ?? null }
}

/**
 * Start run in a fresh workspace: `orca worktree create` (name or goal slug, base branch, --no-parent, the run's
 * slot links as flags; reference chips attach right after via `orca reference add` — create cannot combine them,
 * live-probed), then `mte install`/`mte pin set` against the NEW path and the planner launch there. A brand-new
 * worktree can hold no planner claim, so the claim pre-check is skipped. A step that fails after creation reports
 * the created worktree's name; it is never auto-deleted.
 */
async function startRunInNewWorkspace(deps, settings, ws, input, links) {
  const name = String(input.workspaceName ?? '').trim() || goalSlug(String(input.slugSource ?? input.goal ?? ''))
  const key = String(input.repoKey ?? (input.repoId ? `local|${input.repoId}` : '')).trim()
  let repoId = null
  let repo = null
  if (key) {
    // trust boundary: only a repo Orca lists, on a host it reaches
    repo = (await listRepos(deps)).find((r) => r.key === key || (r.repoId && `local|${r.repoId}` === key && isLocalRepo(r))) ?? null
    if (!repo) {
      return fail('input', 'bad_repo', 'Pick the repo for the new workspace from the list.')
    }
    repoId = repo.repoId
  } else {
    if (!ws) {
      return fail('input', 'no_repo', 'Pick the repo for the new workspace.')
    }
    const refused = checkWorkspaceTarget(deps, ws)
    if (refused) {
      return refused
    }
    let row
    try {
      row = await workspaceRow(deps, ws)
    } catch (error) {
      return fail('create', 'worktree_read_failed', `Could not read the focused workspace: ${String(error?.message ?? error)}`)
    }
    if (!row.repoId) {
      return fail('create', 'no_repo', `The focused workspace ${ws.name} does not report a repo id: pick the repo for the new workspace.`)
    }
    repoId = row.repoId
  }
  const env = repo?.env ?? null
  const { argv, deferred } = createWorkspaceArgs({ name, repoId, setupId: repo?.setupId, base: input.baseBranch, links })
  let created
  try {
    created = (await orcaJson(deps, [...argv, ...envArgs(env)]))?.worktree
  } catch (error) {
    return fail('create', 'create_failed', String(error?.message ?? error))
  }
  if (!created?.id || !created?.path) {
    return fail('create', 'create_failed', 'The orca CLI did not report the created worktree.')
  }
  // raw id (never an `id:` prefix — 0.8.1): it is what worktree/agent selectors take
  const target = { id: created.id, name: created.displayName ?? name, path: created.path, selector: created.id, env }
  const createdNote = (message) => `New workspace “${target.name}” was created and stays; ${message}`
  const linkFailures = []
  for (const url of deferred) {
    try {
      await orcaJson(deps, ['reference', 'add', url, ...worktreeTarget(target), ...envArgs(env)])
    } catch (error) {
      linkFailures.push(`${url} (${String(error?.message ?? error)})`)
    }
  }
  let pinned = false
  if (!repo || isLocalRepo(repo)) {
    const installErr = await runMte(deps, settings, 'install', installArgs(), target.path)
    if (installErr) {
      return fail('install', installErr.error.code, createdNote(installErr.error.message))
    }
    const pins = await applyPins(deps, settings, target.path)
    if (pins.err) {
      return fail('pin', pins.err.error.code, createdNote(pins.err.error.message))
    }
    pinned = pins.pinned
  } else {
    // another machine: this plugin cannot run mte there, so an Orca terminal in the new workspace does it
    deps.progress?.(`Preparing mte on ${repo.host}…`)
    const setupErr = await remoteSetup(deps, target, settings)
    if (setupErr) {
      return fail('setup', setupErr.code, createdNote(setupErr.message))
    }
    pinned = Boolean(pinArgs(settings, 'coder') || pinArgs(settings, 'qa'))
  }
  const prompt = buildBootstrapPrompt(input.goal, setupNote(settings))
  try {
    const launched = await launchPlanner(deps, target, settings, prompt)
    await recordLaunch(deps, launched.sessionId ?? launched.terminalId, launchRecord(input.goal, target, settings))
    return { ok: true, workspace: target, ...launched, pinned, truncated: prompt.includes(TRUNCATION_MARKER), createdWorkspace: { id: target.id, name: target.name }, linkFailures }
  } catch (error) {
    return fail('launch', String(error?.code ?? 'action_failed'), createdNote(String(error?.message ?? error)))
  }
}

/** argv of `orca agent launch` for the planner (without `--json`, which orcaJson appends); `--focus` so the person sees it start (or fail). `--effort` needs `--model` and an agent that takes one. A created-workspace target carries its raw id as `selector`. */
export function launchArgs(ws, settings, prompt) {
  const args = ['agent', 'launch', '--agent', settings.plannerAgent, '--worktree', ws.selector ?? `path:${ws.path}`, '--surface', settings.plannerSurface, '--focus']
  if (settings.plannerModel) {
    args.push('--model', settings.plannerModel)
    if (settings.plannerEffort && effortsFor(settings.plannerAgent).length) {
      args.push('--effort', settings.plannerEffort)
    }
  }
  args.push('--prompt', prompt, ...envArgs(ws.env))
  return args
}

const SETUP_OK = 'MTE_SETUP_OK'
const SETUP_FAILED = 'MTE_SETUP_FAILED'

/** One shell line that installs the required mte, wires the repo and the user skill, and applies the pins; the markers are quoted in the line so only their output matches. */
export function remoteSetupLine(settings, { npm = true } = {}) {
  const steps = [
    ...(npm ? [['npm', 'i', '-g', tarballUrl(REQUIRED_MTE_VERSION)]] : []),
    ['mte', 'install'],
    ['mte', 'install', '--user'],
    ...['coder', 'qa'].map((role) => pinArgs(settings, role)).filter(Boolean).map((a) => ['mte', ...a])
  ]
  // trust boundary: agent, model and effort come from the panel and go through a remote shell, so only plain words pass
  const unsafe = steps.flat().find((a) => !/^[A-Za-z0-9_./:=@%+,-]+$/.test(String(a)))
  if (unsafe !== undefined) {
    return null
  }
  return `${steps.map((a) => a.join(' ')).join(' && ')} && echo MTE_SETUP_"OK" || echo MTE_SETUP_"FAILED"`
}

/**
 * Runs remoteSetupLine in an Orca terminal opened in `target` (on its own host: SSH or a paired server) and waits for
 * its marker. Closes the terminal on success; leaves it open on failure so the person can read why. null when ok.
 */
/** Runs one shell line in an Orca terminal of `target` and waits for its marker: `{ tail }` when it printed OK, `{ error, tail }` otherwise. Closes the terminal only on OK. */
async function runInTerminal(deps, target, line, { timeoutMs, pollMs }) {
  let handle
  try {
    const created = await orcaJson(deps, ['terminal', 'create', '--worktree', String(target.id), '--title', 'MTE setup', '--command', line, ...envArgs(target.env)])
    handle = created?.terminal?.handle
  } catch (error) {
    return { error: { code: 'remote_setup_failed', message: `Could not open a terminal to prepare mte there: ${String(error?.message ?? error)}` } }
  }
  if (!handle) {
    return { error: { code: 'remote_setup_failed', message: 'Orca did not report the setup terminal.' } }
  }
  const deadline = Date.now() + timeoutMs
  let tail = []
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const read = await orcaJson(deps, ['terminal', 'read', '--terminal', handle, '--limit', '60', ...envArgs(target.env)]).catch(() => null)
    tail = (read?.terminal?.tail ?? []).map((l) => String(l).trim())
    if (tail.includes(SETUP_OK)) {
      await orcaJson(deps, ['terminal', 'close', '--terminal', handle, ...envArgs(target.env)]).catch(() => null)
      return { tail }
    }
    if (tail.includes(SETUP_FAILED)) {
      const why = tail.filter((l) => l && l !== SETUP_FAILED).slice(-4).join(' | ')
      return { tail, error: { code: 'remote_setup_failed', message: `Preparing mte there failed (its terminal “MTE setup” stays open): ${why.slice(0, 400)}` } }
    }
  }
  return { tail, error: { code: 'remote_setup_timeout', message: 'Preparing mte there did not finish in 5 minutes; its terminal “MTE setup” stays open.' } }
}

/**
 * Prepares mte in `target` (a workspace on another machine): first asks that machine's `mte --version`, and installs
 * the release with npm only when it is missing or older (a dev `npm link` there stays as it is); then wires the repo,
 * the user skill and the pins. null when ok.
 */
async function remoteSetup(deps, target, settings, { timeoutMs = 300_000, pollMs = deps.pollMs ?? 3_000 } = {}) {
  if (!remoteSetupLine(settings)) {
    return { code: 'bad_pin', message: 'A worker agent, model or effort has characters that cannot be passed to a remote shell; pick plain ids.' }
  }
  const probe = await runInTerminal(deps, target, `mte --version && echo MTE_SETUP_"OK" || echo MTE_SETUP_"FAILED"`, { timeoutMs: 60_000, pollMs })
  const version = (probe.tail ?? []).find((l) => /^\d+\.\d+\.\d+$/.test(l))
  const npm = probe.error ? true : !version || compareVersions(version, REQUIRED_MTE_VERSION) < 0
  if (probe.error && probe.error.code !== 'remote_setup_failed') {
    return probe.error // no terminal at all: the setup line would not fare better
  }
  const run = await runInTerminal(deps, target, remoteSetupLine(settings, { npm }), { timeoutMs, pollMs })
  return run.error ?? null
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
    return { terminalId: handle, sessionId: result.outcome.sessionId, surface, fallback: surface !== settings.plannerSurface, dropped: [] }
  } catch (error) {
    if (error?.code !== 'orca_missing') {
      throw error
    }
  }
  // the host launcher only takes agent+prompt: name what the panel's selection loses to this fallback
  const dropped = []
  if (settings.plannerModel) {
    dropped.push(`model ${settings.plannerModel}`)
    if (settings.plannerEffort && effortsFor(settings.plannerAgent).length) {
      dropped.push(`effort ${settings.plannerEffort}`)
    }
  }
  if (settings.plannerSurface !== 'terminal') {
    dropped.push(`${settings.plannerSurface} surface`)
  }
  const { terminalId } = await deps.host.call('agent.launch', { workspaceId: ws.id, agent: settings.plannerAgent, prompt })
  return { terminalId, surface: 'terminal', fallback: settings.plannerSurface !== 'terminal', dropped }
}

/** `mte` usable? ENOENT means missing; a non-zero `--version` exit (e.g. a global npm install that Node cannot type-strip) means unusable. On success it reports the detected version and whether it drifts below REQUIRED_MTE_VERSION (possible with manual installs; the panel hints). */
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
    const version = parseVersion(res.stdout)?.join('.') ?? null
    return { missing: false, version, required: REQUIRED_MTE_VERSION, drift: version ? compareVersions(version, REQUIRED_MTE_VERSION) < 0 : false }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { missing: true, message: mteMissingError(settings.mteBin).message }
    }
    // a check that could not run is not a passing one: never report mte healthy on a swallowed error
    return { missing: true, unusable: true, message: `\`${settings.mteBin} --version\` could not run: ${String(error?.message ?? error)}. Install it: ${INSTALL_HINT}.` }
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
    // with --json orca reports the real reason as {"ok":false,"error":{...}} on stdout; stderr may only say "Command failed"
    let reason = ''
    try {
      const err = JSON.parse(res.stdout)?.error
      reason = err?.message ? `${err.code ? `${err.code}: ` : ''}${err.message}` : ''
    } catch {
      // not JSON: fall back to the raw text
    }
    throw new MteError('orca_failed', (reason || res.stderr || res.stdout || 'orca failed').trim().slice(0, 400))
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
      orcaJson(deps, ['orchestration', 'worker-list', '--terminal-state', 'active', '--limit', '100', '--full', '--include-remote']),
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
 * started from the panel that have none yet. A run is tied to its planner through the planner claim of the worktree its
 * workers run in; `launch` (what the planner and its workers were started with) is null for planners not started here.
 */
export async function listOrchestrators(deps) {
  const settings = await readSettings(deps.host)
  const [{ workers, runs, error }, launches, worktrees] = await Promise.all([
    listOrchestration(deps),
    liveLaunches(deps).catch(() => ({})),
    worktreeIndex(deps)
  ])
  const byRun = new Map()
  for (const w of workers) {
    byRun.set(w.runId, [...(byRun.get(w.runId) ?? []), w])
  }
  const used = new Set()
  const orchestrators = await Promise.all(
    [...byRun].map(async ([runId, list]) => {
      const home = plannerHome(worktrees, list[0].workspace)
      const [claim, phase] = await Promise.all([readClaim(deps, settings, home.path).catch(() => null), readPhase(deps, settings, home.path)])
      const key = [claim?.claim?.sessionId, claim?.claim?.terminalHandle].find((k) => k && launches[k])
      if (key) {
        used.add(key)
      }
      return { id: runId, title: runs.find((r) => r.id === runId)?.objective || runId, launch: key ? launches[key] : null, workers: list, phase, home: home.id }
    })
  )
  for (const [key, launch] of Object.entries(launches)) {
    if (!used.has(key)) {
      orchestrators.push({ id: key, title: launch.goal, launch, workers: [], phase: await readPhase(deps, settings, launch.workspacePath), home: null })
    }
  }
  const attention = await listAttention(deps, [...byRun.keys()], runs, orchestrators)
  return { orchestrators, attention, activeWorkers: workers.length, error }
}

/** Orca worktrees by id (`<repo>::<path>`) with their parent; empty when Orca cannot list them. */
async function worktreeIndex(deps) {
  try {
    const { worktrees = [] } = await orcaJson(deps, ['worktree', 'list'])
    return new Map(worktrees.map((w) => [w.id, { path: w.path, parent: w.parentWorktreeId ?? null }]))
  } catch {
    return new Map()
  }
}

/** The planner's worktree for a worker workspace: its parent when the coder runs in a child worktree, else itself. */
export function plannerHome(index, workspaceId) {
  const parent = index.get(workspaceId)?.parent
  const id = parent && index.has(parent) ? parent : workspaceId
  return { id, path: index.get(id)?.path ?? workspacePath(id) }
}

/** `mte phase show` in the planner's worktree: `{ phase, name }`, or null (no phase yet, older mte, any failure). */
async function readPhase(deps, settings, cwd) {
  if (!cwd) {
    return null
  }
  try {
    const res = await deps.exec(settings.mteBin, ['phase', 'show', '--json'], { cwd })
    const row = res.code === 0 ? JSON.parse(res.stdout) : null
    return Number.isInteger(row?.phase) ? { phase: row.phase, name: String(row.name ?? '') } : null
  } catch {
    return null
  }
}

const ASKING = new Set(['ask', 'escalation'])

/**
 * What needs a person, across runs: worker questions and escalations the planner has not handled, pending decision
 * gates, and settled workers whose terminal Orca still keeps (released with one click). Each source fails soft.
 */
export async function listAttention(deps, runIds, runs, orchestrators) {
  const title = (runId) => runs.find((r) => r.id === runId)?.objective || runId
  const home = (runId) => orchestrators.find((o) => o.id === runId)?.home ?? null
  const soft = (p) => p.catch(() => null)
  const perRun = await Promise.all(
    runIds.map(async (runId) => {
      const [inbox, gates] = await Promise.all([
        soft(orcaJson(deps, ['orchestration', 'inbox', '--run', runId])),
        soft(orcaJson(deps, ['orchestration', 'gate-list', '--run', runId, '--status', 'pending']))
      ])
      const asks = (inbox?.messages ?? [])
        .filter((m) => ASKING.has(m.type) && m.handled === false && String(m.to ?? '').startsWith('run:'))
        .map((m) => ({ kind: m.type, runId, run: title(runId), text: m.subject || m.body || m.id, workspace: home(runId) }))
      const pending = (gates?.gates ?? []).map((g) => ({ kind: 'gate', runId, run: title(runId), text: g.question || g.title || g.prompt || g.id, workspace: home(runId) }))
      return [...asks, ...pending]
    })
  )
  const kept = await Promise.all(['retained', 'reclaimable'].map((state) => soft(orcaJson(deps, ['orchestration', 'worker-list', '--terminal-state', state, '--limit', '100']))))
  const release = kept
    .flatMap((r) => r?.workers ?? [])
    .filter((w) => SETTLED_STATES.has(w.workerState))
    .map((w) => ({ kind: 'release', runId: w.runId ?? '', run: title(w.runId), text: `${w.taskId || w.dispatchId} finished (${w.workerState}); its terminal is still open`, dispatchId: w.dispatchId }))
  return [...perRun.flat(), ...release]
}

const SETTLED_STATES = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'abandoned'])
const DISPATCH_ID = /^ctx_[A-Za-z0-9]+$/

/** Releases a settled worker's terminal (`orca orchestration worker-release`); the id is re-checked here (trust boundary). */
export async function releaseWorker(deps, dispatchId) {
  if (!DISPATCH_ID.test(String(dispatchId ?? ''))) {
    return { ok: false, error: { code: 'bad_dispatch', message: `Not a dispatch id: ${String(dispatchId).slice(0, 40)}` } }
  }
  try {
    await orcaJson(deps, ['orchestration', 'worker-release', '--dispatch', dispatchId])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: { code: error?.code ?? 'orca_failed', message: String(error?.message ?? error) } }
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

/** Status-bar text; `warning` when any active worker needs attention (the tooltip names how many). */
export const statusText = (workers) => {
  const n = workers.length
  const attention = workers.filter((w) => w.attention).length
  return { n, text: n > 0 ? `MTE ${n}` : 'MTE', tone: n > 0 ? (attention ? 'warning' : 'accent') : 'neutral', attention }
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
const CONSENT_KEY = 'setupDeclined'
const SEED_KEY = 'settingsSeed'

/**
 * Single-poller helper: posts (the panel's `state.changed` reload) only when the serialized observable
 * state differs from what was posted last — workers, setup and the status text/tone.
 */
export function createPollPoster(post) {
  let last = null
  return (state) => {
    const key = JSON.stringify(state)
    if (key === last) {
      return false
    }
    last = key
    post()
    return true
  }
}

/**
 * Panel choices: stored selections beat the settings, but a settings change makes every stored override
 * stale — re-seed (drop them). First run: the seed is remembered and the settings win.
 */
export async function resolveChoices(storage, settings) {
  const seed = await storage.get(SEED_KEY)
  if (seed && JSON.stringify(seed) !== JSON.stringify(settings)) {
    await storage.set(SEED_KEY, settings)
    await storage.set('choices', {})
    return {}
  }
  if (!seed) {
    await storage.set(SEED_KEY, settings)
  }
  return (await storage.get('choices')) ?? {}
}

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

/** Where npm put the `mte` it just installed: `<prefix>/bin/mte`, or `<prefix>\\mte.cmd` on Windows; null when npm cannot say. */
async function npmGlobalMte(deps) {
  const res = await tryExec(deps, 'npm', ['prefix', '-g'], { timeoutMs: 15_000 })
  const prefix = res.code === 0 ? res.stdout.trim() : ''
  if (!prefix) {
    return null
  }
  return process.platform === 'win32' ? win32.join(prefix, 'mte.cmd') : `${prefix}/bin/mte`
}

/** Every `mte` on PATH, in lookup order (`where` on Windows, `which -a` elsewhere); [] when it cannot tell. */
async function mteOnPath(deps, bin) {
  const res = await tryExec(deps, process.platform === 'win32' ? 'where' : 'which', process.platform === 'win32' ? [bin] : ['-a', bin], { timeoutMs: 15_000 }).catch(() => null)
  return res?.code === 0 ? res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
}

/**
 * Why `mte --version` still answers wrong after `npm i -g`: almost always an older copy earlier on PATH (an old global
 * install, another Node's prefix, a leftover shim). Names both files, so the person removes the stale one; the plugin
 * never deletes it itself, and never just switches to the new path, because agents and hooks run `mte` from PATH.
 */
export async function shadowedMessage(deps, bin, required, current) {
  const [installedAt, onPath] = await Promise.all([npmGlobalMte(deps), mteOnPath(deps, bin)])
  if (current.missing) {
    return `mte ${required} was installed${installedAt ? ` at ${installedAt}` : ''} but \`${bin}\` is not on PATH: add npm's global bin folder (${installedAt ? installedAt.replace(/[\\/][^\\/]+$/, '') : 'see `npm prefix -g`'}) to PATH, then press Repair setup.`
  }
  const found = parseVersion(current.stdout)?.join('.') ?? firstLine(current)
  // compare folders, not files: npm leaves `mte`, `mte.cmd` and `mte.ps1` side by side on Windows
  const dir = (p) => p.replace(/[\\/][^\\/]+$/, '').toLowerCase()
  const stale = onPath.find((p) => !installedAt || dir(p) !== dir(installedAt)) ?? onPath[0]
  return `mte ${required} was installed${installedAt ? ` at ${installedAt}` : ''}, but \`${bin}\` on PATH runs ${found}${stale ? ` from ${stale}` : ''}. Remove that old copy (or put npm's global bin folder before it in PATH), then press Repair setup: agents and hooks run \`mte\` from PATH, so they would keep the old one.`
}

const folderOf = (p) => p.replace(/[\\/][^\\/]+$/, '')
const MTE_PACKAGE = '@mtekode/mte'

/** The npm prefix that owns an `mte` bin folder, when that prefix has our package installed: `<prefix>/bin` (POSIX) or `<prefix>` (Windows). */
function npmPrefixOwning(binDir, exists) {
  const win = process.platform === 'win32'
  const prefix = win ? binDir : folderOf(binDir)
  const pkg = win ? win32.join(prefix, 'node_modules', '@mtekode', 'mte', 'package.json') : `${prefix}/lib/node_modules/@mtekode/mte/package.json`
  try {
    return exists(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === MTE_PACKAGE ? prefix : null
  } catch {
    return null
  }
}

/** An MTE shim from before npm releases (the retired `~/.mte` flow): a small text file that names it. Anything else is left alone. */
function isOldMteShim(file) {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 4096)
    return /\.mte[\\/]bin|mte\.mjs|@mtekode\/mte|mte-flow/.test(text)
  } catch {
    return false
  }
}

/**
 * Brings every older MTE copy that PATH finds before npm's fresh one up to date: one installed by another npm prefix
 * (another Node, another global folder) is reinstalled into that same prefix; an old MTE shim is moved aside to
 * `<file>.old` (reversible, never deleted). A file that is not recognisably MTE is never touched. Returns what it did.
 */
export async function updateShadowingMte(deps, bin, required) {
  const exists = deps.exists ?? existsSync
  const fresh = await npmGlobalMte(deps)
  const done = []
  const seen = new Set()
  for (const file of await mteOnPath(deps, bin)) {
    const dir = folderOf(file)
    if (fresh && dir.toLowerCase() === folderOf(fresh).toLowerCase()) {
      break // ours comes first from here on: nothing after it is ever run
    }
    if (seen.has(dir.toLowerCase())) {
      continue // npm leaves mte, mte.cmd and mte.ps1 side by side: one decision per folder
    }
    seen.add(dir.toLowerCase())
    const version = await tryExec(deps, file, ['--version'], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: '' }))
    if (version.code === 0 && compareVersions(version.stdout, required) >= 0) {
      continue
    }
    const prefix = npmPrefixOwning(dir, exists)
    if (prefix) {
      const res = await tryExec(deps, 'npm', ['i', '-g', '--prefix', prefix, tarballUrl(required)], { timeoutMs: 300_000 })
      done.push(res.code === 0 ? `updated the mte in ${prefix} to ${required}` : `could not update the mte in ${prefix}: ${firstLine(res)}`)
      continue
    }
    const shims = (process.platform === 'win32' ? ['mte', 'mte.cmd', 'mte.ps1', 'mte.bat'].map((n) => win32.join(dir, n)) : [file]).filter((f) => exists(f))
    if (!shims.length || !shims.every(isOldMteShim)) {
      done.push(`left ${file} alone: it is not recognisably MTE`)
      continue
    }
    for (const shim of shims) {
      try {
        ;(deps.rename ?? renameSync)(shim, `${shim}.old`)
        done.push(`moved the old ${shim} aside to ${shim}.old`)
      } catch (error) {
        done.push(`could not move ${shim} aside: ${String(error?.message ?? error)}`)
      }
    }
  }
  return done
}

/** True when `mte --version` answers at least the version this plugin needs. */
export async function mteIsCurrent(deps) {
  const settings = await readSettings(deps.host)
  const res = await tryExec(deps, settings.mteBin, ['--version'], { timeoutMs: 15_000 })
  return !res.missing && res.code === 0 && compareVersions(res.stdout, REQUIRED_MTE_VERSION) >= 0
}

const firstLine = (res) => ((res.stderr || res.stdout || '').trim().split('\n')[0] ?? '').slice(0, 300)

/**
 * First-run setup: make sure `mte` >= REQUIRED_MTE_VERSION exists (installing the release tarball with the user's
 * own npm, never sudo), then `mte install --user` for the user-level skill. Remembered per mte version in plugin
 * storage; `force` (the Repair setup button) ignores that memory. `deps.progress(text)` reports each step.
 * Ok results carry the DETECTED version (what `mte --version` answers), not the required one.
 */
export async function ensureSetup(deps, { force = false } = {}) {
  const required = REQUIRED_MTE_VERSION
  const progress = (text) => deps.progress?.(text)
  const settings = await readSettings(deps.host)
  if (!force && (await deps.storage.get(setupKey(required)))) {
    // cheap read-only probe: report what is actually installed (it may be newer than required)
    const detected = parseVersion((await tryExec(deps, settings.mteBin, ['--version'], { timeoutMs: 15_000 })).stdout)?.join('.') ?? null
    return { ok: true, skipped: true, version: detected ?? required }
  }
  progress('Checking the mte CLI…')
  let current = await tryExec(deps, settings.mteBin, ['--version'], { timeoutMs: 15_000 })
  let installed = false
  let updated = []
  if (current.missing || current.code !== 0 || compareVersions(current.stdout, required) < 0) {
    // `npm i -g` changes the machine globally: never unattended. Activation reports needs-consent instead;
    // Run setup and Repair setup call this with force, which is the consent itself. "Not now" (dismiss) stays until then.
    if (!force) {
      const detected = parseVersion(current.stdout)?.join('.') ?? null
      if ((await deps.storage.get(CONSENT_KEY))?.version === required) {
        return { ok: true, declined: true, version: detected ?? required }
      }
      return { ok: true, needsConsent: true, version: detected ?? required, message: `mte ${required} is missing or too old. Installing it runs \`npm i -g\` (a global change) — press Run setup to allow it, or install it yourself: ${INSTALL_HINT}.` }
    }
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
    if (!current.missing && (current.code !== 0 || compareVersions(current.stdout, required) < 0)) {
      progress('Updating an older mte found on PATH…')
      updated = await updateShadowingMte(deps, settings.mteBin, required)
      current = await tryExec(deps, settings.mteBin, ['--version'], { timeoutMs: 15_000 })
    }
    if (current.missing || current.code !== 0 || compareVersions(current.stdout, required) < 0) {
      const tried = updated.length ? ` Tried: ${updated.join('; ')}.` : ''
      return fail('setup', current.missing ? 'mte_not_on_path' : 'mte_shadowed', `${await shadowedMessage(deps, settings.mteBin, required, current)}${tried}`)
    }
    installed = true
  }
  progress('Installing the mte-flow skill…')
  const skill = await tryExec(deps, settings.mteBin, ['install', '--user'], { timeoutMs: 30_000 })
  if (skill.code !== 0) {
    return fail('setup', 'user_install_failed', `\`mte install --user\` failed${firstLine(skill) ? `: ${firstLine(skill)}` : ''}.`)
  }
  await deps.storage.set(setupKey(required), { at: new Date().toISOString() })
  return { ok: true, version: parseVersion(current.stdout)?.join('.') ?? required, installed, updated }
}

export const isDepthReminderDismissed = async (storage) => Boolean(await storage.get(DEPTH_REMINDER_KEY))
export const dismissDepthReminder = (storage) => storage.set(DEPTH_REMINDER_KEY, true)

// ---- panel v2: harness / model lists and goal search ----

/** The only harnesses MTE Flow runs as planner or worker. */
export const HARNESSES = ['claude', 'antigravity']

/** Installed supported harnesses: `orca agent installed --json` -> [{ id, name, default }]. */
export async function listHarnesses(deps) {
  const res = await orcaJson(deps, ['agent', 'installed'])
  return (res.agents ?? []).filter((a) => HARNESSES.includes(a.id)).map((a) => ({ id: a.id, name: a.name ?? a.id, default: Boolean(a.default) }))
}

/** `harness.list` response: a failed listing surfaces as `error` (the panel hints), never as a silent empty list. */
export async function harnessList(deps) {
  try {
    return { harnesses: await listHarnesses(deps), error: null }
  } catch (error) {
    return { harnesses: [], error: String(error?.message ?? error) }
  }
}

// No stock API lists models: seed the stable ids and always let the person type one.
export const MODEL_SEEDS = {
  claude: ['fable', 'opus', 'sonnet', 'haiku']
}
const MODELS_TTL_MS = 10 * 60_000

/** `agy models` prints `<id>\t<label>` per line (after a "Fetching…" line). */
export const parseAgyModels = (stdout) =>
  String(stdout ?? '').split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 2 && /^\S+$/.test(c[0])).map(([id, label]) => ({ id, label: label.trim() }))

/** Harnesses whose models are account-scoped: ask their own CLI. */
const MODEL_PROBES = {
  antigravity: { file: 'agy', args: ['models'], parse: parseAgyModels }
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

/** Models + effort values for one harness; probed lists are cached in plugin storage. A failed probe comes back as `error`, not silent emptiness. */
export async function listModels(deps, { agent }) {
  let models = (MODEL_SEEDS[agent] ?? []).map((id) => ({ id }))
  let error = null
  const probe = MODEL_PROBES[agent]
  if (probe) {
    const key = `models:${agent}`
    const cached = await deps.storage?.get(key)
    if (cached?.models && Date.now() - cached.at < MODELS_TTL_MS) {
      models = cached.models
    } else {
      const res = await tryExec(deps, probe.file, probe.args, { timeoutMs: 30_000 })
      if (res.code === 0) {
        models = probe.parse(res.stdout)
      } else {
        error = res.missing ? `\`${probe.file}\` is not on PATH` : firstLine(res) || `${probe.file} ${probe.args.join(' ')} failed`
      }
      if (models.length) {
        await deps.storage?.set(key, { at: Date.now(), models })
      }
    }
  }
  const extra = readExtraModels(deps, agent).filter((id) => !models.some((m) => m.id === id))
  return { models: [...models, ...extra.map((id) => ({ id }))], efforts: effortsFor(agent), error }
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

// ---- run links: issues, PRs and references the panel attaches to the run's workspace at start ----

const LINK_FLAGS = { issue: '--issue', pr: '--pr', linear: '--linear-issue' }
// host workspace ids already carry their selector shape (`identity:wt2:local:<uuid>`, folders `folder:<id>`);
// prefixing `id:` is what the CLI reads as <repo>::<path> and fails with selector_not_found (live-probed)
const worktreeTarget = (ws) => ['--worktree', String(ws.id)]

/** argv that links a parsed ref: GitHub/Linear go through their `worktree set` slot, any other URL through `orca reference add`. */
export function linkAddArgs(ws, ref) {
  const flag = LINK_FLAGS[ref.kind]
  return [...(flag ? ['worktree', 'set', ...worktreeTarget(ws), flag, ref.value] : ['reference', 'add', ref.value, ...worktreeTarget(ws)]), ...envArgs(ws.env)]
}

