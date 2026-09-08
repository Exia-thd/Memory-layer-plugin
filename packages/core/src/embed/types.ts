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
  modelId: 'Snowflake/snowflake-arctic-embed-xs',
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
export const DEFAULT_MAX_DISTANCE = 0.5;
export const DEFAULT_MCP_MAX_DISTANCE = 0.6;
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
