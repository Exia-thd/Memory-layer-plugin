import type { Layer, MemoryNode, SearchHit, SearchResult } from '../types.js';
import { DEFAULT_MAX_DISTANCE } from '../embed/types.js';
import type { MemoryStore, NodeSummary } from '../store/store.js';
import type { EmbeddingProvider } from '../embed/index.js';
import { Bm25Index } from './bm25.js';
import { persistedBm25Search } from './persisted-bm25.js';
import { decayFactor, DAY_MS } from './recency.js';
import { fuse, type Branch } from './rrf.js';
import { clampMaxDistance } from '../embed/types.js';
import { tokenize } from '../util/tokenize.js';
import { readMeta } from '../store/meta.js';

export interface SearchOptions {
  limit?: number;
  /** How many ranked hits to skip. Fusion is deterministic, so pages are stable. */
  offset?: number;
  layers?: Layer[];
  maxDistance?: number;
  /** Marks hits older than this as stale rather than hiding them. */
  staleAfterDays?: number;
  /** Set to disable the keyword branch; used by the test that guards the fusion report. */
  disableBm25?: boolean;
  disableSemantic?: boolean;
  /** Set to skip the graph branch; used by the test that guards the fusion report. */
  disableGraph?: boolean;
  /** Set to skip the entity branch, for the same reason. */
  disableEntity?: boolean;
  now?: number;
}

export const DEFAULT_STALE_AFTER_DAYS = 180;

/**
 * Fallback keyword index, for a store written before the persisted one existed.
 *
 * Kept behind the write counter so it cannot outlive the write that invalidated
 * it. The normal path never builds this at all.
 */
interface Snapshot {
  writeSeq: number;
  index: Bm25Index;
}

const snapshots = new Map<string, Snapshot>();

export function clearSearchCache(): void {
  snapshots.clear();
}

async function fallbackIndex(store: MemoryStore, writeSeq: number): Promise<Bm25Index> {
  const cached = snapshots.get(store.dir);
  if (cached && cached.writeSeq === writeSeq) return cached.index;

  const index = new Bm25Index();
  index.addAll(
    (await store.allNodes()).map((node) => ({ id: node.id, text: `${node.title}\n${node.body}` })),
  );
  snapshots.set(store.dir, { writeSeq, index });
  return index;
}

/**
 * Three branches fused by RRF, with a report of what each one contributed.
 *
 * Each branch narrows the store to candidates before anything is loaded: keyword
 * hits come from posting rows, similarity is ranked inside the database, and
 * only the nodes that survive fusion are read in full. Nothing here reads the
 * whole store, which is what makes the cost scale with the query rather than
 * with how much has been remembered.
 *
 * The report is not diagnostics decoration. Whether a branch was missing changes
 * how much the ranking should be trusted, so it travels with the results where
 * both an agent and a person can see it.
 */
