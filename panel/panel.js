// MTE Flow panel (html, isolated frame): all data comes from the worker through orca.plugin.request.
import { claimCallout, createSearcher, filterRows, fitSelection, goalText, groupRows, iconFor, KIND_LABEL, listHints, listKey, modelRows, mteDriftHint, mteRow, originIcon, originOf, parseRef, startNote } from './logic.mjs'

const $ = (id) => document.getElementById(id)
const req = (name, params = {}) => orca.plugin.request(name, params, { timeoutMs: 120000 })
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  n.append(...kids)
  return n
}

const st = { snap: null, harnesses: [], harnessError: null, models: {}, planner: null, worker: null, busy: null, notice: null, claimedBy: null, prefilled: false }

// ---- harness / model / effort selectors (harness, surface and effort are native selects; the model list is searchable) ----
const opt = (value, ...kids) => el('option', { value }, ...kids)
const badge = (src, name) => (src ? el('img', { src, alt: '', width: 16, height: 16 }) : el('span', { className: 'letter', textContent: name[0].toUpperCase(), ariaHidden: 'true' }))
const harnessIcon = (h) => badge(iconFor(h.id), h.name)

/** Searchable model list: rows grouped under their origin (with its icon); typing an unlisted id offers it as a row. */
let popSeq = 0
function modelPicker(field, title, { rows, get, set }) {
  const btn = el('button', { type: 'button', className: 'picker', ariaLabel: `${title} model`, ariaHasPopup: 'listbox' })
  let pop = null
  let active = 0
  let shown = []
  const label = () => {
    const cur = get() || ''
    const row = rows().find(([v]) => v === cur) ?? [cur, cur]
    const origin = originOf(cur)
    btn.replaceChildren(...(origin ? [badge(originIcon(origin), origin)] : []), el('span', { className: 't', textContent: row[1] }), el('span', { className: 'caret', textContent: '▼', ariaHidden: 'true' }))
  }
  const close = (focus) => { pop?.remove(); pop = null; if (focus) btn.focus() }
  const choose = (value) => { set(value); close(true) }
  btn.onclick = () => {
    if (pop) return close(true)
    const pid = ++popSeq
    const input = el('input', { placeholder: 'Search models, or type a model id', ariaLabel: `Search ${title} models` })
    const list = el('div', { role: 'listbox' })
    pop = el('div', { className: 'pop' }, input, list)
    const draw = () => {
      const q = input.value.trim()
      const hits = filterRows(rows(), q)
      if (q && !/\s/.test(q) && !rows().some(([v]) => v === q)) hits.push([q, `Use “${q}”`])
      const groups = groupRows(hits)
      shown = groups.flatMap((g) => g.rows)
      active = Math.max(0, Math.min(active, shown.length - 1))
      let at = 0
      list.replaceChildren(
        ...groups.flatMap((g) => [
          ...(g.origin && g.rows.length ? [el('div', { className: 'group' }, badge(originIcon(g.origin), g.origin), el('span', { textContent: g.origin }))] : []),
          ...g.rows.map(([value, text]) => {
            const i = at++
            const row = el('div', { id: `mo-${pid}-${i}`, className: 'opt' + (i === active ? ' active' : ''), role: 'option', ariaSelected: String(value === (get() || '')) }, el('span', { className: 't', textContent: text }))
            row.onmousedown = (e) => { e.preventDefault(); choose(value) }
            return row
          })
        ]),
        ...(shown.length ? [] : [el('div', { className: 'opt muted', textContent: 'No models match.' })])
      )
      input.setAttribute('aria-activedescendant', shown.length ? `mo-${pid}-${active}` : '')
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
    }
    input.oninput = () => { active = 0; draw() }
    input.onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const r = listKey(active, shown.length, e.key)
      active = r.index
      if (r.action === 'select') choose(shown[active][0])
      else if (r.action === 'close') close(true)
      else draw()
    }
    input.onblur = () => setTimeout(() => close(false), 120)
    field.append(pop)
    active = Math.max(0, groupRows(rows()).flatMap((g) => g.rows).findIndex(([v]) => v === (get() || '')))
    draw()
    input.focus()
  }
  return { btn, label }
}

