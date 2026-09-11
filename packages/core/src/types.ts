/** Memory layer — shared types. */

/** The four memory layers (§4). */
export type Layer = 'semantic' | 'episodic' | 'procedural' | 'artifact';

export const LAYERS: readonly Layer[] = ['semantic', 'episodic', 'procedural', 'artifact'];

/**
 * What a layer is worth, and therefore what survives.
 *
 * One number doing two jobs, which is the point: the thing worth ranking highly
 * is the thing worth keeping, and holding those as separate settings lets them
 * drift until a store forgets its decisions and keeps its logs.
 *
 * The ordering is the argument. A decision is why the code is shaped as it is
 * and does not expire -- it is superseded by another decision or it stands. A
 * procedure is how something is done here, durable but replaceable. An artifact
 * chunk is derived: ingest rebuilds it from the file, so losing one costs a
 * re-index and nothing else. An episodic note is what happened once, useful for
 * days and clutter after months.
 *
 * `prune` reads this rather than naming one layer, so "forget the cheap things
 * first" is expressed once instead of hardcoded at the call site.
 */
export const LAYER_WEIGHTS: Record<Layer, number> = {
  semantic: 10,
  procedural: 7,
  artifact: 3,
  episodic: 2,
};

/** Edge labels carry real meaning; there is deliberately no `relates_to`. */
export type EdgeType =
  | 'RESOLVES'
  | 'SUPERSEDES'
  | 'CONTRADICTS'
  | 'DERIVED_FROM'
  | 'OCCURRED_IN'
  | 'CONSTRAINS';

export const EDGE_TYPES: readonly EdgeType[] = [
  'RESOLVES',
  'SUPERSEDES',
  'CONTRADICTS',
  'DERIVED_FROM',
  'OCCURRED_IN',
  'CONSTRAINS',
];

export interface MemoryNode {
  /** Stable, derived from content + source_ref. Never random. */
  id: string;
  layer: Layer;
  title: string;
  body: string;
  /** "docs/ARCHITECTURE.md#L40-L58" — a memory you cannot trace back is a memory you cannot check. */
  sourceRef: string;
  /** Optional join point towards a future code graph. Never used for code relations here. */
  filePath?: string | null;
  importance: number;
  confidence: number;
  createdAt: number;
  lastSeenAt: number;
  accessCount: number;
  /** Set when a newer node supersedes this one. Nodes are demoted, never deleted. */
  supersededAt?: number | null;
  /** Vector-space identity, so two embedding spaces can never silently mix. */
  embeddingModel?: string | null;
  embeddingDims?: number | null;
  embeddingProvider?: string | null;
  embedding?: number[] | null;
}

/**
 * A declaration found while chunking, and nothing more.
 *
 * No callers, no imports: the join this exists for is "which decision covers
 * this function", which needs a name and a line range and stops there.
 */
export interface SymbolRow {
  /** `Symbol:<file>:<name>` -- derived, so re-ingest is idempotent. */
  id: string;
  name: string;
  filePath: string;
  /** The grammar's node type, e.g. function_declaration. */
  kind: string;
  startLine: number;
  endLine: number;
}

export interface MemoryEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight: number;
  createdAt: number;
  evidenceRef?: string | null;
}

/** One capability of the storage backend, recorded rather than assumed (§8.6). */
export interface Capability {
  provider: string;
  status: 'available' | 'unavailable' | 'degraded';
  reason?: string;
  [extra: string]: unknown;
}

export interface Capabilities {
  graph: Capability;
  fts: Capability;
  vectorSearch: Capability;
  embeddings: Capability;
  [name: string]: Capability;
}

/** Which retrieval branches actually contributed (C4). */
export interface FusionReport {
  branches: Record<string, number>;
  degraded: string[];
  /** Why each degraded branch was degraded — readable by an agent and by a person. */
  reasons: Record<string, string>;
  k: number;
}

export interface SearchHit {
  id: string;
  title: string;
  score: number;
  layer: Layer;
  sourceRef: string;
  snippet?: string;
  createdAt: number;
  /** Rank contributed by each branch, so a result can be explained. */
  ranks: Record<string, number>;
  /** Set when the hit comes from a project other than the current one. */
  project?: string;
  /** True when the node is older than the staleness threshold. */
  stale?: boolean;
}

export interface SearchResult {
  results: SearchHit[];
  fusion: FusionReport;
  /**
   * How many hits there were before the limit, and how many did not survive it.
   *
   * A limit answers "how much", never "how much was there" -- so a caller shown
   * three of nine had no way to know the six existed. `dai-memory changes` already
   * reported an `omitted` count for exactly this reason; search and why did not,
   * and they are what the hooks call on every file the agent touches. Anything
   * dropped has to leave a mark, or the caller believes it saw everything.
   */
  total?: number;
  omitted?: number;
  /** Where this page started, so the caller can ask for the next one. */
  offset?: number;
}

export interface StoreStats {
  nodes: number;
  edges: number;
  embedded: number;
  byLayer: Record<string, number>;
}
