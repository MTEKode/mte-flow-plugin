import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { claimCallout, createSearcher, filterRows, fitSelection, goalText, groupRows, iconFor, linksFromItems, listHints, listKey, modelRows, moveIndex, mteDriftHint, mteRow, originIcon, parseRef, startNote } from '../panel/logic.mjs'

test('model rows: default first, labels when the CLI gives them, an unlisted current model stays', () => {
  const info = { models: [{ id: 'gemini-x-high', label: 'Gemini X (High)' }, { id: 'p/m' }] }
  assert.deepEqual(modelRows(info, ''), [['', 'Default model'], ['gemini-x-high', 'Gemini X (High)'], ['p/m', 'p/m']])
  assert.deepEqual(modelRows(info, 'typed/id').at(-1), ['typed/id', 'typed/id'])
})

test('model rows are grouped by origin (the provider prefix); unprefixed rows stay on top, ungrouped', () => {
  const rows = [['', 'Default model'], ['bailian-token-plan-personal/glm-5.3', 'bailian-token-plan-personal/glm-5.3'], ['alibaba-coder-plan/kimi-k2.5', 'alibaba-coder-plan/kimi-k2.5'], ['bailian-token-plan-personal/glm-5.4', 'bailian-token-plan-personal/glm-5.4'], ['nvidia/meta/llama', 'nvidia/meta/llama']]
  assert.deepEqual(groupRows(rows), [
    { origin: null, rows: [['', 'Default model']] },
    { origin: 'bailian-token-plan-personal', rows: [['bailian-token-plan-personal/glm-5.3', 'bailian-token-plan-personal/glm-5.3'], ['bailian-token-plan-personal/glm-5.4', 'bailian-token-plan-personal/glm-5.4']] },
    { origin: 'alibaba-coder-plan', rows: [['alibaba-coder-plan/kimi-k2.5', 'alibaba-coder-plan/kimi-k2.5']] },
    { origin: 'nvidia', rows: [['nvidia/meta/llama', 'nvidia/meta/llama']] }
  ])
  assert.deepEqual(groupRows([['', 'Default model'], ['sonnet', 'sonnet']]), [{ origin: null, rows: [['', 'Default model'], ['sonnet', 'sonnet']] }])
})

test('model search ANDs the words over id and label; origins map to a shipped icon or none', async () => {
  const rows = [['', 'Default model'], ['bailian-token-plan-personal/glm-5.3', 'bailian-token-plan-personal/glm-5.3'], ['gemini-4-neon-high', 'Gemini 4 Neon (High)'], ['alibaba-coder-plan/glm-5', 'alibaba-coder-plan/glm-5']]
  assert.deepEqual(filterRows(rows, 'GLM bailian').map((r) => r[0]), ['bailian-token-plan-personal/glm-5.3'])
  assert.deepEqual(filterRows(rows, 'neon (high)').map((r) => r[0]), ['gemini-4-neon-high'])
  assert.equal(filterRows(rows, '  ').length, 4)
  for (const origin of ['alibaba-coder-plan', 'bailian-token-plan-personal', 'claude-code', 'nvidia']) {
    assert.ok((await readFile(new URL(`../panel/${originIcon(origin)}`, import.meta.url))).length > 0, origin)
  }
  assert.equal(originIcon('bailian-token-plan-personal'), 'icons/alibaba.png')
  assert.equal(originIcon('swiftlm'), null)
})

test('selection is fitted to the harness: effort only with a model it supports', () => {
  const claude = { efforts: ['low', 'high'] }
  assert.deepEqual(fitSelection({ agent: 'claude', model: 'sonnet', effort: 'high' }, claude), { agent: 'claude', model: 'sonnet', effort: 'high' })
  assert.equal(fitSelection({ model: '', effort: 'high' }, claude).effort, '')
  assert.equal(fitSelection({ model: 'sonnet', effort: 'max' }, claude).effort, '')
  assert.deepEqual(fitSelection({ model: 'p/m', effort: 'high' }, { efforts: [] }), { model: 'p/m', effort: '' })
})

