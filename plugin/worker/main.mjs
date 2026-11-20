// MTE Flow worker: drives the `mte` CLI and the stock `orca orchestration` CLI, and keeps the
// status bar item current. Nothing is kept only in memory: runs and workers are re-read from the
// orchestration CLI on every request and poll.
import {
  checkMte,
  defaultExec,
  focusWorkspace,
  installInWorkspace,
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
  const deps = { exec: defaultExec, host, orcaCli: resolveOrcaCli() }

  async function refreshStatus() {
    const { workers, error } = await listOrchestration(deps)
    const { n, text, tone } = statusText(workers)
    await orca.host.call('statusBar.update', {
      id: 'runs',
      text: error ? 'MTE ?' : text,
      tone: error ? 'warning' : tone,
      tooltip: error ? error.message : `MTE Flow: ${n} active worker${n === 1 ? '' : 's'}. Click to open the panel.`
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
    return { settings, mte, workspace, ...orchestration }
  }

  const afterMutation = async (result) => {
    orca.panels.post('state.changed', {})
    void refreshStatus().catch(() => undefined)
    return result
  }

  orca.panels.handle('state.get', () => snapshot())
  orca.panels.handle('run.start', async (input) => afterMutation(await startRun(deps, input)))
  orca.panels.handle('workspace.install', async () => afterMutation(await installInWorkspace(deps)))
  orca.panels.handle('workspace.focus', async ({ workspace }) => focusWorkspace(host, workspace))

  orca.commands.register('mte.startRun', () => openPanel(deps))
  orca.commands.register('mte.openPanel', () => openPanel(deps))
  orca.commands.register('mte.install', async () => {
    const result = await installInWorkspace(deps)
    return result.ok ? `MTE installed in ${result.workspace.name}.` : result.error.message
  })

  // Status bar: the worker stays alive while the plugin is enabled, so it can poll.
  void refreshStatus().catch((error) => orca.log(`status refresh failed: ${error?.message ?? error}`))
  timer = setInterval(() => {
    void refreshStatus().catch((error) => orca.log(`status refresh failed: ${error?.message ?? error}`))
  }, POLL_MS)
}

export async function deactivate() {
  clearInterval(timer)
}
