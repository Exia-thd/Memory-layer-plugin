import { createRequire } from 'node:module';
import { normalize } from './hash-provider.js';
import { MODEL_DTYPE, missingModelFiles, modelCacheDir } from './model-cache.js';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingIdentity, type EmbeddingProvider } from './types.js';
import { log } from '../util/log.js';

const require = createRequire(import.meta.url);

export interface TransformersOptions {
  modelId?: string;
  dimensions?: number;
  batchSize?: number;
  device?: string;
  /**
   * Whether this load may fetch the model. Only setup and `init` pass true;
   * everything else requires it on disk already. See `selectProvider`.
   */
  allowDownload?: boolean;
}

/**
 * transformers.js running ONNX locally: no API call, no data leaving the machine.
 *
 * The model is downloaded by setup (or by `init` on a new machine) and read from
 * disk by everything else. Where it is not there, `warmup` fails with the reason
 * and the command that fixes it. Nothing falls back.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  private readonly batchSize: number;
  private readonly device: string;
  private readonly allowDownload: boolean;
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
    this.allowDownload = options.allowDownload ?? false;
  }

  async warmup(): Promise<void> {
    if (this.pipeline) return;

    // Checked before transformers is touched. Left to the loader, a missing model
    // is a download -- 130 MB, mid-search, or a hang on a machine with no network
    // -- and a missing file it cannot fetch surfaces as a message about paths.
    if (!this.allowDownload) {
      const missing = missingModelFiles(this.identity.model);
      if (missing.length > 0) {
        throw new Error(
          `The embedding model ${this.identity.model} is not downloaded ` +
            `(${missing.join(', ')} missing under ${modelCacheDir()}). ` +
            'Run `node bin/setup.mjs` with network access; nothing else downloads it.',
        );
      }
    }

    let transformers: { pipeline: (task: string, model: string, options: object) => Promise<unknown> };
    try {
      transformers = require('@huggingface/transformers');
    } catch (err) {
      throw new Error(
        `@huggingface/transformers is not installed, so the plugin's dependencies are ` +
          `incomplete. Run \`node bin/setup.mjs --force\`. (${message(err)})`,
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
      const env = (transformers as { env?: { cacheDir?: string; allowRemoteModels?: boolean } }).env;
      if (env) {
        env.cacheDir = modelCacheDir();
        // The presence check above is the real gate; this is the second lock,
        // for a file that exists but is not the one the loader asks for.
        env.allowRemoteModels = this.allowDownload;
      }
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
          dtype: MODEL_DTYPE,
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
          `It is cached in ${modelCacheDir()}. A "File doesn't exist" here usually means ` +
          `that path is too long for the platform rather than that the download was ` +
          `blocked -- set MEMORY_LAYER_MODEL_CACHE to somewhere shorter, then run ` +
          `\`node bin/setup.mjs\` again.`,
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
