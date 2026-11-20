# mte-flow-plugin

MTE Flow for stock Orca: `mte` Node package, Claude/opencode adapters, and the `mtekode.mte-flow` Orca plugin.

## mte package

`packages/mte` is the `@mtekode/mte` engine (bin `mte`): ESM, Node >= 24, zero runtime dependencies. Sources are TypeScript run directly via Node type stripping (`npm test` runs them as is); `npm pack` (via `prepack`) emits plain JS into `dist/` with `scripts/build.mjs`, because Node refuses to strip types under `node_modules`. Not published to the npm registry; install the tarball attached to the GitHub release:

```sh
npm i -g https://github.com/MTEKode/mte-flow-plugin/releases/download/mte-v0.1.0/mtekode-mte-0.1.0.tgz
```

Development alternative: clone this repo, then `cd packages/mte && npm run build && npm link` (or run `node packages/mte/src/cli.ts <cmd>` straight from the sources).

| Command | What it does |
| --- | --- |
| `mte memory [--role orchestrator\|coder\|validator] [--workspace <path>]` | Stdio MCP server over one SQLite DB per repo, `<git-common-dir>/mte/memory.db` (shared by all worktrees; `<cwd>/.mte/memory.db` outside git; a legacy `<worktree>/.mte/memory.db` is imported once, never deleted). The orchestrator gets the full toolkit; coder/validator get only `ask_orq`. Task memory: `record_task` (upsert one row per task), `search_tasks` (FTS5 + `run_id`/`file`/`since`/`until` filters), `get_task`; `search_memory` also returns tasks. |
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
| both | `.gitignore` gets `.mte/memory.db*` (covers the SQLite `-wal`/`-shm` files), `.mte/planner.json` (legacy / non-git fallback only), `.mte/guard.log` |

`mte` must be on `PATH` (hook, plugin and MCP all call it by name). Start a run with `/mte-flow <goal>`. The skill is named `mte-flow` so it cannot be shadowed by Orca's bundled `mte` skill; `mte install` removes a previously installed project-level `<dir>/mte` skill only when its files are byte-identical to ones it generated.

- **Planner gate**: `mte guard` denies `orca orchestration run-create` and `worker-start` unless the caller is the claimed planner (claim stored in `<git-common-dir>/mte/planner.json`, shared by every worktree of the repo and never committed, so a worker's own worktree cannot auto-claim; an old `<workspace>/.mte/planner.json` is migrated on first read; first claim wins, `mte planner claim --force` replaces). On an unclaimed workspace the first identified `run-create` caller is auto-claimed. Once a planner is claimed, a caller that presents NO identity is denied too, `mte dispatch` included (fail-open remains only for internal errors); `mte planner release` removes a stale claim so the next claim needs no `--force`. Identity: Claude native chat `ORCA_AGENT_SESSION_ID`, Claude terminal `ORCA_TERMINAL_HANDLE`; opencode 2.3.2 fires `execute.before` (has `sessionID`) first and the shell `create.before` (has `env`/`cwd`/`command`, no `sessionID`) second, so the plugin stashes `command → sessionID` (bounded, 30 s, newest unconsumed match is consumed), decides in `create.before` with the client env identity plus the opencode session id (`mte guard --opencode-session <id>`), remembers identity per session (never one shared variable) and sets `MTE_OPENCODE_SESSION` in the shell env; a caller matching ANY identity stored in the claim is the planner. `mte planner claim` stores every identity present, taken from env `ORCA_AGENT_SESSION_ID`/`ORCA_TERMINAL_HANDLE`/`MTE_OPENCODE_SESSION`; `--session-id`/`--terminal-handle`/`--opencode-session` are accepted only when the env lacks that identity and are refused when they differ from it (no spoofing). On opencode builds without the shell `create.before` hook nothing is injected into the shell: the guard keys on the opencode session id only, and a planner claims with `mte planner claim --opencode-session <id>` (the guard's deny message prints it). opencode sessions can outlive their terminal: retire a planner with `mte planner release` and stop the session. the opencode plugin never trusts its own `process.env` and resolves the project dir from `ctx.location.directory`.
- **Recognised calls**: `orchestration run-create|worker-start` behind `orca`, any path ending in `/orca`, `"$ORCA_CLI_COMMAND"`/`${ORCA_CLI_COMMAND}`, `env ... orca`, and inside `&&`, `;`, `|`, subshells, real `$(...)`/backtick substitution and the script argument of `bash|sh|zsh|dash -c` / `eval`. Quoted prose, heredoc bodies and backticks inside quotes are data and never parsed as commands. The corrected command is built only from that invocation's own argv (redirections such as `2>&1` and anything after a shell operator are dropped); internal calls (`mte dispatch`) use `$ORCA_CLI_COMMAND` when set, else `orca`.
- **Worker pin**: `.mte/worker-pin.json` (`mte pin set --agent <a> --model <m> [--effort <e>]`, `mte pin get --json`). A `worker-start` missing the pin's `--agent/--model/--effort` is denied with the corrected command; opencode pins never carry `--effort`. `mte dispatch --task <id> [-- <extra args>]` applies the pin itself (extra flags win, used for escalation) and exits with orca's code.
- **Fail open**: internal guard errors allow the command and log to `.mte/guard.log`.
- **Not a security boundary**: a cooperative-agent guardrail only. Also set Orca's *Settings > Orchestration > Nested worker depth* to `1` (user setting `nestedWorkerMaxDepth`, not written by `mte`) so dispatched workers cannot start workers.

