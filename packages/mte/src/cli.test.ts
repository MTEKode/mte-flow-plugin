import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createInterface } from 'node:readline'
import { expect } from './test-support/expect.ts'
import { parseArgs } from './cli.ts'
import { readPackageVersion } from './version.ts'

const CLI = new URL('./cli.ts', import.meta.url).pathname
let fixture: string

before(() => {
  fixture = mkdtempSync(join(tmpdir(), 'mte-cli-'))
  mkdirSync(join(fixture, '.mte'))
})
after(() => rmSync(fixture, { recursive: true, force: true }))

function mte(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

/** Drives `mte memory` over stdio: initialize + tools/list, returns the tool names. */
async function listTools(role: string): Promise<string[]> {
  const child = spawn(process.execPath, [CLI, 'memory', '--role', role, '--workspace', fixture])
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const next = async (): Promise<Record<string, any>> => JSON.parse((await lines.next()).value)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  expect((await next()).result.serverInfo.version).toBe(readPackageVersion())
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const reply = await next()
  child.stdin.end()
  return reply.result.tools.map((tool: { name: string }) => tool.name)
}

describe('mte cli', () => {
  it('prints the package version', () => {
    const res = mte(['--version'])
    expect(res.stdout.trim()).toBe(readPackageVersion())
    expect(res.status).toBe(0)
  })

  it('fails on unknown commands and prints help', () => {
    expect(mte(['nope']).status).toBe(1)
    expect(mte(['help']).stdout).toContain('mte memory')
  })

  it('parses flags without letting booleans swallow positionals', () => {
    const { positionals, flags } = parseArgs(['deploy-check', '--json', 'config', '--summary', 'ok', '--x=1'])
    expect(positionals).toEqual(['deploy-check', 'config'])
    expect(flags.get('json')).toBe(true)
    expect(flags.get('summary')).toBe('ok')
    expect(flags.get('x')).toBe('1')
  })
})

describe('mte memory over stdio', () => {
  it('exposes only ask_orq to the coder role', async () => {
    expect(await listTools('coder')).toEqual(['ask_orq'])
  })

  it('exposes only ask_orq to the validator role', async () => {
    expect(await listTools('validator')).toEqual(['ask_orq'])
  })

  it('exposes the full toolkit to the orchestrator role', async () => {
    const names = await listTools('orchestrator')
    expect(names).toHaveLength(11)
    for (const name of ['record_task', 'search_tasks', 'get_task']) {
      expect(names).toContain(name)
    }
    expect(names).not.toContain('ask_orq')
    expect(names).toContain('record_decision')
    expect(names).toContain('answer_orq')
  })

  it('rejects an unknown role before any protocol byte', () => {
    const res = mte(['memory', '--role', 'boss'])
    expect(res.status).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('--role must be one of')
  })
})

describe('mte check', () => {
  it('exits 1 and reports the failing group on a fixture repo with one failing script', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mte-check-'))
    try {
      writeFileSync(
        join(repo, 'package.json'),
        JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "console.error(\'boom\');process.exit(2)"' } })
      )
      const res = spawnSync(process.execPath, [CLI, 'check', '--json', '--workspace', repo], { encoding: 'utf8' })
      expect(res.status).toBe(1)
      const report = JSON.parse(res.stdout)
      expect(report.failedGroups).toBe(1)
      const byGroup = Object.fromEntries(report.results.map((r: { group: string }) => [r.group, r]))
      expect(byGroup.lint).toMatchObject({ status: 'passed' })
      expect(byGroup.typecheck).toMatchObject({ status: 'skipped' })
      expect(byGroup.test).toMatchObject({ status: 'failed', exitCode: 2 })
      expect(byGroup.test.tail).toContain('boom')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('mte deploy-check config', () => {
  it('reports unconfigured when no config file exists', () => {
    expect(JSON.parse(mte(['deploy-check', 'config', '--json']).stdout)).toEqual({ configured: false })
  })

  it('never contains the password string, only hasPassword', () => {
    writeFileSync(
      join(fixture, '.mte', 'deploy-check.json'),
      JSON.stringify({ url: 'https://x.test', username: 'bot', password: 'file-secret-9' })
    )
    const env = { MTE_DEPLOY_CHECK_PASSWORD: 'hunter2-secret' }
    const json = mte(['deploy-check', 'config', '--json'], env)
    const text = mte(['deploy-check', 'config'], env)
    for (const out of [json.stdout, json.stderr, text.stdout, text.stderr]) {
      expect(out).not.toContain('hunter2-secret')
      expect(out).not.toContain('file-secret-9')
    }
    expect(JSON.parse(json.stdout)).toEqual({
      configured: true,
      url: 'https://x.test',
      username: 'bot',
      linearDoneState: 'Done',
      hasPassword: true
    })
    expect(JSON.parse(mte(['deploy-check', 'config', '--json'], { MTE_DEPLOY_CHECK_PASSWORD: '' }).stdout).hasPassword).toBe(false)
  })
})
