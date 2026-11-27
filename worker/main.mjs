// MTE Flow worker: drives the `mte` CLI and the stock `orca orchestration` CLI, and keeps the
// status bar item current. Nothing is kept only in memory: runs and workers are re-read from the
// orchestration CLI on every request and poll.
import {
  checkMte,
  createPollPoster,
  defaultExec,
  describeClaim,
  dismissDepthReminder,
  ensureSetup,
  listRepos,
  repoOfWorkspace,
  mteIsCurrent,
  focusWorkspace,
  harnessList,
  installInWorkspace,
  isDepthReminderDismissed,
  listModels,
  listOrchestration,
  listOrchestrators,
  releaseWorker,
  openPanel,
  readClaim,
  readSettings,
  REQUIRED_MTE_VERSION,
  resolveChoices,
  resolveOrcaCli,
  resolveWorkspace,
  searchGoal,
  startRun,
  statusText
} from './lib.mjs'

const POLL_MS = 15_000
let timer
const SETTING_KEYS = ['plannerAgent', 'plannerModel', 'plannerSurface', 'plannerEffort', 'workerAgent', 'workerModel', 'workerEffort', 'qaAgent', 'qaModel', 'qaEffort', 'mteBin']
const CHOICE_KEYS = SETTING_KEYS.slice(0, -1)
let searchSeq = 0

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  const host = {
    call: (method, params) => orca.host.call(method, params),
    settings: async () =>
      Object.fromEntries(await Promise.all(SETTING_KEYS.map(async (k) => [k, await orca.settings.get(k)])))
  }
  const deps = {
    exec: defaultExec,
    host,
    orcaCli: resolveOrcaCli(),
    storage: orca.storage,
    progress: (message) => setSetup({ status: 'running', message })
  }

  // Setup progress lives in memory only; "already done" is remembered in plugin storage per mte version.
  let setup = { status: 'idle', message: '' }
  let setupRun = null
  function setSetup(next) {
    setup = next
    orca.panels.post('state.changed', {})
    void refreshStatus().catch(() => undefined)
  }
  /** One run at a time; a second request joins the one in flight. */
  function runSetup(force) {
    setupRun ??= (async () => {
      setSetup({ status: 'running', message: 'Starting setup…' })
      try {
        const result = await ensureSetup(deps, { force })
        setSetup(
          result.ok
            ? result.needsConsent
              ? { status: 'needs-consent', message: result.message }
              : { status: 'done', message: result.skipped || result.declined ? '' : `mte ${result.version} ready${result.installed ? ' (installed)' : ''}${result.updated?.length ? ` (${result.updated.join('; ')})` : ''}; skill installed.` }
            : { status: 'error', message: result.error.message }
        )
        return result
      } catch (error) {
        const message = String(error?.message ?? error)
        setSetup({ status: 'error', message })
        return { ok: false, error: { stage: 'setup', code: 'setup_failed', message } }
      } finally {
        setupRun = null
      }
    })()
    return setupRun
  }

  const postPoll = createPollPoster(() => orca.panels.post('state.changed', {}))
  async function refreshStatus() {
    const { workers, error } = await listOrchestration(deps)
    const { n, text, tone, attention } = statusText(workers)
    const setupNote = setup.status === 'running' ? { text: 'MTE setup…', tooltip: setup.message } : setup.status === 'error' ? { text: 'MTE !', tooltip: `MTE setup failed: ${setup.message}` } : null
    await orca.host.call('statusBar.update', {
      id: 'runs',
      text: setupNote?.text ?? (error ? 'MTE ?' : text),
      tone: setupNote ? 'warning' : error ? 'warning' : tone,
      tooltip: setupNote?.tooltip ?? (error ? error.message : `MTE Flow: ${n} active worker${n === 1 ? '' : 's'}${attention ? `, ${attention} needing attention` : ''}. Click to open the panel.`)
    })
    // single poller: the panel has no interval of its own, so a changed observable state reloads it
    postPoll([workers, setup, text, tone, error?.message ?? null])
    return { workers, error }
  }

  async function snapshot() {
    // the last selection made in the panel (storage) beats the declared settings, which only seed it;
    // a settings change re-seeds (resolveChoices drops stale overrides)
    const fresh = await readSettings(host)
    const settings = { ...fresh, ...(await resolveChoices(orca.storage, fresh)) }
    const [orchestration, mte, workspace, repos] = await Promise.all([
      listOrchestrators(deps),
      checkMte(deps, settings),
      resolveWorkspace(host).catch(() => null),
      listRepos(deps)
    ])
    // the focused workspace's planner claim: the panel warns about a conflict before Start, not after a failed one
    let claim = null
    let claimError = null
    if (workspace) {
      const res = await readClaim(deps, settings, workspace.path)
      if (res.ok) {
        if (res.claim?.claimed) {
          const launches = (await orca.storage.get('launches')) ?? {}
          claim = {
            claimed: true,
            holder: describeClaim(res.claim),
            claimedAt: res.claim.claimedAt ?? '',
            mine: [res.claim.sessionId, res.claim.terminalHandle].some((k) => k && launches[k])
          }
        }
      } else if (res.error.code !== 'mte_missing') {
        // a corrupt or unreadable claim is actionable (T-0004): render it where Start would have failed
        claimError = res.error.message
      }
    }
    return {
      settings,
      mte,
      workspace,
      repos,
      focusedRepoKey: repoOfWorkspace(repos, workspace)?.key ?? null,
      claim,
      claimError,
      setup,
      depthReminderDismissed: await isDepthReminderDismissed(orca.storage),
      ...orchestration
    }
  }

  const afterMutation = async (result) => {
    orca.panels.post('state.changed', {})
    void refreshStatus().catch(() => undefined)
    return result
  }

  orca.panels.handle('state.get', () => snapshot())
  orca.panels.handle('run.start', async (input) => {
    await orca.storage.set('choices', Object.fromEntries(CHOICE_KEYS.filter((k) => typeof input?.[k] === 'string').map((k) => [k, input[k]])))
    return afterMutation(await startRun(deps, input))
  })
  orca.panels.handle('harness.list', () => harnessList(deps))
  orca.panels.handle('models.list', ({ agent }) => listModels(deps, { agent }))
  orca.panels.handle('goal.search', (input) => {
    const mine = ++searchSeq
    return searchGoal(deps, input, { isStale: () => mine !== searchSeq })
  })
  orca.panels.handle('workspace.install', async () => {
    // an older mte would write an old skill: pressing Install is consent to bring mte up to date first, as Repair does
    if (!(await mteIsCurrent(deps))) {
      const setupResult = await runSetup(true)
      if (!setupResult.ok || setupResult.needsConsent) {
        return setupResult
      }
    }
    return afterMutation(await installInWorkspace(deps))
  })
  orca.panels.handle('setup.repair', () => runSetup(true))
  // "Not now": the needs-consent prompt is remembered as declined for this required version; Repair setup still runs it
  orca.panels.handle('setup.dismiss', async () => {
    await orca.storage.set('setupDeclined', { version: REQUIRED_MTE_VERSION, at: new Date().toISOString() })
    setSetup({ status: 'idle', message: '' })
    return { ok: true }
  })
  orca.panels.handle('reminder.dismiss', async () => {
    await dismissDepthReminder(orca.storage)
    orca.panels.post('state.changed', {})
    return { ok: true }
  })
  orca.panels.handle('workspace.focus', async ({ workspace }) => focusWorkspace(host, workspace))
  orca.panels.handle('worker.release', async ({ dispatchId }) => afterMutation(await releaseWorker(deps, dispatchId)))

  orca.commands.register('mte.openPanel', () => openPanel(deps))
  orca.commands.register('mte.install', async () => {
    const result = await installInWorkspace(deps)
    return result.ok ? `MTE installed in ${result.workspace.name}.` : result.error.message
  })

  // First run per mte version: install/upgrade the CLI and the user-level skill, in the background.
  void runSetup(false)

  // Status bar: the worker stays alive while the plugin is enabled, so it can poll.
  void refreshStatus().catch((error) => orca.log(`status refresh failed: ${error?.message ?? error}`))
  timer = setInterval(() => {
    void refreshStatus().catch((error) => orca.log(`status refresh failed: ${error?.message ?? error}`))
  }, POLL_MS)
}

export async function deactivate() {
  clearInterval(timer)
}
