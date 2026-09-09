# Memory layer plugin

Project memory for Claude: it records **why** — decisions, the incidents that
prompted them, constraints, and the relationships between them — and retrieves
them when an agent needs the reasoning behind unfamiliar code.

It does not build a code graph. Call graphs and impact analysis answer *what
calls what*; this answers *why it is like that*. Different question, different
lifecycle, separate store.

---

## What it does

```
$ memory why src/billing/retry.ts

 1. [semantic] Cap declined-card retries at two
    docs/billing.md#L3-L8
    Chosen over exponential backoff because the processor counts attempts, not
    elapsed time. Two attempts stays under the fraud heuristic.

 2. [episodic] Merchant account flagged
    session:2026-09-01
    Three retries on a declined card tripped the processor fraud heuristic; the
    account was flagged for six hours.

fusion: bm25=3 semantic=2 recency=4 anchor=2
```

The second entry is the incident. The first is the decision that `RESOLVES` it.
Asking from either end reaches the other.

---

## Install

Requires Node 20.11+ and a git repository.

```bash
pnpm install
pnpm build

node packages/cli/dist/cli.js init
node packages/cli/dist/cli.js ingest docs
node packages/cli/dist/cli.js search "why do we retry declined cards"
```

As a Claude plugin, `.mcp.json` registers the MCP server and `hooks/` wires it
into the session; nothing needs to be configured by hand.

---

## Commands

| Command | Purpose |
|---|---|
| `memory init` | Create the store, probe what works, report it |
| `memory ingest <paths>` | Load files into the one store — no import step |
| `memory search <query>` | Three-branch retrieval with a fusion report |
| `memory why <file\|symbol>` | Decisions and constraints touching it |
| `memory get <id>` | One node in full, with its edges |
| `memory graph <id> --depth N` | Walk the memory graph |
| `memory constraints` | What this project has already settled |
| `memory conflicts` | Contradictions a person needs to resolve |
| `memory clusters` | Communities in the memory graph |
| `memory write` / `memory link` | Record a memory, or relate two |
| `memory merge` | Fold queued session writes into the store |
| `memory list` | Registered projects, with index freshness |
| `memory doctor` | What is actually working |
| `memory serve` | MCP server on stdio |

---

## How retrieval works

Three branches, fused by reciprocal rank fusion at `k=60`, keyed on **node id**
rather than file path — one file can hold several decisions that disagree, and
collapsing them to the file would merge them.

```
query ├─► BM25 (posting rows in the store)     ─┐
      ├─► semantic (cosine ranked in-database) ─┼─► RRF k=60 ─► graph expansion
      └─► recency × importance                 ─┘
```

Each branch narrows to candidates before anything is loaded: keyword hits come
from one row per query term, similarity is ranked inside the database by
`array_cosine_similarity`, and only the nodes that survive fusion are read in
full. Nothing on this path reads the whole store, so the cost scales with the
query rather than with how much has been remembered.

Every result carries a `fusion` block:

```jsonc
{
  "results": [ /* ... */ ],
  "fusion": {
    "branches": { "bm25": 12, "semantic": 0, "recency": 20 },
    "degraded": ["semantic"],
    "reasons": { "semantic": "No node in this store carries an embedding yet." },
    "k": 60
  }
}
```

**This is the single most important design decision in the project.** A branch
that returns nothing and says nothing turns fusion into whichever branch still
works, and nobody finds out. The report distinguishes *ran and matched nothing*
from *could not run*, and names the reason. It is what an agent needs in order to
know how much weight the ranking deserves.

---

## Design constraints

Each one guards a failure that has actually been observed, and each has a test.

| # | Constraint |
|---|---|
| C1 | One store. No migration step between writing and reading. |
| C2 | One implementation per capability. |
| C3 | No swallowed errors. Every command exits non-zero with a reason. |
| C4 | Fusion declares its empty branches. |
| C5 | Queries are matched by term, never as a substring. |
| C6 | No decorative parameters. `depth` genuinely changes the traversal. |
| C7 | Anything writable is readable back through a path that is exercised. |
| C8 | Every import is a declared dependency. |
| C9 | No claiming a capability that is not implemented. |
| C10 | A reader never serves a snapshot from before the last write. |
| C11 | The write counter advances only after a durable commit, never before. |

