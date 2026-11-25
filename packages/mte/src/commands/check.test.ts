import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { expect } from '../test-support/expect.ts'
import { detectChecks } from '../checks/detect-checks.ts'
import { createCheckCommand } from './check.ts'

describe('mte check --json', () => {
  let repo: string

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'mte-check-cmd-'))
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"' } }))
  })
  after(() => rmSync(repo, { recursive: true, force: true }))

  it('runs detection once and reports the real group results (AC10)', async () => {
    let calls = 0
    const command = createCheckCommand({
      detect: (ws: string) => {
        calls += 1
        return detectChecks(ws)
      }
    })
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '))
    }
    let code = -1
    try {
      code = await command({ flags: new Map([['json', true], ['workspace', repo]]), positionals: [], cwd: repo })
    } finally {
      console.log = original
    }
    expect(code).toBe(0)
    expect(calls).toBe(1)
    const report = JSON.parse(logs[0])
    const byGroup = Object.fromEntries(report.results.map((r: { group: string }) => [r.group, r]))
    expect(report.detected).toEqual(detectChecks(repo))
    expect(byGroup.lint).toMatchObject({ status: 'passed' })
    expect(byGroup.typecheck).toMatchObject({ status: 'skipped' })
    expect(byGroup.test).toMatchObject({ status: 'skipped' })
    expect(report.failedGroups).toBe(0)
  })
})
