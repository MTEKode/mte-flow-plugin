// MTE Flow panel (html, isolated frame): all data comes from the worker through orca.plugin.request.
import { addLink, attentionRow, runTarget, exactLink, linkSource, withExact, claimCallout, createSearcher, filterRepos, filterRows, fitSelection, groupRepos, groupRows, osOf, iconFor, listHints, listKey, modelRows, mteDriftHint, mteRow, originIcon, originOf, phaseText, startNote } from './logic.mjs'

const $ = (id) => document.getElementById(id)
const req = (name, params = {}) => orca.plugin.request(name, params, { timeoutMs: 120000 })
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  n.append(...kids)
  return n
}

// links are the run's own: only what the person adds here, attached to the run's workspace at Start
const st = { snap: null, harnesses: [], harnessError: null, models: {}, planner: null, worker: null, qa: null, links: [], busy: null, notice: null, claimedBy: null, prefilled: false, repoKey: '' }

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

// ---- repo picker (new workspace): project icon like Orca's sidebar, grouped by host with OS and server icons, searchable ----
const SVG = {
  mac: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2.1-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.8 1.3 10.3.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.2zM13.9 4.9c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3-1.5z"/></svg>',
  windows: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 4.3 10 3.2v8.1H2zM11 3.1 22 1.5v9.8H11zM2 12.6h8v8.2L2 19.7zM11 12.6h11v9.9l-11-1.5z"/></svg>',
  linux: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c-2.3 0-3.7 1.9-3.7 4.5 0 1.3.2 2.2-.6 3.6C6.5 12 5 14.4 5 16.9c0 1 .3 1.8.8 2.4l-1.2 1.8c-.3.5.1 1 .6 1h4.1c.5 0 .9-.3 1.1-.7.5.1 1 .2 1.6.2s1.1-.1 1.6-.2c.2.4.6.7 1.1.7h4.1c.5 0 .9-.5.6-1l-1.2-1.8c.5-.6.8-1.4.8-2.4 0-2.5-1.5-4.9-2.7-6.8-.8-1.4-.6-2.3-.6-3.6C15.7 3.9 14.3 2 12 2zm-1.6 3.6c.5 0 .8.5.8 1.1s-.4 1.1-.8 1.1-.8-.5-.8-1.1.4-1.1.8-1.1zm3.2 0c.5 0 .8.5.8 1.1s-.4 1.1-.8 1.1-.8-.5-.8-1.1.4-1.1.8-1.1zM12 12c1.7 0 3 1.8 3 4s-1.3 4-3 4-3-1.8-3-4 1.3-4 3-4z"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>'
}
// link origins, drawn like their own marks (monochrome, currentColor)
Object.assign(SVG, {
  linear: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.6 14.1 9.9 21.4c-3.7-.8-6.5-3.6-7.3-7.3zM2.3 11l10.7 10.7c.8-.1 1.6-.3 2.3-.5L2.8 8.7c-.3.7-.4 1.5-.5 2.3zm1.5-4.3 13.5 13.5c.6-.3 1.2-.7 1.7-1.2L5 5c-.5.5-.9 1.1-1.2 1.7zM6.6 3.6A9.7 9.7 0 0 1 12 2a10 10 0 0 1 10 10c0 2-.6 3.9-1.6 5.4z"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 4.9.4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>',
  gitlab: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m22.7 13.4-1.2-3.7-2.4-7.3a.4.4 0 0 0-.8 0l-2.4 7.3H8.1L5.7 2.4a.4.4 0 0 0-.8 0L2.5 9.7l-1.2 3.7c-.1.3 0 .7.3.9L12 21.9l10.4-7.6c.3-.2.4-.6.3-.9z"/></svg>',
  jira: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.6 2H2a4.3 4.3 0 0 0 4.3 4.3h1.8V8a4.3 4.3 0 0 0 4.3 4.3V2.8a.8.8 0 0 0-.8-.8zm4.7 4.7H6.7A4.3 4.3 0 0 0 11 11h1.8v1.7a4.3 4.3 0 0 0 4.3 4.3V7.5a.8.8 0 0 0-.8-.8zM21 11.4h-9.6a4.3 4.3 0 0 0 4.3 4.3h1.8v1.7a4.3 4.3 0 0 0 4.3 4.3v-9.5a.8.8 0 0 0-.8-.8z"/></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'
})
const SOURCE_LABEL = { linear: 'Linear', github: 'GitHub', gitlab: 'GitLab', jira: 'Jira', web: 'Link' }
const linkIcon = (it) => el('span', { className: `os src src-${linkSource(it)}`, title: SOURCE_LABEL[linkSource(it)], innerHTML: SVG[linkSource(it)] })
const OS_LABEL = { mac: 'macOS', windows: 'Windows', linux: 'Linux' }
const svgIcon = (name, title) => el('span', { className: 'os', title, innerHTML: SVG[name] })
/** OS icon of a host plus a server icon when it is another machine. */
const hostIcons = (h) => [...(osOf(h.platform) ? [svgIcon(osOf(h.platform), OS_LABEL[osOf(h.platform)])] : []), ...(h.server ? [svgIcon('server', 'Server')] : [])]
/** The project's own icon (as Orca shows it), or its first letter on the project's badge color. */
const repoIcon = (r) =>
  r.icon
    ? el('img', { className: 'repo-ico', src: r.icon, alt: '' })
    : el('span', { className: 'repo-ico letter', textContent: (r.name || '?')[0].toUpperCase(), ariaHidden: 'true', style: `background:${/^#[0-9a-f]{3,8}$/i.test(r.color ?? '') ? r.color : 'var(--orca-muted-foreground)'}` })

