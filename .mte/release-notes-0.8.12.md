# MTE Flow 0.8.12

## Links are enough to start a run

- **No goal needed when links are added**: an empty goal becomes `Work on the linked item(s): <links>`, and the planner reads each linked ticket first. A new workspace is named after the links (`eng-1091`). With no goal and no links, Start run still asks for one or the other.

## A better link search

- **Origin icons**: each suggestion and chip shows where it comes from: Linear, GitHub, GitLab, Jira, or a plain link. PRs and issues carry a tag.
- **You can see it searching**: from the first keystroke, a spinner row ("Searching Linear and GitHub for …") and a sweep on the field. Errors and empty results show in the list: Linear not connected, no GitHub remote, `No issues or PRs match.`
- **Already linked** suggestions are dimmed and marked `✓ linked`.

No new plugin access. Version sites are aligned at **0.8.12**.
