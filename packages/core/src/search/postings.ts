/**
 * Encoding for a term's posting list.
 *
 * One row per term, holding every document that contains it, rather than one row
 * per (term, document) pair. At a hundred thousand nodes the pair form is
 * millions of rows; this form is one row per distinct term, and a query touches
 * only the rows for the terms it actually contains.
 *
 * Each entry carries the document length alongside the term frequency. BM25
 * needs both, and keeping the length here means scoring a query costs exactly
 * one read per query term -- looking lengths up separately meant a second query
 * over a candidate set that, for a common term, is most of the store.
 *
 * The format is deliberately dull -- `id:tf:len` separated by spaces -- because
 * it has to survive being read back by a future version.
 */
export interface PostingEntry {
  tf: number;
  length: number;
}

export type Postings = Map<string, PostingEntry>;

export function encodePostings(postings: Postings): string {
  const parts: string[] = [];
  for (const [id, entry] of postings) parts.push(`${id}:${entry.tf}:${entry.length}`);
  return parts.join(' ');
}

export function decodePostings(encoded: string): Postings {
  const postings: Postings = new Map();
  if (!encoded) return postings;

  for (const part of encoded.split(' ')) {
    if (!part) continue;
    const fields = part.split(':');
    if (fields.length < 3) continue;

    // Ids never contain a colon, but splitting from the right keeps that from
    // being an assumption the format silently depends on.
    const length = Number(fields[fields.length - 1]);
    const tf = Number(fields[fields.length - 2]);
    const id = fields.slice(0, -2).join(':');
    if (!id || !Number.isFinite(tf) || tf <= 0 || !Number.isFinite(length)) continue;

    postings.set(id, { tf, length });
  }
  return postings;
}
