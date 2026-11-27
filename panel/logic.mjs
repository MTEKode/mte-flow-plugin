// DOM-free helpers of the MTE Flow panel: selector rows, keyboard navigation, goal text, debounced search.
export const KIND_LABEL = { linear: 'Linear', pr: 'PR', issue: 'Issue' }

// icons shipped in panel/icons (the frame cannot load remote images); other harnesses get a letter badge
const HARNESS_ICONS = ['claude', 'antigravity']
export const iconFor = (agent) => (HARNESS_ICONS.includes(agent) ? `icons/${agent}.png` : null)

/** `[value, label]` rows of the model selector; a current model the harness did not list stays selectable. */
export function modelRows(info, current) {
  const rows = [['', 'Default model'], ...info.models.map((m) => [m.id, m.label ?? m.id])]
  if (current && !info.models.some((m) => m.id === current)) {
    rows.push([current, current])
  }
  return rows
}

// which shipped icon stands for an origin (a provider id such as `alibaba-coder-plan`); first match wins
const ORIGIN_ICONS = [[/alibaba|bailian|dashscope|qwen/, 'alibaba'], [/claude|anthropic/, 'claude'], [/nvidia/, 'nvidia']]
export function originIcon(origin) {
  const hit = ORIGIN_ICONS.find(([re]) => re.test(String(origin).toLowerCase()))
  return hit ? `icons/${hit[1]}.png` : null
}

/** The origin of a model id: its `provider/` prefix, or null. */
export const originOf = (id) => (String(id).indexOf('/') > 0 ? String(id).slice(0, String(id).indexOf('/')) : null)

/** Case-insensitive AND over the words of `q`, matched against a row's id and label. */
export function filterRows(rows, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? rows.filter(([value, label]) => words.every((w) => `${value} ${label}`.toLowerCase().includes(w))) : rows
}

/**
 * Groups model rows by origin: the `provider/` prefix of a model id is the plan or account it bills.
 * Rows without a prefix come first, ungrouped. Labels keep the full id so the closed selector still names the origin.
 */
export function groupRows(rows) {
  const groups = [{ origin: null, rows: [] }]
  for (const [value, label] of rows) {
    const origin = originOf(value)
    let group = groups.find((g) => g.origin === origin)
    if (!group) {
      groups.push((group = { origin, rows: [] }))
    }
    group.rows.push([value, label])
  }
  return groups
}

/** Drops what the harness cannot take: an effort it lacks or one without a model. */
export function fitSelection(sel, info) {
  const model = sel.model || ''
  return { ...sel, model, effort: model && info.efforts.includes(sel.effort) ? sel.effort : '' }
}

/** Next highlighted index for ArrowDown/ArrowUp/Home/End in a list of `n` rows (wraps; -1 when empty). */
export function moveIndex(index, n, key) {
  if (n <= 0) {
    return -1
  }
  if (key === 'ArrowDown') {
    return index < 0 || index >= n - 1 ? 0 : index + 1
  }
  if (key === 'ArrowUp') {
    return index <= 0 ? n - 1 : index - 1
  }
  if (key === 'Home') {
    return 0
  }
  if (key === 'End') {
    return n - 1
  }
  return index
}

/** One keydown on an open list -> { index, action } where action is 'select' | 'close' | null. */
export function listKey(index, n, key) {
  if (key === 'Enter') {
    return { index, action: index >= 0 && index < n ? 'select' : null }
  }
  if (key === 'Escape') {
    return { index, action: 'close' }
  }
  return { index: moveIndex(index, n, key), action: null }
}

/**
 * Direct parse of the links input; null when the text is search material instead.
 * `#45` -> GitHub issue, `ENG-123` -> Linear, a github.com PR/issue URL -> pr/issue,
 * a linear.app issue URL -> Linear, any other http(s) URL -> reference (Orca parses its provider).
 */
