// The panel <-> worker contract, declared once: src/panel.tsx and worker/main.mjs both follow it.
export {}

type McpError = { stage: string; code: string; message: string }
type Result<T = object> = ({ ok: true } & T) | { ok: false; error: McpError }

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    'state.get': {
      input: Record<string, never>
      output: {
        settings: {
          plannerAgent: string
          plannerModel: string
          workerAgent: string
          workerModel: string
          workerEffort: string
          mteBin: string
        }
        mte: { missing: boolean; message?: string }
        workspace: { id: string; name: string; path: string; branch: string | null } | null
        workers: {
          dispatchId: string
          taskId: string
          agent: string
          state: string
          outcome: string
          liveness: string
          workspace: string
          active: boolean
        }[]
        runs: { id: string; objective: string }[]
        error: { code: string; message: string } | null
      }
    }
    'run.start': {
      input: { goal: string; plannerAgent: string; plannerModel: string }
      output: Result<{ terminalId: string; pinned: boolean; truncated: boolean }>
    }
    'workspace.install': { input: Record<string, never>; output: Result }
    'workspace.focus': { input: { workspace: string }; output: Result }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    /** The worker changed something (install, run start): re-read the state. */
    'state.changed': Record<string, never>
  }
}