export async function search(
  store: MemoryStore,
  query: string,
  embedder: EmbeddingProvider | null,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = options.limit ?? 10;
  const now = options.now ?? Date.now();
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const writeSeq = readMeta(store.dir).writeSeq;
  const wanted = options.layers && options.layers.length > 0 ? new Set(options.layers) : null;

  const terms = [...new Set(tokenize(query))];
  const postings = terms.length > 0 ? await store.postingsFor(terms) : new Map();

  // Keyword ranking and term-overlap both come from the same posting rows, and
  // both are narrowed to a shortlist before anything is read from the store. A
  // common term can appear in most of the corpus, so fetching a row per
  // candidate would turn a cheap query into a scan of everything.
  const keyword = await keywordHits(store, query, limit, writeSeq, options.disableBm25);
  const overlapRanked = rankByOverlap(postings, terms, limit);

  const shortlist = [...new Set([...keyword.ranked, ...overlapRanked])].slice(0, limit * 12);
  const summaries = await store.nodeSummaries(shortlist);

  const eligible = (id: string): boolean => {
    const summary = summaries.get(id);
    if (!summary) return false;
    if (summary.supersededAt) return false;
    return !wanted || wanted.has(summary.layer);
  };

  const branches: Branch[] = [];
  branches.push({
    name: 'bm25',
    ranked: keyword.ranked.filter(eligible).slice(0, limit * 3),
    ...(keyword.unavailableReason ? { unavailableReason: keyword.unavailableReason } : {}),
    ...(keyword.degradedReason ? { degradedReason: keyword.degradedReason } : {}),
  });
  branches.push(await semanticBranch(store, query, embedder, limit, options));
  branches.push(recencyBranch(overlapRanked, postings, summaries, terms, limit, now, eligible));
  branches.push(await entityBranch(store, terms, limit, options));
  branches.push(await graphBranch(store, branches, limit, wanted, options));

  const { hits, report } = fuse(branches);

  // Fusion is deterministic -- the same query over an unchanged store ranks the
  // same way every time -- so an offset is a real page rather than a reshuffle.
  // Without it, "6 more not shown" was an apology with no way to act on it: the
  // only route to the seventh result was to ask for more of the first six.
  const offset = Math.max(0, options.offset ?? 0);
  const top = hits.slice(offset, offset + limit);

  // Only the winners are loaded in full.
  const nodes = await store.getNodes(top.map((hit) => hit.id));

  const results: SearchHit[] = [];
  for (const hit of top) {
    const node = nodes.get(hit.id);
    if (!node) continue;
    if (wanted && !wanted.has(node.layer)) continue;
    results.push({
      id: node.id,
      title: node.title,
      score: hit.score,
      layer: node.layer,
      sourceRef: node.sourceRef,
      snippet: snippet(node, query),
      createdAt: node.createdAt,
      ranks: hit.ranks,
      stale: now - node.createdAt > staleAfterDays * DAY_MS,
    });
  }

  // What the limit cut. `hits` is what fusion actually found, so the difference
  // is the answer to "was there more" -- a question the caller could not ask
  // before, and therefore never did.
  return {
    results,
    fusion: report,
    total: hits.length,
    omitted: Math.max(0, hits.length - (offset + results.length)),
    offset,
  };
}

