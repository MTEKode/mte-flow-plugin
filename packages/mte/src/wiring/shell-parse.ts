export type Token = { text: string; op: boolean }
export type GateKind = 'run-create' | 'worker-start'
export type Invocation = { kind: GateKind; bin: string; args: string[] }

const ORCA_BINS = new Set(['orca', 'orca-dev', 'orca-ide'])
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time'])

/** Quote-aware split; `&& || ; | &` and newlines become operator tokens. Not a full shell parser. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let cur = ''
  let has = false
  const flush = (): void => {
    if (has) {
      tokens.push({ text: cur, op: false })
    }
    cur = ''
    has = false
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? ''
    if (ch === "'" || ch === '"') {
      const end = input.indexOf(ch, i + 1)
      const stop = end === -1 ? input.length : end
      cur += input.slice(i + 1, stop)
      has = true
      i = stop
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1]
      has = true
      i++
    } else if (/\s/.test(ch) && ch !== '\n') {
      flush()
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      flush()
      const double = (ch === '|' || ch === '&') && input[i + 1] === ch
      tokens.push({ text: double ? ch + ch : ch, op: true })
      i += double ? 1 : 0
    } else {
      cur += ch
      has = true
    }
  }
  flush()
  return tokens
}

function baseName(text: string): string {
  return text.slice(text.lastIndexOf('/') + 1)
}

function segments(tokens: Token[]): string[][] {
  const out: string[][] = [[]]
  for (const token of tokens) {
    if (token.op) {
      out.push([])
    } else {
      out[out.length - 1]?.push(token.text)
    }
  }
  return out.filter((segment) => segment.length > 0)
}

function matchSegment(words: string[]): Invocation | null {
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '') || WRAPPERS.has(words[i] ?? ''))) {
    i++
  }
  const bin = words[i]
  const cliCommand = process.env.ORCA_CLI_COMMAND
  if (bin === undefined || !(ORCA_BINS.has(baseName(bin)) || (cliCommand && bin === cliCommand))) {
    return null
  }
  i++
  while ((words[i] ?? '').startsWith('-')) {
    i++
  }
  const sub = words[i + 1]
  if (words[i] !== 'orchestration' || (sub !== 'run-create' && sub !== 'worker-start')) {
    return null
  }
  return { kind: sub, bin, args: words.slice(i + 2) }
}

/** Finds `orca orchestration run-create|worker-start` calls, including inside `bash -c "..."` strings. */
export function findInvocations(command: string, depth = 0): Invocation[] {
  const found: Invocation[] = []
  for (const words of segments(tokenize(command))) {
    const hit = matchSegment(words)
    if (hit) {
      found.push(hit)
    } else if (depth < 2) {
      for (const word of words) {
        if (/\s/.test(word) && word.includes('orchestration')) {
          found.push(...findInvocations(word, depth + 1))
        }
      }
    }
  }
  return found
}

export function getFlag(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === `--${name}`) {
      return args[i + 1]
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3)
    }
  }
  return undefined
}

export function hasFlag(args: readonly string[], name: string): boolean {
  return args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
}

export function removeFlags(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    const name = names.find((n) => arg === `--${n}` || arg.startsWith(`--${n}=`))
    if (name === undefined) {
      out.push(arg)
    } else if (arg === `--${name}`) {
      i++
    }
  }
  return out
}

export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}
