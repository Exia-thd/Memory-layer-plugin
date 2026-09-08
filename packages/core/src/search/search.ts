import type { Layer, MemoryNode, SearchHit, SearchResult } from '../types.js';
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
  layers?: Layer[];
  maxDistance?: number;
  /** Marks hits older than this as stale rather than hiding them. */
  staleAfterDays?: number;
  /** Set to disable the keyword branch; used by the test that guards the fusion report. */
  disableBm25?: boolean;
  disableSemantic?: boolean;
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

  const { hits, report } = fuse(branches);
  const top = hits.slice(0, limit);

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

  return { results, fusion: report };
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
        'Run `memory ingest --force` to build one.';
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
      unavailableReason: 'No node in this store carries an embedding yet. Run `memory embed`.',
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

    const maxDistance = clampMaxDistance(options.maxDistance ?? 0.5);
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
