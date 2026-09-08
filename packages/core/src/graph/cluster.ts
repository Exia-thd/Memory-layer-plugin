import { createRequire } from 'node:module';
import type { MemoryStore } from '../store/store.js';
import type { MemoryNode } from '../types.js';

const require = createRequire(import.meta.url);

// Both packages are CommonJS with a default export, which NodeNext will not let
// TypeScript call directly; requiring them keeps the call sites honest.
const Graph = require('graphology') as new (options: object) => GraphologyGraph;
const louvain = require('graphology-communities-louvain') as (
  graph: GraphologyGraph,
  options: object,
) => Record<string, number>;

interface GraphologyGraph {
  order: number;
  addNode(id: string): void;
  hasNode(id: string): boolean;
  hasEdge(a: string, b: string): boolean;
  addEdge(a: string, b: string, attributes: object): void;
}

export interface Cluster {
  id: number;
  size: number;
  /** Highest-importance members first; these stand in for the cluster. */
  representatives: { id: string; title: string; layer: string }[];
  /** Terms that occur across the cluster, as a rough label. */
  terms: string[];
}

/**
 * Community detection over the memory graph.
 *
 * Clusters are computed and returned raw. There is no summarisation step, so this
 * is community detection and is named as such -- calling it GraphRAG without the
 * summarisation stage would be claiming a capability that is not here.
 */
export async function clusters(store: MemoryStore, options: { minSize?: number } = {}): Promise<Cluster[]> {
  const minSize = options.minSize ?? 2;
  const nodes = await store.allNodes();
  const edges = await store.allEdges();

  const graph = new Graph({ type: 'undirected', multi: false });
  for (const node of nodes) graph.addNode(node.id);
  for (const edge of edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) continue;
    graph.addEdge(edge.from, edge.to, { weight: edge.weight || 1 });
  }

  if (graph.order === 0) return [];

  const assignment = louvain(graph, { getEdgeWeight: 'weight' }) as Record<string, number>;
  const byCommunity = new Map<number, MemoryNode[]>();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const [id, community] of Object.entries(assignment)) {
    const node = byId.get(id);
    if (!node) continue;
    const list = byCommunity.get(community);
    if (list) list.push(node);
    else byCommunity.set(community, [node]);
  }

  const result: Cluster[] = [];
  for (const [id, members] of byCommunity) {
    if (members.length < minSize) continue;
    const ranked = [...members].sort((a, b) => b.importance - a.importance);
    result.push({
      id,
      size: members.length,
      representatives: ranked.slice(0, 5).map((node) => ({
        id: node.id,
        title: node.title,
        layer: node.layer,
      })),
      terms: commonTerms(members),
    });
  }

  return result.sort((a, b) => b.size - a.size);
}

function commonTerms(nodes: MemoryNode[], count = 6): string[] {
  const frequency = new Map<string, number>();
  for (const node of nodes) {
    const seen = new Set(
      node.title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    );
    for (const word of seen) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  return [...frequency.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word);
}
