# MTE Flow 0.8.16

## Agents and models from the project's machine

The Orchestrator, Coder and QA selectors listed the agents installed on the machine running the panel. They now list the agents of the machine where the run will happen:

- **New workspace:** the picked repo's host. This is a paired Orca server (`orca agent installed --environment <id>`) or an SSH host (`--worktree path:<repo>`).
- **Otherwise:** the focused workspace's host.
- **The panel says where:** the Orchestrator label reads `Agents and models from <host>`. The lists reload whenever that host changes (focus, the New workspace toggle, the picked repo). A slower answer for a previous host never overwrites a newer one.
- **Models on another machine:** its model CLI (`agy models`) and its `~/.mte/models.json` cannot be read from here, so the built-in list shows, with a hint to type a model id.

No new plugin access. Version sites are aligned at **0.8.16**.
