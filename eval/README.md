# Measuring whether it finds the right thing

The test suite answers "does the machine do what it was built to do" -- 178
tests, all green. This answers the question none of them touch: **does it find
the right thing?** A store can pass every test and return the wrong document.

```bash
node eval/run.mjs
```

## The two files

`golden.json` holds questions whose answer is already known:

```json
{
  "ask":    "how do I get a PDF into memory",
  "also":   "lam sao dua file PDF vao memory",
  "expect": ["usage.md", "usage_vn.md"],
  "reject": []
}
```

`run.mjs` asks each question both ways, in every branch configuration, and
scores what comes back.

## Why the second phrasing

Mem0's own analysis of memory benchmarks names this as the flaw in theirs:
*"benchmarks often reuse almost identical wording for probes."* A set that asks
each question one way measures how well the system matches that wording, not
whether it understood. Asking twice separates the two.

## Why `reject` is the hard column

Recall alone is trivial to game -- return everything and it is perfect. What
makes a threshold choosable is the pair moving in opposite directions, and the
useful setting is where the trade stops being worth it. Filling in `reject`
means naming the plausible wrong answer, which takes more thought than naming
the right one and is worth more.

## Why the interval, not the percentage

Borrowed from Forgewright's routing eval, which scores its corpus the same way.
Five out of six and seventeen out of twenty are both about 85%, and only one of
them is a finding:

```
all branches   recall@5  5/6 (83%)  95% CI 44-97%, 53 wide
```

Fifty-three points wide is the number admitting it means nothing yet. Two
configurations whose intervals overlap have not been shown to differ, however
far apart their headline numbers look. Twenty questions is roughly where the
interval narrows enough to act on -- and now the runner makes that argument
itself instead of leaving it as an assertion.

## Why you have to write it

The first draft of `golden.json` scored 50%. Every Vietnamese phrasing was
marked wrong -- for returning the Vietnamese translation of the correct
section, because `expect` listed `usage.md` and not `usage_vn.md`. Fixing the
set moved it to 83%. **The set was wrong, not the search.**

That error was the harmless direction: it made the system look worse than it
is. The dangerous direction is a set written by whoever built the thing, asking
only what it already answers, scoring 95%, with nobody able to tell the number
is hollow.

Draw the questions from ones actually asked -- *why LadybugDB*, *does `.env`
get indexed*, *where did 0.75 come from* -- and for each, name the file that
answers it and the file that must not come back.
