# mte 0.8.6

## Repair updates the stale `mte` instead of only naming it

When `mte --version` still answers an older version after `npm i -g`, an older copy is earlier on PATH. **Repair setup** now brings it up to date:

- **An `mte` owned by another npm prefix** (another Node version, another global folder, with `@mtekode/mte` installed there) is reinstalled into that same prefix with `npm i -g --prefix <prefix> <release tarball>`.
- **An old MTE shim** (from the retired `~/.mte` flow) is renamed to `<file>.old`. Nothing is deleted, so it can be undone.
- **A file that is not recognisably MTE** is never touched; the error names it, so you can decide.

Repair only touches copies that come before npm's fresh install on PATH, decides once per folder (npm's `mte`, `mte.cmd` and `mte.ps1` sit together), and reports what it did in the setup message.

**Install MTE in this workspace** runs the same repair first when `mte` is older than the plugin requires, so it never writes an old skill.

Version sites are aligned at **0.8.6**, and the plugin requires it.
