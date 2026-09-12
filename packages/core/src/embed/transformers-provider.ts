import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { globalDir } from '../util/paths.js';
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
  /** The device actually in use, which may be a downgrade from the requested one. */
  activeDevice: string | null = null;
  private pipeline: ((texts: string[], options: object) => Promise<{ tolist(): number[][] }>) | null = null;

  constructor(options: TransformersOptions = {}) {
    this.identity = {
      model: options.modelId ?? DEFAULT_EMBEDDING_CONFIG.modelId,
      dimensions: options.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
      provider: 'local',
    };
    this.batchSize = options.batchSize ?? DEFAULT_EMBEDDING_CONFIG.batchSize;
    // Named by the caller, then by the environment, then the safe default.
    this.device = options.device
      ?? process.env.MEMORY_LAYER_EMBED_DEVICE?.trim().toLowerCase()
      ?? DEFAULT_EMBEDDING_CONFIG.device;
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

    // Point the model cache somewhere short and stable before the first load.
    //
    // Left alone, transformers.js caches inside its own package directory. Under
    // pnpm that is `node_modules/.pnpm/@huggingface+transformers@x.y.z/node_modules/
    // @huggingface/transformers/.cache/...`, and by the time the model filename is
    // appended the path was 279 characters here -- past Windows' 260-character
    // limit. The write failed, and the loader then reported the only thing it
    // could see: "File doesn't exist". That reads as a blocked network, and was
    // recorded as one for weeks. It was a path length.
    try {
      const env = (transformers as { env?: { cacheDir?: string } }).env;
      if (env) env.cacheDir = modelCacheDir();
    } catch {
      // A future version may not expose env; the default path still works
      // wherever it is short enough.
    }

    // The requested device first, CPU second.
    //
    // The default is now CPU, so this list is usually one entry long. It still
    // matters for anyone who set MEMORY_LAYER_EMBED_DEVICE: a device that does
    // not work is a reason to use another device, not a reason to lose semantic
    // search -- but the downgrade is recorded, never silent, and it is worth
    // knowing that a failed accelerator attempt costs more than the attempt.
    // See the note on DEFAULT_EMBEDDING_CONFIG.device: on this platform the
    // failed DirectML session crashed the process at exit, long after the work
    // had succeeded.
    const devices = this.device === 'cpu' ? ['cpu'] : [this.device, 'cpu'];
    let lastError: unknown = null;

    for (const device of devices) {
      try {
        this.pipeline = (await transformers.pipeline('feature-extraction', this.identity.model, {
          device,
          dtype: 'q8',
        })) as typeof this.pipeline;
        this.activeDevice = device;
        if (device !== this.device) {
          log('warn', `embedding device ${this.device} unavailable, using ${device}`, lastError);
        }
        return;
      } catch (err) {
        lastError = err;
      }
    }

    try {
      throw lastError ?? new Error('no embedding device could be initialised');
    } catch (err) {
      throw new Error(
        `Could not load embedding model ${this.identity.model}: ${message(err)}. ` +
          `The first run downloads it into ${modelCacheDir()}. A "File doesn't exist" ` +
          `here usually means that path is too long for the platform rather than that ` +
          `the download was blocked -- set MEMORY_LAYER_MODEL_CACHE to somewhere shorter. ` +
          `On a machine with no model access at all, set MEMORY_LAYER_EMBEDDINGS=hash.`,
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

/**
 * Where model weights live: short, stable, and outside any package directory.
 *
 * Outside, because a cache inside `node_modules` is deleted on every reinstall
 * and re-downloaded for no reason. Short, because the platform has a limit and
 * exceeding it fails as a missing file rather than as a path error.
 */
export function modelCacheDir(): string {
  const configured = process.env.MEMORY_LAYER_MODEL_CACHE?.trim();
  if (configured) return nodePath.resolve(configured);
  return nodePath.join(globalDir(), 'models');
}
