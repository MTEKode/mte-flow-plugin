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

## Agent setup

`mte install [--agents claude,opencode] [--workspace <path>]` wires a workspace in one idempotent step (re-running changes nothing; JSON files are merged, unrelated keys survive; invalid JSON aborts without writing):

| Agent | Writes |
| --- | --- |
| claude | `.claude/skills/mte-flow/{SKILL.md,playbook.md}`, `.claude/settings.json` (PreToolUse `Bash` hook `mte guard --claude-hook`), `.mcp.json` (`mte-memory` = `mte memory --role orchestrator`) |
| opencode | `.agents/skills/mte-flow/{SKILL.md,playbook.md}`, `.opencode/plugins/mte-guard/index.js` (V2 plugin, `execute.before` on tool `shell`), `opencode.json` (`mcp.servers.mte-memory`, command as array) |
| both | `.gitignore` gets `.mte/memory.db`, `.mte/planner.json`, `.mte/guard.log` |

`mte` must be on `PATH` (hook, plugin and MCP all call it by name). Start a run with `/mte-flow <goal>`. The skill is named `mte-flow` so it cannot be shadowed by Orca's bundled `mte` skill; `mte install` removes a previously installed project-level `<dir>/mte` skill only when its files are byte-identical to ones it generated.

- **Planner gate**: `mte guard` denies `orca orchestration run-create` and `worker-start` unless the caller is the claimed planner (`.mte/planner.json`, first claim wins, `mte planner claim --force` replaces). On an unclaimed workspace the first `run-create` caller is auto-claimed; callers with no identity are never blocked. Identity: Claude native chat `ORCA_AGENT_SESSION_ID`, Claude terminal `ORCA_TERMINAL_HANDLE`, opencode the client env seen by the shell `create.before` event plus the opencode session id (`mte guard --opencode-session <id>`, always passed, because the shell event fires after the first `execute.before`); a caller matching ANY identity stored in the claim is the planner. `mte planner claim` stores every identity present (`--session-id`, `--terminal-handle`, `--opencode-session`, or env `ORCA_AGENT_SESSION_ID`/`ORCA_TERMINAL_HANDLE`/`MTE_OPENCODE_SESSION`); the opencode plugin never trusts its own `process.env` and resolves the project dir from `ctx.location.directory`.
- **Recognised calls**: `orchestration run-create|worker-start` behind `orca`, any path ending in `/orca`, `"$ORCA_CLI_COMMAND"`/`${ORCA_CLI_COMMAND}`, `env ... orca`, and inside `&&`, `;`, `|`, subshells and `bash -c`. The corrected command is built only from that invocation's own argv (redirections such as `2>&1` and anything after a shell operator are dropped); internal calls (`mte dispatch`) use `$ORCA_CLI_COMMAND` when set, else `orca`.
- **Worker pin**: `.mte/worker-pin.json` (`mte pin set --agent <a> --model <m> [--effort <e>]`, `mte pin get --json`). A `worker-start` missing the pin's `--agent/--model/--effort` is denied with the corrected command; opencode pins never carry `--effort`. `mte dispatch --task <id> [-- <extra args>]` applies the pin itself (extra flags win, used for escalation) and exits with orca's code.
- **Fail open**: internal guard errors allow the command and log to `.mte/guard.log`.
- **Not a security boundary**: a cooperative-agent guardrail only. Also set Orca's *Settings > Orchestration > Nested worker depth* to `1` (user setting `nestedWorkerMaxDepth`, not written by `mte`) so dispatched workers cannot start workers.

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
