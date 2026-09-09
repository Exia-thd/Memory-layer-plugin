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
  /** Every member, so a summary can be anchored to the set rather than the id. */
  memberIds: string[];
  /**
   * A summary somebody wrote for this group, if one exists.
   *
   * Community ids come out of Louvain and change between runs, so a summary is
   * never stored against an id. It is stored as an ordinary memory linked to
   * the members it came from, and rediscovered here by that link.
   */
  summary?: { id: string; title: string; body: string; covers: number };
}

/**
 * Community detection over the memory graph, plus any summary already written.
 *
 * Detection itself stays raw: nothing here writes a summary, and nothing calls
 * an LLM. What it does is find a summary a person or an agent wrote earlier and
 * linked to the members, so the group can answer a broad question without a
 * generation step hiding inside a read path.
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
    const memberIds = members.map((node) => node.id);
    result.push({
      id,
      size: members.length,
      representatives: ranked.slice(0, 5).map((node) => ({
        id: node.id,
        title: node.title,
        layer: node.layer,
      })),
      terms: commonTerms(members),
      memberIds,
      summary: findSummary(nodes, edges, memberIds),
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


/**
 * A memory that derives from at least two members of this group.
 *
 * Two rather than one: a note derived from a single memory is a comment on that
 * memory, not a summary of the group around it.
 */
function findSummary(
  nodes: MemoryNode[],
  edges: { from: string; to: string; type: string }[],
  memberIds: string[],
): Cluster['summary'] {
  const members = new Set(memberIds);
  const coverage = new Map<string, number>();
  for (const edge of edges) {
    if (edge.type !== 'DERIVED_FROM') continue;
    if (!members.has(edge.to) || edge.from === edge.to) continue;
    // The summary is usually inside the group it summarises: linking it to every
    // member is exactly what makes the community detector put it there. Excluding
    // members as authors therefore excluded every real summary.
    coverage.set(edge.from, (coverage.get(edge.from) ?? 0) + 1);
  }

  let best: { id: string; covers: number } | null = null;
  for (const [id, covers] of coverage) {
    if (covers < 2) continue;
    if (!best || covers > best.covers) best = { id, covers };
  }
  if (!best) return undefined;

  const node = nodes.find((candidate) => candidate.id === best.id);
  if (!node) return undefined;
  return { id: node.id, title: node.title, body: node.body, covers: best.covers };
}