function chooser(field, key, title, withSurface) {
  const harness = el('select', { ariaLabel: `${title} harness` })
  const surface = el('select', { ariaLabel: `${title} surface`, className: 'fit' }, opt('chat', 'Chat'), opt('terminal', 'Terminal'))
  const effort = el('select', { ariaLabel: `${title} effort`, className: 'fit' })
  const info = () => st.models[st[key].agent] ?? { models: [], efforts: [] }
  const model = modelPicker(field, title, { rows: () => modelRows(info(), st[key].model), get: () => st[key].model, set: (v) => { st[key].model = v; draw() } })
  field.append(el('div', { className: 'row' }, harness, ...(withSurface ? [surface] : [])), el('div', { className: 'row' }, model.btn, effort))

  function draw() {
    const c = st[key]
    if (!c) return
    if (st.models[c.agent]) Object.assign(c, fitSelection(c, st.models[c.agent]))
    const { efforts } = info()
    const listed = st.harnesses.some((h) => h.id === c.agent) ? st.harnesses : [{ id: c.agent, name: c.agent }, ...st.harnesses]
    harness.replaceChildren(el('button', {}, el('selectedcontent')), ...listed.map((h) => opt(h.id, harnessIcon(h), el('span', { textContent: h.name }))))
    harness.value = c.agent
    surface.value = c.surface
    model.label()
    effort.replaceChildren(opt('', 'Default effort'), ...efforts.map((e) => opt(e, e)))
    effort.value = c.effort || ''
    effort.hidden = efforts.length === 0
    effort.disabled = !c.model
    effort.title = c.model ? '' : 'Pick a model first: an effort is only sent together with a model.'
  }
  harness.onchange = () => { Object.assign(st[key], { agent: harness.value, model: '', effort: '' }); draw() }
  surface.onchange = () => { st[key].surface = surface.value }
  effort.onchange = () => { st[key].effort = effort.value }
  return { draw }
}

const choosers = [chooser($('f-planner'), 'planner', 'Orchestrator', true), chooser($('f-worker'), 'worker', 'Workers', false)]
const drawChoosers = () => choosers.forEach((c) => c.draw())

// ---- goal box with Linear / PR / issue suggestions ----
const goal = $('goal')
const goalList = $('goal-list')
let items = []
let gi = 0
const closeGoal = () => { goalList.hidden = true; goal.setAttribute('aria-expanded', 'false'); goal.setAttribute('aria-activedescendant', ''); items = [] }
function drawGoal() {
  goalList.replaceChildren(
    ...items.map((it, i) => {
      const row = el('div', { id: `go-${i}`, className: 'opt' + (i === gi ? ' active' : ''), role: 'option' }, el('span', { className: 'tag', textContent: KIND_LABEL[it.kind] }), el('code', { textContent: it.id }), el('span', { className: 't', textContent: it.title }))
      row.onmousedown = (e) => { e.preventDefault(); pickGoal(it) }
      return row
    })
  )
  goalList.hidden = items.length === 0
  goal.setAttribute('aria-expanded', String(items.length > 0))
  goal.setAttribute('aria-activedescendant', items.length ? `go-${gi}` : '')
  goalList.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}
