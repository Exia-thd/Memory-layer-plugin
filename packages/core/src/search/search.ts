import type { Layer, MemoryNode, SearchHit, SearchResult } from '../types.js';
import type { MemoryStore } from '../store/store.js';
import type { EmbeddingProvider } from '../embed/index.js';
import { Bm25Index } from './bm25.js';
import { semanticSearch } from './semantic.js';
import { recencySearch, decayFactor } from './recency.js';
import { fuse, type Branch } from './rrf.js';
import { EXACT_SCAN_LIMIT } from '../store/capabilities.js';
import { DAY_MS } from './recency.js';
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
 * Nodes and the keyword index, cached against the store's write counter.
 *
 * Rebuilding the inverted index on every query costs most of the latency of a
 * search, and in a long-lived MCP server the store usually has not changed
 * between queries. The counter is the same one that tells a read-only handle its
 * snapshot is stale, so the cache cannot outlive a write: if it moved, this is
 * discarded rather than served.
 *
 * A short-lived CLI process gets no benefit from this and pays nothing for it.
 */
interface Snapshot {
  writeSeq: number;
  nodes: MemoryNode[];
  index: Bm25Index;
}

const snapshots = new Map<string, Snapshot>();

function snapshotFor(store: MemoryStore, nodes: MemoryNode[], writeSeq: number): Bm25Index {
  const cached = snapshots.get(store.dir);
  if (cached && cached.writeSeq === writeSeq) return cached.index;

  const index = new Bm25Index();
  index.addAll(nodes.map((node) => ({ id: node.id, text: `${node.title}\n${node.body}` })));
  snapshots.set(store.dir, { writeSeq, nodes, index });
  return index;
}

/** Drops cached indexes. Exposed so a test can prove the cache is not what is being tested. */
export function clearSearchCache(): void {
  snapshots.clear();
}

/**
 * Three branches fused by RRF, with a report of what each one contributed.
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
  const cached = snapshots.get(store.dir);
  const allNodes = cached?.writeSeq === writeSeq ? cached.nodes : await store.allNodes();

  // The keyword index covers the whole store; filtering by layer happens on the
  // way out, so a layer-restricted query cannot poison the cache for other queries.
  const keywordIndex = snapshotFor(store, allNodes, writeSeq);

  const wanted = options.layers && options.layers.length > 0 ? new Set(options.layers) : null;
  const nodes = wanted ? allNodes.filter((node) => wanted.has(node.layer)) : allNodes;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const branches: Branch[] = [];

  branches.push(keywordBranch(keywordIndex, byId, query, limit, options.disableBm25));
  branches.push(await semanticBranch(nodes, query, embedder, limit, options));
  branches.push({
    name: 'recency',
    ranked: recencySearch(nodes, query, { limit: limit * 3, now }).map((hit) => hit.id),
  });

  const { hits, report } = fuse(branches);
  const top = hits.slice(0, limit);

  const results: SearchHit[] = [];
  for (const hit of top) {
    const node = byId.get(hit.id);
    if (!node) continue;
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

function keywordBranch(
  index: Bm25Index,
  eligible: Map<string, MemoryNode>,
  query: string,
  limit: number,
  disabled?: boolean,
): Branch {
  if (disabled) {
    return {
      name: 'bm25',
      ranked: [],
      unavailableReason: 'Keyword branch disabled by caller.',
    };
  }

  // Over-fetch, then drop anything outside the requested layers, so a layer
  // filter narrows the results rather than the search.
  const ranked = index
    .search(query, limit * 6)
    .map((hit) => hit.id)
    .filter((id) => eligible.has(id))
    .slice(0, limit * 3);

  return { name: 'bm25', ranked };
}

async function semanticBranch(
  nodes: MemoryNode[],
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

  const embedded = nodes.filter((node) => node.embedding && node.embeddingModel);
  if (embedded.length === 0) {
    return {
      name: 'semantic',
      ranked: [],
      unavailableReason: 'No node in this store carries an embedding yet. Run `memory embed`.',
    };
  }

  // Vectors from different spaces are not comparable, so only the ones written by
  // the current provider take part -- and the caller is told the rest sat out.
  const identity = embedder.identity;
  const comparable = embedded.filter(
    (node) =>
      node.embeddingModel === identity.model &&
      node.embeddingProvider === identity.provider &&
      node.embedding?.length === identity.dimensions,
  );

  if (comparable.length === 0) {
    return {
      name: 'semantic',
      ranked: [],
      unavailableReason:
        `Every embedding in this store belongs to a different vector space than the ` +
        `active provider (${identity.model}/${identity.provider}). Re-embed to use this branch.`,
    };
  }

  try {
    const [queryVector] = await embedder.embed([query]);
    if (!queryVector) {
      return { name: 'semantic', ranked: [], unavailableReason: 'Embedding the query returned nothing.' };
    }

    const hits = semanticSearch(comparable, queryVector, {
      limit: limit * 3,
      maxDistance: options.maxDistance,
      scanLimit: EXACT_SCAN_LIMIT,
    });

    const branch: Branch = { name: 'semantic', ranked: hits.map((hit) => hit.id) };
    if (comparable.length < embedded.length) {
      branch.unavailableReason =
        `${embedded.length - comparable.length} of ${embedded.length} embedded nodes ` +
        `belong to another vector space and were skipped.`;
    }
    return branch;
  } catch (err) {
    return {
      name: 'semantic',
      ranked: [],
      unavailableReason: `Embedding the query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