C10 and C11 came out of measurement rather than from the plan. A read-only
LadybugDB handle is frozen at its open point and reports no error when it falls
behind; and because the counter that fixes that lives outside the database, the
order of committing and advancing it is a contract in its own right. Getting it
backwards would leave the guard asserting a falsehood, which is worse than not
having one. See [docs/m0-findings.md](docs/m0-findings.md).

### The rule behind all of them

The three worst bugs in this project's history have the same shape: a component
went missing, a `try/catch` or a `?? []` absorbed it, and the system carried on
at lower quality **emitting no signal at all**. Silent RRF decay when a branch
returned nothing; a keyword branch that became `undefined` and was patched to an
empty array; an AST chunker that never once ran.

So:

> **Anything that can be absent while the system keeps working must have a line
> in `capabilities`. There is no exception for "this one is always there".**

The AST chunker was the thing everyone was sure was always there.

```bash
node --test tests/*.test.js     # 34 tests
node packages/cli/dist/cli.js doctor
```

---

## Data model

Four layers — `semantic` (decisions, constraints), `episodic` (what happened),
`procedural` (sequences known to work), `artifact` (ingested content).

Six edge types, all of which mean something: `RESOLVES`, `SUPERSEDES`,
`CONTRADICTS`, `DERIVED_FROM`, `OCCURRED_IN`, `CONSTRAINS`. There is deliberately
no `relates_to`.

Every node carries a `source_ref` (`docs/billing.md#L3-L8`). A memory that cannot
be traced back cannot be checked, and will be believed anyway — so a chunk
without one is not written.

Nodes are superseded, never deleted. Episodic memories decay in ranking weight;
semantic ones do not. Decay demotes; it does not remove.

---

## Privacy and safety

- **Redaction runs before embedding.** Once text has been through an embedder the
  vector still carries the secret, and masking the source text afterwards changes
  nothing. There is a test for the ordering.
- **Everything is local.** The store lives in `.memory/` and is gitignored. The
  embedding model runs locally through ONNX; no text leaves the machine.
- **Memory does not cross projects.** The registry knows every project, so
  cross-repo queries are technically possible and deliberately not offered.
- **Automatic writes are off by default.** Reads are automatic; recording into a
  project's store is something the user opts into with
  `MEMORY_LAYER_AUTO_RECORD=1`.

---

## Known limits

- **Process startup costs more than search now.** A cold CLI command spends
  231 ms loading modules -- chiefly the native database binding, which even
  `memory help` pays for -- against roughly 180 ms of actual work at 20,000
  nodes. Deferring that load is the next worthwhile change.
- **Semantic search is still an exact scan.** There is no vector index on these
  platforms, so its cost grows with the number of embedded nodes even though the
  scan now happens inside the database.
- **The default embedding threshold is unvalidated for prose.** 384 dimensions
  and a 0.5 cosine cutoff were tuned on source code, not on decision text. This
  needs measuring on a machine that can reach the model hub.
- **Community detection is not summarised.** `memory clusters` returns raw
  communities. Clusters without summarisation are community detection, and are
  named as such.
- **Journaled writes lag.** A write made while another process held the lock is
  recorded but not searchable until `memory merge`. `doctor` reports the backlog.
- **On Windows, one writable open per process.** A LadybugDB path opened for
  writing cannot be opened for writing again in the same process, even after
  `close()`; the second open is refused as though another process held the lock,
  and the process it names is this one. Read-only handles take a shared lock and
  are unaffected, so search, `why` and the reader's reopen-after-write are not.

  A CLI command writes once and exits, so it never meets this. `memory serve`
  does: the first write in a session commits and every later one is journaled,
  reported as `queued` with a note, and counted by `doctor` until `memory merge`
  runs from another process. Holding one writable handle open for the life of
  the server removes the queueing, and was measured and rejected -- an abrupt
  exit then leaves the write-ahead log un-checkpointed and the store does not
  open again, which is a worse failure than a visible backlog. Journaling is the
  safer degradation, and it is the one that reports itself.

---

## Configuration

| Variable | Effect |
|---|---|
| `MEMORY_LAYER_EMBEDDINGS` | `auto` (default), `local` (require the real model), `hash` (offline fallback) |
| `MEMORY_LAYER_DIMS` | Vector width at `init`. Fixed thereafter. |
| `MEMORY_LAYER_HOME` | Registry and log location (default `~/.memory`) |
| `MEMORY_LAYER_AUTO_RECORD` | `1` to let hooks record failed commands |
| `MEMORY_LAYER_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

## Licence

MIT
