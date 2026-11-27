# MTE Flow 0.8.11

## A searchable repo picker, like Orca's sidebar

The New workspace repo picker is a search list instead of a native select:

- **The project's own icon**, as Orca shows it: the GitHub owner avatar, fetched by the worker and passed to the panel as a data URL. Without one, the project's first letter appears on its badge color.
- **Grouped by host**, each group with its **OS icon** (macOS, Windows, Linux, from `orca host list` / `orca host name --environment`) and a **server icon** for SSH targets and paired Orca servers.
- **Search** by repo name, host or path. Arrow keys, Enter and Escape work as in the model picker. The selected repo shows its icon, host and badges in the button.

No new plugin access. Version sites are aligned at **0.8.11**.
