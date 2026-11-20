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
  assert.ok(view.find({ text: /mte binary not found/ }))
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

test('an unusable mte shows its own title and the stderr line', async () => {
  const host = mockHost({
    requests: { 'state.get': { ...base, mte: { missing: true, unusable: true, message: '`mte --version` failed: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Install it: clone, npm link.' } } }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /mte binary not usable/ }))
  assert.ok(view.find({ text: /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/ }))
  await view.unmount()
})

test('Start run with a live planner shows the holder and Replace planner re-sends with replace', async () => {
  const starts: unknown[] = []
  const host = mockHost({
    requests: {
      'state.get': { ...base, mte: { missing: false } },
      'run.start': (input) => {
        starts.push(input)
        return input.replace
          ? { ok: true, terminalId: 't1', pinned: false, truncated: false }
          : { ok: false, error: { stage: 'planner', code: 'planner_claimed', message: 'A planner already holds this workspace (terminal term_9).' }, claim: { holder: 'terminal term_9', claimedAt: '' } }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Goal' }, 'ship it')
  await view.press({ role: 'button', text: 'Start run' })
  await view.settled()
  assert.ok(view.find({ text: /Held by terminal term_9/ }))
  assert.deepEqual(starts.map((i) => (i as { replace: boolean }).replace), [false])
  await view.press({ role: 'button', text: 'Replace planner' })
  await view.settled()
  assert.deepEqual(starts.map((i) => (i as { replace: boolean }).replace), [false, true])
  assert.equal(view.find({ text: /Held by/ }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
