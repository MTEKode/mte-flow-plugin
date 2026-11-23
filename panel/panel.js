// MTE Flow panel (html, isolated frame): all data comes from the worker through orca.plugin.request.
import { buildOptions, createSearcher, customOption, filterOptions, goalText, KIND_LABEL, listKey, optionLabel, sameOption } from './logic.mjs'

const $ = (id) => document.getElementById(id)
const req = (name, params = {}) => orca.plugin.request(name, params, { timeoutMs: 120000 })
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  n.append(...kids)
  return n
}

const st = { snap: null, harnesses: [], models: {}, planner: null, worker: null, busy: null, notice: null, claimedBy: null, prefilled: false }

// ---- combined harness/model/effort dropdown (like the new-workspace modal's agent row) ----
function picker(btn, { withSurface, get, set }) {
  const field = btn.parentElement
  let pop = null
  let active = 0
  let rows = []
  const label = () => {
    const c = get()
    const h = st.harnesses.find((x) => x.id === c?.agent)
    btn.firstElementChild.textContent = c ? optionLabel({ name: h?.name ?? c.agent, surface: withSurface ? c.surface : undefined, model: c.model, effort: c.effort }) : 'Loading…'
  }
  const close = () => { pop?.remove(); pop = null; btn.focus() }
  const draw = (list, q) => {
    list.replaceChildren(
      ...rows.map((o, i) => {
        const row = el('div', { className: 'opt' + (i === active ? ' active' : ''), role: 'option', ariaSelected: String(i === active) }, el('span', { className: 't', textContent: o.label }))
        row.onmousedown = (e) => { e.preventDefault(); choose(o) }
        return row
      })
    )
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }
  const choose = (o) => { set(o); pop?.remove(); pop = null; label(); btn.focus() }
  const open = () => {
    if (pop) return close()
    const all = buildOptions({ harnesses: st.harnesses, models: st.models, withSurface })
    const input = el('input', { placeholder: 'Search harness, model or effort — or type a model id', ariaLabel: 'Search' })
    const list = el('div', { role: 'listbox' })
    pop = el('div', { className: 'pop' }, input, list)
    const refresh = () => {
      const cur = get()
      const base = filterOptions(all, input.value)
      const custom = cur ? customOption(cur, input.value, st.harnesses.find((h) => h.id === cur.agent)?.name ?? cur.agent) : null
      rows = custom && !all.some((o) => sameOption(o, custom)) ? [custom, ...base] : base
      active = Math.max(0, Math.min(active, rows.length - 1))
      draw(list, input.value)
    }
    input.oninput = () => { active = 0; refresh() }
    input.onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const r = listKey(active, rows.length, e.key)
      active = r.index
      if (r.action === 'select') choose(rows[active])
      else if (r.action === 'close') close()
      else draw(list, input.value)
    }
    input.onblur = () => setTimeout(() => { pop?.remove(); pop = null }, 120)
    field.append(pop)
    const cur = get()
    refresh()
    const at = cur ? rows.findIndex((o) => sameOption(o, cur)) : -1
    if (at >= 0) { active = at; draw(list, '') }
    input.focus()
  }
  btn.onclick = open
  return { label }
}

const plannerPicker = picker($('planner-btn'), { withSurface: true, get: () => st.planner, set: (o) => { st.planner = { agent: o.agent, surface: o.surface, model: o.model, effort: o.effort } } })
const workerPicker = picker($('worker-btn'), { withSurface: false, get: () => st.worker, set: (o) => { st.worker = { agent: o.agent, model: o.model, effort: o.effort } } })

