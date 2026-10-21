# Hot functions

## Hotspot reflection

A function with 6+ trunk commits among its lines in 60 days is a hotspot:
before changing it, read it and its fix diffs, then record
`amux churn verdict '<path>::<name>' REWRITE|SPLIT|KEEP "<why>"` (Claude
panes are held at `git commit` until it exists; other engines run
`amux churn check` first). Reflection, not a rewrite: KEEP when fixes
came from constants, copy, upstream values or features, SPLIT or REWRITE when
from its own branching or state; a small split goes in the same change.
