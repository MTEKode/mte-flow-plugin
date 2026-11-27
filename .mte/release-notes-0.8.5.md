# mte 0.8.5

## Setup: name the stale `mte` that shadows the install

When `npm i -g` installs the new release but `mte --version` still answers an older version (for example 0.3.0), there is almost always an older copy earlier on PATH: an old global install, another Node's prefix, or a leftover shim. Setup now reports both files: where npm installed the new `mte` (from `npm prefix -g`) and which `mte` on PATH answers instead (from `where` on Windows, `which -a` elsewhere; folders are compared, so npm's `mte`, `mte.cmd` and `mte.ps1` count as one). Remove the old copy, or put npm's global bin folder before it in PATH, then press **Repair setup**.

The plugin never deletes that file. It also never just switches to the new path, because agents and hooks run `mte` from PATH and would keep running the old one.

When `mte` is not on PATH at all, the message names npm's global bin folder to add to PATH.

Version sites are aligned at **0.8.5**. The plugin requires it, so **Repair setup** shows the new diagnosis on machines with a stale copy.