## Orca plugin

`plugin/` is the `mtekode.mte-flow` Orca plugin (id `mte-flow`, trusted-worker, no build step). It only drives the `mte` CLI and stock Orca APIs.

- **Panel "MTE Flow"**: start-run form (goal, planner agent/model prefilled from settings, target = focused workspace), an "Install MTE in this workspace" button, and workers/runs read from `orca orchestration worker-list` / `run-list` with a Focus button per worker.
- **Commands**: `MTE: Start run` and `MTE: Open panel` (both open the panel), `MTE: Install in workspace`.
- **Status bar**: `MTE <n>` active workers, polled every 15 s; click opens the panel.
- **Settings**: `plannerAgent`, `plannerModel`, `workerAgent`, `workerModel`, `workerEffort` (ignored for opencode), `mteBin` (default `mte`).
- **Start run (terminal planner)**: re-reads the focused workspace at press time (refused when it is the home directory or not a git repo), runs `mte planner show --json` first (a live claim stops the run: the panel names the holder and offers a **Replace planner** button), then `mte install --agents claude,opencode` (both agents, always), `mte pin set ...` and, only when replacing, `mte planner release` in its path, then launches the planner with the prompt `/mte-flow <goal>` through `orca agent launch --surface terminal --prompt` (goal truncated with a marker to stay under the 4096-char cap). The host `agent.launch` is only a fallback when the CLI is missing: it sends the prompt in a second, fire-and-forget call that failed silently in QA. A native-chat planner is started by typing `/mte-flow <goal>` in the chat.
- **Which Orca**: the worker's env has no `ORCA_*`, so the plugin derives the hosting app's CLI from `process.execPath` (`<app>/Contents/Resources/bin/orca` on macOS, `resources/bin/orca-ide` on Linux, `resources/bin/orca.exe` on Windows) and the profile from its own install path (`<userData>/plugins/<key>/<hash>/`), and runs the CLI with `ORCA_USER_DATA_PATH` set. A dev-linked plugin has no userData in its path and uses the bundle's default profile.
- Requires the `mte` CLI: `npm i -g https://github.com/MTEKode/mte-flow-plugin/releases/download/mte-v0.1.0/mtekode-mte-0.1.0.tgz` (dev alternative: clone this repo, then `cd packages/mte && npm run build && npm link`). The panel shows this when `mte` is missing or `mte --version` exits non-zero.
- `plannerModel` is passed to the planner launch (`--model`); empty means the agent's default. An empty `workerModel` skips `mte pin set`.

Develop and test (from `plugin/`; none of these install into your Orca profile):

```sh
orca plugin validate .
orca plugin check .
orca plugin test .            # or: node --test "plugin/**/*.test.mjs"
```
