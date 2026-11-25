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

/** What selecting a suggestion writes into the goal: "<id> <title>" plus the URL. */
export const goalText = (item) => `${item.id} ${item.title}\n${item.url}`

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

/** Chips for the links field: `worktree show`'s linkedItems (WorkspaceAttachment[]). kind/value choose the remove call. */
export function linksFromItems(items) {
  return (items ?? []).map((it) => {
    const id = it.identifier ?? it.linearIdentifier ?? it.jiraIdentifier
    if (it.provider === 'github' && (it.type === 'issue' || it.type === 'pr')) {
      return { kind: it.type, value: String(it.number), url: it.url ?? '', label: it.type === 'pr' ? `PR #${it.number}` : `#${it.number}` }
    }
    if (it.provider === 'linear' && id) return { kind: 'linear', value: String(id), url: it.url ?? '', label: String(id) }
    const bare = String(it.url ?? '').replace(/^https?:\/\/(?:www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
    const label = id ?? (bare || `${it.provider}:${it.type}:${it.number}`)
    return { kind: 'reference', value: it.url ?? '', url: it.url ?? '', label: it.type === 'mr' ? `MR ${label}` : `Link ${label}` }
  })
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
  return `${r.replacedStale ? 'The previous planner was closed, so its claim was dropped. ' : ''}Planner started in ${where}${fb}${r.truncated ? `; goal truncated to fit the ${PROMPT_CAP}-char prompt cap` : ''}.`
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
export function createSearcher({ request, onResult, delay = 300, minLength = 2, timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t) } }) {
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
