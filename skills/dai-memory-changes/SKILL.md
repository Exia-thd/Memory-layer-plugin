---
name: dai-memory-changes
description: "Use before committing, or when the user asks whether a change is safe, conflicts with an earlier decision, or has been decided before. Examples: \"can I commit this?\", \"does this contradict anything?\", \"is there a decision about these files?\", \"review my changes\", \"anything I should know before I push?\""
---

# Checking a change against what the project already decided

Memory is worth the most in one specific moment: just before a change lands that
may contradict a decision somebody already made and wrote down. Not while
exploring — then it is merely useful.

## When to use

- Before `git commit`, always.
- When the user asks whether a change is safe, or wants it reviewed.
- After a refactor that touched files you did not open.

## Workflow

```
1. dai_memory_changes({scope: "staged"})     → what memory covers the staged files
2. Read every CONTESTED entry            → a contradiction is a person's call
3. dai_memory_get on anything that applies   → the full reasoning, not the title
4. Report to the user before committing
```

For a branch review rather than a commit, use
`dai_memory_changes({scope: "compare", base_ref: "main"})`.

## Reading the result

| Field | Means |
|---|---|
| `covered` | Changed files memory has something to say about |
| `uncovered` | Changed files with nothing recorded — say so out loud |
| `contested` | Memories on one side of an unresolved contradiction |

`uncovered` is reported for a reason: "memory found nothing" and "memory was
never asked" look identical if only hits are shown. Tell the user which files
are simply unrecorded, so the silence is theirs to interpret.

## Rules

- **A CONTESTED entry is escalated, never resolved here.** Two live decisions
  covering the same ground is exactly what a person needs to settle.
- **Do not treat a hit as a veto.** A recorded decision may be the thing the
  user is deliberately changing. Surface the reasoning and let them decide.
- **Cite the `source_ref`** when you report a memory, so the user can check it.
- If the change *does* overturn a recorded decision, offer to record the new one
  with a `SUPERSEDES` link — an unrecorded reversal is how the reasoning gets
  lost the second time.
