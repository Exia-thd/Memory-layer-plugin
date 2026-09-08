# M0 findings

Measured on Linux x64, Node v22.22.2, `@ladybugdb/core@0.20.3`, in the container
this repository was built in. Every number below came from running the code, not
from a datasheet. Where a question could not be answered here, that is stated
rather than estimated.

---

## 1. Storage backend: what LadybugDB actually provides

```
LOAD fts     -> Binder exception: Extension: fts is an official extension and has not been installed.
LOAD vector  -> Binder exception: Extension: vector is an official extension and has not been installed.
LOAD json    -> Binder exception: Extension: json is an official extension and has not been installed.
```

No official extension loads on this platform, and there is no network path to
install one in a sandboxed environment. So:

- **Keyword search must be self-hosted.** There is no FTS to lean on.
- **There is no vector index.** Semantic search is an exact scan.

One thing works better than expected. `array_cosine_similarity` is a **built-in
function, not part of the vector extension**, and it returns correct results:

```
CREATE NODE TABLE T(id STRING, v FLOAT[4], PRIMARY KEY(id))    -> ok
array_cosine_similarity(t.v, CAST([1.0,0,0,0] AS FLOAT[4]))    -> 1
```

So vectors are stored as `FLOAT[dims]` columns in the same store as the nodes and
edges, and cosine similarity is available in-database if the scan ever needs to
move there. Graph, text and vectors live in one store; there is no second store
and therefore no step between writing and reading (C1).

**Decision:** LadybugDB for graph and storage. BM25 written in-process. Semantic
search by exact scan, bounded at 10,000 vectors, filtered by distance *before*
the bound is applied so the cut is by relevance rather than by row order.

---

## 2. Concurrency: the measurement that changed the design

The plan treated concurrent access as a risk to be managed with a lease or a
lock probe. The measurement showed something better.

### Two writers

```
process A (read-write): WROTE ok
process B (read-write): FAILED: IO exception: Could not set lock on file
```

A second writer **fails fast and cleanly**. It does not corrupt, and it does not
hang. Fail-fast is an outcome that can be handled.

### A reader blocking a writer

```
holder (read-write handle, only ran a MATCH query): holds the lock for 4s
writer C during that window: FAILED: Could not set lock on file
```

A handle opened read-write takes the exclusive lock **even when it only reads**.
This is the trap: a long-lived server that has run a single query blocks every
write for as long as it lives.

### The read-only flag

`new Database(path, bufferSize, compression, readOnly)` — the fourth argument.

```
read-only holder open, writer D runs:          D WROTE ok
two read-only holders concurrently:            both ok
```

`readOnly: true` takes a **shared** lock. Readers coexist with each other and
with a writer.

**Decision:** every read path opens read-only; only writes take a read-write
handle. That one flag removes the entire cross-platform process-probing problem
the reference architecture needed — readers simply never hold the lock that
would block a writer.

### The cost, and the guard

A read-only handle is not merely cheap, it is **frozen**:

```
read-only handle opens, sees:       100 nodes
writer commits 50 more
same handle, queried again:         100 nodes     <- no error, no warning
a freshly opened handle:            150 nodes
```

A long-lived reader serves the snapshot it saw at open time, forever, silently.
This is a new failure class, not in the original plan, and it is exactly the kind
this layer exists to prevent — so it gets a constraint of its own:

> **C10 — A reader must never serve a snapshot from before the last write.**

The implementation: `meta.json` carries a `writeSeq` counter, bumped on every
commit. A read-only handle compares it before serving and reopens when it moved.
Guarded by a test.

The same counter keys the in-process search cache, so a cached index cannot
outlive the write that invalidated it either.

### Writes that cannot take the lock

Session hooks write while other sessions may be writing. Rather than probe for
the lock, a write that hits `StoreLockedError` appends to a per-session
journal, and `memory merge` folds it in later. The caller is **told** it was
queued — a memory that is recorded but not yet searchable is a different
outcome from one that is live, and the difference matters to whoever wrote it.
`memory doctor` reports the pending count so the lag is never invisible.

---

## 3. Keyword search: how fast is a hand-written BM25

Inverted index, `k1=1.2`, `b=0.75`, shared tokenizer for indexing and querying.

| Nodes | Index build | Query (p50) | Heap |
|---|---|---|---|
| 10,000 | 750 ms | 20 ms | 82 MB |
| 100,000 | 8,131 ms | 412 ms | 660 MB |

