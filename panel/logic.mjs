// DOM-free helpers of the MTE Flow panel: option building/filtering, keyboard navigation, goal text, debounced search.
export const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
}
export const effortsFor = (agent) => EFFORTS[agent] ?? []
// keep in sync with worker/lib.mjs NO_MODEL_AGENTS
export const NO_MODEL_AGENTS = ['opencode2', 'droid']
export const takesModel = (agent) => !NO_MODEL_AGENTS.includes(agent)

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
export const KIND_LABEL = { linear: 'Linear', pr: 'PR', issue: 'Issue' }

/** "Claude (Chat) · sonnet · high"; `surface` is omitted for the worker selector. */
export function optionLabel({ agent, name, surface, model, effort }) {
  const head = surface ? `${name} (${cap(surface)})` : name
  if (agent && !takesModel(agent)) {
    return `${head} · agent default`
  }
  return [head, model || 'default model', effort].filter(Boolean).join(' · ')
}

/**
 * Every selectable combination: harness x [surface] x model x [effort]. Effort is only offered for harnesses that
 * take one (and never without a model). `withSurface` is true for the orchestrator, false for workers.
 */
export function buildOptions({ harnesses, models, withSurface }) {
  const out = []
  for (const h of harnesses) {
    const m = models[h.id] ?? { models: [], efforts: effortsFor(h.id) }
    const efforts = m.efforts ?? []
    for (const surface of withSurface ? ['chat', 'terminal'] : [undefined]) {
      const add = (model, effort) =>
        out.push({ agent: h.id, name: h.name, surface, model, effort, label: optionLabel({ agent: h.id, name: h.name, surface, model, effort }) })
      add('', '')
      for (const { id } of takesModel(h.id) ? m.models : []) {
        add(id, '')
        for (const effort of efforts) {
          add(id, effort)
        }
      }
    }
  }
  return out
}

/** Case-insensitive AND over the words of `q`, capped so a huge opencode list stays snappy. */
export function filterOptions(options, q, limit = 150) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const hits = words.length ? options.filter((o) => words.every((w) => o.label.toLowerCase().includes(w))) : options
  return hits.slice(0, limit)
}

/** The "type any model id" row for the harness/surface/effort currently selected. */
export function customOption(base, q, name) {
  const model = String(q ?? '').trim()
  if (!model || /\s/.test(model) || !takesModel(base.agent)) {
    return null
  }
  const effort = effortsFor(base.agent).includes(base.effort) ? base.effort : ''
  return { ...base, name, model, effort, custom: true, label: optionLabel({ agent: base.agent, name, surface: base.surface, model, effort }) }
}

export const sameOption = (a, b) => a.agent === b.agent && a.surface === b.surface && (a.model || '') === (b.model || '') && (a.effort || '') === (b.effort || '')

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
