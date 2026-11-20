import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const base = {
  settings: { plannerAgent: 'claude', plannerModel: '', workerAgent: 'claude', workerModel: '', workerEffort: '', mteBin: 'mte' },
  workspace: { id: 'wt-1', name: 'feat', path: '/repo/feat', branch: 'feat' },
  workers: [],
  runs: [],
  error: null
}

test('missing mte binary shows the error state with install instructions', async () => {
  const host = mockHost({
    requests: { 'state.get': { ...base, mte: { missing: true, message: 'The `mte` binary was not found.' } } }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /mte binary not found/ }))
  assert.ok(view.find({ text: /npm i -g @mtekode\/mte/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('with mte present there is no error and workers get a Focus button', async () => {
  const host = mockHost({
    requests: {
      'state.get': {
        ...base,
        mte: { missing: false },
        workers: [
          { dispatchId: 'd1', taskId: 't1', agent: 'claude/sonnet', state: 'ready', outcome: 'in_progress', liveness: 'live', workspace: 'r::/repo/feat', active: true }
        ]
      },
      'workspace.focus': { ok: true }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: /mte binary not found/ }), null)
  await view.press({ role: 'button', text: 'Focus' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
