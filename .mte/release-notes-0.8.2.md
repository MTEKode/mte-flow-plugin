# mte 0.8.2

## Panel: start a run in a new workspace

- **New workspace toggle**: a checkbox next to Start run starts the run in a fresh Orca worktree instead of the focused one, reproducing the value of Orca's native «Crear worktree» modal without any app change. With the toggle off, the flow is byte-identical to 0.8.1.
- **Inputs**: the toggle reveals a name field (empty: a slug derived from the goal, fallback `mte-run`) and a base-branch field (default `origin/main`, passed as `--base-branch`).
- **Creation**: `orca worktree create --name <name> --repo id:<focused repo> --base-branch <base> --no-parent`; the current Links field entries go with it — GitHub issue/PR and Linear as `--issue` / `--pr` / `--linear-issue` flags at creation, reference URLs right after via `orca reference add` (create refuses to mix `--reference` with the slot flags, live-probed).
- **Wiring**: `mte install` and `mte pin set` run against the new path, the planner launches there with `orca agent launch --worktree <raw created id> --prompt "/mte-flow <goal>" [--model m [--effort e]] --surface … --focus`, and the launch is recorded like any other (the orchestrators fold tracks it). The planner-claim pre-check is skipped: a brand-new worktree cannot hold a claim.
- **Errors**: a creation failure stops before anything else; a failure after creation names the created workspace in the notice and never deletes it. Failed reference links are reported in the start note, never swallowed.
- Version sites aligned at **0.8.2** (`REQUIRED_MTE_VERSION`, `packages/mte/package.json`, `orca-plugin.json`, README install URLs).

## Gated release procedure (nothing below has run; user approval required)

1. Push the release branch and open a PR into `main`; merge once validation is green.
2. On the merge commit: `git tag mte-v0.8.2 && git tag v0.8.2 && git push origin mte-v0.8.2 v0.8.2`
3. Publish the release with the packed tarball:
   `gh release create mte-v0.8.2 .mte/mtekode-mte-0.8.2.tgz --title "mte 0.8.2" --notes-file .mte/release-notes-0.8.2.md`
   Every install URL in the manifest/READMEs points at this asset (`mte-v0.8.2/mtekode-mte-0.8.2.tgz`).
