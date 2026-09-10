---
name: dai-memory-record
description: "Use when a decision, constraint, or hard-won lesson comes out of the conversation and should survive it. Examples: \"remember this for next time\", \"note that we decided X\", \"make sure we don't do this again\", \"record why we went with this\", \"save this for future sessions\"."
---

# Recording something worth keeping

## What belongs in which layer

| Layer | What goes here |
|---|---|
| `semantic` | Decisions, constraints, ADRs -- things meant to stay true |
| `episodic` | What happened: an incident, a failed approach, a debugging session |
| `procedural` | A sequence that is known to work |
| `artifact` | Ingested content; written by `dai-memory ingest`, rarely by hand |

## Two things every record needs

**A `source_ref`.** Where this came from: `docs/adr/0007.md#L1-L40`, or
`session:2026-09-08` when it came out of a conversation. A memory nobody can
trace back is a memory nobody can check, and it will eventually be believed
anyway.

**The reason, including the alternative.** "Retries are capped at two" is a
setting. "Retries are capped at two, chosen over exponential backoff because the
processor counts attempts rather than elapsed time" is a decision. Only the
second can be re-evaluated when the processor changes. Write the second.

## Linking

A decision that came from an incident should be linked to it:

```
dai_memory_write  layer=semantic  title="Cap retries at two"  ...
dai_memory_link   from=<decision> to=<incident> type=RESOLVES
```

That edge is what lets someone later ask from the error side and find the fix.

## Before writing

Check `dai_memory_conflicts` first. Recording a decision that contradicts a
standing one, without saying so, makes the store less trustworthy than it was
before you wrote to it.

## What not to record

Transient state, secrets or credentials of any kind, and anything you have not
actually confirmed. A memory layer that fills up with guesses is worse than an
empty one, because it gets believed.
