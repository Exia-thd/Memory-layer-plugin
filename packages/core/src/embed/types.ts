/**
 * Vector-space identity.
 *
 * Model alone is not enough: the same model at a different width, or served by a
 * different provider, produces vectors that are not comparable. Recording all
 * three is what lets `doctor` notice a store holding two incompatible spaces --
 * the failure that otherwise degrades search quality with no visible symptom.
 */
export interface EmbeddingIdentity {
  model: string;
  dimensions: number;
  /** 'local', 'hash', or 'http:<sha256 of the cleaned URL>'. Never the URL itself. */
  provider: string;
}

export interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  embed(texts: string[]): Promise<number[][]>;
  /** Resolves when the model is ready, or rejects with a reason a person can act on. */
  warmup(): Promise<void>;
}

/** Values taken from a system already tuned for this workload; confirm, do not re-pick. */
export const DEFAULT_EMBEDDING_CONFIG = {
  // An English-only model measured as actively misleading on Vietnamese prose:
  // it scored "hôm nay trời đẹp quá" at 0.818 similarity against a payment-retry
  // decision, above both genuinely relevant questions (0.749, 0.763). It was
  // ranking by "is this Vietnamese", not by subject, and no threshold separates
  // overlapping distributions. This model keeps 384 dimensions, so the schema is
  // unchanged, and separates the same set with a margin four times wider.
  modelId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  dimensions: 384,
  batchSize: 16,
  subBatchSize: 8,
  threads: 2,
  device: 'auto' as const,
};

/**
 * Cosine distance on normalised vectors lives in [0, 2]. A threshold above the
 * ceiling admits every row and switches the filter off without saying so, which
 * is exactly the class of silent degradation this layer exists to prevent.
 */
/**
 * Cosine distance a semantic hit must stay under.
 *
 * Measured, not inherited. Against a Vietnamese decision and five queries, the
 * multilingual model scores relevant questions at 0.32-0.51 similarity and
 * unrelated ones at -0.13 to 0.13 -- so 0.75 distance (0.25 similarity) sits in
 * the gap with room on both sides. The old 0.5 came from an English-only model
 * and would reject a relevant Vietnamese question outright.
 */
export const DEFAULT_MAX_DISTANCE = 0.75;
export const DEFAULT_MCP_MAX_DISTANCE = 0.8;
export const MAX_DISTANCE_CEILING = 2;

let warnedAboutClamp = false;

export function clampMaxDistance(value: number): number {
  if (value <= MAX_DISTANCE_CEILING) return value;
  if (!warnedAboutClamp) {
    warnedAboutClamp = true;
    process.stderr.write(
      `[memory] max distance ${value} exceeds the cosine ceiling of ${MAX_DISTANCE_CEILING}; ` +
        `clamped, because a higher value would silently disable the filter.\n`,
    );
  }
  return MAX_DISTANCE_CEILING;
}

export function sameIdentity(a: EmbeddingIdentity, b: EmbeddingIdentity): boolean {
  return a.model === b.model && a.dimensions === b.dimensions && a.provider === b.provider;
}

export function identityLabel(identity: EmbeddingIdentity): string {
  return `${identity.model}@${identity.dimensions}/${identity.provider}`;
}
