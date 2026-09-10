/**
 * Tokenizer shared by indexing and querying.
 *
 * Both sides must use the same function: an index built one way and queried
 * another is the substring-matching failure (C5) wearing a different hat.
 *
 * The first version matched `[A-Za-z0-9_]+`, which is ASCII-only. On a corpus
 * written in Vietnamese that is not a degradation, it is destruction:
 * "quyết" became "quy", "định" became "nh", and "lỗi", "từ" and "lần"
 * disappeared entirely -- three of them words this system exists to store.
 * Worse, the surviving fragments collide: "thẻ", "theo", "thanh" and "thứ" all
 * reduce to "th", so recall drops *and* precision drops together.
 *
 * So: Unicode letters, folded to their unaccented form, with CJK cut into
 * bigrams because those scripts do not separate words with spaces.
 */

/** Bump when the token stream changes shape. Postings built under an older
 *  value cannot be queried with a newer one -- `doctor` reports the mismatch
 *  rather than letting a half-matching index look healthy. */
export const TOKENIZER_VERSION = 3;

/** Scripts this tokenizer claims to handle, for the capability line. */
export const TOKENIZER_SCRIPTS = [
  'latin', 'latin-diacritics-dual', 'cyrillic', 'greek', 'cjk-bigram',
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their',
  'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were', 'will', 'with',
]);

// Deliberately no Vietnamese stopword list. BM25's IDF already discounts "của"
// and "là" for appearing everywhere, and a hand-written list would eventually
// swallow "không" -- a negation that flips the meaning of a constraint.

/** Han, Hiragana, Katakana, Hangul: no spaces between words, so bigram them. */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

/**
 * Strip accents so an unaccented query still finds accented text: someone
 * typing "quyet dinh" must reach "quyết định", because that is how people
 * actually search their own notes.
 *
 * NFD splits a base letter from its combining marks, which handles most of
 * Latin. Vietnamese "đ" is its own letter and does not decompose, so it is
 * mapped by hand; the same is true of a handful of northern-European letters.
 */
const HAND_FOLDED: Record<string, string> = {
  đ: 'd', Đ: 'd', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ß: 'ss', ł: 'l', Ł: 'l', ð: 'd', Ð: 'd', þ: 'th', Þ: 'th',
};

export function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    out += HAND_FOLDED[ch] ?? ch;
  }
  return out.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
}

/**
 * Splits identifiers as well as prose: `retryDeclinedCard` and `retry_declined_card`
 * both yield ["retry", "declined", "card"], and the compound is kept too so an exact
 * identifier query still scores.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const rawTokens = text.match(/[\p{L}\p{N}_]+/gu) ?? [];

  for (const raw of rawTokens) {
    if (CJK.test(raw)) {
      out.push(...cjkBigrams(raw));
      continue;
    }

    const english = isAscii(raw);
    const folded = fold(raw);
    const parts = splitIdentifier(folded);
    if (parts.length > 1) out.push(folded.toLowerCase());

    // English rules -- the stopword list and the suffix stripper -- only apply
    // to a word that was ASCII before folding. Folding moves other languages
    // into English's space and they collide there: Vietnamese "thẻ" (card)
    // folds to "the" and would be dropped as an article.
    for (const part of parts) {
      if (part.length < 2) continue;
      if (english && STOPWORDS.has(part)) continue;
      out.push(english ? stem(part) : part);
    }

    // Both forms, for a word that carries marks.
    //
    // Folding alone merges words that Vietnamese keeps apart: "bò" (beef),
    // "bỏ" (drop) and "bó" (bundle) all became "bo", so "phở bò" matched a
    // document that said "đã bị bỏ". Dropping the fold instead would mean an
    // unaccented query stops finding accented text, and people do type without
    // accents.
    //
    // Emitting both leaves the marked form to carry the meaning and the folded
    // form to carry the reach. It does not stop "bò" matching "bỏ" -- they still
    // share "bo" -- it makes the document that also matches "bỏ" score on two
    // terms where the other scores on one, and IDF discounts the shared form
    // because it appears everywhere. Ranking separates them; no extra rule does.
    if (!english) {
      const marked = raw.toLowerCase();
      if (marked.length >= 2 && marked !== folded.toLowerCase()) out.push(marked);
    }
  }
  return out;
}

/**
 * A run of CJK becomes overlapping character pairs: 記憶層 -> 記憶, 憶層.
 * Standard practice for CJK without a dictionary segmenter, and it keeps the
 * index and the query agreeing, which is the property that matters here.
 * A single character is kept whole so a one-character query still finds it.
 */
function cjkBigrams(run: string): string[] {
  const chars = [...run];
  if (chars.length === 0) return [];
  if (chars.length === 1) return [run];
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  return out;
}

function isAscii(token: string): boolean {
  return /^[\x00-\x7f]*$/.test(token);
}

function splitIdentifier(token: string): string[] {
  return token
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
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