async function keywordHits(
  store: MemoryStore,
  query: string,
  limit: number,
  writeSeq: number,
  disabled?: boolean,
): Promise<{ ranked: string[]; unavailableReason?: string; degradedReason?: string }> {
  if (disabled) {
    return { ranked: [], unavailableReason: 'Keyword branch disabled by caller.' };
  }

  // The persisted index is the normal path; rebuilding in memory is the fallback
  // for an older store. Which one answered is reported, because a silent fallback
  // here is the difference between a query and a full scan of everything.
  let hits: { id: string }[] | null = null;
  let degradedReason: string | undefined;

  try {
    hits = await persistedBm25Search(store, query, limit * 6);
    if (hits === null) {
      degradedReason =
        'This store has no persisted keyword index, so it was rebuilt in memory. ' +
        'Run `dai-memory ingest --force` to build one.';
    }
  } catch (err) {
    degradedReason = `Persisted keyword index unreadable, rebuilt in memory: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const ranked = (hits ?? (await fallbackIndex(store, writeSeq)).search(query, limit * 6)).map(
    (hit) => hit.id,
  );

  return degradedReason ? { ranked, degradedReason } : { ranked };
}

/**
 * Orders candidates by how much of the query they cover, using only the posting
 * lists.
 *
 * This runs before anything is read from the store, so the recency branch pays
 * for a shortlist rather than for every document containing a common word.
 */
function rankByOverlap(
  postings: Map<string, Map<string, { tf: number; length: number }>>,
  terms: string[],
  limit: number,
): string[] {
  if (terms.length === 0) return [];

  const overlap = new Map<string, number>();
  for (const list of postings.values()) {
    for (const id of list.keys()) overlap.set(id, (overlap.get(id) ?? 0) + 1);
  }

  return [...overlap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit * 6)
    .map(([id]) => id);
}

async function semanticBranch(
  store: MemoryStore,
  query: string,
  embedder: EmbeddingProvider | null,
  limit: number,
  options: SearchOptions,
): Promise<Branch> {
  if (options.disableSemantic) {
    return { name: 'semantic', ranked: [], unavailableReason: 'Semantic branch disabled by caller.' };
  }
  if (!embedder) {
    return {
      name: 'semantic',
      ranked: [],
      unavailableReason: 'No embedding provider available; nothing can be embedded to compare against.',
    };
  }

  const identity = embedder.identity;
  const total = await store.embeddedCount();
  if (total === 0) {
    return {
      name: 'semantic',
      ranked: [],
      unavailableReason: 'No node in this store carries an embedding yet. Run `dai-memory embed`.',
    };
  }

  // Vectors from different spaces are not comparable, so only the ones written by
  // the active provider take part -- and the caller is told the rest sat out.
  const comparable = await store.embeddedCount(identity.model, identity.provider);
  if (comparable === 0) {
    return {
      name: 'semantic',
      ranked: [],
      unavailableReason:
        `All ${total} embeddings in this store belong to a different vector space than the ` +
        `active provider (${identity.model}/${identity.provider}). Re-embed to use this branch.`,
    };
  }

  try {
    const [queryVector] = await embedder.embed([query]);
    if (!queryVector) {
      return { name: 'semantic', ranked: [], unavailableReason: 'Embedding the query returned nothing.' };
    }

    const maxDistance = clampMaxDistance(options.maxDistance ?? DEFAULT_MAX_DISTANCE);
    const ranked = (
      await store.semanticTopK(queryVector, {
        limit: limit * 3,
        model: identity.model,
        provider: identity.provider,
        layers: options.layers,
      })
    )
      .filter((hit) => 1 - hit.similarity <= maxDistance)
      .map((hit) => hit.id);

    const branch: Branch = { name: 'semantic', ranked };
    if (comparable < total) {
      branch.degradedReason =
        `${total - comparable} of ${total} embedded nodes belong to another vector space ` +
        `and were skipped.`;
    }
    return branch;
  } catch (err) {
    return {
      name: 'semantic',
      ranked: [],
      unavailableReason: `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Ranks candidates by importance and freshness.
 *
 * Candidates come from the posting lists, so this branch only ever sees nodes
 * that share a term with the query. Without that restriction it would return the
 * newest rows regardless of subject, and a branch that answers every query is a
 * branch that answers none of them.
 */
function recencyBranch(
  candidates: string[],
  postings: Map<string, Map<string, { tf: number; length: number }>>,
  summaries: Map<string, NodeSummary>,
  terms: string[],
  limit: number,
  now: number,
  eligible: (id: string) => boolean,
): Branch {
  if (terms.length === 0) {
    return { name: 'recency', ranked: [], unavailableReason: 'The query contains no indexable terms.' };
  }

  const overlap = new Map<string, number>();
  for (const list of postings.values()) {
    for (const id of list.keys()) overlap.set(id, (overlap.get(id) ?? 0) + 1);
  }

  const scored: { id: string; score: number }[] = [];
  for (const id of candidates) {
    if (!eligible(id)) continue;
    const summary = summaries.get(id);
    if (!summary) continue;
    const coverage = (overlap.get(id) ?? 0) / terms.length;
    scored.push({ id, score: coverage * (summary.importance || 1) * decayFactor(summary, now) });
  }

  const ranked = scored
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit * 3)
    .map((hit) => hit.id);

  return { name: 'recency', ranked };
}

/**
 * Memories about a declaration the query names.
 *
 * The signal Mem0 calls entity linking, and the one this store had the data for
 * and was not using: `ABOUT` edges tie a memory to a named declaration, and
 * only `why` consulted them. `dai-memory search "chargeInvoice"` ran three text
 * branches over prose that may never contain the word, while the graph sat
 * there holding the exact answer.
 *
 * A symbol name is a strong signal precisely because it is arbitrary. Ordinary
 * words match many memories weakly; `chargeInvoice` matches one thing, and a
 * memory anchored to it is about that thing rather than merely mentioning it.
 * That is why this is a branch of its own rather than a boost inside another --
 * fusion can then show what it contributed, and a store with no anchors reports
 * a reason instead of quietly ranking the same as before.
 */
async function entityBranch(
  store: MemoryStore,
  terms: string[],
  limit: number,
  options: SearchOptions,
): Promise<Branch> {
  if (options.disableEntity) {
    return {
      name: 'entity',
      ranked: [],
      unavailableReason: 'Skipped: disableEntity was set for this query.',
    };
  }
  if (terms.length === 0) {
    return {
      name: 'entity',
      ranked: [],
      degradedReason: 'The query contains no indexable terms.',
    };
  }

  try {
    const found = await store.nodesAboutSymbolNames(terms, limit * 2);
    return found.length > 0
      ? { name: 'entity', ranked: found.map((node) => node.id) }
      : {
          name: 'entity',
          ranked: [],
          degradedReason:
            'No declaration named in this query carries recorded memory. ' +
            'Anchors come from a source_ref with a line span, or `dai-memory link ... ABOUT`.',
        };
  } catch (err) {
    return {
      name: 'entity',
      ranked: [],
      unavailableReason: `Symbol lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * One hop out from what the other branches found.
 *
 * Until this existed the memory graph was a thing you could query with separate
 * commands and nothing more -- `search.ts` traversed zero edges. Calling that
 * arrangement GraphRAG promised something it did not do: the edges recorded
 * between decisions had no effect on what a search returned.
 *
 * The hop is deliberately one. A decision reached through two or three links is
 * related to the query the way anything in a small graph is related to anything
 * else, and fusion would rank that noise alongside a direct match. One hop says
 * "the thing you found points at this", which is a claim worth making.
 *
 * Direction is ignored on purpose. `A SUPERSEDES B` should surface A when B is
 * found -- the reader needs to know the thing they matched has been replaced,
 * which is the case where a stale answer does the most damage.
 *
 * Seeds come from the branches already computed, so this costs one edge query
 * and no extra ranking. Nodes the other branches already returned are dropped:
 * fusion rewards agreement between branches, and a branch that echoes its own
 * input would inflate exactly the results that needed no help.
 */
async function graphBranch(
  store: MemoryStore,
  branches: Branch[],
  limit: number,
  wanted: Set<Layer> | null,
  options: SearchOptions,
): Promise<Branch> {
  if (options.disableGraph) {
    return {
      name: 'graph',
      ranked: [],
      unavailableReason: 'Skipped: disableGraph was set for this query.',
    };
  }

  // The best few from each branch. Widening the seed set widens the noise, and
  // a neighbour of a poor match is a poor match.
  const seeds = new Set<string>();
  for (const branch of branches) {
    for (const id of branch.ranked.slice(0, Math.max(3, Math.ceil(limit / 2)))) seeds.add(id);
  }
  if (seeds.size === 0) {
    return {
      name: 'graph',
      ranked: [],
      degradedReason: 'No hits to walk from; the other branches matched nothing.',
    };
  }

  let edges;
  try {
    edges = await store.edgesFor([...seeds]);
  } catch (err) {
    // A branch that failed must say so rather than contributing an empty list
    // that reads identically to "walked, and found nothing".
    return {
      name: 'graph',
      ranked: [],
      unavailableReason: `Edge lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (edges.length === 0) {
    return {
      name: 'graph',
      ranked: [],
      degradedReason:
        'Nothing the other branches found is linked to anything. Record links with `dai-memory link`.',
    };
  }

  // Ordered by how many separate seeds reach a neighbour: something two
  // independent hits both point at is a better bet than something one does.
  const reachedBy = new Map<string, number>();
  for (const edge of edges) {
    for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
      if (!seeds.has(from) || seeds.has(to)) continue;
      reachedBy.set(to, (reachedBy.get(to) ?? 0) + 1);
    }
  }
  if (reachedBy.size === 0) {
    return {
      name: 'graph',
      ranked: [],
      degradedReason: 'Every linked neighbour was already found by another branch.',
    };
  }

  // Eligibility has to be re-established here rather than reused.
  //
  // The caller's predicate is closed over summaries fetched for the shortlist,
  // and a graph neighbour is by definition outside it -- it did not match the
  // query, which is the entire reason this branch exists. Reusing that
  // predicate rejected every neighbour and made the branch look like it had run
  // and found nothing.
  const candidates = [...reachedBy.keys()];
  const summaries = await store.nodeSummaries(candidates);
  const ranked = [...reachedBy.entries()]
    .filter(([id]) => {
      const summary = summaries.get(id);
      if (!summary) return false;
      if (summary.supersededAt) return false;
      return !wanted || wanted.has(summary.layer);
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 2)
    .map(([id]) => id);

  return ranked.length > 0
    ? { name: 'graph', ranked }
    : {
        name: 'graph',
        ranked: [],
        degradedReason: 'Every linked neighbour was already found by another branch.',
      };
}

/** A window around the first query term, so the excerpt shows why the hit matched. */
function snippet(node: MemoryNode, query: string, width = 220): string {
  const body = node.body.replace(/\s+/g, ' ').trim();
  if (body.length <= width) return body;

  const firstTerm = query.toLowerCase().split(/\s+/).find((term) => term.length > 2);
  const at = firstTerm ? body.toLowerCase().indexOf(firstTerm) : -1;
  if (at < 0) return `${body.slice(0, width)}...`;

  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? '...' : ''}${body.slice(start, start + width)}...`;
}

export { decayFactor };
