import { createRequire } from 'node:module';
import { normalize } from './hash-provider.js';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingIdentity, type EmbeddingProvider } from './types.js';
import { log } from '../util/log.js';

const require = createRequire(import.meta.url);

export interface TransformersOptions {
  modelId?: string;
  dimensions?: number;
  batchSize?: number;
  device?: string;
}

/**
 * transformers.js running ONNX locally: no API call, no data leaving the machine.
 *
 * The first run downloads the model. Where that download is impossible -- an
 * offline machine, a blocked network -- `warmup` fails with the reason, and the
 * caller falls back rather than the whole ingest dying.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  private readonly batchSize: number;
  private readonly device: string;
  private pipeline: ((texts: string[], options: object) => Promise<{ tolist(): number[][] }>) | null = null;

  constructor(options: TransformersOptions = {}) {
    this.identity = {
      model: options.modelId ?? DEFAULT_EMBEDDING_CONFIG.modelId,
      dimensions: options.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
      provider: 'local',
    };
    this.batchSize = options.batchSize ?? DEFAULT_EMBEDDING_CONFIG.batchSize;
    this.device = options.device ?? DEFAULT_EMBEDDING_CONFIG.device;
  }

  async warmup(): Promise<void> {
    if (this.pipeline) return;

    let transformers: { pipeline: (task: string, model: string, options: object) => Promise<unknown> };
    try {
      transformers = require('@huggingface/transformers');
    } catch (err) {
      throw new Error(
        `@huggingface/transformers is not installed. Install it, or run with ` +
          `MEMORY_LAYER_EMBEDDINGS=hash to use the offline fallback. (${message(err)})`,
      );
    }

    try {
      this.pipeline = (await transformers.pipeline('feature-extraction', this.identity.model, {
        device: this.device,
        dtype: 'q8',
      })) as typeof this.pipeline;
    } catch (err) {
      throw new Error(
        `Could not load embedding model ${this.identity.model}: ${message(err)}. ` +
          `The first run needs to download it; on a machine without that access, ` +
          `set MEMORY_LAYER_EMBEDDINGS=hash.`,
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.warmup();
    if (!this.pipeline) throw new Error('Embedding pipeline unavailable after warmup.');

    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      const output = await this.pipeline(batch, { pooling: 'mean', normalize: true });
      for (const vector of output.tolist()) {
        if (vector.length !== this.identity.dimensions) {
          throw new Error(
            `Model ${this.identity.model} returned ${vector.length} dimensions, ` +
              `but this store is FLOAT[${this.identity.dimensions}]. ` +
              `Width is a schema decision; rebuild the store to change it.`,
          );
        }
        vectors.push(normalize(vector));
      }
      log('debug', `embedded ${Math.min(offset + this.batchSize, texts.length)}/${texts.length}`);
    }
    return vectors;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
