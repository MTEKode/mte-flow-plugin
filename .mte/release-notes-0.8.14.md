# MTE Flow 0.8.14

## "No workspace is focused" while one is

Clicking into the MTE Flow panel can leave Orca with no focused workspace, so `workspace.readContext` answers null at the moment Start run or Install is pressed. The panel then said "No workspace is focused" while the workspace was plainly selected in the sidebar.

- **The last focused workspace stands in.** The worker follows Orca's `workspace.changed` event and remembers the last workspace you focused. When Orca reports none at press time, that workspace is used. A live focus always wins.
- **The panel follows focus changes.** Switching workspace now refreshes the panel, so the "Workspace: …" line under the buttons no longer stays stale.

No new plugin access. Version sites are aligned at **0.8.14**.
