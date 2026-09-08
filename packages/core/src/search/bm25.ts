import { tokenize } from '../util/tokenize.js';

/**
 * BM25 over an in-process inverted index.
 *
 * This is written from scratch rather than delegated, because the LadybugDB FTS
 * extension is not installable on the platforms measured (see
 * docs/m0-findings.md) and keyword search is the core of this layer, not a
 * garnish. Leaning on an extension that may be absent would mean shipping a
 * product that loses a third of its value at install time on some machines.
 */
export const K1 = 1.2;
export const B = 0.75;

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
  matchedTerms: string[];
}

export class Bm25Index {
  /** term -> (docId -> term frequency) */
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  private totalLength = 0;

  get size(): number {
    return this.lengths.size;
  }

  add(document: Bm25Document): void {
    const tokens = tokenize(document.text);
    this.lengths.set(document.id, tokens.length);
    this.totalLength += tokens.length;

    for (const token of tokens) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = new Map<string, number>();
        this.postings.set(token, posting);
      }
      posting.set(document.id, (posting.get(document.id) ?? 0) + 1);
    }
  }

  addAll(documents: Iterable<Bm25Document>): void {
    for (const document of documents) this.add(document);
  }

  private get averageLength(): number {
    return this.lengths.size === 0 ? 0 : this.totalLength / this.lengths.size;
  }

  /**
   * Scores documents against the query terms.
   *
   * Terms are matched as terms. A query is never treated as one long substring,
   * which is how "retry declined card" ends up matching a document that contains
   * all three words in a different order.
   */
  search(query: string, limit = 20): Bm25Hit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.lengths.size === 0) return [];

    const documentCount = this.lengths.size;
    const averageLength = this.averageLength;
    const scores = new Map<string, number>();
    const matched = new Map<string, Set<string>>();

    for (const term of new Set(terms)) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const idf = Math.log(1 + (documentCount - posting.size + 0.5) / (posting.size + 0.5));

      for (const [id, frequency] of posting) {
        const length = this.lengths.get(id) ?? 0;
        const denominator = frequency + K1 * (1 - B + (B * length) / (averageLength || 1));
        scores.set(id, (scores.get(id) ?? 0) + (idf * frequency * (K1 + 1)) / denominator);

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
}