export function parseRef(text) {
  const t = String(text ?? '').trim()
  const gh = /^#(\d+)$/.exec(t)
  if (gh) return { kind: 'issue', value: gh[1] }
  if (/^[A-Za-z]+-\d+$/.test(t)) return { kind: 'linear', value: t }
  if (/^https?:\/\//i.test(t)) {
    let u
    try {
      u = new URL(t)
    } catch {
      return null
    }
    const host = u.hostname.toLowerCase()
    const m = host === 'github.com' ? /^\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)\/?$/.exec(u.pathname) : null
    if (m) return { kind: m[1] === 'pull' ? 'pr' : 'issue', value: m[2] }
    if (host === 'linear.app' && /^\/[^/]+\/issue\/[^/?#]+/.test(u.pathname)) return { kind: 'linear', value: t }
    return { kind: 'reference', value: t }
  }
  return null
}

/**
 * The run's chip list with `ref` added: null when `ref` is not an identifier or URL, the same list when it is already
 * there. `id` (a suggestion's `ENG-123` / `#45`) labels the chip; otherwise the typed text does, minus the scheme.
 */
export function addLink(list, ref, id) {
  const parsed = parseRef(ref)
  if (!parsed) return null
  if (list.some((l) => l.kind === parsed.kind && l.value === parsed.value)) return list
  const label = id || (parsed.kind === 'pr' ? `PR #${parsed.value}` : parsed.kind === 'issue' ? `#${parsed.value}` : String(ref).trim().replace(/^https?:\/\/(?:www\.)?/i, ''))
  return [...list, { ref: String(ref).trim(), kind: parsed.kind, value: parsed.value, label }]
}

/** Char cap of the launched prompt (worker/lib.mjs PROMPT_MAX; the panel frame cannot import it). */
export const PROMPT_CAP = 4000

/** One-line outcome after a start: where it opened, what a launcher fallback dropped, whether the goal was cut. */
export function startNote(r) {
  const where = r.surface === 'chat' ? 'a native chat' : 'a new terminal'
  const fb = r.dropped?.length
    ? ` (the orca CLI was unavailable: dropped ${r.dropped.join(', ')})`
    : r.fallback
      ? ' (chat was unavailable, fell back to a terminal)'
      : ''
  const links = r.linkFailures?.length ? `; could not attach ${r.linkFailures.length} link${r.linkFailures.length === 1 ? '' : 's'}: ${r.linkFailures.join('; ')}` : ''
  return `${r.createdWorkspace ? `New workspace “${r.createdWorkspace.name}” created. ` : ''}${r.replacedStale ? 'The previous planner was closed, so its claim was dropped. ' : ''}Planner started in ${where}${fb}${r.truncated ? `; goal truncated to fit the ${PROMPT_CAP}-char prompt cap` : ''}${links}.`
}

/** Workspace name derived from the goal: lowercase words joined with '-', max 48 chars; `mte-run` when nothing is left. */
/** A URL in a goal, reduced to what names the work: a Linear key and title, `pr-12` / `issue-12`; other URLs drop out. */
function urlWords(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean)
  if (host === 'linear.app' && parts[1] === 'issue') {
    return parts.slice(2, 4).join(' ')
  }
  const gh = host === 'github.com' ? /^(pull|issues)$/.exec(parts[2] ?? '') : null
  return gh && /^\d+$/.test(parts[3] ?? '') ? `${gh[1] === 'pull' ? 'pr' : 'issue'} ${parts[3]}` : ''
}

export function goalSlug(goal) {
  const slug = String(goal ?? '')
    .replace(/https?:\/\/\S+/gi, (url) => ` ${urlWords(url)} `)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug || 'mte-run'
}

// worktree create takes the slot links as flags (live-probed: --reference cannot mix with them, so reference chips
// attach after creation through `orca reference add`, the 0.8.1 link path)
const CREATE_LINK_FLAGS = { issue: '--issue', pr: '--pr', linear: '--linear-issue' }

/**
 * argv of `orca worktree create` for a fresh run workspace: name, the focused repo (id:<repoId> — path: only
 * resolves main checkouts, live-probed), base ref (omitted when empty: Orca then uses the repo default),
 * --no-parent, and one slot flag per link kind. Reference chips are returned as `deferred` urls instead.
 */
