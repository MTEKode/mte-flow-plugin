// Runs inside an Orca terminal opened on the fixture repo (so the planner gets ORCA_TERMINAL_HANDLE and its
// workers land in the fixture): a real planner session (Claude Agent SDK, project skill + hook + memory MCP)
// talks to a simulated user until the draft PR exists, then writes transcript.jsonl and result.json to MTE_E2E_OUT.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { SCENARIO, checkFlow } from './flow.mjs'

const OUT = process.env.MTE_E2E_OUT
const FIXTURE = process.cwd()
const PLANNER_MODEL = process.env.MTE_E2E_PLANNER_MODEL || 'sonnet'
const USER_MODEL = process.env.MTE_E2E_USER_MODEL || 'haiku'
const MAX_TURNS = Number(process.env.MTE_E2E_MAX_TURNS || 60)
// ponytail: the user's ~/.claude config is left out for a reproducible run; MTE_E2E_USER_SETTINGS=1 adds it to reproduce what a real session sees
const SOURCES = process.env.MTE_E2E_USER_SETTINGS === '1' ? ['user', 'project', 'local'] : ['project', 'local']

const events = []
let turn = 0
let cost = 0
function record(event) {
  events.push({ turn, ...event })
  appendFileSync(join(OUT, 'transcript.jsonl'), `${JSON.stringify({ turn, ...event })}\n`)
}

const ghLog = () => (existsSync(join(OUT, 'gh.log')) ? readFileSync(join(OUT, 'gh.log'), 'utf8') : '')

const PERSONA = `Eres la persona que pidió esto a un arquitecto de software (el "planner"): ${SCENARIO.goal}
Tus preferencias, que solo cuentas si te preguntan o si chocan con lo que te proponen: ${SCENARIO.preferences.join(' ')}
Respondes como un humano ocupado: en español, 1-3 frases, nunca código.
- Si te presenta enfoques o una propuesta, elige el recomendado salvo que choque con tus preferencias y comenta algo concreto.
- Si te pide confirmar unos requisitos, confírmalos si encajan con tus preferencias; si no, corrige lo que falle.
- Si solo informa de progreso o dice que espera a los workers, responde exactamente: Sigue.
- Es un entorno de prueba: una URL de PR de ejemplo (example.invalid) es lo esperado; no pidas otra.`

/** One reply from the simulated user (a fresh, tool-less, single-turn session per reply). */
async function userSays(prompt) {
  let text = ''
  for await (const m of query({
    prompt,
    options: { model: USER_MODEL, systemPrompt: PERSONA, settingSources: [], tools: [], maxTurns: 1, cwd: OUT }
  })) {
    if (m.type === 'result') {
      cost += m.total_cost_usd ?? 0
      text = m.subtype === 'success' ? m.result : ''
    }
  }
  return text.trim()
}

const recent = () =>
  events
    .filter((e) => e.kind === 'assistant_text' || e.kind === 'user')
    .slice(-6)
    .map((e) => `${e.kind === 'user' ? 'TÚ' : 'PLANNER'}: ${e.text}`)
    .join('\n\n')

/** AskUserQuestion answered by the simulated user; an unparseable or off-menu reply falls back to the first option. */
async function answer(questions) {
  const menu = questions.map((q, i) => `${i + 1}. ${q.question}\n${q.options.map((o) => `   - ${o.label}: ${o.description}`).join('\n')}`).join('\n')
  const raw = await userSays(
    `Conversación reciente:\n${recent()}\n\nEl planner te pregunta:\n${menu}\n\nResponde SOLO con JSON {"<número de pregunta>": "<label exacto>"}.`
  )
  let picked = {}
  try {
    picked = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  } catch {
    // fallback below
  }
  return Object.fromEntries(
    questions.map((q, i) => {
      const label = picked[String(i + 1)]
      return [q.question, q.options.some((o) => o.label === label) ? label : q.options[0].label]
    })
  )
}

/** Push-driven prompt stream: the planner reads user turns as we produce them. */
function inbox() {
  const pending = []
  let wake = null
  let closed = false
  return {
    push(text) {
      pending.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
      wake?.()
    },
    close() {
      closed = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length) {
          yield pending.shift()
        }
        if (closed) {
          return
        }
        await new Promise((resolve) => (wake = resolve))
      }
    }
  }
}

const mcp = JSON.parse(readFileSync(join(FIXTURE, '.mcp.json'), 'utf8')).mcpServers
const prompt = inbox()
const first = `/mte-flow ${SCENARIO.goal}`
record({ kind: 'user', text: first })
prompt.push(first)

let error = null
try {
  for await (const m of query({
    prompt,
    options: {
      model: PLANNER_MODEL,
      cwd: FIXTURE,
      settingSources: SOURCES,
      mcpServers: mcp,
      permissionMode: 'default',
      canUseTool: async (name, input) => {
        if (name !== 'AskUserQuestion') {
          return { behavior: 'allow', updatedInput: input }
        }
        const answers = await answer(input.questions)
        record({ kind: 'ask', questions: input.questions.map((q) => q.question), answers })
        return { behavior: 'allow', updatedInput: { questions: input.questions, answers } }
      }
    }
  })) {
    if (m.type === 'assistant' && m.parent_tool_use_id === null) {
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          record({ kind: 'assistant_text', text: block.text })
        } else if (block.type === 'tool_use' && block.name !== 'AskUserQuestion') {
          record({ kind: 'tool', name: block.name, input: block.name === 'Bash' ? block.input.command : undefined })
        }
      }
    }
    if (m.type !== 'result') {
      continue
    }
    cost += m.total_cost_usd ?? 0
    const done = /pr create/.test(ghLog()) // a missing phase 8 header is checkFlow's to report, not a reason to keep talking
    if (done || ++turn >= MAX_TURNS) {
      break
    }
    const reply = (await userSays(`Conversación reciente:\n${recent()}\n\nResponde al último mensaje del planner.`)) || 'Sigue.'
    if (/^sigue\.?$/i.test(reply)) {
      await new Promise((resolve) => setTimeout(resolve, 60_000)) // a human checks back later; workers need minutes, not turns
    }
    record({ kind: 'user', text: reply })
    prompt.push(reply)
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e)
} finally {
  prompt.close()
}

const failures = checkFlow(events, { ghLog: ghLog() })
if (error) {
  failures.unshift(`driver: ${error}`)
}
if (turn >= MAX_TURNS) {
  failures.unshift(`driver: stopped after ${MAX_TURNS} user turns without a draft PR`)
}
writeFileSync(join(OUT, 'result.json'), `${JSON.stringify({ failures, turns: turn, costUsd: Number(cost.toFixed(4)) }, null, 2)}\n`)
process.exit(0)
