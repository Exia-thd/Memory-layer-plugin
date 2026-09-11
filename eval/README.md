# Measuring whether it finds the right thing

178 tests say the machine does what it was built to do. None of them say it
finds the right thing, and a store can pass every one of them while returning
the wrong document.

```bash
dai-memory eval
```

It reads `.memory-eval.json` **from your repository**, not from this package.
The questions name files in *your* project and the right answers are yours to
know -- a set shipped with the plugin would measure the plugin's own
documentation, which is a different question and one nobody asked.

## What a question looks like

```json
{
  "ask":    "why do retries stop at two",
  "also":   "vi sao khong dung exponential backoff",
  "expect": ["adr-001.md"],
  "reject": ["perf-notes.md"]
}
```

`also` is the same question worded differently. Mem0's own analysis of memory
benchmarks names the lack of it as the flaw in theirs: *"benchmarks often reuse
almost identical wording for probes"*, which measures matching rather than
understanding.

`reject` is the hard column and the one that makes the score mean anything.
Recall alone is trivial to game -- return everything and it is perfect. Naming
the plausible wrong answer takes more thought than naming the right one, and is
worth more.

## Two kinds of question, and only one of them tests this layer

This is the trap, and the set in this directory fell into it.

```
DOCUMENT LOOKUP   "how do I exclude a folder"      -> usage.md
DECISION RECALL   record a decision about chargeInvoice,
                  then ask "chargeInvoice"          -> that decision
```

The first kind shares vocabulary with its answer, so BM25 alone solves it.
Measured on twenty such questions, removing *any* branch changed recall not at
all -- not because the branches are useless, but because the questions cannot
tell them apart.

The second kind is what the layer exists for: a reason that is not in the code
and never will be, reached from the thing you are looking at. Measured on one:

```
question: "chargeInvoice"   (shares no word with the decision)

  all branches     found the decision: yes
  without bm25     found the decision: yes
  without semantic found the decision: yes
  without entity   found the decision: NO      <- only this branch carried it
  without graph    found the decision: yes
```

Same system, opposite conclusions. Write the second kind.

## Reading the output

```
all branches        33/40 (83%)  95% CI 68-91%, 23 wide   false 5/40
```

Read the interval before the percentage. Five of six and seventeen of twenty are
both about 85%, and only one of them is a finding; the width is the report
declining to let a small set pass for evidence. Twenty questions is roughly
where it narrows enough to act on. Two configurations whose intervals overlap
have not been shown to differ, however far apart the headline numbers look.

The `unanswered` list at the bottom is worth more than the score. It names the
questions nothing answered and what came back instead.

## Why you have to write it

The set in this directory scored 50% on its first run. Every Vietnamese phrasing
was marked wrong -- for returning the Vietnamese translation of the correct
section, because `expect` listed `usage.md` and not `usage_vn.md`. Fixing the
set moved it to 83%. **The set was wrong, not the search.**

That is the harmless direction. The dangerous one is a set written by whoever
built the thing, asking only what it already answers, scoring 95%, with nobody
able to tell the number is hollow.

## The files here

`golden.json` and `run.mjs` are the worked example, scored against this
repository. They are a template to copy, not a measurement of your project.
`harvest.mjs` reads your own Claude Code transcripts and prints the questions
you actually asked -- useful mainly for spotting what your documentation failed
to answer, since a question asked mid-conversation is rarely one a search box
would receive.
