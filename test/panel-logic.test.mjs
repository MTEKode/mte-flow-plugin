import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { claimCallout, createSearcher, createWorkspaceArgs, filterRows, fitSelection, goalSlug, groupRows, iconFor, addLink, listHints, listKey, modelRows, moveIndex, mteDriftHint, mteRow, originIcon, parseRef, startNote, phaseText, attentionRow, filterRepos, groupRepos, osOf } from '../panel/logic.mjs'

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

test('AC10: the links combobox announces the highlighted option; model options get ids too', async () => {
  const text = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(text, /links\.setAttribute\('aria-activedescendant', linkItems\[li\] \? `lk-\$\{li\}` : ''\)/)
  assert.match(text, /input\.setAttribute\('aria-activedescendant'/)
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

test('the panel takes Orca\'s fonts and radius', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8')
  assert.match(html, /body \{[^}]*font: 13px\/1\.4 var\(--orca-font-sans/)
  assert.match(html, /code \{ font-family: var\(--orca-font-mono/)
  assert.ok(!html.includes('border-radius: 6px'), 'control radii come from --orca-radius')
})

test('the goal is a plain textarea: no search, no programmatic writes (Cmd/Ctrl+Z keeps working)', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8')
  assert.match(html, /<textarea id="goal" placeholder="[^"]*"><\/textarea>/)
  assert.ok(!html.includes('goal-list'))
  const js = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.ok(!/goal\.value\s*=[^=]/.test(js), 'goal.value is never assigned')
  assert.ok(!/links\.value = ''\s*\n/.test(js.replace("if (!document.execCommand('delete')) links.value = ''", '')), 'links clears through execCommand')
})

test('AC1: the orchestrator sits outside the closed Advanced fold, which holds the coder and QA choosers', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8')
  const tag = /<details id="advanced"([^>]*)>/.exec(html)
  assert.ok(tag, 'index.html must have <details id="advanced">')
  assert.ok(!/\bopen\b/.test(tag[1]), 'the fold must start closed')
  const fold = html.slice(tag.index, html.indexOf('</details>', tag.index))
  assert.ok(fold.includes('<summary>Advanced: workers'))
  assert.ok(!fold.includes('id="f-planner"') && html.includes('id="f-planner"'))
  assert.ok(fold.includes('id="f-worker"') && fold.includes('id="f-qa"'))
  const js = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(js, /chooser\(\$\('f-planner'\)[\s\S]*?\$\('f-worker'\)[\s\S]*?\$\('f-qa'\), 'qa'/)
  assert.match(js, /qaAgent: st\.qa\.agent, qaModel: st\.qa\.model \|\| '', qaEffort: st\.qa\.effort \|\| ''/)
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

test('run links: chips hold only what was added; duplicates collapse, free text is refused', () => {
  const one = addLink([], ' #45 ')
  assert.deepEqual(one, [{ ref: '#45', kind: 'issue', value: '45', label: '#45' }])
  assert.equal(addLink(one, '#45'), one)
  assert.equal(addLink(one, 'fix login'), null)
  const two = addLink(one, 'https://linear.app/acme/issue/ABC-9', 'ABC-9')
  assert.deepEqual(two[1], { ref: 'https://linear.app/acme/issue/ABC-9', kind: 'linear', value: 'https://linear.app/acme/issue/ABC-9', label: 'ABC-9' })
  assert.equal(addLink(two, 'https://github.com/a/b/pull/7').at(-1).label, 'PR #7')
  assert.equal(addLink([], 'https://www.example.com/x')[0].label, 'example.com/x')
})

test('run links: the panel keeps them local (× removes at once) and sends them with run.start; no link.add/link.remove', async () => {
  const js = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(js, /links: st\.links\.map\(\(l\) => l\.ref\)/)
  assert.match(js, /function unlink\(link\) \{\n  st\.links = st\.links\.filter/)
  assert.ok(!js.includes("req('link."))
  assert.match(js, /li = -1/, 'no suggestion is highlighted until the person moves to one')
  const main = await readFile(new URL('../worker/main.mjs', import.meta.url), 'utf8')
  assert.ok(!main.includes("'link.add'") && !main.includes('readLinks'))
})

// ---- panel v4: new-workspace start ----

test('AC2: the goal slug is lowercase words joined with -; anything unsluggable falls back to mte-run', () => {
  assert.equal(goalSlug('Build the thing!'), 'build-the-thing')
  assert.equal(goalSlug('  Fix login — 2025/05  '), 'fix-login-2025-05')
  assert.equal(goalSlug('AÑOS de café: edición'), 'anos-de-cafe-edicion')
  assert.equal(goalSlug(''), 'mte-run')
  assert.equal(goalSlug('https://linear.app/cubbo/issue/ENG-1091'), 'eng-1091', 'a ticket URL names the workspace by its key')
  assert.equal(goalSlug('https://linear.app/cubbo/issue/ENG-1091/fix-the-thing'), 'eng-1091-fix-the-thing')
  assert.equal(goalSlug('Arregla https://github.com/a/b/pull/12 ya'), 'arregla-pr-12-ya')
  assert.equal(goalSlug('https://example.com/x'), 'mte-run', 'other URLs drop out')
  assert.equal(goalSlug('!!! ???'), 'mte-run')
  assert.equal(goalSlug('x'.repeat(80)), 'x'.repeat(48), 'capped at 48 chars')
  assert.equal(goalSlug('a'.repeat(47) + ' b'), 'a'.repeat(47), 'a truncated tail never keeps a cut word with a trailing dash')
})

test('AC2: create argv: name, repo id selector, --no-parent, base flag; slot links per kind; reference links deferred (create cannot mix them, live-probed)', () => {
  const { argv, deferred } = createWorkspaceArgs({
    name: 'my-ws',
    repoId: 'r-9',
    base: ' origin/main ',
    links: [
      { kind: 'issue', value: '45' },
      { kind: 'pr', value: '7' },
      { kind: 'linear', value: 'ENG-123' },
      { kind: 'reference', value: 'https://gitlab.com/a/b/-/merge_requests/3' },
      { kind: 'reference', value: '' }
    ]
  })
  assert.deepEqual(argv, ['worktree', 'create', '--name', 'my-ws', '--repo', 'id:r-9', '--no-parent', '--base-branch', 'origin/main', '--issue', '45', '--pr', '7', '--linear-issue', 'ENG-123'])
  assert.deepEqual(deferred, ['https://gitlab.com/a/b/-/merge_requests/3'])
  // empty base: the repo default applies, so the flag is not passed at all
  assert.ok(!createWorkspaceArgs({ name: 'n', repoId: 'r', base: '  ', links: [] }).argv.includes('--base-branch'))
})

test('AC2: the start note names the created workspace, and link failures that did not block the run are never silent', () => {
  const note = startNote({ surface: 'chat', createdWorkspace: { id: 'r::/p', name: 'fix-login' } })
  assert.ok(note.startsWith('New workspace “fix-login” created. Planner started in a native chat.'), note)
  assert.match(startNote({ surface: 'chat', createdWorkspace: { name: 'w' }, linkFailures: ['https://x (nope)'] }), /could not attach 1 link: https:\/\/x \(nope\)/)
  assert.match(startNote({ surface: 'chat', createdWorkspace: { name: 'w' }, linkFailures: ['a', 'b'] }), /could not attach 2 links: a; b/)
})

test('AC5: the new-workspace inputs exist hidden; the panel reveals them only while the toggle is on', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8')
  assert.match(html, /<input type="checkbox" id="new-ws"/)
  assert.match(html, /<div class="stack" id="ws-fields"[^>]*hidden/)
  assert.match(html, /<div class="field" id="ws-repo">/)
  assert.match(html, /id="ws-base" placeholder="Base branch \(empty: repo default\)"/)
  const js = await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8')
  assert.match(js, /\$\('new-ws'\)\.onchange[^\n]*\n[^\n]*ws-fields'\)\.hidden = !/)
  assert.match(js, /newWorkspace: \$\('new-ws'\)\.checked/)
})

test('phase tag and attention rows', () => {
  assert.equal(phaseText({ phase: 5, name: 'Coder' }), 'Fase 5/8 · Coder')
  assert.equal(phaseText({ phase: 2, name: '' }), 'Fase 2/8')
  assert.equal(phaseText(null), null)
  assert.equal(phaseText({ phase: null }), null)
  assert.deepEqual(attentionRow({ kind: 'release', text: 't1 finished', run: 'Goal', dispatchId: 'ctx_1' }), { label: 'Idle terminal', text: 't1 finished', run: 'Goal', action: 'release' })
  assert.equal(attentionRow({ kind: 'ask', text: 'q', run: 'G', workspace: 'r::/p' }).action, 'focus')
  assert.equal(attentionRow({ kind: 'gate', text: 'q', run: 'G', workspace: null }).action, null)
})

test('repo picker: search by name, host or path; grouped by host; OS from platform', () => {
  const repos = [
    { key: 'a', name: 'app', host: 'this machine', path: '/code/app', platform: 'darwin', server: false },
    { key: 'b', name: 'api', host: 'box', path: '/home/u/api', platform: 'linux', server: true },
    { key: 'c', name: 'fotoclass', host: 'win-pc', path: 'C:\\code\\fotoclass', platform: 'win32', server: true }
  ]
  assert.deepEqual(filterRepos(repos, 'win').map((r) => r.key), ['c'])
  assert.deepEqual(filterRepos(repos, 'home api').map((r) => r.key), ['b'])
  assert.deepEqual(filterRepos(repos, '').map((r) => r.key), ['a', 'b', 'c'])
  assert.deepEqual(groupRepos(repos).map((g) => [g.host, g.platform, g.server, g.repos.length]), [['this machine', 'darwin', false, 1], ['box', 'linux', true, 1], ['win-pc', 'win32', true, 1]])
  assert.deepEqual(['darwin', 'win32', 'linux', null, 'aix'].map(osOf), ['mac', 'windows', 'linux', null, null])
})
