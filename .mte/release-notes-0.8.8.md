# MTE Flow 0.8.8

## New workspace fixes

- **The real reason when `orca worktree create` fails**: with `--json`, Orca reports the error as JSON on stdout, while stderr only said "Command failed". The panel now shows Orca's code and message (for example a base branch that does not exist in the repo). This applies to every `orca` call the plugin makes.
- **Base branch defaults to the repo's own** (empty field) instead of `origin/main`, which repos on `master` or other names do not have.
- **Repo picker on its own row**: it no longer overlaps the workspace name field.
- **A ticket URL in the goal names the workspace and is linked**: a goal of `https://linear.app/team/issue/ENG-1091` gives the workspace name `eng-1091` (not `https-linear-app-…`), and the Linear issue, or a GitHub PR or issue URL, is linked to the new workspace like a chip.

Version sites are aligned again at **0.8.8**, after 0.8.7 bumped only the plugin manifest. The plugin requires mte 0.8.8, which has no CLI changes since 0.8.6; **Repair setup** installs it.
