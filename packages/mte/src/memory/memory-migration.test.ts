import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { expect } from '../test-support/expect.ts'
import { legacyMemoryDbPath, memoryDbPath, openMemoryStore } from './memory-database.ts'
import { openWorkspaceMemoryStore } from './memory-migration.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mte-repo-memory-')))
after(() => rmSync(root, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  }
}

function makeRepo(name: string): { main: string; linked: string } {
  const main = join(root, name)
  mkdirSync(main)
  git(main, 'init', '-q')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const linked = join(root, `${name}-wt`)
  git(main, 'worktree', 'add', '-q', linked, '-b', `${name}-wt`)
  return { main, linked: realpathSync(linked) }
}

describe('repo-wide memory db', () => {
  it('resolves one DB for every worktree and shares rows between them', () => {
    const { main, linked } = makeRepo('shared')
    expect(memoryDbPath(linked)).toBe(memoryDbPath(main))
    expect(memoryDbPath(main)).toBe(join(realpathSync(main), '.git', 'mte', 'memory.db'))
    const a = openWorkspaceMemoryStore(main)
    a.record_decision('memory', 'one db per repo', 'shared across worktrees', [])
    a.record_task({ task_id: 'T1', title: 'from A' })
    a.close()
    const b = openWorkspaceMemoryStore(linked)
    expect(b.get_active_decisions().map((row) => row.decision)).toEqual(['one db per repo'])
    expect(b.get_task('T1').title).toBe('from A')
    b.close()
  })

  it('falls back to <cwd>/.mte/memory.db outside git', () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(memoryDbPath(plain)).toBe(join(plain, '.mte', 'memory.db'))
  })

  it('imports a legacy per-worktree DB exactly once and leaves the old file untouched', () => {
    const { main, linked } = makeRepo('legacy')
    const oldPath = legacyMemoryDbPath(linked)
    const old = openMemoryStore(oldPath)
    old.record_decision('feature', 'old decision', 'because', ['src'])
    old.record_qa('s1', 'topic', 'old question', 'old answer')
    old.save_note('lesson', 'topic', 'old note')
    old.close()
    const before = readFileSync(oldPath)

    const first = openWorkspaceMemoryStore(linked)
    expect(first.get_active_decisions()).toHaveLength(1)
    expect(first.search_qa('old')).toHaveLength(1)
    expect(first.search_notes('old')).toHaveLength(1)
    first.close()

    const second = openWorkspaceMemoryStore(linked)
    expect(second.get_active_decisions()).toHaveLength(1)
    expect(second.search_qa('old')).toHaveLength(1)
    second.close()
    // Another worktree of the same repo opens the same DB and does not re-import.
    const other = openWorkspaceMemoryStore(main)
    expect(other.get_active_decisions()).toHaveLength(1)
    other.close()

    expect(readFileSync(oldPath).equals(before)).toBe(true)
  })
})
