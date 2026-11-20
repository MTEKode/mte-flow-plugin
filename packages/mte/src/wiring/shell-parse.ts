export type Token = { text: string; op: boolean; redir?: boolean }
export type GateKind = 'run-create' | 'worker-start'
export type Invocation = { kind: GateKind; bin: string; args: string[] }

const ORCA_BINS = new Set(['orca', 'orca-dev', 'orca-ide'])
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'builtin', '{', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until'])
/** `env -u NAME` / `env -C DIR` take a value. */
const ENV_VALUE_FLAGS = new Set(['-u', '-C'])
const CLI_VAR = /^\$\{?ORCA_CLI_COMMAND\b/

/** Heredoc operator at `i` (`<<` / `<<-`, not `<<<`): the delimiter word, or null. */
function heredocDelimiter(input: string, i: number): string | null {
  if (input[i] !== '<' || input[i + 1] !== '<' || input[i + 2] === '<') {
    return null
  }
  const m = /^-?[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;|&<>()'"]+))/.exec(input.slice(i + 2))
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
}

/** Index just past the heredoc body that starts at `from` (the terminating `delim` line included); input end when unterminated. */
function heredocBodyEnd(input: string, from: number, delim: string): number {
  let pos = from
  while (pos < input.length) {
    const nl = input.indexOf('\n', pos)
    const lineEnd = nl === -1 ? input.length : nl
    if (input.slice(pos, lineEnd).trim() === delim) {
      return lineEnd
    }
    pos = lineEnd + 1
  }
  return input.length
}

/** Index of the `)` closing a `$(` whose content starts at `from`; input end when unbalanced. Skips quotes and heredoc bodies. */
function matchParen(input: string, from: number): number {
  let depth = 1
  const pending: string[] = []
  for (let i = from; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\') {
      i++
    } else if (ch === "'") {
      const end = input.indexOf("'", i + 1)
      i = end === -1 ? input.length : end
    } else if (ch === '"') {
      i = scanDouble(input, i).end
    } else if (ch === '<') {
      const delim = heredocDelimiter(input, i)
      if (delim !== null) {
        pending.push(delim)
        i++
      }
    } else if (ch === '\n') {
      for (const delim of pending.splice(0)) {
        i = heredocBodyEnd(input, i + 1, delim)
      }
    } else if (ch === '(') {
      depth++
    } else if (ch === ')' && --depth === 0) {
      return i
    }
  }
  return input.length
}

/** Double-quoted span opening at `i`: its text, the real `$(...)` substitutions inside it (backticks are not followed), and the closing-quote index. */
function scanDouble(input: string, i: number): { text: string; subs: string[]; end: number } {
  let text = ''
  const subs: string[] = []
  let j = i + 1
  for (; j < input.length && input[j] !== '"'; j++) {
    if (input[j] === '\\' && j + 1 < input.length) {
      j++
      text += '$`"\\\n'.includes(input[j] ?? '') ? input[j] : `\\${input[j]}`
    } else if (input[j] === '$' && input[j + 1] === '(') {
      const close = matchParen(input, j + 2)
      subs.push(input.slice(j + 2, close))
      text += input.slice(j, close + 1)
      j = close
    } else {
      text += input[j]
    }
  }
  return { text, subs, end: j }
}

/**
 * Quote-aware split. `&& || ; | & ( ) ` and newlines become operator tokens; unquoted `<` `>` (with an optional
 * leading fd digit run and trailing `&`) become redirection tokens, which `segments` drops together with their target
 * word. Heredoc bodies are skipped (they are data, not commands). Single quotes are literal; double quotes are literal
 * too except for `$(...)`, whose content is pushed to `subs` for the caller to parse. Not a full shell parser.
 */
export function tokenize(input: string, subs: string[] = []): Token[] {
  const tokens: Token[] = []
  const pending: string[] = []
  let cur = ''
  let has = false
  let quoted = false
  const flush = (): void => {
    if (has) {
      tokens.push({ text: cur, op: false })
    }
    cur = ''
    has = false
    quoted = false
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? ''
    if (ch === "'") {
      const end = input.indexOf(ch, i + 1)
      const stop = end === -1 ? input.length : end
      cur += input.slice(i + 1, stop)
      has = true
      quoted = true
      i = stop
    } else if (ch === '"') {
      const span = scanDouble(input, i)
      cur += span.text
      subs.push(...span.subs)
      has = true
      quoted = true
      i = span.end
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1]
      has = true
      quoted = true
      i++
    } else if (/\s/.test(ch) && ch !== '\n') {
      flush()
    } else if (ch === '<' || ch === '>') {
      if (has && !quoted && /^[0-9]+$/.test(cur)) {
        cur = '' // `2>` : the digits are the fd, not an argument
        has = false
      }
      flush()
      const delim = heredocDelimiter(input, i)
      if (delim !== null) {
        pending.push(delim)
      }
      while (input[i + 1] === ch) {
        i++
      }
      if (input[i + 1] === '&') {
        i++
      }
      tokens.push({ text: ch, op: false, redir: true })
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      flush()
      const double = (ch === '|' || ch === '&') && input[i + 1] === ch
      tokens.push({ text: double ? ch + ch : ch, op: true })
      i += double ? 1 : 0
      if (ch === '\n') {
        for (const delim of pending.splice(0)) {
          i = heredocBodyEnd(input, i + 1, delim)
        }
      }
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

/** Words per simple command; operators split, redirections vanish together with the word that follows them. */
function segments(tokens: Token[]): string[][] {
  const out: string[][] = [[]]
  let skipTarget = false
  for (const token of tokens) {
    if (token.op) {
      out.push([])
      skipTarget = false
    } else if (token.redir) {
      skipTarget = true
    } else if (skipTarget) {
      skipTarget = false
    } else {
      out[out.length - 1]?.push(token.text)
    }
  }
  return out.filter((segment) => segment.length > 0)
}

/** `orca`, any path ending in `/orca`, `$ORCA_CLI_COMMAND` / `${ORCA_CLI_COMMAND...}`, or the literal value of that env var. */
function isOrcaBin(bin: string): boolean {
  const cliCommand = process.env.ORCA_CLI_COMMAND
  return ORCA_BINS.has(baseName(bin)) || CLI_VAR.test(bin) || (cliCommand !== undefined && cliCommand !== '' && bin === cliCommand)
}

/** Index of the command word: past wrappers (`env -i`, `command`, `if`...) and `VAR=x` assignments. */
function commandIndex(words: string[]): number {
  let i = 0
  let wrapper = ''
  while (i < words.length) {
    const word = words[i] ?? ''
    if (WRAPPERS.has(word)) {
      wrapper = word
      i++
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++
    } else if (wrapper !== '' && word.startsWith('-')) {
      i += wrapper === 'env' && ENV_VALUE_FLAGS.has(word) ? 2 : 1
    } else {
      break
    }
  }
  return i
}

function matchSegment(words: string[]): Invocation | null {
  let i = commandIndex(words)
  const bin = words[i]
  if (bin === undefined || !isOrcaBin(bin)) {
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

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

/** The script a segment executes as a string: `bash|sh|zsh|dash [-flags] -c <script>` or `eval <words>`; null otherwise. */
function scriptOf(words: string[]): string | null {
  const i = commandIndex(words)
  const cmd = baseName(words[i] ?? '')
  if (cmd === 'eval') {
    return words.slice(i + 1).join(' ')
  }
  if (!SHELLS.has(cmd)) {
    return null
  }
  for (let j = i + 1; j < words.length && (words[j] ?? '').startsWith('-'); j++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[j] ?? '')) {
      return words[j + 1] ?? null
    }
  }
  return null
}

/**
 * Finds `orca orchestration run-create|worker-start` calls: simple commands (also after `&&`, `|`, `$(`, backticks), real
 * `$(...)` inside double quotes, and the script of `bash -c` / `eval`. Other quoted text is data and is never re-parsed.
 */
export function findInvocations(command: string, depth = 0): Invocation[] {
  const found: Invocation[] = []
  const subs: string[] = []
  for (const words of segments(tokenize(command, subs))) {
    const hit = matchSegment(words)
    const script = hit ? null : scriptOf(words)
    if (hit) {
      found.push(hit)
    } else if (script !== null && depth < 3) {
      found.push(...findInvocations(script, depth + 1))
    }
  }
  if (depth < 3) {
    for (const sub of subs) {
      found.push(...findInvocations(sub, depth + 1))
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

/** Renders an executable: `$ORCA_CLI_COMMAND` stays expandable (double-quoted), everything else is single-quoted when needed. */
export function renderBin(bin: string): string {
  return CLI_VAR.test(bin) ? `"${bin}"` : shellQuote(bin)
}

export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}