function pickGoal(it) { goal.value = goalText(it); closeGoal(); search.cancel(); goal.focus() }
const search = createSearcher({
  request: (q) => req('goal.search', { q }),
  onResult: (res) => {
    items = res?.items ?? []
    gi = 0
    const hint = $('goal-hint')
    hint.textContent = (res?.hints ?? []).join(' ')
    hint.hidden = !hint.textContent
    drawGoal()
  }
})
let picked = false
goal.addEventListener('input', () => { if (picked) { picked = false } search.input(goal.value) })
goal.addEventListener('keydown', (e) => {
  if (goalList.hidden || !items.length) return
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return
  const r = listKey(gi, items.length, e.key)
  e.preventDefault()
  gi = r.index
  if (r.action === 'select') pickGoal(items[gi])
  else if (r.action === 'close') closeGoal()
  else drawGoal()
})
goal.addEventListener('blur', () => setTimeout(closeGoal, 120))

// ---- links: exact refs link on Enter, free text searches (goal.search), suggestions and chips link/unlink ----
const links = $('links')
const linksList = $('links-list')
let linkItems = []
let li = 0
const setLinkHint = (text) => {
  const hint = $('links-hint')
  hint.textContent = text ?? ''
  hint.hidden = !text
}
const closeLinks = () => { linksList.hidden = true; links.setAttribute('aria-expanded', 'false'); links.setAttribute('aria-activedescendant', ''); linkItems = [] }
function drawLinks() {
  linksList.replaceChildren(
    ...linkItems.map((it, i) => {
      const row = el('div', { id: `lk-${i}`, className: 'opt' + (i === li ? ' active' : ''), role: 'option' }, el('span', { className: 'tag', textContent: KIND_LABEL[it.kind] ?? 'Link' }), el('code', { textContent: it.id ?? '' }), el('span', { className: 't', textContent: it.title ?? it.url ?? '' }))
      row.onmousedown = (e) => { e.preventDefault(); sendLink(it) }
      return row
    })
  )
  linksList.hidden = linkItems.length === 0
  links.setAttribute('aria-expanded', String(linkItems.length > 0))
  links.setAttribute('aria-activedescendant', linkItems.length ? `lk-${li}` : '')
  linksList.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}