export function createWorkspaceArgs({ name, repoId, setupId, base, links = [] }) {
  // a project host setup names the repo on its host (local, SSH or a paired server); a bare repo id is the local fallback
  const where = setupId ? ['--project-host-setup', String(setupId)] : ['--repo', `id:${repoId}`]
  const argv = ['worktree', 'create', '--name', String(name), ...where, '--no-parent']
  if (String(base ?? '').trim()) {
    argv.push('--base-branch', String(base).trim())
  }
  const deferred = []
  for (const l of links) {
    const flag = CREATE_LINK_FLAGS[l.kind]
    if (flag && l.value) {
      argv.push(flag, String(l.value))
    } else if (l.kind === 'reference') {
      const url = String(l.value ?? l.url ?? '').trim()
      if (url) {
        deferred.push(url)
      }
    }
  }
  return { argv, deferred }
}

/** The planner-claim callout: a live foreign claim warns before Start (Replace offered); a corrupt claim only reports. */
export function claimCallout(snap, heldBy = null) {
  if (snap?.claimError) {
    return { tone: 'danger', title: 'Could not read the planner claim', body: snap.claimError }
  }
  if (snap?.claim?.claimed && !snap.claim.mine) {
    return { tone: '', title: 'A planner is already running here', body: `Held by ${snap.claim.holder}. Replacing it cuts that planner off from dispatching workers.`, replace: true }
  }
  if (heldBy) {
    return { tone: '', title: 'A planner is already running here', body: `Held by ${heldBy}. Replacing it cuts that planner off from dispatching workers.`, replace: true }
  }
  return null
}

/** mte row for the panel: the detected CLI version (null when unknown); `worker/lib.mjs checkMte` supplies the fields. */
export function mteRow({ missing, version }) {
  return missing || !version ? null : `mte ${version}`
}

/** Drift hint callout: the installed mte is below what this plugin pins (possible with manual installs); warning tone, points at Repair setup. */
export function mteDriftHint({ missing, version, required, drift }) {
  if (missing || !version || !drift) {
    return null
  }
  return { tone: 'warning', title: `mte ${version} is older than ${required}`, body: 'This plugin is built for mte ' + required + '. Press Repair setup to install it (or run the npm command in the mte-binary setting).' }
}

/** Hint lines for failed harness/model listings (the goal.search hint pattern: muted text, never a silent empty list). */
export function listHints({ harnessError, models }) {
  const hints = []
  if (harnessError) {
    hints.push(`Could not list the installed harnesses (${harnessError}); claude and antigravity stay selectable.`)
  }
  for (const [agent, info] of Object.entries(models ?? {})) {
    if (info?.error) {
      hints.push(`Could not list ${agent} models (${info.error}); type a model id instead.`)
    }
  }
  return hints
}

/**
 * Debounced, stale-safe search. `input(q)` schedules a request after `delay` ms; any older request that resolves
 * after a newer one was issued is dropped. Timers are injectable for tests.
 */
export function createSearcher({ request, onResult, onSearching = () => {}, delay = 300, minLength = 2, timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t) } }) {
  let timer = null
  let seq = 0
  return {
    input(q) {
      timers.clearTimeout(timer)
      const mine = ++seq
      const text = String(q ?? '').trim()
      if (text.length < minLength) {
        onResult(null)
        return
      }
      onSearching(text) // from the first keystroke: the debounce is waiting too
      timer = timers.setTimeout(async () => {
        let res
        try {
          res = await request(text)
        } catch {
          res = { items: [], hints: ['Search failed.'] }
        }
        if (mine === seq && !res?.stale) {
          onResult(res)
        }
      }, delay)
    },
    cancel() {
      seq++
      timers.clearTimeout(timer)
    }
  }
}

/** Run phase tag: `Fase 5/8 · Coder`; null when the planner has not announced a phase yet. */
export function phaseText(phase) {
  if (!Number.isInteger(phase?.phase)) {
    return null
  }
  return `Fase ${phase.phase}/8${phase.name ? ` · ${phase.name}` : ''}`
}

const ATTENTION_LABEL = { ask: 'Worker question', escalation: 'Escalation', gate: 'Decision gate', release: 'Idle terminal' }

/** What an attention row says and which action it offers: release a kept terminal, or focus the planner. */
export function attentionRow(item) {
  return {
    label: ATTENTION_LABEL[item.kind] ?? 'Attention',
    text: item.text,
    run: item.run,
    action: item.kind === 'release' ? 'release' : item.workspace ? 'focus' : null
  }
}

