# MTE Flow 0.8.9

## Updates keep their approval

Orca keeps a plugin's approval across updates that ask for no new access, but every MTE Flow release still asked for `--approve` with "asks for more access: new settings". The cause was in our manifest: the `mte binary` setting's description carried the versioned tarball URL, so the settings schema changed with every release.

The description no longer carries a version. It points to the panel's Run setup / Repair setup and to the releases page. A test keeps it version-free.

**This update still asks for approval once**, because its description changes for the last time. From the next release on, `orca plugin update mtekode.mte-flow` (or `--all`) applies without `--approve`, unless a release really adds access (new capabilities, commands or panels); in that case Orca has to ask.

Version sites are aligned at **0.8.9**. `mte` has no CLI changes since 0.8.6; **Repair setup** installs 0.8.9.
