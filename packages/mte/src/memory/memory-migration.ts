import { existsSync, realpathSync } from 'node:fs'
import { legacyMemoryDbPath, memoryDbPath, openMemoryDatabase } from './memory-database.ts'
import { createMemoryStore } from './memory-store.ts'
import type { MemoryStore } from './memory-store.ts'
import { openSqliteConnection } from './sqlite-connection.ts'
import type { SqliteConnection } from './sqlite-connection.ts'

// Columns copied per table; ids are regenerated so rows from several worktrees never collide.
const IMPORTED_TABLES: Record<string, string[]> = {
  decisions: ['feature', 'decision', 'rationale', 'affected_files', 'status', 'created_at'],
  qa_log: ['step_id', 'topic', 'question', 'answer', 'timestamp'],
  questions: ['step_id', 'topic', 'question', 'asked_by', 'asked_at', 'status', 'answered_at'],
  notes: ['kind', 'topic', 'content', 'created_at']
}

function hasTable(db: SqliteConnection, name: string): boolean {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/**
 * Imports a pre-shared `<worktree>/.mte/memory.db` into the repo DB exactly once (marker `imported:<abs path>` in
 * `meta`). The old file is only read, never modified or deleted. Returns the number of imported rows.
 */
export function importLegacyMemory(db: SqliteConnection, legacyPath: string, targetPath: string): number {
  if (!existsSync(legacyPath)) {
    return 0
  }
  const abs = realpathSync(legacyPath)
  if (abs === (existsSync(targetPath) ? realpathSync(targetPath) : targetPath)) {
    return 0
  }
  const marker = `imported:${abs}`
  const imported = (): boolean => db.prepare('SELECT 1 AS found FROM meta WHERE key = ?').get(marker) !== undefined
  if (imported()) {
    return 0
  }
  const legacy = openSqliteConnection(abs)
  let count = 0
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (imported()) {
        db.exec('ROLLBACK')
        return 0
      }
      for (const [table, columns] of Object.entries(IMPORTED_TABLES)) {
        if (!hasTable(legacy, table)) {
          continue
        }
        const present = new Set(legacy.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
        const usable = columns.filter((column) => present.has(column))
        const insert = db.prepare(
          `INSERT INTO ${table} (${usable.join(', ')}) VALUES (${usable.map(() => '?').join(', ')})`
        )
        for (const row of legacy.prepare(`SELECT ${usable.join(', ')} FROM ${table} ORDER BY id`).all()) {
          insert.run(...usable.map((column) => row[column]))
          count += 1
        }
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(marker, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
      throw error
    }
  } finally {
    legacy.close()
  }
  return count
}

/** Opens the repo-wide memory store for a workspace, importing its legacy per-worktree DB once. */
export function openWorkspaceMemoryStore(workspaceRoot: string): MemoryStore {
  const target = memoryDbPath(workspaceRoot)
  const db = openMemoryDatabase(target)
  try {
    importLegacyMemory(db, legacyMemoryDbPath(workspaceRoot), target)
  } catch (error) {
    db.close()
    throw error
  }
  return createMemoryStore(db)
}
