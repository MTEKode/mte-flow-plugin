// DOM-free helpers of the MTE Flow panel: selector rows, keyboard navigation, goal text, debounced search.
export const KIND_LABEL = { linear: 'Linear', pr: 'PR', issue: 'Issue' }

// icons shipped in panel/icons (the frame cannot load remote images); other harnesses get a letter badge
const HARNESS_ICONS = ['claude', 'opencode', 'codex', 'antigravity', 'pi', 'droid', 'gemini']
export function iconFor(agent) {
  const id = agent === 'opencode2' ? 'opencode' : agent
  return HARNESS_ICONS.includes(id) ? `icons/${id}.png` : null
}

/** `[value, label]` rows of the model selector; a current model the harness did not list stays selectable. */
export function modelRows(info, current) {
  if (!info.takesModel) {
    return [['', 'Agent default']]
  }
  const rows = [['', 'Default model'], ...info.models.map((m) => [m.id, m.label ?? m.id])]
  if (current && !info.models.some((m) => m.id === current)) {
    rows.push([current, current])
  }
  return rows
}

// which shipped icon stands for an origin (a provider id such as `zai-coding-plan`); first match wins
const ORIGIN_ICONS = [[/alibaba|bailian|dashscope|qwen/, 'alibaba'], [/zai|z-ai|zhipu|glm/, 'zai'], [/claude|anthropic/, 'claude'], [/opencode/, 'opencode'], [/nvidia/, 'nvidia'], [/openai|codex/, 'codex'], [/google|gemini/, 'gemini']]
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
 * Groups model rows by origin: the `provider/` prefix of a model id (opencode, pi) is the plan or account it bills.
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

/** Drops what the harness cannot take: a model where it runs its own, an effort it lacks or one without a model. */
export function fitSelection(sel, info) {
  const model = info.takesModel ? sel.model || '' : ''
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
