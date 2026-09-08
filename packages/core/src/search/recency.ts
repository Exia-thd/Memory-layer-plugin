import type { MemoryNode } from '../types.js';
import { tokenSet } from '../util/tokenize.js';

export interface RecencyHit {
  id: string;
  score: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Episodic memories fade; semantic ones do not. Fading only demotes -- nothing is deleted. */
export const HALF_LIFE_DAYS: Record<string, number> = {
  episodic: 30,
  procedural: 180,
  artifact: 365,
  semantic: Number.POSITIVE_INFINITY,
};

/**
 * Ranks by importance and freshness, restricted to nodes that actually share a
 * term with the query.
 *
 * The term-set filter is the point: without it this branch would return the
 * newest rows regardless of subject, and a branch that answers every query is
 * a branch that answers none of them.
 */
export function recencySearch(
  nodes: MemoryNode[],
  query: string,
  options: { limit?: number; now?: number } = {},
): RecencyHit[] {
  const limit = options.limit ?? 20;
  const now = options.now ?? Date.now();
  const queryTerms = tokenSet(query);
  if (queryTerms.size === 0) return [];

  const hits: RecencyHit[] = [];

  for (const node of nodes) {
    const nodeTerms = tokenSet(`${node.title} ${node.body}`);
    let overlap = 0;
    for (const term of queryTerms) if (nodeTerms.has(term)) overlap += 1;
    if (overlap === 0) continue;

    const coverage = overlap / queryTerms.size;
    hits.push({
      id: node.id,
      score: coverage * (node.importance || 1) * decayFactor(node, now),
    });
  }

  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export function decayFactor(node: MemoryNode, now = Date.now()): number {
  const halfLife = HALF_LIFE_DAYS[node.layer] ?? 90;
  if (!Number.isFinite(halfLife)) return 1;
  const ageDays = Math.max(0, (now - node.createdAt) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLife);
}
