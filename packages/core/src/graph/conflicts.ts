import type { MemoryStore } from '../store/store.js';
import type { MemoryNode } from '../types.js';
import { tokenSet } from '../util/tokenize.js';

export interface Conflict {
  a: { id: string; title: string; createdAt: number; sourceRef: string };
  b: { id: string; title: string; createdAt: number; sourceRef: string };
  /** 'declared' when someone recorded the edge, 'suspected' when overlap suggests it. */
  kind: 'declared' | 'suspected';
  overlap?: number;
}

/**
 * Contradictions between recorded decisions.
 *
 * This is the reason a memory layer beats grepping the docs: when a new decision
 * cuts against an old one, someone has to be told. Returning both and letting the
 * reader pick is how the wrong one gets followed.
 */
export async function conflicts(
  store: MemoryStore,
  options: { suspectThreshold?: number } = {},
): Promise<Conflict[]> {
  const threshold = options.suspectThreshold ?? 0.6;
  const nodes = await store.allNodes();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const found: Conflict[] = [];
  const declaredPairs = new Set<string>();

  for (const edge of await store.allEdges()) {
    if (edge.type !== 'CONTRADICTS') continue;
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    declaredPairs.add(pairKey(a.id, b.id));
    found.push({ a: brief(a), b: brief(b), kind: 'declared' });
  }

  // Two live decisions covering the same subject, neither superseding the other,
  // are worth surfacing as a question rather than asserting as a contradiction.
  const semantic = nodes.filter((node) => node.layer === 'semantic' && !node.supersededAt);
  const superseded = new Set(
    (await store.allEdges())
      .filter((edge) => edge.type === 'SUPERSEDES')
      .flatMap((edge) => [pairKey(edge.from, edge.to)]),
  );

  for (let i = 0; i < semantic.length; i++) {
    for (let j = i + 1; j < semantic.length; j++) {
      const a = semantic[i]!;
      const b = semantic[j]!;
      const key = pairKey(a.id, b.id);
      if (declaredPairs.has(key) || superseded.has(key)) continue;

      const overlap = jaccard(tokenSet(a.title), tokenSet(b.title));
      if (overlap < threshold) continue;
      found.push({ a: brief(a), b: brief(b), kind: 'suspected', overlap });
    }
  }

  return found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'declared' ? -1 : 1));
}

function brief(node: MemoryNode): Conflict['a'] {
  return { id: node.id, title: node.title, createdAt: node.createdAt, sourceRef: node.sourceRef };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}
