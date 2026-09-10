---
name: dai-memory-conflicts
description: "Use when about to record or act on a project decision and it might clash with an earlier one, or when the user asks whether something contradicts an existing rule. Examples: \"does this conflict with anything?\", \"did we already decide this?\", \"is there an existing rule about this?\", \"are these two decisions compatible?\""
---

# Finding contradictions before they cost something

Two decisions covering the same ground, neither aware of the other, is the
failure a memory layer is uniquely able to catch. Text search cannot: it returns
both and leaves the reader to pick, and the reader picks the newer one whether
or not it is the one that survived.

## Before recording a decision

1. Call `dai_memory_conflicts` and check whether the subject already has a ruling.
2. If it does and your new decision agrees, do not record a duplicate.
3. If it does and your new decision disagrees, you have two choices, and they
   are different:
   - The old decision is genuinely replaced: record the new one and link it
     `SUPERSEDES` the old.
   - Both are live and incompatible: link them `CONTRADICTS` and tell the user.
     A contradiction is for a person to settle, not for you to resolve quietly.

## Reading the output

`declared` conflicts are ones somebody recorded deliberately. `suspected` ones
are inferred from overlapping subject matter and can be wrong -- treat them as a
question worth asking, not as a finding.

## The thing not to do

Do not pick between two contradicting decisions on your own and carry on. The
value of surfacing a conflict is entirely lost if it is resolved silently.
