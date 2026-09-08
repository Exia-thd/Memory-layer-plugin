import type { EdgeType, MemoryEdge, MemoryNode } from '../types.js';
import type { MemoryStore } from '../store/store.js';

export interface TraverseOptions {
  depth?: number;
  edgeTypes?: EdgeType[];
  /** Both directions by default: asking from the error must reach the decision that fixed it. */
  direction?: 'both' | 'out' | 'in';
  limit?: number;
}

export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 4;
/** Each hop away counts for less, so a distant neighbour cannot outrank an adjacent one. */
export const HOP_DECAY = 0.5;

export interface NeighborNode {
  node: MemoryNode;
  hops: number;
  score: number;
  /** How this node was reached, for an answer that can be explained. */
  via: { from: string; type: EdgeType; direction: 'out' | 'in' }[];
}

export interface Subgraph {
  root: MemoryNode;
  neighbors: NeighborNode[];
  edges: MemoryEdge[];
  depth: number;
}

/**
 * Breadth-first walk out from a node.
 *
 * `depth` genuinely controls how far this goes; there is a test asserting that
 * depth 1 and depth 2 return different things, because a parameter that is
 * parsed and then ignored is worse than one that was never offered.
 */
export async function neighbors(
  store: MemoryStore,
  id: string,
  options: TraverseOptions = {},
): Promise<Subgraph> {
  const requestedDepth = options.depth ?? DEFAULT_DEPTH;
  if (requestedDepth < 1) throw new Error(`depth must be at least 1, got ${requestedDepth}`);
  const depth = Math.min(requestedDepth, MAX_DEPTH);

  const direction = options.direction ?? 'both';
  const wantedTypes = options.edgeTypes && options.edgeTypes.length > 0
    ? new Set<EdgeType>(options.edgeTypes)
    : null;

  const root = await store.getNode(id);
  if (!root) throw new Error(`No such memory node: ${id}`);

  const allEdges = await store.allEdges();
  const relevant = wantedTypes ? allEdges.filter((edge) => wantedTypes.has(edge.type)) : allEdges;

  const outgoing = new Map<string, MemoryEdge[]>();
  const incoming = new Map<string, MemoryEdge[]>();
  for (const edge of relevant) {
    push(outgoing, edge.from, edge);
    push(incoming, edge.to, edge);
  }

  const seen = new Map<string, NeighborNode>();
  const usedEdges: MemoryEdge[] = [];
  let frontier = [id];

  for (let hop = 1; hop <= depth; hop++) {
    const next: string[] = [];

    for (const current of frontier) {
      const steps: { edge: MemoryEdge; other: string; dir: 'out' | 'in' }[] = [];

      if (direction === 'both' || direction === 'out') {
        for (const edge of outgoing.get(current) ?? []) {
          steps.push({ edge, other: edge.to, dir: 'out' });
        }
      }
      if (direction === 'both' || direction === 'in') {
        for (const edge of incoming.get(current) ?? []) {
          steps.push({ edge, other: edge.from, dir: 'in' });
        }
      }

      for (const step of steps) {
        if (step.other === id) continue;
        usedEdges.push(step.edge);

        const existing = seen.get(step.other);
        if (existing) {
          existing.via.push({ from: current, type: step.edge.type, direction: step.dir });
          continue;
        }

        const node = await store.getNode(step.other);
        if (!node) continue;

        seen.set(step.other, {
          node,
          hops: hop,
          score: (step.edge.weight || 1) * Math.pow(HOP_DECAY, hop - 1),
          via: [{ from: current, type: step.edge.type, direction: step.dir }],
        });
        next.push(step.other);
      }
    }

    frontier = next;
    if (frontier.length === 0) break;
  }

  const neighborList = [...seen.values()]
    .sort((a, b) => a.hops - b.hops || b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, options.limit ?? 50);

  return { root, neighbors: neighborList, edges: dedupe(usedEdges), depth };
}

function push(map: Map<string, MemoryEdge[]>, key: string, edge: MemoryEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function dedupe(edges: MemoryEdge[]): MemoryEdge[] {
  const seen = new Set<string>();
  const out: MemoryEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.type}|${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}