function repoPicker(field, { rows, get, set }) {
  const btn = el('button', { type: 'button', className: 'picker', ariaLabel: 'Repo for the new workspace', ariaHasPopup: 'listbox' })
  field.append(btn)
  let pop = null
  let active = 0
  let shown = []
  const label = () => {
    const r = rows().find((x) => x.key === get())
    btn.replaceChildren(
      ...(r ? [repoIcon(r), el('span', { className: 't', textContent: r.name }), el('span', { className: 'sub', textContent: r.host }), el('span', { className: 'hostbadges' }, ...hostIcons(r))] : [el('span', { className: 't muted', textContent: rows().length ? 'Pick a repo…' : 'No repos in Orca' })]),
      el('span', { className: 'caret', textContent: '▼', ariaHidden: 'true' })
    )
  }
  const close = (focus) => { pop?.remove(); pop = null; if (focus) btn.focus() }
  const choose = (key) => { set(key); label(); close(true) }
  btn.onclick = () => {
    if (pop) return close(true)
    const pid = ++popSeq
    const input = el('input', { placeholder: 'Search repos or hosts', ariaLabel: 'Search repos' })
    const list = el('div', { role: 'listbox' })
    pop = el('div', { className: 'pop' }, input, list)
    const draw = () => {
      const groups = groupRepos(filterRepos(rows(), input.value.trim()))
      shown = groups.flatMap((g) => g.repos)
      active = Math.max(0, Math.min(active, shown.length - 1))
      let at = 0
      list.replaceChildren(
        ...groups.flatMap((g) => [
          el('div', { className: 'group' }, ...hostIcons(g), el('span', { textContent: g.host })),
          ...g.repos.map((r) => {
            const i = at++
            const row = el('div', { id: `ro-${pid}-${i}`, className: 'opt repo' + (i === active ? ' active' : ''), role: 'option', ariaSelected: String(r.key === get()) },
              repoIcon(r), el('div', { className: 'main' }, el('span', { className: 't', textContent: r.name }), el('span', { className: 'sub', textContent: r.path, title: r.path })))
            row.onmousedown = (e) => { e.preventDefault(); choose(r.key) }
            return row
          })
        ]),
        ...(shown.length ? [] : [el('div', { className: 'opt muted', textContent: 'No repos match.' })])
      )
      input.setAttribute('aria-activedescendant', shown.length ? `ro-${pid}-${active}` : '')
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
    }
    input.oninput = () => { active = 0; draw() }
    input.onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const r = listKey(active, shown.length, e.key)
      active = r.index
      if (r.action === 'select' && shown[active]) choose(shown[active].key)
      else if (r.action === 'close') close(true)
      else draw()
    }
    input.onblur = () => setTimeout(() => close(false), 120)
    field.append(pop)
    active = Math.max(0, groupRepos(rows()).flatMap((g) => g.repos).findIndex((r) => r.key === get()))
    draw()
    input.focus()
  }
  return { label }
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

