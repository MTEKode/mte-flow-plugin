# mte 0.8.0 / mtekode.mte-flow plugin 0.8.0

Run `run_14f832f87f2e`. First release where every version site agrees: the CLI package, the plugin
manifest and the `REQUIRED_MTE_VERSION` the panel installs against are all **0.8.0**, and a test now
fails if a bump misses any of them (or leaves a stale tarball URL in `README.md`, `orca-plugin.json`
or `worker/lib.mjs`).

## Changes

### Guard integrity (T-0004)
- The plain `mte guard --command` probe is read-only: it never writes a planner claim (only the hook auto-claims).
- Identity is env-first: `--session-id` / `--terminal-handle` are accepted only when the env lacks that identity and refused when they contradict it (no spoofing); a contradicting flag denies instead of silently overriding.
- A claimed workspace denies callers presenting no identity at all (`mte dispatch` included); fail-open stays only for internal errors.
- Deny messages no longer leak claim internals; corrupt `planner.json` reports an actionable error (`mte planner release`) and the panel shows it where Start would have failed.
- Known parse limits are documented and pinned by tests (arbitrary `$VAR` command names, substitution glued to a binary name).

### Memory and install (T-0005)
- The memory MCP server is planner-only: `tools/call` is refused for any identity other than the claimed planner; an unclaimed workspace fails open. The removed `--role coder|validator` exits with a usage error; queue/roles machinery is gone.
- `mte install` writes the MCP entry as the running node + the absolute CLI entry + `memory`, so it starts without `mte` on PATH; installs still carrying `--role orchestrator` keep working.
- `mte install` never writes `.agents` (opencode support retired) and removes previously generated `.agents/skills/{mte,mte-flow}` copies and the legacy project-level `mte` skill, marker-checked, file by file.
- Worker dispatch carries a 3-worker cap and per-worktree planner claims (unchanged surface, tightened in T-0004).

### Panel and worker (T-0006)
- Failures surface instead of being swallowed: a failed harness/model listing or goal search becomes a visible hint; a `checkMte` error never reports healthy.
- `npm i -g` never runs unattended: activation asks for consent (Run setup / Not now); only Run setup or Repair setup install, never sudo.
- Single poller: the worker polls every 15 s and posts `state.changed`; the panel no longer runs its own interval.
- Start run pre-checks the planner claim (`mte planner show --json`) and offers Replace planner before launching.

### Version alignment (T-0007, this release)
- `REQUIRED_MTE_VERSION`, `packages/mte/package.json` and `orca-plugin.json` all at 0.8.0; the frozen `0.3.0` test literal is replaced by the consistency test (files are read from disk).
- `checkMte` returns the detected CLI version; `ensureSetup` ok results carry the detected version (including the skipped path after a newer manual install).
- The panel's mte row shows the installed version and raises a warning drift hint (pointing at Repair setup) when the detected version is below `REQUIRED_MTE_VERSION`.
- All install URLs (manifest `mteBin` description, both READMEs) moved to the 0.8.0 tarball.

## Publication procedure (user-gated — nothing below has been run)

1. Push the run branch and open a PR to `main`; review and merge.
2. On `main`, tag both series: `mte-v0.8.0` (the CLI tarball release) and `v0.8.0` (plugin marker).
3. Create the release with the packaged tarball built from the merged tree:
   ```sh
   cd packages/mte && npm pack --pack-destination ../../.mte   # → .mte/mtekode-mte-0.8.0.tgz
   gh release create mte-v0.8.0 .mte/mtekode-mte-0.8.0.tgz \
     --title "mte 0.8.0" --notes-file .mte/release-notes-0.8.0.md
   ```
   The tarball and `dist/` are build artifacts and stay out of git.

`engines.orca` (`>=1.4.248`) and `pluginApi` are unchanged.
