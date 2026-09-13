import fs from 'node:fs';
import nodePath from 'node:path';
import { globalDir } from '../util/paths.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';

/**
 * Whether the embedding model is required, and whether it is on disk.
 *
 * Kept free of anything heavy on purpose. The hook runs on every Read, Grep and
 * Glob, and the launcher runs before the MCP server starts; both need to answer
 * "is the model here" without loading onnxruntime to find out. So this module
 * reads the environment and stats four files, and nothing more.
 */

/**
 * The model is required. The lexical hash embedder exists for the test suite
 * and nothing else.
 *
 * It used to be a fallback anyone could select, and before that it was what
 * happened automatically when the model could not be had. A store built from it
 * answers every question with something, just worse, in a way that looks
 * exactly like working -- until a project's whole history sits in a vector
 * space that cannot be compared with the real one. There is no deployment in
 * which that is the better outcome than an error, so there is no longer a
 * switch for it outside a test run.
 *
 * `hash` is honoured only alongside MEMORY_LAYER_TEST=1, which the suite sets
 * and nothing else should. `auto` is refused by name rather than quietly read
 * as something else: somebody who set it expects a fallback, and must find out
 * that they are no longer getting one.
 */
export function embeddingMode(env: NodeJS.ProcessEnv = process.env): 'local' | 'hash' {
  const requested = (env.MEMORY_LAYER_EMBEDDINGS ?? '').trim().toLowerCase();

  if (requested === 'hash') {
    if (env.MEMORY_LAYER_TEST === '1') return 'hash';
    throw new Error(
      'MEMORY_LAYER_EMBEDDINGS=hash is for the test suite only. The embedding model is ' +
      'required: a store built from hashed token features cannot be compared with one ' +
      'built by the model, and nothing reports the difference in the search results. ' +
      'Unset MEMORY_LAYER_EMBEDDINGS and run `node bin/setup.mjs` to download the model.',
    );
  }

  if (requested === 'auto') {
    throw new Error(
      'MEMORY_LAYER_EMBEDDINGS=auto is no longer supported: it fell back to a lexical ' +
      'embedder when the model was missing, and that fallback has been removed. ' +
      'Unset MEMORY_LAYER_EMBEDDINGS and run `node bin/setup.mjs` to download the model.',
    );
  }

  return 'local';
}

/** Where model weights live: short, stable, and outside any package directory. */
export function modelCacheDir(): string {
  const configured = process.env.MEMORY_LAYER_MODEL_CACHE?.trim();
  if (configured) return nodePath.resolve(configured);
  return nodePath.join(globalDir(), 'models');
}

/**
 * The quantisation the provider loads. The file names below follow from it, so
 * they are defined together: change one without the other and the presence
 * check would pass on files the loader never reads.
 */
export const MODEL_DTYPE = 'q8';

const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/**
 * Model files that are absent or empty, relative to the cache.
 *
 * Presence, not validity: a truncated weights file passes here and fails when it
 * is loaded, which is still a loud failure. What this catches cheaply is the
 * common case -- the model was never downloaded on this machine.
 */
export function missingModelFiles(modelId: string = DEFAULT_EMBEDDING_CONFIG.modelId): string[] {
  const root = nodePath.join(modelCacheDir(), ...modelId.split('/'));
  return MODEL_FILES.filter((file) => {
    try {
      return fs.statSync(nodePath.join(root, file)).size === 0;
    } catch {
      return true;
    }
  });
}

/** Whether this process can embed right now, and in words, why not. */
export function embeddingReadiness(env: NodeJS.ProcessEnv = process.env): {
  ready: boolean;
  problem: string | null;
} {
  let mode: 'local' | 'hash';
  try {
    mode = embeddingMode(env);
  } catch (err) {
    return { ready: false, problem: err instanceof Error ? err.message : String(err) };
  }
  if (mode === 'hash') return { ready: true, problem: null };

  const missing = missingModelFiles();
  if (missing.length === 0) return { ready: true, problem: null };
  return {
    ready: false,
    problem:
      `The embedding model is not downloaded: ${missing.join(', ')} missing under ` +
      `${nodePath.join(modelCacheDir(), ...DEFAULT_EMBEDDING_CONFIG.modelId.split('/'))}. ` +
      'Run `node bin/setup.mjs` with network access.',
  };
}