/** Repo picker rows matching every word of `q` in name, host or path. */
export function filterRepos(repos, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? repos.filter((r) => words.every((w) => `${r.name} ${r.host} ${r.path}`.toLowerCase().includes(w))) : repos
}

/** Repos grouped by host, in first-seen order (this machine first, as the worker lists it). */
export function groupRepos(repos) {
  const groups = []
  for (const r of repos) {
    let g = groups.find((x) => x.host === r.host)
    if (!g) {
      groups.push((g = { host: r.host, platform: r.platform ?? null, server: Boolean(r.server), repos: [] }))
    }
    g.repos.push(r)
  }
  return groups
}

/** `darwin` → mac, `win32` → windows, `linux` → linux; anything else → null (no OS icon). */
export function osOf(platform) {
  return { darwin: 'mac', win32: 'windows', linux: 'linux' }[platform] ?? null
}

/** Where a link comes from, for its icon: linear, github, gitlab, jira, or web. */
export function linkSource(item) {
  if (item?.kind === 'linear') return 'linear'
  const url = String(item?.url ?? item?.ref ?? item?.value ?? '')
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // a bare key or number
  }
  if (item?.kind === 'pr' || item?.kind === 'issue' || host === 'github.com') return 'github'
  if (host.includes('gitlab')) return 'gitlab'
  if (host.endsWith('atlassian.net') || host.includes('jira')) return 'jira'
  return 'web'
}

/**
 * The suggestion row for text that is already a link (`ENG-1051`, `#45`, a URL): it shows on top of the list and is
 * picked like any other row. `search` is what to look up for its title (a key or number), null for a bare URL.
 */
export function exactLink(text) {
  const t = String(text ?? '').trim()
  const p = parseRef(t)
  if (!p) return null
  const isUrl = /^https?:\/\//i.test(t)
  if (p.kind === 'linear') {
    const key = isUrl ? (/\/issue\/([A-Za-z]+-\d+)/.exec(t)?.[1] ?? '').toUpperCase() : t.toUpperCase()
    return { kind: 'linear', id: key || null, url: isUrl ? t : key, title: null, exact: true, search: key || null }
  }
  if (p.kind === 'pr' || p.kind === 'issue') {
    return { kind: p.kind, id: `#${p.value}`, url: isUrl ? t : `#${p.value}`, title: null, exact: true, search: isUrl ? null : `#${p.value}` }
  }
  return { kind: 'reference', id: null, url: t, title: null, exact: true, search: null }
}

/** The list the link field shows: search results, with the exact row on top (or the matching result moved up in its place). */
export function withExact(exact, items) {
  if (!exact) return items
  const same = (it) => exact.id && String(it.id ?? '').toUpperCase() === exact.id.toUpperCase() && (exact.kind === 'linear' ? it.kind === 'linear' : it.kind !== 'linear')
  const hit = items.find(same)
  return hit ? [hit, ...items.filter((it) => it !== hit)] : [exact, ...items]
}

/**
 * Where the run will happen, so harnesses and models come from that machine: the picked repo's host for a new
 * workspace, else the focused workspace's. `{ env, worktree, label, key }`; env and worktree null = this machine.
 */
export function runTarget({ newWorkspace, repos = [], repoKey, workspace }) {
  if (newWorkspace) {
    const r = repos.find((x) => x.key === repoKey)
    if (r && (r.env || (r.hostId && r.hostId !== 'local'))) {
      const worktree = r.hostId && r.hostId !== 'local' ? `path:${r.path}` : null
      return { env: r.env ?? null, worktree, label: r.host, key: `${r.env ?? 'local'}|${worktree ?? ''}` }
    }
    return { env: null, worktree: null, label: 'this machine', key: 'local|' }
  }
  if (workspace?.env) {
    return { env: workspace.env, worktree: workspace.id, label: workspace.host ?? workspace.env, key: `${workspace.env}|${workspace.id}` }
  }
  if (workspace?.hostId && workspace.hostId !== 'local') {
    return { env: null, worktree: workspace.id, label: workspace.hostId.replace(/^ssh:/, ''), key: `local|${workspace.id}` }
  }
  return { env: null, worktree: null, label: 'this machine', key: 'local|' }
}
