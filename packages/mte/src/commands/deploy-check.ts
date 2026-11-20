// Adapted from spookfish:src/cli/handlers/mte-deploy-check.ts @ 4c059137f8e
import { errorMessage } from '../error-message.ts'
import {
  DeployCheckReportError,
  formatDeployCheckConfigText,
  readDeployCheckConfig,
  reportDeployCheck,
  runOrcaCli
} from '../deploy-check.ts'
import type { OrcaRunner } from '../deploy-check.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/** `mte deploy-check config [--json]`: never prints the password, only whether the env var is set. */
export const deployCheckConfigCommand: Command = ({ flags, cwd }) => {
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  const config = readDeployCheckConfig(root)
  console.log(
    flags.get('json') === true ? JSON.stringify(config, null, 2) : formatDeployCheckConfigText(config)
  )
  return 0
}

/** `mte deploy-check validated --summary <text> [--failed]`: reports on the linked Linear issue via `orca linear`. */
export function createDeployCheckValidatedCommand(runOrca: OrcaRunner = runOrcaCli): Command {
  return ({ flags, cwd }) => {
    const summary = flags.get('summary')
    if (typeof summary !== 'string' || summary.trim() === '') {
      return usageError('--summary <text> is required (how the deploy was validated)')
    }
    const root = resolveWorkspaceRoot(flags, cwd)
    if (typeof root !== 'string') {
      return usageError(root.error)
    }
    const config = readDeployCheckConfig(root)
    try {
      const linear = reportDeployCheck(
        {
          workspaceRoot: root,
          summary,
          ok: flags.get('failed') !== true,
          doneState: config.configured ? config.linearDoneState : 'Done'
        },
        runOrca
      )
      console.log(flags.get('json') === true ? JSON.stringify({ linear }, null, 2) : `linear: ${linear}`)
      return 0
    } catch (error) {
      return usageError(error instanceof DeployCheckReportError ? error.message : errorMessage(error))
    }
  }
}

export const deployCheckValidatedCommand: Command = createDeployCheckValidatedCommand()
