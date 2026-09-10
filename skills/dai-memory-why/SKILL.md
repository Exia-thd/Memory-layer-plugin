---
name: dai-memory-why
description: "Use when someone asks why code is the way it is, who decided something, or what the reasoning behind an existing choice was, and before changing code they did not write. Examples: \"why does this retry twice?\", \"who decided we use this processor?\", \"is there a reason this is hardcoded?\", \"what was the thinking here?\", \"any history on this file?\""
---

# Recovering the reasoning behind existing code

The code says what happens. It rarely says why, and the why is usually the part
that matters when deciding whether a change is safe.

## When to use this

Reach for `dai_memory_why` before editing code you did not write, and whenever a
piece of code looks wrong, arbitrary, or needlessly cautious. Code that looks
arbitrary is the strongest signal that a reason exists and has been lost.

## How to use it

1. Call `dai_memory_why` with the file path or symbol name.
2. Read the `semantic` results first: those are decisions and constraints. The
   `episodic` results are what went wrong to prompt them.
3. Follow `dai_memory_neighbors` from an interesting node when you want the chain --
   a decision usually `RESOLVES` an error and is sometimes `SUPERSEDES`-ed by a
   later one.

## Reading the result honestly

**Check the `fusion` block.** It reports which retrieval branches contributed.
If branches are listed under `degraded`, the ranking rests on fewer signals than
it looks like, and absence of a result is weaker evidence than usual.

**Check `index.stale`.** When present, the store was built at an older commit.
Everything in it describes what was true then.

**Memory is context, never current state.** A returned decision tells you what
was decided and why. It does not tell you the code still does that. Verify
against the working tree before acting, and cite the `source_ref` when you
explain your reasoning to the user.

## What to do with nothing

An empty result means nothing was recorded, not that no reason exists. Say so
plainly rather than concluding the code is arbitrary.
