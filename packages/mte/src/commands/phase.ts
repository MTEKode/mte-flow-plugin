import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { identityFromEnv, logGuard, readPhase, readPlanner, sameCaller, writePhase } from '../wiring/state.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

const HEADER = /^#{1,4}\s*Fase\s+([1-8])\b[ \t]*[—–-]?[ \t]*([^\n(]*)/gm
/** The last transcript bytes read: a phase header is in the planner's latest messages, never megabytes back. */
const TAIL_BYTES = 512 * 1024

function tail(path: string): string {
  const size = statSync(path).size
  const length = Math.min(size, TAIL_BYTES)
  const buf = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8')
}

/** The last `## Fase N — name` in one assistant text, or null. */
export function phaseIn(text: string): { phase: number; name: string } | null {
  const last = [...text.matchAll(HEADER)].at(-1)
  return last ? { phase: Number(last[1]), name: (last[2] ?? '').trim() } : null
}

/** The last `## Fase N — name` the assistant wrote in a Claude Code transcript (JSONL), or null. */
export function lastPhase(transcript: string): { phase: number; name: string } | null {
  const lines = transcript.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { content?: unknown } }
    try {
      entry = JSON.parse(lines[i] ?? '')
    } catch {
      continue // the first line of a tail is usually cut
    }
    const content = entry.type === 'assistant' ? entry.message?.content : undefined
    const texts = Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => String(b.text)) : []
    const found = phaseIn(texts.join('\n'))
    if (found) {
      return found
    }
  }
  return null
}

/**
 * `mte phase --claude-hook` (Claude Stop hook): records the claimed planner's latest `## Fase N` header so the panel
 * can show where each run is. Silent, always exit 0, fails open: it must never keep an agent from stopping.
 * `mte phase show [--json] [--workspace p]`: prints `{"phase":N,"name":...,"at":...}` or `{"phase":null}`.
 */
export const phaseCommand: Command = ({ flags, cwd }) => {
  if (flags.get('claude-hook') !== true) {
    return usageError('usage: mte phase --claude-hook (Stop hook, reads its JSON on stdin) | mte phase show [--json]')
  }
  let root = cwd
  try {
    const payload: { transcript_path?: unknown; cwd?: unknown; last_assistant_message?: unknown } = JSON.parse(readFileSync(0, 'utf8'))
    const resolved = resolveWorkspaceRoot(flags, typeof payload.cwd === 'string' ? payload.cwd : cwd)
    if (typeof resolved !== 'string' || typeof payload.transcript_path !== 'string') {
      return 0
    }
    root = resolved
    const claim = readPlanner(root)
    if (claim === null || !sameCaller(claim, identityFromEnv(process.env))) {
      return 0 // only the planner's own phases count, never a worker's or a bystander's
    }
    // the transcript may not hold the turn's final message yet when Stop fires: the payload's copy wins, the transcript covers earlier messages
    const last = typeof payload.last_assistant_message === 'string' ? phaseIn(payload.last_assistant_message) : null
    const found = last ?? lastPhase(tail(payload.transcript_path))
    const current = readPhase(root)
    if (found && (current?.phase !== found.phase || current.name !== found.name)) {
      writePhase(root, found.phase, found.name)
    }
  } catch (error) {
    logGuard(root, `phase hook failed open: ${error instanceof Error ? error.message : String(error)}`)
  }
  return 0
}

export const phaseShowCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  try {
    console.log(JSON.stringify(readPhase(root) ?? { phase: null }))
    return 0
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error))
  }
}
