import type { MemoryStore } from '../store/store.js';
import { tokenize } from '../util/tokenize.js';
import { B, K1, type Bm25Hit } from './bm25.js';

/**
 * BM25 against the posting lists held in the store.
 *
 * The in-memory index has to read and tokenise every node before it can answer
 * anything, which is most of the cost of a search and is paid again by every
 * short-lived CLI process. This path reads one row per query term instead, so
 * the work scales with the query rather than with the store.
 *
 * The scoring is the same formula over the same numbers; only where the postings
 * come from differs. A test asserts both paths rank identically, because a
 * change in storage that quietly changes results would be worse than the cost it
 * saves.
 */
export async function persistedBm25Search(
  store: MemoryStore,
  query: string,
  limit: number,
): Promise<Bm25Hit[] | null> {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const { docCount, totalLength } = await store.indexStats();
  // No index rows at all: this store predates the persisted index, or was written
  // by a path that did not build one. Say so, rather than returning no results.
  if (docCount === 0) return null;

  const postings = await store.postingsFor(terms);
  if (postings.size === 0) return [];

  const averageLength = totalLength / docCount || 1;

  const scores = new Map<string, number>();
  const matched = new Map<string, Set<string>>();

  for (const [term, list] of postings) {
    const df = list.size;
    if (df === 0) continue;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));

    for (const [id, entry] of list) {
      const denominator = entry.tf + K1 * (1 - B + (B * entry.length) / averageLength);
      scores.set(id, (scores.get(id) ?? 0) + (idf * entry.tf * (K1 + 1)) / denominator);

      let terms = matched.get(id);
      if (!terms) {
        terms = new Set<string>();
        matched.set(id, terms);
      }
      terms.add(term);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, matchedTerms: [...(matched.get(id) ?? [])] }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