// ---- goal box with Linear / PR / issue suggestions ----
const goal = $('goal')
const goalList = $('goal-list')
let items = []
let gi = 0
const closeGoal = () => { goalList.hidden = true; goal.setAttribute('aria-expanded', 'false'); items = [] }
function drawGoal() {
  goalList.replaceChildren(
    ...items.map((it, i) => {
      const row = el('div', { className: 'opt' + (i === gi ? ' active' : ''), role: 'option' }, el('span', { className: 'tag', textContent: KIND_LABEL[it.kind] }), el('code', { textContent: it.id }), el('span', { className: 't', textContent: it.title }))
      row.onmousedown = (e) => { e.preventDefault(); pickGoal(it) }
      return row
    })
  )
  goalList.hidden = items.length === 0
  goal.setAttribute('aria-expanded', String(items.length > 0))
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
    (r) => `Planner started in ${r.surface === 'chat' ? 'a native chat' : 'a new terminal'}${r.fallback ? ' (chat was unavailable, fell back to a terminal)' : ''}${r.truncated ? '; goal truncated to fit the 4096-char prompt cap' : ''}.`)
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
    }
  } catch (e) {
    st.loadError = String(e?.message ?? e)
  }
  render()
}
async function loadLists() {
  st.harnesses = (await req('harness.list')).harnesses
  await Promise.all(st.harnesses.map(async (h) => { st.models[h.id] = await req('models.list', { agent: h.id }).catch(() => ({ models: [], efforts: [] })) }))
  render()
}

function callout(tone, title, body, ...buttons) {
  return el('div', { className: `callout ${tone}` }, ...(title ? [el('b', { textContent: title })] : []), el('span', { textContent: body }), ...(buttons.length ? [el('div', { className: 'row' }, ...buttons)] : []))
}
const btn = (text, onclick) => el('button', { type: 'button', textContent: text, onclick, disabled: st.busy !== null })

function render() {
  const s = st.snap
  const out = []
  if (st.loadError) out.push(callout('danger', 'Could not reach the MTE worker', st.loadError))
  if (s?.setup.status === 'running') out.push(callout('', 'Setting up MTE', s.setup.message))
  if (s?.setup.status === 'error') out.push(callout('danger', 'MTE setup failed', s.setup.message, btn('Repair setup', () => act('repair', () => req('setup.repair'), () => 'Setup finished.'))))
  if (s && !s.depthReminderDismissed) out.push(callout('', 'One manual setting', 'Set Settings → Orchestration → Nested worker depth = 1 so dispatched workers cannot start workers.', btn('Dismiss', () => act('dismiss', () => req('reminder.dismiss'), () => 'Reminder dismissed.'))))
  if (s?.mte.missing) out.push(callout('danger', s.mte.unusable ? 'mte binary not usable' : 'mte binary not found', s.mte.message ?? ''))
  if (st.claimedBy) out.push(callout('', 'A planner is already running here', `Held by ${st.claimedBy}. Replacing it cuts that planner off from dispatching workers.`, btn('Replace planner', () => startRun(true))))
  if (st.notice) out.push(callout(st.notice.tone, '', st.notice.text))
  $('notices').replaceChildren(...out)

  const workers = s?.workers ?? []
  $('active').textContent = `${workers.filter((w) => w.active).length} active`
  $('ws').textContent = s?.workspace ? `Workspace: ${s.workspace.name} · ${s.workspace.path}` : 'No workspace focused.'
  $('workers').replaceChildren(
    ...(workers.length
      ? workers.map((w) => el('div', { className: 'worker' }, el('div', {}, el('div', { textContent: `${w.taskId || w.dispatchId} · ${w.agent}` }), el('div', { className: 'muted', textContent: `${w.state} · ${w.outcome} · ${w.liveness}` })), btn('Focus', () => act('focus', () => req('workspace.focus', { workspace: w.workspace }), () => 'Workspace focused.'))))
      : [el('div', { className: 'worker muted', textContent: s?.error ? s.error.message : 'No workers yet.' })])
  )
  for (const id of ['start', 'install', 'repair']) $(id).disabled = st.busy !== null || (id === 'start' && !st.planner)
  $('start').textContent = st.busy === 'start' ? 'Starting…' : 'Start run'
  plannerPicker.label()
  workerPicker.label()
}

orca.plugin.on('state.changed', () => void load())
orca.on?.('workspace.changed', () => void load())
void load()
void loadLists()
