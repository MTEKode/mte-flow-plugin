import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createSearcher, filterRows, fitSelection, goalText, groupRows, iconFor, listKey, modelRows, moveIndex, originIcon } from '../panel/logic.mjs'

test('model rows: default first, labels when the CLI gives them, an unlisted current model stays', () => {
  const info = { takesModel: true, models: [{ id: 'gemini-x-high', label: 'Gemini X (High)' }, { id: 'p/m' }] }
  assert.deepEqual(modelRows(info, ''), [['', 'Default model'], ['gemini-x-high', 'Gemini X (High)'], ['p/m', 'p/m']])
  assert.deepEqual(modelRows(info, 'typed/id').at(-1), ['typed/id', 'typed/id'])
  assert.deepEqual(modelRows({ takesModel: false, models: [{ id: 'p/m' }] }, 'p/m'), [['', 'Agent default']])
})

test('model rows are grouped by origin (the provider prefix); unprefixed rows stay on top, ungrouped', () => {
  const rows = [['', 'Default model'], ['zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-5.3'], ['alibaba-coder-plan/kimi-k2.5', 'alibaba-coder-plan/kimi-k2.5'], ['zai-coding-plan/glm-5.4', 'zai-coding-plan/glm-5.4'], ['nvidia/meta/llama', 'nvidia/meta/llama']]
  assert.deepEqual(groupRows(rows), [
    { origin: null, rows: [['', 'Default model']] },
    { origin: 'zai-coding-plan', rows: [['zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-5.3'], ['zai-coding-plan/glm-5.4', 'zai-coding-plan/glm-5.4']] },
    { origin: 'alibaba-coder-plan', rows: [['alibaba-coder-plan/kimi-k2.5', 'alibaba-coder-plan/kimi-k2.5']] },
    { origin: 'nvidia', rows: [['nvidia/meta/llama', 'nvidia/meta/llama']] }
  ])
  assert.deepEqual(groupRows([['', 'Default model'], ['sonnet', 'sonnet']]), [{ origin: null, rows: [['', 'Default model'], ['sonnet', 'sonnet']] }])
})

test('model search ANDs the words over id and label; origins map to a shipped icon or none', async () => {
  const rows = [['', 'Default model'], ['zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-5.3'], ['gemini-4-neon-high', 'Gemini 4 Neon (High)'], ['alibaba-coder-plan/glm-5', 'alibaba-coder-plan/glm-5']]
  assert.deepEqual(filterRows(rows, 'GLM zai').map((r) => r[0]), ['zai-coding-plan/glm-5.3'])
  assert.deepEqual(filterRows(rows, 'neon (high)').map((r) => r[0]), ['gemini-4-neon-high'])
  assert.equal(filterRows(rows, '  ').length, 4)
  for (const origin of ['alibaba-coder-plan', 'bailian-token-plan-personal', 'zai-coding-plan', 'claude-code', 'opencode', 'nvidia']) {
    assert.ok((await readFile(new URL(`../panel/${originIcon(origin)}`, import.meta.url))).length > 0, origin)
  }
  assert.equal(originIcon('bailian-token-plan-personal'), 'icons/alibaba.png')
  assert.equal(originIcon('swiftlm'), null)
})

test('selection is fitted to the harness: no model where it runs its own, effort only with a model it supports', () => {
  const claude = { takesModel: true, efforts: ['low', 'high'] }
  assert.deepEqual(fitSelection({ agent: 'claude', model: 'sonnet', effort: 'high' }, claude), { agent: 'claude', model: 'sonnet', effort: 'high' })
  assert.equal(fitSelection({ model: '', effort: 'high' }, claude).effort, '')
  assert.equal(fitSelection({ model: 'sonnet', effort: 'max' }, claude).effort, '')
  assert.deepEqual(fitSelection({ model: 'p/m', effort: 'high' }, { takesModel: false, efforts: [] }), { model: '', effort: '' })
})

test('every harness icon the panel names ships in panel/icons; opencode2 reuses opencode; unknown gets none', async () => {
  for (const id of ['claude', 'opencode', 'opencode2', 'codex', 'antigravity', 'pi', 'droid', 'gemini']) {
    assert.ok((await readFile(new URL(`../panel/${iconFor(id)}`, import.meta.url))).length > 0, id)
  }
  assert.equal(iconFor('opencode2'), 'icons/opencode.png')
  assert.equal(iconFor('someday'), null)
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
    // rgb()/rgba()/hsl() literals are only allowed as a var() fallback
    const bare = text.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
    assert.ok(!/\b(?:rgba?|hsla?)\(/i.test(bare), `${f} has a color function literal`)
  }
})
