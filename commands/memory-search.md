---
description: Search project memory for decisions, incidents and constraints
---

Search this project's memory for: $ARGUMENTS

Use the `memory_search` tool. Then report back:

1. The matching memories, each with its `source_ref` and layer.
2. Any entry marked `stale`, flagged as such.
3. The `fusion` block if any branch is `degraded` -- the user should know when a
   ranking rests on fewer signals than usual.

If nothing matches, say that nothing is recorded, rather than concluding that
nothing exists.
