# Agent guidance

Paste this into the project's `CLAUDE.md` to put memory in front of the agent on
every session, not only when it remembers a tool exists.

The plugin does not write this file for you. Editing a project's `CLAUDE.md`
behind the user's back is exactly the kind of thing a memory layer should not do.

```markdown
## Always Do

- **MUST run memory_why before changing code you did not write.** Code that looks
  arbitrary is the strongest signal that a reason exists and has been lost.
- **MUST check memory_conflicts before recording a new decision.** Two live
  decisions covering the same ground, neither aware of the other, is the failure
  this layer exists to catch.
- **MUST cite the source_ref** of anything memory returned when acting on it.
- **MUST record the alternative** when writing a decision. "Capped at two" is a
  setting; "capped at two, chosen over backoff because the processor counts
  attempts" is a decision, and only the second can be re-evaluated later.

## Never Do

- **NEVER treat a memory result as current state.** It describes what was true
  when it was recorded. Re-verify against the working tree.
- **NEVER resolve a CONTRADICTS pair on your own.** Surface it; a person decides.
- **NEVER record a decision without a source_ref.** A memory nobody can trace
  back cannot be checked, and will be believed anyway.
- **NEVER record secrets, credentials, or anything unverified.** A memory layer
  full of guesses is worse than an empty one, because it gets trusted.
```

## Why this is the weakest of the four layers

Guidance in `CLAUDE.md` relies on the agent reading and following it. The
stronger mechanisms are the ones that do not:

| Layer | Mechanism | Relies on the agent remembering? |
|---|---|---|
| 1 | `CLAUDE.md` guidance | Yes |
| 2 | Skills, described in the user's own words | Partly — the harness routes |
| 3 | `SessionStart` hook injecting active constraints | No |
| 4 | `PreToolUse` hook on `Read`/`Grep`/`Glob` | No |

Layer 4 is the strongest and works differently from the rest. It does not tell
the agent to consult memory. It fires at the moment the agent reaches for raw
search — the moment the question is actually being asked — and puts what memory
holds in front of it.

## Keeping it honest

Every one of these layers is a confident liar if the store is out of date, so
`memory_search` and `memory_why` attach an `index.stale` block when the store was
built at an older commit, and individual results older than the staleness
threshold are marked. Guidance that tells an agent to trust memory, without
memory telling it when not to, is worse than no guidance.