test('every harness icon the panel names ships in panel/icons; unknown gets none', async () => {
  for (const id of ['claude', 'antigravity']) {
    assert.ok((await readFile(new URL(`../panel/${iconFor(id)}`, import.meta.url))).length > 0, id)
  }
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

test('AC1: the panel keeps no poller of its own — the worker posts state.changed', async () => {
  const text = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.ok(!text.includes('setInterval'), 'panel.js must not poll; the worker notifies it')
})

test('AC10: the goal combobox announces the highlighted option; model options get ids too', async () => {
  const text = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(text, /goal\.setAttribute\('aria-activedescendant', items\.length \? `go-\$\{gi\}` : ''\)/)
  assert.match(text, /input\.setAttribute\('aria-activedescendant'/)
  assert.match(text, /id: `go-\$\{i\}`/)
  assert.match(text, /id: `mo-\$\{pid\}-\$\{i\}`/)
})

test('AC5: a live foreign claim shows the conflict callout before Start; own claims stay quiet; corrupt ones report', () => {
  const conflict = claimCallout({ claim: { claimed: true, holder: 'session s9' } })
  assert.deepEqual([conflict.tone, conflict.title, conflict.replace, conflict.body.includes('session s9')], ['', 'A planner is already running here', true, true])
  assert.equal(claimCallout({ claim: { claimed: true, holder: 'session s9', mine: true } }), null)
  assert.equal(claimCallout({ claim: { claimed: false } }), null)
  const corrupt = claimCallout({ claimError: '`mte planner show` failed (exited with 1): claim file is corrupt; run `mte planner release`' })
  assert.equal(corrupt.tone, 'danger')
  assert.equal(corrupt.replace, undefined)
  assert.match(corrupt.body, /corrupt/)
  assert.match(claimCallout(null, 'terminal term_1').body, /terminal term_1/)
})

test('AC8: the fallback note names exactly the selections the host launcher dropped', () => {
  const plain = startNote({ surface: 'terminal' })
  assert.equal(plain, 'Planner started in a new terminal.')
  const dropped = startNote({ surface: 'terminal', fallback: true, dropped: ['model opus', 'effort high', 'chat surface'] })
  assert.match(dropped, /the orca CLI was unavailable: dropped model opus, effort high, chat surface/)
  const chat = startNote({ surface: 'chat', fallback: false, dropped: [] })
  assert.equal(chat, 'Planner started in a native chat.')
})

test('AC9: the truncation note states the real 4000-char cap', () => {
  assert.match(startNote({ surface: 'chat', truncated: true }), /truncated to fit the 4000-char prompt cap/)
  assert.ok(!startNote({ surface: 'chat', truncated: true }).includes('4096'))
})

test('AC4: the panel row shows the installed mte version; drift below REQUIRED raises a warning hint pointing at Repair setup', () => {
  assert.equal(mteRow({ missing: false, version: '0.8.0' }), 'mte 0.8.0')
  assert.equal(mteRow({ missing: false, version: null }), null)
  assert.equal(mteRow({ missing: true, message: 'gone' }), null)
  const drift = mteDriftHint({ missing: false, version: '0.7.0', required: '0.8.0', drift: true })
  assert.equal(drift.tone, 'warning')
  assert.match(drift.title, /0\.7\.0 is older than 0\.8\.0/)
  assert.match(drift.body, /Repair setup/)
  assert.equal(mteDriftHint({ missing: false, version: '0.8.0', required: '0.8.0', drift: false }), null)
  assert.equal(mteDriftHint({ missing: false, version: null, required: '0.8.0', drift: false }), null)
  assert.equal(mteDriftHint({ missing: true, version: null, required: '0.8.0', drift: false }), null)
})

test('AC3: failed harness/model listings become hint lines (goal.search hint pattern)', () => {
  assert.deepEqual(listHints({ harnessError: 'orca CLI missing', models: { antigravity: { error: 'agy: offline' } } }), [
    'Could not list the installed harnesses (orca CLI missing); claude and antigravity stay selectable.',
    'Could not list antigravity models (agy: offline); type a model id instead.'
  ])
  assert.deepEqual(listHints({ harnessError: null, models: { claude: { models: [], error: null } } }), [])
})

// ---- panel v3: Advanced fold + Links field ----

test('AC1: the selector fields live in a closed Advanced fold the choosers still mount into', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8')
  const tag = /<details id="advanced"([^>]*)>/.exec(html)
  assert.ok(tag, 'index.html must have <details id="advanced">')
  assert.ok(!/\bopen\b/.test(tag[1]), 'the fold must start closed')
  const fold = html.slice(tag.index, html.indexOf('</details>', tag.index))
  assert.ok(fold.includes('<summary>Advanced</summary>'))
  assert.ok(fold.includes('id="f-planner"') && fold.includes('id="f-worker"'))
  const js = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(js, /chooser\(\$\('f-planner'\)[\s\S]*?\$\('f-worker'\)/)
})

test('AC2: the links parser maps exact refs; free text stays search material', () => {
  assert.deepEqual(parseRef(' #45 '), { kind: 'issue', value: '45' })
  assert.deepEqual(parseRef('ENG-123'), { kind: 'linear', value: 'ENG-123' })
  assert.deepEqual(parseRef('https://github.com/MTEKode/mte-flow-plugin/pull/7'), { kind: 'pr', value: '7' })
  assert.deepEqual(parseRef('https://github.com/a/b/issues/8#issuecomment-1'), { kind: 'issue', value: '8' })
  assert.deepEqual(parseRef('https://linear.app/acme/issue/ABC-9'), { kind: 'linear', value: 'https://linear.app/acme/issue/ABC-9' })
  assert.deepEqual(parseRef('https://example.com/docs/x'), { kind: 'reference', value: 'https://example.com/docs/x' })
  assert.equal(parseRef('fix login bug'), null)
  assert.equal(parseRef(''), null)
  assert.equal(parseRef('https:// not a url'), null)
})

test('AC4: worktree linkedItems become chips carrying the remove data', () => {
  assert.deepEqual(linksFromItems([
    { provider: 'github', type: 'issue', number: 45, url: 'u45' },
    { provider: 'github', type: 'pr', number: 7 },
    { provider: 'linear', type: 'issue', number: 0, linearIdentifier: 'ENG-123', url: 'lu' },
    { provider: 'gitlab', type: 'mr', number: 3, url: 'https://gitlab.com/a/b/-/merge_requests/3' }
  ]), [
    { kind: 'issue', value: '45', url: 'u45', label: '#45' },
    { kind: 'pr', value: '7', url: '', label: 'PR #7' },
    { kind: 'linear', value: 'ENG-123', url: 'lu', label: 'ENG-123' },
    { kind: 'reference', value: 'https://gitlab.com/a/b/-/merge_requests/3', url: 'https://gitlab.com/a/b/-/merge_requests/3', label: 'MR gitlab.com/a/b/-/merge_requests/3' }
  ])
  assert.deepEqual(linksFromItems(undefined), [])
})

test('AC3: the panel and worker wire link.add/link.remove, errors surfacing as the field hint', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8')
  assert.ok(html.includes('placeholder="Add by identifier or URL: ENG-123, #45, https://…"'))
  const js = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(js, /req\('link.add'/)
  assert.match(js, /req\('link.remove'/)
  assert.match(js, /setLinkHint\(r\.error/)
  const main = await readFile(new URL('../worker/main.mjs', import.meta.url), 'utf8')
  assert.match(main, /panels\.handle\('link.add'/)
  assert.match(main, /panels\.handle\('link.remove'/)
})

test('AC4: a failed links read is never silent: the worker stores linksError and the panel renders it as the hint', async () => {
  const main = await readFile(new URL('../worker/main.mjs', import.meta.url), 'utf8')
  assert.match(main, /catch \(error\) \{[\s\S]*?links = \[\][\s\S]*?linksError/)
  assert.ok(!main.includes('.catch(() => [])'), 'snapshot must not swallow the readLinks failure')
  const js = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(js, /linksError.*setLinkHint/s)
})
