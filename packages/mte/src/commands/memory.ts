import { errorMessage } from '../error-message.ts'
import { runMemoryMcpServer } from '../memory/memory-mcp-server.ts'
import type { MemoryRole } from '../memory/memory-tools.ts'
import { readPackageVersion } from '../version.ts'
import { resolveWorkspaceRoot, usageError } from './flags.ts'
import type { Command } from './flags.ts'

const ROLES: readonly MemoryRole[] = ['orchestrator', 'coder', 'validator']

/** `mte memory [--role r] [--workspace p]`: stdio MCP server. Usage errors exit before any protocol byte. */
export const memoryCommand: Command = async ({ flags, cwd }) => {
  const roleFlag = flags.get('role') ?? 'orchestrator'
  const role = ROLES.find((candidate) => candidate === roleFlag)
  if (role === undefined) {
    return usageError('--role must be one of: orchestrator, coder, validator')
  }
  const root = resolveWorkspaceRoot(flags, cwd)
  if (typeof root !== 'string') {
    return usageError(root.error)
  }
  try {
    await runMemoryMcpServer(process.stdin, process.stdout, {
      role,
      workspaceRoot: root,
      version: readPackageVersion()
    })
    return 0
  } catch (error) {
    // Startup failures wrote no protocol bytes; keep the failure on stderr.
    return usageError(errorMessage(error))
  }
}