const repoPick = repoPicker($('ws-repo'), { rows: () => st.snap?.repos ?? [], get: () => st.repoKey, set: (k) => { st.repoKey = k; render() } })
const choosers = [chooser($('f-planner'), 'planner', 'Orchestrator', true), chooser($('f-worker'), 'worker', 'Coder', false), chooser($('f-qa'), 'qa', 'QA', false)]
const drawChoosers = () => choosers.forEach((c) => c.draw())

const goal = $('goal')

// ---- links: what is typed is searched (goal.search); text that already is a link shows as the top row. Rows are
// picked with click, or ↑ ↓ and Enter; nothing is added on its own ----
const links = $('links')
const linksList = $('links-list')
let linkItems = [] // what the list shows (exact row merged with the results)
let foundItems = [] // the last search results
let exactRow = null // the row for text that is already a link
let li = -1
let linkHints = []
let linkQueried = false
let linkSearching = null // the query being searched, while the spinner shows
const setLinkHint = (text) => {
  const hint = $('links-hint')
  hint.textContent = text ?? ''
  hint.hidden = !text
}
const linkBox = links.parentElement
const closeLinks = () => { linkSearching = null; linkBox.classList.remove('searching'); linksList.hidden = true; links.setAttribute('aria-expanded', 'false'); links.setAttribute('aria-activedescendant', ''); linkItems = []; foundItems = []; exactRow = null; linkHints = []; linkQueried = false }
function drawLinks() {
  linkItems = withExact(exactRow, foundItems)
  li = Math.min(li, linkItems.length - 1)
  linkBox.classList.toggle('searching', Boolean(linkSearching))
  const empty = linkItems.length === 0
  linksList.replaceChildren(
    ...linkItems.map((it, i) => {
      const linked = st.links.some((l) => l.ref === it.url || (it.id && l.label === it.id))
      const kind = it.kind === 'pr' ? 'PR' : it.kind === 'issue' ? 'Issue' : null
      const title = it.title ?? (it.exact ? (linkSearching ? 'Looking it up…' : it.id ? 'Add this link' : it.url) : it.url ?? '')
      const row = el('div', { id: `lk-${i}`, className: 'opt link' + (i === li ? ' active' : '') + (linked ? ' linked' : '') + (it.exact && !it.title ? ' exact' : ''), role: 'option', ariaSelected: String(i === li) },
        linkIcon(it), ...(it.id ? [el('code', { textContent: it.id })] : []), el('span', { className: 't', textContent: title }),
        ...(kind ? [el('span', { className: 'tag', textContent: kind })] : []), ...(linked ? [el('span', { className: 'tag', textContent: '✓ linked' })] : []))
      row.onmousedown = (e) => { e.preventDefault(); sendLink(it) }
      row.onmouseenter = () => { li = i; for (const n of linksList.querySelectorAll('.opt.link')) n.classList.toggle('active', n === row) }
      return row
    }),
    ...(linkSearching ? [el('div', { className: 'opt muted searching-row', role: 'status' }, el('span', { className: 'spinner', ariaHidden: 'true' }), el('span', { className: 't', textContent: `Searching Linear and GitHub for “${linkSearching}”…` }))] : []),
    ...(!linkSearching && empty ? linkHints.map((h) => el('div', { className: 'opt muted', textContent: h })) : []),
    ...(!linkSearching && empty && linkHints.length === 0 && linkQueried ? [el('div', { className: 'opt muted', textContent: 'No issues or PRs match.' })] : [])
  )
  const open = !linksList.firstChild ? false : true
  linksList.hidden = !open
  links.setAttribute('aria-expanded', String(open))
  links.setAttribute('aria-activedescendant', linkItems[li] ? `lk-${li}` : '')
  linksList.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}
