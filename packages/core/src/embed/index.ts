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
 * What was asked for, before anything is loaded.
 *
 * The default used to be `auto`, which meant: try the real model, and if it
 * cannot be had, quietly build the store out of hashed token features instead.
 * The capability block recorded the downgrade honestly, and that was treated as
 * enough. It is not. Nobody reads a capability block at install time, and the
 * store that comes out answers every question with something -- just worse, in
 * a way that looks exactly like working. A degraded store is the expensive kind
 * of broken: it is discovered months later, by which time it holds a project's
 * whole history in the wrong vector space.
 *
 * So the default is `local`: get the real model or fail. `auto` still exists
 * for anyone who wants the old behaviour, and `hash` for a machine that will
 * never reach a model hub -- but both are now something a person chose.
 */
export function embeddingMode(env: NodeJS.ProcessEnv = process.env): 'local' | 'auto' | 'hash' {
  const requested = (env.MEMORY_LAYER_EMBEDDINGS ?? 'local').trim().toLowerCase();
  return requested === 'hash' || requested === 'auto' ? requested : 'local';
}

/**
 * Picks an embedding provider and says, in the returned capability, exactly what
 * was picked and why.
 *
 * Falling back happens only where it was asked for, and never quietly. A store
 * embedded by the hash fallback is a different vector space from one embedded
 * by the real model, and the capability block is where that stays visible.
 */
export async function selectProvider(dimensions: number): Promise<ProviderChoice> {
  const requested = embeddingMode();

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

    if (requested === 'local') {
      // The default path. Refusing beats writing vectors from a different space
      // into somebody's store on the strength of a line in a report they will
      // not read until the search results have been disappointing for a month.
      throw err;
    }

    log('warn', 'falling back to the hash embedder', reason);

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