End-to-end, through the real CLI, on a store of **1,040 nodes**:

| Operation | Cold process | Warm (cached index) |
|---|---|---|
| `search` | ~800 ms | ~100 ms |
| `why` | ~700 ms | — |
| re-`ingest`, all unchanged | 379 ms | — |

**What this means, stated plainly.** The index is built in memory from the store
on first use. That is fine up to roughly 10,000 nodes and comfortable at the
1,000–2,000 a project memory realistically holds. At 100,000 nodes it is not
good enough: 8 seconds to build and 412 ms a query.

The cache keyed on `writeSeq` makes the long-lived MCP server pay the build cost
once rather than per query, which is where it matters. A short-lived CLI
invocation still pays it every time.

**Not solved here:** a persisted inverted index. When a store grows past ~10,000
nodes this is the first thing that needs to change. It is a known limit, not an
oversight.

---

## 4. Embeddings: what could and could not be measured

`Snowflake/snowflake-arctic-embed-xs` at 384 dimensions was adopted as the
default. **It could not be benchmarked here**, and the reason is worth recording:

```
huggingface.co:443 -> CONNECT tunnel failed, 403 (network policy denial)
```

The model hub is unreachable from this environment, so no ONNX model could be
downloaded. Three consequences, all of which improved the design:

1. **The embedding provider is an interface, not a hard dependency.** The
   transformers.js provider is an `optionalDependency`.
2. **There is an offline fallback**, `HashEmbeddingProvider`: deterministic
   hashed token features, 384 dimensions. It captures lexical overlap and
   nothing deeper, and it says so — it reports `provider: 'hash'` and
   `status: 'degraded'`, so a store embedded this way can never be mistaken for
   one embedded properly. It embeds 1,000 chunks in **158 ms**.
3. **The test suite needs no network and no model download.**

Exact-scan cosine, 10,000 vectors at 384 dimensions: **11 ms per query**. The
scan is not the bottleneck; building the keyword index is.

**Still open, and it is the honest gap:** whether 384 dimensions and a 0.5 cosine
distance threshold suit *decision prose* rather than source code. The reference
values were tuned on code. Answering this needs the real model, so it needs a
machine that can reach the model hub. Until then the threshold is clamped at the
cosine ceiling of 2 with a one-time warning, because a threshold above the
ceiling admits every row and switches the filter off without saying so.

---

## 5. Vector space identity

Recorded per node as `{model, dimensions, provider}`. Search compares only
vectors from the active space and **reports how many it skipped**; `doctor`
fails loudly when a store holds more than one space. Width is fixed at `init`
and baked into the DDL as `FLOAT[dims]`; changing it means rebuilding.

The dimension parser accepts plain digits only. `1e3`, `0x10`, `3.5`, `+5` and
`4096x` are all rejected, because a value that reads as one width at DDL time and
another at runtime produces a store that disagrees with its own embedder.

---

## 6. A silent failure found while building

Worth recording because it is precisely the class of bug this design is aimed at.

The tree-sitter integration appeared to work: grammars loaded, no errors, chunks
came out with sensible line ranges. But **every chunk was a character window** —
the AST branch never engaged. `require('web-tree-sitter')` returns the parser
class before `init()` and a *different object without the constructor* after it,
so the second call site could load grammars but never build a parser. The
`try/catch` fallback to character chunking then hid it completely.

Nothing failed. Chunk quality was simply worse than designed, permanently, with
no symptom. It was caught by a test asserting that AST chunking actually engages
— not by anything watching for errors.

Fixed by requiring the module exactly once behind a cached accessor. The lesson
is the one behind C4: **a fallback that does not announce itself is
indistinguishable from a feature that works.**

---

## Gate

| Question | Answer |
|---|---|
| Can LadybugDB do BM25? | No. Written in-process. 20 ms/query at 10k, 412 ms at 100k. |
| Is there a vector index? | No. Exact scan, 11 ms at 10k × 384. |
| How long does embedding take? | Fallback: 158 ms / 1,000 chunks. Real model: **unmeasured**, hub unreachable. |
| What happens with two writers? | Second fails fast. Readers are shared-lock and never block writers. Frozen-snapshot hazard found and guarded (C10). |

Three of four have numbers. The fourth is blocked by the environment, not by the
design, and is the first thing to run on a machine with model-hub access.
