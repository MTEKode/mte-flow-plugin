// Deploy-check config + Linear reporting. Adapted from spookfish:src/shared/mte/deploy-check.ts @ 4c059137f8e
// (the fork read Orca repo settings and a secret store; here: <workspace>/.mte/deploy-check.json + env password).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEPLOY_CHECK_DEFAULT_DONE_STATE = 'Done'
export const DEPLOY_CHECK_PASSWORD_ENV = 'MTE_DEPLOY_CHECK_PASSWORD'

export type DeployCheckConfig =
  | { configured: false }
  | {
      configured: true
      url: string
      username: string
      linearDoneState: string
      hasPassword: boolean
    }

export type DeployCheckLinearOutcome = 'commented+moved' | 'commented'

export function deployCheckConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.mte', 'deploy-check.json')
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Reads the config file and password presence. The password value itself never leaves this module. */
export function readDeployCheckConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): DeployCheckConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(deployCheckConfigPath(workspaceRoot), 'utf8'))
  } catch {
    return { configured: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { configured: false }
  }
  const record: Record<string, unknown> = { ...parsed }
  const url = trimmedString(record.url)
  const username = trimmedString(record.username)
  if (url === '' || username === '') {
    return { configured: false }
  }
  return {
    configured: true,
    url,
    username,
    linearDoneState: trimmedString(record.linearDoneState) || DEPLOY_CHECK_DEFAULT_DONE_STATE,
    hasPassword: (env[DEPLOY_CHECK_PASSWORD_ENV] ?? '') !== ''
  }
}

/** Comment posted on the linked Linear issue when the deploy check finishes. */
export function deployCheckLinearCommentBody(summary: string, ok: boolean): string {
  const heading = ok ? 'Deploy validated by MTE flow:' : 'Deploy validation FAILED in MTE flow:'
  return `${heading}\n\n${summary}`
}

/** Config output for text mode; there is no password field to leak. */
export function formatDeployCheckConfigText(config: DeployCheckConfig): string {
  if (!config.configured) {
    return 'Deploy check is not configured. Create .mte/deploy-check.json with {"url","username","linearDoneState"}.'
  }
  return [
    `url: ${config.url}`,
    `username: ${config.username}`,
    `linearDoneState: ${config.linearDoneState}`,
    `hasPassword: ${config.hasPassword}`
  ].join('\n')
}

export type OrcaResult = { ok: true } | { ok: false; code: string; message: string }

/** Runs the stock `orca` CLI (override with ORCA_CLI_COMMAND) and normalizes its --json error envelope. */
export type OrcaRunner = (args: string[], cwd: string, input?: string) => OrcaResult

export const runOrcaCli: OrcaRunner = (args, cwd, input) => {
  const command = process.env.ORCA_CLI_COMMAND?.trim() || 'orca'
  const res = spawnSync(command, [...args, '--json'], { cwd, input, encoding: 'utf8' })
  if (res.error) {
    return { ok: false, code: 'orca_unavailable', message: `cannot run ${command}: ${res.error.message}` }
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(res.stdout)
  } catch {
    envelope = undefined
  }
  const record: Record<string, unknown> =
    typeof envelope === 'object' && envelope !== null ? { ...envelope } : {}
  if (res.status === 0 && record.ok !== false) {
    return { ok: true }
  }
  const error: Record<string, unknown> =
    typeof record.error === 'object' && record.error !== null ? { ...record.error } : {}
  return {
    ok: false,
    code: trimmedString(error.code) || 'orca_failed',
    message:
      trimmedString(error.message) || res.stderr.trim() || `${command} exited with ${res.status}`
  }
}

export class DeployCheckReportError extends Error {}

/** Posts the result on the worktree's linked Linear issue and moves it when it passed; throws when it cannot. */
export function reportDeployCheck(
  params: { workspaceRoot: string; summary: string; ok: boolean; doneState: string },
  runOrca: OrcaRunner = runOrcaCli
): DeployCheckLinearOutcome {
  const comment = runOrca(
    ['linear', 'comment', 'add', '--current', '--body-file', '-'],
    params.workspaceRoot,
    deployCheckLinearCommentBody(params.summary, params.ok)
  )
  if (!comment.ok) {
    if (comment.code === 'linear_no_linked_issue') {
      throw new DeployCheckReportError(
        'No Linear issue is linked to this workspace. Link one in Orca, then rerun `mte deploy-check validated`.'
      )
    }
    throw new DeployCheckReportError(`Could not comment on the Linear issue: ${comment.message}`)
  }
  if (!params.ok) {
    return 'commented'
  }
  const moved = runOrca(
    ['linear', 'status', 'set', '--current', '--to', params.doneState],
    params.workspaceRoot
  )
  if (!moved.ok) {
    throw new DeployCheckReportError(
      `Commented, but could not move the Linear issue to ${params.doneState}: ${moved.message}`
    )
  }
  return 'commented+moved'
}
