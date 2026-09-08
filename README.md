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
| `memory doctor` | What is actually working |
| `memory serve` | MCP server on stdio |

---

## How retrieval works

Three branches, fused by reciprocal rank fusion at `k=60`, keyed on **node id**
rather than file path — one file can hold several decisions that disagree, and
collapsing them to the file would merge them.

```
query ├─► BM25 (in-process inverted index) ─┐
      ├─► semantic (exact cosine scan)      ─┼─► RRF k=60 ─► graph expansion
      └─► recency × importance              ─┘
```

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

C10 came out of M0 rather than from the original plan: a read-only LadybugDB
handle is frozen at its open point and reports no error when it falls behind.
See [docs/m0-findings.md](docs/m0-findings.md).

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

- **The keyword index is built in memory.** Fine to ~10,000 nodes; at 100,000 it
  takes 8 s to build and 412 ms a query. A persisted index is the first thing to
  add when a store outgrows that.
- **The default embedding threshold is unvalidated for prose.** 384 dimensions
  and a 0.5 cosine cutoff were tuned on source code, not on decision text. This
  needs measuring on a machine that can reach the model hub.
- **Community detection is not summarised.** `memory clusters` returns raw
  communities. Clusters without summarisation are community detection, and are
  named as such.
- **Journaled writes lag.** A write made while another process held the lock is
  recorded but not searchable until `memory merge`. `doctor` reports the backlog.

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
