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
