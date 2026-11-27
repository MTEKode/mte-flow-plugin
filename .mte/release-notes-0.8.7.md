# MTE Flow 0.8.7 (plugin)

## New workspace picks its repo

With **New workspace** on, Start run no longer fails with "No workspace is focused". The panel shows a repo picker next to the name and base fields. It lists Orca's git repos, defaults to the focused workspace's repo, and keeps your pick across reloads. The worktree is created in the picked repo, re-checked against Orca's list. With the toggle off, Start run still needs a focused workspace.

Plugin-only release: the `mte` CLI stays at **0.8.6** (no new tarball; the plugin keeps requiring 0.8.6, so no Repair is needed). Update the plugin from Orca: *Settings > Plugins*, or `orca plugin update mte-flow`.
