import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkFlow } from './flow.mjs'

const say = (turn, text) => ({ kind: 'assistant_text', turn, text })
const bash = (turn, input) => ({ kind: 'tool', turn, name: 'Bash', input })
const user = (turn, text = 'ok') => ({ kind: 'user', turn, text })
const ask = (turn) => ({ kind: 'ask', turn, questions: [], answers: {} })
const GH = 'pr create --draft --title x'

function goodRun() {
  return [
    say(0, '## Fase 1 — Exploración (tamaño: small)'),
    bash(0, 'mte dispatch --task t1'),
    say(0, '## Fase 2 — Brainstorming\nTres enfoques...'),
    user(1, 'Me vale el recomendado'),
    say(1, '## Fase 3 — Grill me'),
    ask(1),
    say(1, '## Fase 4 — Write spec\nResumen'),
    user(2, 'Confirmado'),
    say(2, '## Fase 5 — Coder'),
    bash(2, 'mte dispatch --task t2'),
    say(2, '## Fase 6 — QA'),
    bash(2, 'mte dispatch --task t3 --role qa'),
    { kind: 'tool', turn: 2, name: 'mcp__mte-memory__record_task' },
    say(2, '## Fase 7 — Resumen'),
    say(2, '## Fase 8 — PR en draft')
  ]
}

describe('checkFlow', () => {
  it('accepts a run that follows every phase', () => {
    assert.deepEqual(checkFlow(goodRun(), { ghLog: GH }), [])
  })

  it('flags a brainstorming that asks questions instead of proposing', () => {
    const events = goodRun()
    events.splice(3, 1, ask(0))
    const failures = checkFlow(events, { ghLog: GH })
    assert.ok(failures.some((f) => f.includes('phase 2: AskUserQuestion outside grill-me')), failures.join('\n'))
    assert.ok(failures.some((f) => f.includes('before the user answered')), failures.join('\n'))
  })

  it('flags missing phases, a coder without requirements lock, missing QA and missing PR', () => {
    const events = goodRun().filter((e) => !(e.kind === 'user' && e.text === 'Confirmado') && !/--role qa|Fase 7/.test(e.input ?? e.text ?? ''))
    const failures = checkFlow(events)
    for (const want of ['no "## Fase 7"', 'requirements lock', 'no `mte dispatch --role qa`', 'gh pr create --draft']) {
      assert.ok(failures.some((f) => f.includes(want)), `${want}\n${failures.join('\n')}`)
    }
  })

  it('flags a requirements lock asked with AskUserQuestion instead of in text', () => {
    const events = goodRun()
    events.splice(7, 1, ask(2))
    const failures = checkFlow(events, { ghLog: GH })
    assert.ok(failures.some((f) => f.includes('phase 4: AskUserQuestion outside grill-me')), failures.join('\n'))
    assert.ok(failures.some((f) => f.includes('requirements lock')), failures.join('\n'))
  })

  it('flags a raw worker-start', () => {
    const events = [...goodRun(), bash(3, 'orca orchestration worker-start --task t4')]
    assert.ok(checkFlow(events, { ghLog: GH }).some((f) => f.includes('raw `orca orchestration worker-start`')))
  })
})
