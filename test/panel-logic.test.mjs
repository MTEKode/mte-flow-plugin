import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildOptions, createSearcher, customOption, filterOptions, goalText, listKey, moveIndex, optionLabel } from '../panel/logic.mjs'

const harnesses = [{ id: 'claude', name: 'Claude' }, { id: 'opencode', name: 'OpenCode' }]
const models = { claude: { models: [{ id: 'sonnet' }], efforts: ['low', 'high'] }, opencode: { models: [{ id: 'p/m' }], efforts: [] } }

test('AC3: options combine harness (surface) model effort; effort only where supported', () => {
  const labels = buildOptions({ harnesses, models, withSurface: true }).map((o) => o.label)
  assert.ok(labels.includes('Claude (Chat) · sonnet · high'))
  assert.ok(labels.includes('OpenCode (Terminal) · p/m'))
  assert.ok(!labels.some((l) => l.startsWith('OpenCode') && /· (low|high)$/.test(l)))
  assert.ok(buildOptions({ harnesses, models, withSurface: false }).every((o) => o.surface === undefined && !/\(/.test(o.label)))
  assert.equal(optionLabel({ name: 'Claude', surface: 'chat', model: '', effort: '' }), 'Claude (Chat) · default model')
})

test('AC3: filtering ANDs the words, case-insensitively; custom model row', () => {
  const all = buildOptions({ harnesses, models, withSurface: true })
  assert.ok(filterOptions(all, 'CLAUDE term high').every((o) => o.label === 'Claude (Terminal) · sonnet · high'))
  assert.equal(filterOptions(all, 'zzz').length, 0)
  const c = customOption({ agent: 'claude', surface: 'chat', effort: 'high' }, 'my-model', 'Claude')
  assert.deepEqual([c.model, c.effort, c.custom], ['my-model', 'high', true])
  assert.equal(customOption({ agent: 'opencode', surface: 'chat', effort: 'high' }, 'p/x', 'OpenCode').effort, '')
  assert.equal(customOption({ agent: 'claude' }, 'two words', 'Claude'), null)
})

test('AC3: keyboard navigation wraps and Enter/Esc map to select/close', () => {
  assert.equal(moveIndex(-1, 3, 'ArrowDown'), 0)
  assert.equal(moveIndex(2, 3, 'ArrowDown'), 0)
  assert.equal(moveIndex(0, 3, 'ArrowUp'), 2)
  assert.equal(moveIndex(0, 0, 'ArrowDown'), -1)
  assert.deepEqual(listKey(1, 3, 'Enter'), { index: 1, action: 'select' })
  assert.deepEqual(listKey(-1, 3, 'Enter'), { index: -1, action: null })
  assert.equal(listKey(1, 3, 'Escape').action, 'close')
  assert.deepEqual(listKey(1, 3, 'ArrowDown'), { index: 2, action: null })
})

test('AC3: selecting a suggestion fills "<id> <title>" plus the URL', () => {
  assert.equal(goalText({ id: 'ENG-1', title: 'Do it', url: 'https://x/1' }), 'ENG-1 Do it\nhttps://x/1')
})

test('AC3: searcher debounces ~300ms and drops stale results', async () => {
  const timers = []
  const fake = { setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: (id) => { if (id) timers[id - 1].fn = null } }
  const out = []
  const resolvers = []
  const s = createSearcher({ timers: fake, request: (q) => new Promise((r) => resolvers.push([q, r])), onResult: (r) => out.push(r) })
  s.input('fi'); s.input('fix'); s.input('fixe')
  assert.deepEqual(timers.map((t) => t.ms), [300, 300, 300])
  assert.deepEqual(timers.map((t) => t.fn === null), [true, true, false])
  timers[2].fn()
  s.input('fixed')
  timers[3].fn()
  resolvers[1][1]({ items: ['new'] })
  resolvers[0][1]({ items: ['old'] })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(out, [{ items: ['new'] }])
  s.input('x')
  assert.equal(out.at(-1), null)
})

test('AC3: the panel only uses --orca-* colors (no hard-coded hex)', async () => {
  for (const f of ['index.html', 'panel.js', 'logic.mjs']) {
    const text = await readFile(new URL(`../panel/${f}`, import.meta.url), 'utf8')
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), `${f} has a hex color`)
  }
})
