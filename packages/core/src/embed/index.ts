import { HashEmbeddingProvider } from './hash-provider.js';
import { TransformersEmbeddingProvider } from './transformers-provider.js';
import type { EmbeddingProvider } from './types.js';
import type { Capability } from '../types.js';
import { log } from '../util/log.js';

export * from './types.js';
export { HashEmbeddingProvider, normalize } from './hash-provider.js';
export { TransformersEmbeddingProvider } from './transformers-provider.js';

export interface ProviderChoice {
  provider: EmbeddingProvider;
  capability: Capability;
}

/**
 * Picks an embedding provider and says, in the returned capability, exactly what
 * was picked and why.
 *
 * Falling back is allowed; falling back quietly is not. A store embedded by the
 * hash fallback is a different vector space from one embedded by the real model,
 * and the capability block is where that becomes visible.
 */
export async function selectProvider(dimensions: number): Promise<ProviderChoice> {
  const requested = (process.env.MEMORY_LAYER_EMBEDDINGS ?? 'auto').toLowerCase();

  if (requested === 'hash') {
    const provider = new HashEmbeddingProvider(dimensions);
    return {
      provider,
      capability: {
        provider: 'hash',
        status: 'degraded',
        model: provider.identity.model,
        dimensions,
        reason:
          'MEMORY_LAYER_EMBEDDINGS=hash: lexical hash features, not a language model. ' +
          'Semantic search will only match wording that overlaps.',
      },
    };
  }

  const local = new TransformersEmbeddingProvider({ dimensions });
  try {
    await local.warmup();
    return {
      provider: local,
      capability: {
        provider: 'local',
        status: 'available',
        model: local.identity.model,
        dimensions,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('warn', 'falling back to the hash embedder', reason);

    if (requested === 'local') {
      // The caller asked for the real model by name; refusing beats silently
      // writing vectors from a different space into their store.
      throw err;
    }

    const provider = new HashEmbeddingProvider(dimensions);
    return {
      provider,
      capability: {
        provider: 'hash',
        status: 'degraded',
        model: provider.identity.model,
        dimensions,
        reason: `Local model unavailable, using the lexical fallback. ${reason}`,
      },
    };
  }
}
