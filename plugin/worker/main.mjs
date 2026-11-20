// MTE Flow worker: drives the `mte` CLI and the stock `orca orchestration` CLI, and keeps the
// status bar item current. Nothing is kept only in memory: runs and workers are re-read from the
// orchestration CLI on every request and poll.
import {
  checkMte,
  defaultExec,
  dismissDepthReminder,
  ensureSetup,
  focusWorkspace,
  installInWorkspace,
  isDepthReminderDismissed,
  listOrchestration,
  openPanel,
  readSettings,
  resolveOrcaCli,
  resolveWorkspace,
  startRun,
  statusText
} from './lib.mjs'

const POLL_MS = 15_000
let timer
const SETTING_KEYS = ['plannerAgent', 'plannerModel', 'workerAgent', 'workerModel', 'workerEffort', 'mteBin']

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
            ? { status: 'done', message: result.skipped ? '' : `mte ${result.version} ready${result.installed ? ' (installed)' : ''}; skill installed.` }
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

  async function refreshStatus() {
    const { workers, error } = await listOrchestration(deps)
    const { n, text, tone } = statusText(workers)
    const setupNote = setup.status === 'running' ? { text: 'MTE setup…', tooltip: setup.message } : setup.status === 'error' ? { text: 'MTE !', tooltip: `MTE setup failed: ${setup.message}` } : null
    await orca.host.call('statusBar.update', {
      id: 'runs',
      text: setupNote?.text ?? (error ? 'MTE ?' : text),
      tone: setupNote ? 'warning' : error ? 'warning' : tone,
      tooltip: setupNote?.tooltip ?? (error ? error.message : `MTE Flow: ${n} active worker${n === 1 ? '' : 's'}. Click to open the panel.`)
    })
    return { workers, error }
  }

  async function snapshot() {
    const settings = await readSettings(host)
    const [orchestration, mte, workspace] = await Promise.all([
      listOrchestration(deps),
      checkMte(deps, settings),
      resolveWorkspace(host).catch(() => null)
    ])
    return {
      settings,
      mte,
      workspace,
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
  orca.panels.handle('run.start', async (input) => afterMutation(await startRun(deps, input)))
  orca.panels.handle('workspace.install', async () => afterMutation(await installInWorkspace(deps)))
  orca.panels.handle('setup.repair', () => runSetup(true))
  orca.panels.handle('reminder.dismiss', async () => {
    await dismissDepthReminder(orca.storage)
    orca.panels.post('state.changed', {})
    return { ok: true }
  })
  orca.panels.handle('workspace.focus', async ({ workspace }) => focusWorkspace(host, workspace))

  orca.commands.register('mte.startRun', () => openPanel(deps))
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
