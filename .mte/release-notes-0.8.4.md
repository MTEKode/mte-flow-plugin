# mte 0.8.4

## Planner flow hardening

- **Questions only in grill-me**: AskUserQuestion is reserved for phase 3. Brainstorming is a text proposal the user answers before grill-me starts, and the requirements lock is confirmed in text under phase 4. This overrides any general "make every question interactive" preference.
- **Exact phase headers**: every phase opens with `## Fase N — <name>`. All 8 are mandatory, and the e2e run checks their order.
- **Change size**: the planner classifies the goal as trivial, small, standard or large, and that sets how many Explorers and QA workers run. Auth, secrets, money, data migrations and public APIs are at least standard.
- **QA fails closed**: a Validator or QA worker without its verdict line, that dies, or that Orca cannot verify counts as a failure.
- **Coders in their own worktree**: `mte dispatch` adds `--worktree new-child` for coders unless another `--worktree` is passed. Validator and QA run on the coder's worktree, and the planner merges the branch.
- **Overlap check** before merging parallel coders. On a conflict or broken tests the coder is re-dispatched with the conflict diff and test output.
- **Memory**: the planner saves a checkpoint per phase and treats recall as evidence, checking it against the repo before relying on it.
- **Validator**: fails a diff that relaxes lint, format, typecheck or test config unless the spec allows it.

## mte

- **Guard**: blocks git hook bypasses for every caller (`--no-verify`, `commit -n`, `-c core.hooksPath=…`, `git config core.hooksPath …`) and lets `--help` probes through.
- **`mte dispatch --role qa`** warns when the QA worker would run on the coder's model.
- **`mte phase --claude-hook`** is a Stop hook installed by `mte install`. It records the claimed planner's latest `## Fase N` header, taken from the Stop payload's last assistant message with the transcript as fallback. `mte phase show [--json]` reads it.

## Panel

- **Phase per run**: each run shows its phase, e.g. `Fase 5/8 · Coder`. Coders now run in child worktrees, so the panel ties a run to its planner through the worker worktree's parent.
- **Needs you**: a new list of worker questions and escalations the planner has not handled, pending decision gates (Focus opens the planner workspace), and settled workers whose terminal is still kept (**Release**).

## End-to-end run (opt-in)

`e2e/`: a real planner (Claude Agent SDK, `sonnet`) and a simulated user (`haiku`) drive a whole run, with real Orca workers on cheap pins, against a throwaway fixture repo and a fake `gh`. It checks the phase order, that questions are asked only in grill-me, the requirements lock before the coder, QA after the coder, `record_task`, the draft PR and the recorded phase, then runs a hidden acceptance check on the pushed branch. Run it with `cd e2e && npm install && npm run e2e`; `npm test` runs only the free unit tests of the checks.

Version sites are aligned at **0.8.4**, and the plugin requires it.
