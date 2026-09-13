import { HashEmbeddingProvider } from './hash-provider.js';
import { TransformersEmbeddingProvider } from './transformers-provider.js';
import { embeddingMode } from './model-cache.js';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingIdentity, type EmbeddingProvider } from './types.js';
import type { Capability } from '../types.js';

export * from './types.js';
export { HashEmbeddingProvider, normalize } from './hash-provider.js';
export { TransformersEmbeddingProvider } from './transformers-provider.js';
export {
  embeddingMode, embeddingReadiness, missingModelFiles, modelCacheDir, MODEL_DTYPE,
} from './model-cache.js';

export interface ProviderChoice {
  provider: EmbeddingProvider;
  capability: Capability;
}

/**
 * The embedding model, or an error that says why there is none.
 *
 * There is no fallback. There used to be two -- an automatic one, and later a
 * selectable one -- and both produced a store that answers every question with
 * something, in a vector space that cannot be compared with the model's, with
 * nothing in the results to say so. The hash embedder remains only for the test
 * suite; see `embeddingMode`.
 *
 * `allowDownload` separates the two moments that may fetch the model -- setup,
 * and `init` on a new machine -- from everything else. A search that discovers
 * the model is missing and quietly spends a minute downloading 130 MB is not a
 * search, and on a machine without network it is a hang that looks like one.
 * Everywhere else, a missing model is an error naming the command that fixes it.
 */
export async function selectProvider(
  dimensions: number,
  options: { allowDownload?: boolean } = {},
): Promise<ProviderChoice> {
  if (embeddingMode() === 'hash') {
    const provider = new HashEmbeddingProvider(dimensions);
    return {
      provider,
      capability: {
        provider: 'hash',
        status: 'degraded',
        model: provider.identity.model,
        dimensions,
        reason: 'MEMORY_LAYER_TEST=1: lexical hash features for the test suite, not a language model.',
      },
    };
  }

  const local = new TransformersEmbeddingProvider({
    dimensions,
    allowDownload: options.allowDownload ?? false,
  });
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
}

/**
 * The vector space this process would embed into, without loading anything.
 *
 * For reports. `doctor` compares it against the store to find drift, and it has
 * to keep working on exactly the machines where the model is missing -- those
 * are the machines somebody runs `doctor` on. Null when the environment itself
 * is refused.
 */
export function expectedIdentity(dimensions: number): EmbeddingIdentity | null {
  try {
    return embeddingMode() === 'hash'
      ? new HashEmbeddingProvider(dimensions).identity
      : { model: DEFAULT_EMBEDDING_CONFIG.modelId, dimensions, provider: 'local' };
  } catch {
    return null;
  }
}
