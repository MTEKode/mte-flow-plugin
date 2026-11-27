# MTE Flow 0.8.13

## A typed link shows in the list

Typing something that already is a link (`eng-1051`, `#45`, a Linear or GitHub URL, any URL) used to close the suggestion list and wait for Enter, with nothing on screen. Now the link shows as the **top row of the list**, highlighted:

- **Enter or a click adds it**; ↑ ↓ move through it and the search results below it.
- **A key or number is looked up**: while it searches, the row reads "Looking it up…". When the matching issue or PR arrives, it takes the row with its real title.
- A Linear key is upper-cased (`eng-1051` becomes `ENG-1051`). A bare URL is added as typed, without a search.

No new plugin access. Version sites are aligned at **0.8.13**.
