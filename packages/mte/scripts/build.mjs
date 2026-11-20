// Emits plain ESM JS into dist/ (same layout as src/) so the CLI runs from node_modules,
// where Node refuses to strip types. Uses Node's own stripper: no compiler dependency.
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const root = new URL('..', import.meta.url).pathname
const src = join(root, 'src')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
for (const entry of readdirSync(src, { recursive: true })) {
  if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.startsWith('test-support')) continue
  const code = stripTypeScriptTypes(readFileSync(join(src, entry), 'utf8'), { mode: 'strip' })
  const out = join(dist, entry.replace(/\.ts$/, '.js'))
  mkdirSync(dirname(out), { recursive: true })
  // ponytail: regex rewrite of relative `.ts` specifiers; fine while imports stay static `from '...'`
  writeFileSync(out, code.replace(/(from\s+['"]\.{1,2}\/[^'"]*)\.ts(['"])/g, '$1.js$2'))
}
chmodSync(join(dist, 'cli.js'), 0o755)
