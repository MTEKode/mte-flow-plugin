# mte-flow-plugin

MTE Flow for stock Orca: `mte` Node package, Claude/opencode adapters, and the `mtekode.mte-flow` Orca plugin.

## mte package

`packages/mte` is the `@mtekode/mte` engine (bin `mte`): ESM, Node >= 24, TypeScript run directly via Node type stripping (no build step), zero runtime dependencies. Run from a checkout (`node packages/mte/src/cli.ts <cmd>` or `npm link` inside `packages/mte`); a copy installed under `node_modules` cannot be executed, because Node refuses to strip types there.

| Command | What it does |
| --- | --- |
| `mte memory [--role orchestrator\|coder\|validator] [--workspace <path>]` | Stdio MCP server over `<workspace>/.mte/memory.db`. The orchestrator gets the full toolkit; coder/validator get only `ask_orq`. |
| `mte check [--json]` | Detects and runs lint/typecheck/test groups; the exit code is the number of failing groups. |
| `mte deploy-check config [--json]` | Prints `<workspace>/.mte/deploy-check.json` (`url`, `username`, `linearDoneState`) plus `hasPassword`; the password is read only from `MTE_DEPLOY_CHECK_PASSWORD` and never printed. |
| `mte deploy-check validated --summary <text> [--failed]` | Comments on the linked Linear issue via `orca linear comment add --current` and, unless `--failed`, runs `orca linear status set --current --to <linearDoneState>`. Exits non-zero when no issue is linked. |
| `mte --version`, `mte help` | |

Tests: `cd packages/mte && npm test` (or `node --test 'packages/mte/**/*.test.ts'` from the repo root). `src/cli.ts` holds the command table that further commands extend.

## Orca plugin

`plugin/` is the `mtekode.mte-flow` Orca plugin (id `mte-flow`, trusted-worker, no build step). It only drives the `mte` CLI and stock Orca APIs.

- **Panel "MTE Flow"**: start-run form (goal, planner agent/model prefilled from settings, target = focused workspace), an "Install MTE in this workspace" button, and workers/runs read from `orca orchestration worker-list` / `run-list` with a Focus button per worker.
- **Commands**: `MTE: Start run` and `MTE: Open panel` (both open the panel), `MTE: Install in workspace`.
- **Status bar**: `MTE <n>` active workers, polled every 15 s; click opens the panel.
- **Settings**: `plannerAgent`, `plannerModel`, `workerAgent`, `workerModel`, `workerEffort` (ignored for opencode), `mteBin` (default `mte`).
- **Start run (terminal planner)**: runs `mte install --agents ...` and `mte pin set ...` in the workspace path, then `agent.launch` with the prompt `/mte <goal>` (goal truncated with a marker to stay under the 4096-char host cap). A native-chat planner is started by typing `/mte <goal>` in the chat.
- Requires the `mte` CLI: `npm i -g @mtekode/mte` (the panel shows this when it is missing).
- `plannerModel` is advisory: `agent.launch` cannot select a model. An empty `workerModel` skips `mte pin set`.

Develop and test (from `plugin/`; none of these install into your Orca profile):

```sh
orca plugin validate .
orca plugin check .
orca plugin test .            # or: node --test "plugin/**/*.test.mjs"
```

## mte package

`packages/mte` is the `@mtekode/mte` engine (bin `mte`): ESM, Node >= 24, TypeScript run directly via Node type stripping (no build step), zero runtime dependencies. Run from a checkout (`node packages/mte/src/cli.ts <cmd>` or `npm link` inside `packages/mte`); a copy installed under `node_modules` cannot be executed, because Node refuses to strip types there.

| Command | What it does |
| --- | --- |
| `mte memory [--role orchestrator\|coder\|validator] [--workspace <path>]` | Stdio MCP server over `<workspace>/.mte/memory.db`. The orchestrator gets the full toolkit; coder/validator get only `ask_orq`. |
| `mte check [--json]` | Detects and runs lint/typecheck/test groups; the exit code is the number of failing groups. |
| `mte deploy-check config [--json]` | Prints `<workspace>/.mte/deploy-check.json` (`url`, `username`, `linearDoneState`) plus `hasPassword`; the password is read only from `MTE_DEPLOY_CHECK_PASSWORD` and never printed. |
| `mte deploy-check validated --summary <text> [--failed]` | Comments on the linked Linear issue via `orca linear comment add --current` and, unless `--failed`, runs `orca linear status set --current --to <linearDoneState>`. Exits non-zero when no issue is linked. |
| `mte --version`, `mte help` | |

Tests: `cd packages/mte && npm test` (or `node --test 'packages/mte/**/*.test.ts'` from the repo root). `src/cli.ts` holds the command table that further commands extend.