function sendLink(it) {
  const ref = String(it?.url || it?.id || '').trim()
  linkSearch.cancel()
  closeLinks()
  const next = addLink(st.links, ref, it?.id)
  if (!next) return setLinkHint(`“${ref.slice(0, 60)}” is not an identifier or URL: pick a suggestion instead.`)
  setLinkHint('')
  st.links = next
  // clear through the editing commands, not .value: Cmd/Ctrl+Z can bring the text back
  links.select()
  if (!document.execCommand('delete')) links.value = ''
  render()
}
function unlink(link) {
  st.links = st.links.filter((l) => l !== link)
  render()
}
const linkSearch = createSearcher({
  request: (q) => req('goal.search', { q }),
  onSearching: (q) => { linkSearching = q; drawLinks() },
  onResult: (res) => { linkSearching = null; foundItems = res?.items ?? []; linkHints = res?.hints ?? []; linkQueried = Boolean(res); drawLinks() }
})
links.addEventListener('input', () => {
  setLinkHint('')
  exactRow = exactLink(links.value)
  // a typed link is the top row and Enter picks it; free text highlights nothing until the person moves
  li = exactRow ? 0 : -1
  foundItems = []
  linkQueried = false
  linkHints = []
  if (exactRow && !exactRow.search) {
    linkSearch.cancel()
    linkSearching = null
    drawLinks()
    return
  }
  drawLinks()
  linkSearch.input(exactRow?.search ?? links.value)
})
links.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && linkItems[li]) { e.preventDefault(); sendLink(linkItems[li]); return }
  if (e.key === 'Enter') { e.preventDefault(); return }
  if (linksList.hidden || !linkItems.length || !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return
  const r = listKey(li, linkItems.length, e.key)
  e.preventDefault()
  li = r.index
  if (r.action === 'select' && linkItems[li]) sendLink(linkItems[li])
  else if (r.action === 'close') { linkSearch.cancel(); closeLinks() }
  else drawLinks()
})
links.addEventListener('blur', () => setTimeout(() => { linkSearch.cancel(); closeLinks() }, 120))

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
  act('start', () => req('run.start', { goal: goal.value, plannerAgent: st.planner.agent, plannerModel: st.planner.model || '', plannerSurface: st.planner.surface, plannerEffort: st.planner.effort || '', workerAgent: st.worker.agent, workerModel: st.worker.model || '', workerEffort: st.worker.effort || '', qaAgent: st.qa.agent, qaModel: st.qa.model || '', qaEffort: st.qa.effort || '', links: st.links.map((l) => l.ref), replace, newWorkspace: $('new-ws').checked, repoKey: st.repoKey, workspaceName: $('ws-name').value, baseBranch: $('ws-base').value }),
    (r) => { st.links = []; return startNote(r) })
