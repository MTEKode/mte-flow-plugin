import { errorMessage } from '../error-message.ts'
import { runMemoryMcpServer } from '../memory/memory-mcp-server.ts'
import { readPackageVersion } from '../version.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

/**
 * `mte memory [--role orchestrator] [--workspace p]`: stdio MCP server, orchestrator-only.
 * `--role coder|validator` names the removal; existing installs pass `--role orchestrator` and keep working.
 * Usage errors exit before any protocol byte.
 */
export const memoryCommand: Command = async ({ flags, cwd }) => {
  const roleFlag = flags.get('role') ?? 'orchestrator'
  if (roleFlag !== 'orchestrator') {
    return usageError(
      `--role ${roleFlag} was removed: the memory server is orchestrator-only (workers ask via orca orchestration ask)`
    )
  }
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  try {
    await runMemoryMcpServer(process.stdin, process.stdout, {
      workspaceRoot: root,
      version: readPackageVersion()
    })
    return 0
  } catch (error) {
    // Startup failures wrote no protocol bytes; keep the failure on stderr.
    return usageError(errorMessage(error))
  }
}
