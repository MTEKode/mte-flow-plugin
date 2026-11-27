# MTE Flow 0.8.10

## New workspace on linked servers

- **The repo picker lists every host Orca reaches**: this machine, its SSH targets and each paired Orca server (`orca project setups`, then the same with `--environment <id>` per server). Each entry reads `name · host`.
- **Start run creates the workspace on that host** (`orca worktree create --project-host-setup <id> [--environment <id>]`).
- **mte is prepared on that host.** The plugin cannot run `mte` there itself, so it opens an Orca terminal in the new workspace that runs `npm i -g <release tarball> && mte install && mte install --user && mte pin set …`, and waits for it to finish. On success the terminal closes; on failure it stays open and the panel shows the last lines.
- **The planner launches on that host**, and the orchestrator list now includes workers on paired servers.

Limits: the remote shell must understand `&&` (sh, bash, zsh, cmd and PowerShell 7 do; Windows PowerShell 5.1 does not). Agent, model and effort ids must be plain words to cross the remote shell. Install MTE and Start run without New workspace still work on this machine only.

No new plugin access, so this update should keep its approval. Version sites are aligned at **0.8.10**; Repair setup installs it locally.
