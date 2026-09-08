/** Memory layer — shared types. */

/** The four memory layers (§4). */
export type Layer = 'semantic' | 'episodic' | 'procedural' | 'artifact';

export const LAYERS: readonly Layer[] = ['semantic', 'episodic', 'procedural', 'artifact'];

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
}

export interface StoreStats {
  nodes: number;
  edges: number;
  embedded: number;
  byLayer: Record<string, number>;
}
