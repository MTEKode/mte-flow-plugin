// Cases ported from spookfish:src/shared/mte/deploy-check.test.ts @ 4c059137f8e, plus the Linear report flow.
import { describe, it } from 'node:test'
import { expect } from './test-support/expect.ts'
import {
  DeployCheckReportError,
  deployCheckLinearCommentBody,
  formatDeployCheckConfigText,
  reportDeployCheck
} from './deploy-check.ts'
import type { OrcaResult } from './deploy-check.ts'

describe('deployCheckLinearCommentBody', () => {
  it('formats the success comment', () => {
    expect(deployCheckLinearCommentBody('Login and checkout work', true)).toBe(
      'Deploy validated by MTE flow:\n\nLogin and checkout work'
    )
  })

  it('formats the failure comment', () => {
    expect(deployCheckLinearCommentBody('Login 500s', false)).toBe(
      'Deploy validation FAILED in MTE flow:\n\nLogin 500s'
    )
  })
})

describe('formatDeployCheckConfigText', () => {
  it('prints the config and reports unconfigured projects', () => {
    const text = formatDeployCheckConfigText({
      configured: true,
      url: 'https://x.test',
      username: 'bot',
      linearDoneState: 'Done',
      hasPassword: true
    })
    expect(text).toContain('https://x.test')
    expect(formatDeployCheckConfigText({ configured: false })).toContain('not configured')
  })
})

describe('reportDeployCheck', () => {
  const params = { workspaceRoot: '/ws', summary: 'all good', ok: true, doneState: 'Shipped' }

  function recorder(results: OrcaResult[]) {
    const calls: { args: string[]; input?: string }[] = []
    const run = (args: string[], _cwd: string, input?: string): OrcaResult => {
      calls.push({ args, input })
      return results[calls.length - 1] ?? { ok: true }
    }
    return { calls, run }
  }

  it('comments then moves the issue when validated', () => {
    const { calls, run } = recorder([{ ok: true }, { ok: true }])
    expect(reportDeployCheck(params, run)).toBe('commented+moved')
    expect(calls[0]?.args).toEqual(['linear', 'comment', 'add', '--current', '--body-file', '-'])
    expect(calls[0]?.input).toBe('Deploy validated by MTE flow:\n\nall good')
    expect(calls[1]?.args).toEqual(['linear', 'status', 'set', '--current', '--to', 'Shipped'])
  })

  it('only comments when the deploy check failed', () => {
    const { calls, run } = recorder([{ ok: true }])
    expect(reportDeployCheck({ ...params, ok: false }, run)).toBe('commented')
    expect(calls).toHaveLength(1)
  })

  it('throws a clear error when no Linear issue is linked', () => {
    const { run } = recorder([{ ok: false, code: 'linear_no_linked_issue', message: 'not linked' }])
    expect(() => reportDeployCheck(params, run)).toThrow(/No Linear issue is linked/)
    expect(() => reportDeployCheck(params, recorder([{ ok: false, code: 'linear_no_linked_issue', message: 'x' }]).run)).toThrow(DeployCheckReportError)
  })

  it('reports a status move failure after the comment landed', () => {
    const { run } = recorder([{ ok: true }, { ok: false, code: 'x', message: 'no such state' }])
    expect(() => reportDeployCheck(params, run)).toThrow(/Commented, but could not move .* Shipped: no such state/)
  })
})
