import type { MemoryNode } from '../types.js';
import { DEFAULT_MAX_DISTANCE } from '../embed/types.js';
import { clampMaxDistance } from '../embed/types.js';

export interface SemanticHit {
  id: string;
  score: number;
  distance: number;
}

/**
 * Exact cosine scan.
 *
 * There is no vector index on the platforms measured, so this walks the
 * candidates. The scan is bounded, and the bound is applied *after* filtering by
 * distance -- so the cut is by relevance, not by whichever rows happened to come
 * back first.
 */
export function semanticSearch(
  nodes: MemoryNode[],
  queryVector: number[],
  options: { limit?: number; maxDistance?: number; scanLimit?: number } = {},
): SemanticHit[] {
  const limit = options.limit ?? 20;
  const maxDistance = clampMaxDistance(options.maxDistance ?? DEFAULT_MAX_DISTANCE);
  const scanLimit = options.scanLimit ?? 10_000;

  const hits: SemanticHit[] = [];
  let scanned = 0;

  for (const node of nodes) {
    if (scanned >= scanLimit) break;
    if (!node.embedding || node.embedding.length !== queryVector.length) continue;
    scanned += 1;

    const similarity = cosineSimilarity(node.embedding, queryVector);
    const distance = 1 - similarity;
    if (distance > maxDistance) continue;
    hits.push({ id: node.id, score: similarity, distance });
  }

  return hits.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, limit);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
