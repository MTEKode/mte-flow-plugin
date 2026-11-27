# MTE Flow 0.8.15

## Start run and Install on a paired server's workspace

The real cause of "No workspace is focused": the focused workspace lived on a **paired Orca server**. In the case reported, the Mac's `eng-1051` was shown in the Windows PC's sidebar. The plugin only searched this machine's workspaces.

- **Found on the server:** the worker now looks for a focused workspace that is not on this machine on each paired server (`orca worktree list --environment <id>`). It matches by Orca's instance id first, then by name and branch. The panel shows it as `Workspace: <name> · <path> (on <server>)`.
- **Start run works there:** an Orca terminal in that workspace prepares mte, Linear and GitHub links attach with `--environment`, and the planner launches there. The planner claim check stays with the planner's own skill.
- **Install MTE works there** the same way.
- **mte installs only when needed:** a remote setup first asks the remote machine for `mte --version`. npm installs the release only when mte is missing or older, so a developer's `npm link` on the server stays as it is. This applies to New workspace on remote hosts too.

No new plugin access. Version sites are aligned at **0.8.15**.
