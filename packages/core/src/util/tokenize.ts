/**
 * Tokenizer shared by indexing and querying.
 *
 * Both sides must use the same function: an index built one way and queried
 * another is the substring-matching failure (C5) wearing a different hat.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their',
  'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were', 'will', 'with',
]);

/**
 * Splits identifiers as well as prose: `retryDeclinedCard` and `retry_declined_card`
 * both yield ["retry", "declined", "card"], and the compound is kept too so an exact
 * identifier query still scores.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const rawTokens = text.match(/[A-Za-z0-9_]+/g) ?? [];

  for (const raw of rawTokens) {
    const lower = raw.toLowerCase();
    const parts = splitIdentifier(raw);
    if (parts.length > 1) out.push(lower);
    for (const part of parts) {
      if (part.length < 2) continue;
      if (STOPWORDS.has(part)) continue;
      out.push(stem(part));
    }
  }
  return out;
}

function splitIdentifier(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Deliberately light suffix stripping, not a full Porter stemmer.
 *
 * It exists so "retries"/"retry" and "declined"/"declines" meet in the middle.
 * Aggressive stemming costs more precision than it buys on this corpus.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('ss')) return w;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

/** Unique tokens, for set-based filters that must not use substring matching. */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}
