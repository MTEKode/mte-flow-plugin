// Pure pieces of the MTE e2e: the scenario and the flow assertions over a recorded transcript.

/** What the simulated user asks for, and what it secretly prefers (the planner must find out by asking). */
export const SCENARIO = {
  goal: 'Añade una función `subtract(a, b)` exportada en `src/math.mjs`, con sus tests en `test/math.test.mjs`.',
  preferences: [
    'Sin dependencias nuevas.',
    'subtract solo acepta números: con cualquier otra cosa lanza TypeError.',
    'No quieres monitorizar ni probar ningún deploy.'
  ]
}

/** Index of the first transcript event that opens phase `n` (`## Fase N — ...`), or -1. */
export function phaseIndex(events, n) {
  const header = new RegExp(`^#{1,4}\\s*Fase\\s+${n}\\b`, 'm')
  return events.findIndex((e) => e.kind === 'assistant_text' && header.test(e.text))
}

const isDispatch = (e) => e.kind === 'tool' && e.name === 'Bash' && /\bmte dispatch\b/.test(e.input ?? '')
const isQaDispatch = (e) => isDispatch(e) && /--role[ =]qa\b/.test(e.input)
const firstAfter = (events, from, pred) => events.findIndex((e, i) => i > from && pred(e))

/**
 * Every rule of the playbook the run broke, as readable lines ([] = the run followed the flow).
 * `events`: transcript rows `{ kind: 'assistant_text'|'tool'|'ask'|'user', turn, text?, name?, input? }`.
 * `ghLog`: what the fake `gh` recorded (one invocation per line).
 */
export function checkFlow(events, { ghLog = '' } = {}) {
  const failures = []
  const at = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => phaseIndex(events, n))
  at.forEach((i, n) => {
    if (i === -1) {
      failures.push(`phase ${n + 1}: no "## Fase ${n + 1}" header`)
    } else if (n > 0 && at[n - 1] !== -1 && i < at[n - 1]) {
      failures.push(`phase ${n + 1}: opened before phase ${n}`)
    }
  })
  const [, i2, i3, i4] = at
  if (i2 !== -1 && i3 !== -1) {
    const between = events.slice(i2, i3)
    if (!between.some((e) => e.kind === 'user')) {
      failures.push('phase 2: grill-me started before the user answered the brainstorming')
    }
    if (events[i2].turn === events[i3].turn) {
      failures.push('phase 2: brainstorming and grill-me opened in the same turn')
    }
  }
  // interactive questions belong to grill-me only; everything else is conversation
  events.forEach((e, i) => {
    if (e.kind === 'ask' && !(i3 !== -1 && i > i3 && (i4 === -1 || i < i4))) {
      const phase = at.findLastIndex((p) => p !== -1 && p < i) + 1
      failures.push(`phase ${phase || '?'}: AskUserQuestion outside grill-me ("${e.questions?.[0] ?? ''}")`)
    }
  })
  // after the spec phase opens: the planner may dispatch a moment before writing the phase 5 header
  const coder = firstAfter(events, i4, (e) => isDispatch(e) && !isQaDispatch(e))
  if (i4 !== -1) {
    if (coder === -1) {
      failures.push('phase 5: no coder `mte dispatch` after the spec')
    } else if (!events.slice(i4, coder).some((e) => e.kind === 'user')) {
      failures.push('phase 4: coder dispatched without the user confirming the requirements lock')
    }
  }
  const qa = coder === -1 ? -1 : firstAfter(events, coder, isQaDispatch)
  if (coder !== -1 && qa === -1) {
    failures.push('phase 6: no `mte dispatch --role qa` after the coder')
  }
  if (qa !== -1 && firstAfter(events, qa, (e) => e.kind === 'tool' && /record_task$/.test(e.name)) === -1) {
    failures.push('memory: no record_task after QA')
  }
  if (events.some((e) => e.kind === 'tool' && e.name === 'Bash' && /orchestration worker-start/.test(e.input ?? ''))) {
    failures.push('dispatch: a raw `orca orchestration worker-start` instead of `mte dispatch`')
  }
  if (!/pr create\b.*--draft/.test(ghLog)) {
    failures.push('phase 8: no `gh pr create --draft`')
  }
  return failures
}
