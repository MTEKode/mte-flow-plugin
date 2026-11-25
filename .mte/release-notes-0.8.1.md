# mte 0.8.1

## Panel: Advanced fold + workspace Links

- **Advanced section**: the orchestrator and worker selectors (harness / model / effort, planner surface) are folded into a closed `<details>` under the Goal box, restoring the layout of the removed native MTE UI. Nothing about the selectors changes.
- **Links field**: a new field under the Goal box links issues and PRs to the focused workspace. Type an identifier or URL and press Enter — `#45` (GitHub issue), `ENG-123` (Linear), a GitHub PR/issue URL, a Linear issue URL, or any other http(s) URL (`orca worktree set` / `orca reference add`). Free text searches instead (the Goal box's `goal.search` suggestions); picking a suggestion links it. Current links render as removable chips from `worktree show`'s `linkedItems`; failures show as a hint under the field. The Goal box is unchanged.
- Worker handlers added: `link.add`, `link.remove`; `state.get` now carries `workspace.links`.
- Version sites aligned at **0.8.1** (`REQUIRED_MTE_VERSION`, `packages/mte/package.json`, `orca-plugin.json`, README install URLs).

## Gated release procedure (nothing below has run; user approval required)

1. Push the release branch and open a PR into `main`; merge once validation is green.
2. On the merge commit: `git tag mte-v0.8.1 && git tag v0.8.1 && git push origin mte-v0.8.1 v0.8.1`
3. Publish the release with the packed tarball:
   `gh release create mte-v0.8.1 .mte/mtekode-mte-0.8.1.tgz --title "mte 0.8.1" --notes-file .mte/release-notes-0.8.1.md`
   Every install URL in the manifest/READMEs points at this asset (`mte-v0.8.1/mtekode-mte-0.8.1.tgz`).
