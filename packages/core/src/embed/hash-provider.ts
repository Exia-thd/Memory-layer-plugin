import crypto from 'node:crypto';
import { tokenize } from '../util/tokenize.js';
import type { EmbeddingProvider, EmbeddingIdentity } from './types.js';

/**
 * A deterministic embedder built from hashed token features.
 *
 * It is not a language model and does not pretend to be: it captures lexical
 * overlap and nothing deeper. Two things make it worth shipping anyway --
 * the test suite gets a vector branch that needs no network and no model
 * download, and a machine that cannot reach the model hub still gets a working
 * (if shallow) semantic branch instead of a dead one.
 *
 * It reports itself as provider 'hash' so a store embedded this way can never be
 * mistaken for one embedded properly.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;

  constructor(dimensions: number) {
    this.identity = { model: 'hashed-token-features', dimensions, provider: 'hash' };
  }

  async warmup(): Promise<void> {
    // Nothing to load.
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const dims = this.identity.dimensions;
    const vector = new Array<number>(dims).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vector;

    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    for (const [token, count] of counts) {
      const digest = crypto.createHash('sha1').update(token).digest();
      // Two buckets per token, with a sign bit, so unrelated tokens mostly cancel
      // rather than piling up in the same direction.
      for (let i = 0; i < 2; i++) {
        const bucket = digest.readUInt32BE(i * 4) % dims;
        const sign = (digest[8 + i]! & 1) === 0 ? 1 : -1;
        vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count));
      }
    }

    return normalize(vector);
  }
}

export function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}