async function sendLink(it = {}) {
  const ref = String(it?.url || it?.id || links.value).trim()
  closeLinks()
  setLinkHint('')
  const r = await req('link.add', { ref }).catch((e) => ({ ok: false, error: { message: String(e?.message ?? e) } }))
  if (r.ok) {
    links.value = ''
    void load()
  } else setLinkHint(r.error?.message ?? 'Could not link that.')
}
async function unlink(link) {
  setLinkHint('')
  const r = await req('link.remove', { kind: link.kind, value: link.value }).catch((e) => ({ ok: false, error: { message: String(e?.message ?? e) } }))
  if (!r.ok) setLinkHint(r.error?.message ?? 'Could not unlink that.')
  void load()
}
const linkSearch = createSearcher({
  request: (q) => req('goal.search', { q }),
  onResult: (res) => { linkItems = res?.items ?? []; li = 0; drawLinks() }
})
links.addEventListener('input', () => {
  setLinkHint('')
  if (parseRef(links.value)) { linkSearch.cancel(); closeLinks(); return }
  linkSearch.input(links.value)
})
links.addEventListener('keydown', (e) => {
  const exact = parseRef(links.value)
  if (e.key === 'Enter' && (exact || (!linksList.hidden && linkItems.length))) { e.preventDefault(); sendLink(exact ? {} : linkItems[li]); return }
  if (linksList.hidden || !linkItems.length || !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return
  const r = listKey(li, linkItems.length, e.key)
  e.preventDefault()
  li = r.index
  if (r.action === 'select') sendLink(linkItems[li])
  else if (r.action === 'close') closeLinks()
  else drawLinks()
})
links.addEventListener('blur', () => setTimeout(closeLinks, 120))

// ---- actions ----
async function act(name, run, success) {
  st.busy = name; st.notice = null; st.claimedBy = null; render()
  try {
    const r = await run()
    if (!r.ok && r.error?.code === 'planner_claimed') st.claimedBy = r.claim?.holder ?? 'an unknown caller'
    else st.notice = r.ok ? { tone: 'ok', text: success(r) } : { tone: 'danger', text: r.error.message }
  } catch (e) {
    st.notice = { tone: 'danger', text: String(e?.message ?? e) }
  }
  st.busy = null
  void load()
}
const startRun = (replace = false) =>
  act('start', () => req('run.start', { goal: goal.value, plannerAgent: st.planner.agent, plannerModel: st.planner.model || '', plannerSurface: st.planner.surface, plannerEffort: st.planner.effort || '', workerAgent: st.worker.agent, workerModel: st.worker.model || '', workerEffort: st.worker.effort || '', replace }),
    (r) => startNote(r))
$('start').onclick = () => startRun(false)
$('install').onclick = () => act('install', () => req('workspace.install'), () => 'MTE installed in this workspace.')
$('repair').onclick = () => act('repair', () => req('setup.repair'), () => 'Setup finished: mte and the mte-flow skill are ready.')

// ---- state ----
async function load() {
  try {
    st.snap = await req('state.get')
    st.loadError = null
    if (!st.prefilled) {
      st.prefilled = true
      const s = st.snap.settings
      st.planner = { agent: s.plannerAgent, surface: s.plannerSurface, model: s.plannerModel, effort: s.plannerEffort }
      st.worker = { agent: s.workerAgent, model: s.workerModel, effort: s.workerEffort }
      drawChoosers()
    }
  } catch (e) {
    st.loadError = String(e?.message ?? e)
  }
  render()
}
async function loadLists() {
  const hl = await req('harness.list').catch(() => ({ harnesses: [], error: 'the harness.list request failed' }))
  st.harnesses = hl.harnesses ?? []
  st.harnessError = hl.error ?? null
  drawChoosers()
  // each harness fills in as its own CLI answers (agy takes seconds); a failed probe reports its error
  await Promise.all(st.harnesses.map(async (h) => { st.models[h.id] = await req('models.list', { agent: h.id }).catch((e) => ({ models: [], efforts: [], error: String(e?.message ?? e) })); drawChoosers() }))
  render()
}

function callout(tone, title, body, ...buttons) {
  return el('div', { className: `callout ${tone}` }, ...(title ? [el('b', { textContent: title })] : []), el('span', { textContent: body }), ...(buttons.length ? [el('div', { className: 'row' }, ...buttons)] : []))
}
const btn = (text, onclick) => el('button', { type: 'button', textContent: text, onclick, disabled: st.busy !== null })

// folded orchestrators stay folded across refreshes
const closedRuns = new Set()
const agentBadge = (agent) => harnessIcon(st.harnesses.find((h) => h.id === agent) ?? { id: agent, name: agent })
const choiceText = (model, effort) => [model || 'default model', effort].filter(Boolean).join(' · ')

function render() {
  const s = st.snap
  const out = []
  if (st.loadError) out.push(callout('danger', 'Could not reach the MTE worker', st.loadError))
  if (s?.setup.status === 'running') out.push(callout('', 'Setting up MTE', s.setup.message))
  // npm i -g never runs unattended: the person consents here (or dismisses; Repair setup still works)
  if (s?.setup.status === 'needs-consent') out.push(callout('', 'Setup needs your OK', s.setup.message, btn('Run setup', () => act('repair', () => req('setup.repair'), () => 'Setup finished: mte and the mte-flow skill are ready.')), btn('Not now', () => act('decline', () => req('setup.dismiss'), () => 'Skipped: press Repair setup whenever you want it run.'))))
  if (s?.setup.status === 'error') out.push(callout('danger', 'MTE setup failed', s.setup.message, btn('Repair setup', () => act('repair', () => req('setup.repair'), () => 'Setup finished.'))))
  if (s && !s.depthReminderDismissed) out.push(callout('', 'One manual setting', 'Set Settings → Orchestration → Nested worker depth = 1 so dispatched workers cannot start workers.', btn('Dismiss', () => act('dismiss', () => req('reminder.dismiss'), () => 'Reminder dismissed.'))))
  if (s?.mte.missing) out.push(callout('danger', s.mte.unusable ? 'mte binary not usable' : 'mte binary not found', s.mte.message ?? ''))
  const drift = s ? mteDriftHint(s.mte) : null
  if (drift) out.push(callout(drift.tone, drift.title, drift.body))
  const conflict = claimCallout(s, st.claimedBy)
  if (conflict) out.push(callout(conflict.tone, conflict.title, conflict.body, ...(conflict.replace ? [btn('Replace planner', () => startRun(true))] : [])))
  const hints = listHints({ harnessError: st.harnessError, models: st.models })
  if (hints.length) out.push(el('div', { className: 'muted', textContent: hints.join(' ') }))
  if (st.notice) out.push(callout(st.notice.tone, '', st.notice.text))
  $('notices').replaceChildren(...out)

  $('active').textContent = `${s?.activeWorkers ?? 0} active`
  const version = s ? mteRow(s.mte) : null
  $('ws').textContent = (s?.workspace ? `Workspace: ${s.workspace.name} · ${s.workspace.path}` : 'No workspace focused.') + (version ? ` · ${version}` : '')
  const chips = s?.workspace?.links ?? []
  if (s?.workspace?.linksError) setLinkHint(`Could not read the workspace links: ${s.workspace.linksError}`)
  const chipBox = $('chips')
  chipBox.hidden = chips.length === 0
  chipBox.replaceChildren(
    ...chips.map((l) =>
      el('span', { className: 'chip', title: l.url || l.label },
        el('span', { className: 'tag', textContent: KIND_LABEL[l.kind] ?? 'Link' }),
        el('span', { className: 't', textContent: l.label }),
        el('button', { type: 'button', textContent: '×', ariaLabel: `Remove ${l.label}`, disabled: st.busy !== null, onclick: () => unlink(l) }))
    )
  )
  const runs = s?.orchestrators ?? []
  $('runs').replaceChildren(
    ...(runs.length
      ? runs.map((r) => {
          const l = r.launch
          const box = el('details', { className: 'run', open: !closedRuns.has(r.id) },
            el('summary', {}, ...(l ? [agentBadge(l.plannerAgent)] : []), el('span', { className: 't', textContent: r.title, title: r.title }), ...(l ? [el('span', { className: 'tag', textContent: choiceText(l.plannerModel, l.plannerEffort) })] : []), el('span', { className: 'muted', textContent: `${r.workers.length} worker${r.workers.length === 1 ? '' : 's'}` })),
            ...(r.workers.length
              ? r.workers.map((w) => el('div', { className: 'worker' },
                  el('div', { className: 'who' }, ...(l ? [agentBadge(l.workerAgent)] : []), el('div', {}, el('div', { textContent: w.taskId || w.dispatchId }), el('div', { className: 'muted', textContent: [l && choiceText(l.workerModel, l.workerEffort), w.state, w.activity !== 'unknown' && w.activity, w.attention && 'needs attention'].filter(Boolean).join(' · ') }))),
                  btn('Focus', () => act('focus', () => req('workspace.focus', { workspace: w.workspace }), () => 'Workspace focused.'))))
              : [el('div', { className: 'worker muted', textContent: 'No workers running yet.' })]))
          box.ontoggle = () => (box.open ? closedRuns.delete(r.id) : closedRuns.add(r.id))
          return box
        })
      : [el('div', { className: 'empty muted', textContent: s?.error ? s.error.message : 'No orchestrators running.' })])
  )
  for (const id of ['start', 'install', 'repair']) $(id).disabled = st.busy !== null || (id === 'start' && !st.planner)
  $('start').textContent = st.busy === 'start' ? 'Starting…' : 'Start run'
}

// the worker posts state.changed whenever its poll sees an observable change: the panel never polls itself
orca.plugin.on('state.changed', () => void load())
orca.on?.('workspace.changed', () => void load())
void load()
void loadLists()
