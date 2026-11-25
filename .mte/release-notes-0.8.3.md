# mte 0.8.3

## Panel feedback

- **Orca typography**: the panel takes Orca's `--orca-font-sans` / `--orca-font-mono` and `--orca-radius` instead of a fixed system font and 6px corners.
- **Advanced = workers only**: the orchestrator selector moves into the form; the closed Advanced fold holds the **Coder** and **QA** worker selectors.
- **Goal is plain text**: no search, no suggestion list, never rewritten by the panel, so Cmd/Ctrl+Z keeps its history.
- **Links are the run's own**: chips show only what you added (the workspace's observed PRs are no longer listed or copied into a new workspace), × removes a chip at once, and Start run attaches them to the run's workspace. Enter never picks a search suggestion you did not move to; clearing the field after adding keeps undo.

## mte: per-role worker pins

- `mte pin set|get --role qa` writes/reads `.mte/worker-pin-qa.json`; the default role (`coder`) stays `.mte/worker-pin.json`.
- `mte dispatch --task <id> --role qa` applies the QA pin (falls back to the coder pin when unset). The guard accepts a `worker-start` carrying either pin.
- The skill and playbook dispatch validator and QA workers with `--role qa`.
- Version sites aligned at **0.8.3**: the plugin requires it (an older `mte` would ignore `--role` and overwrite the coder pin).

## Planner flow: 8 phases

1. **Exploration**: 3 independent Explorer workers (new persona, read-only, no mesh) observe the problem; the planner synthesizes.
2. **Brainstorming** with the user (open discussion, not the grill).
3. **Grill me**: one AskUserQuestion at a time; at 10 questions the planner asks whether to relaunch exploration with the gathered context and design problems, then brainstorming and grill again.
4. **Write spec**: autonomous review, requirements lock, task specs.
5. **Coder**: 1, or 2 in parallel only for independent tasks with disjoint edit boundaries.
6. **QA**: 2 separate `--role qa` workers per task (Validator + QA), blind to each other.
7. **Summary**: a few lines plus a short visual note.
8. **Draft PR**: the run's only push.

## Gated release procedure (nothing below has run; user approval required)

1. Push the release branch and open a PR into `main`; merge once validation is green.
2. On the merge commit: `git tag mte-v0.8.3 && git tag v0.8.3 && git push origin mte-v0.8.3 v0.8.3`
3. `gh release create mte-v0.8.3 .mte/mtekode-mte-0.8.3.tgz --title "mte 0.8.3" --notes-file .mte/release-notes-0.8.3.md`