$('start').onclick = () => startRun(false)
// the name/base inputs only exist for a new-workspace start
$('new-ws').onchange = (e) => {
  $('ws-fields').hidden = !e.target.checked
  render()
}
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
      st.qa = { agent: s.qaAgent, model: s.qaModel, effort: s.qaEffort }
      drawChoosers()
    }
  } catch (e) {
    st.loadError = String(e?.message ?? e)
  }
  render()
}
/** Harnesses and models of the machine the run will happen on (runTarget); a newer target supersedes a slower answer. */
let listSeq = 0
async function loadLists(target = { env: null, worktree: null, label: 'this machine', key: 'local|' }) {
  const mine = ++listSeq
  st.listTarget = target.key
  const hl = await req('harness.list', { target }).catch(() => ({ harnesses: [], error: 'the harness.list request failed' }))
  if (mine !== listSeq) return
  st.harnesses = hl.harnesses ?? []
  st.harnessError = hl.error ?? null
  st.models = {}
  st.listLabel = target.label
  drawChoosers()
  // each harness fills in as its own CLI answers (agy takes seconds); a failed probe reports its error
  await Promise.all(st.harnesses.map(async (h) => {
    const m = await req('models.list', { agent: h.id, target }).catch((e) => ({ models: [], efforts: [], error: String(e?.message ?? e) }))
    if (mine !== listSeq) return
    st.models[h.id] = m
    drawChoosers()
  }))
  if (mine === listSeq) render()
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
  $('ws').textContent = (s?.workspace ? `Workspace: ${s.workspace.name} · ${s.workspace.path}${s.workspace.host ? ` (on ${s.workspace.host})` : ''}` : 'No workspace focused.') + (version ? ` · ${version}` : '')
  // new-workspace repo picker: keep the person's pick across reloads; default to the focused workspace's repo
  const repos = s?.repos ?? []
  if (!repos.some((r) => r.key === st.repoKey)) st.repoKey = repos.some((r) => r.key === s?.focusedRepoKey) ? s.focusedRepoKey : ''
  repoPick.label()
  // agents and models come from the machine the run will happen on: reload them when that machine changes
  const target = runTarget({ newWorkspace: $('new-ws').checked, repos, repoKey: st.repoKey, workspace: s?.workspace })
  if (s && target.key !== st.listTarget) void loadLists(target)
  $('agents-host').textContent = target.env || target.worktree ? `Agents and models from ${target.label}` : ''
  $('agents-host').hidden = !(target.env || target.worktree)
  const chips = st.links
  goal.placeholder = chips.length ? 'Optional: the linked items are the goal. Add context if you want…' : 'Describe the goal, or just add links below…'
  const chipBox = $('chips')
  chipBox.hidden = chips.length === 0
  chipBox.replaceChildren(
    ...chips.map((l) =>
      el('span', { className: 'chip', title: l.ref || l.label },
        linkIcon(l),
        el('span', { className: 't', textContent: l.label }),
        el('button', { type: 'button', textContent: '×', ariaLabel: `Remove ${l.label}`, onclick: () => unlink(l) }))
    )
  )
  const attention = s?.attention ?? []
  $('attention-box').hidden = attention.length === 0
  $('attention').replaceChildren(
    ...attention.map((item) => {
      const row = attentionRow(item)
      const button =
        row.action === 'release'
          ? [btn('Release', () => act('release', () => req('worker.release', { dispatchId: item.dispatchId }), () => 'Worker terminal released.'))]
          : row.action === 'focus'
            ? [btn('Focus', () => act('focus', () => req('workspace.focus', { workspace: item.workspace }), () => 'Planner workspace focused.'))]
            : []
      return el('div', { className: 'attn' },
        el('div', { className: 't' }, el('div', {}, el('span', { className: 'tag', textContent: row.label }), ' ', el('span', { textContent: row.text, title: row.text })), el('div', { className: 'muted', textContent: row.run })),
        ...button)
    })
  )
  const runs = s?.orchestrators ?? []
  $('runs').replaceChildren(
    ...(runs.length
      ? runs.map((r) => {
          const l = r.launch
          const box = el('details', { className: 'run', open: !closedRuns.has(r.id) },
            el('summary', {}, ...(l ? [agentBadge(l.plannerAgent)] : []), el('span', { className: 't', textContent: r.title, title: r.title }), ...(phaseText(r.phase) ? [el('span', { className: 'tag', textContent: phaseText(r.phase) })] : []), ...(l ? [el('span', { className: 'tag', textContent: choiceText(l.plannerModel, l.plannerEffort) })] : []), el('span', { className: 'muted', textContent: `${r.workers.length} worker${r.workers.length === 1 ? '' : 's'}` })),
            ...(r.workers.length
              ? r.workers.map((w) => el('div', { className: 'worker' },
                  // Orca does not say which pin (coder or qa) a worker runs, so no model here
                  el('div', { className: 'who' }, el('div', {}, el('div', { textContent: w.taskId || w.dispatchId }), el('div', { className: 'muted', textContent: [w.state, w.activity !== 'unknown' && w.activity, w.attention && 'needs attention'].filter(Boolean).join(' · ') }))),
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
