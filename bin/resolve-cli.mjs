/**
 * Whether the plugin is installed -- all of it -- and what to say when it is not.
 *
 * Installing this as a Claude plugin copies the repository and nothing else: no
 * dependency install, no TypeScript build, no model. Each of those used to be
 * discovered late and quietly. A missing build meant the MCP server never
 * registered and the hooks failed open with nothing said. A missing model meant
 * a store embedded by a lexical fallback, answering every question a little
 * worse than it should, with nothing in the results to say why.
 *
 * Installed now means all three, and every entry point asks the same question
 * through this one file so that they cannot drift apart or word it differently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(PLUGIN_ROOT, 'packages', 'cli', 'dist', 'cli.js');
const MODEL_CACHE_MODULE = path.join(PLUGIN_ROOT, 'packages', 'core', 'dist', 'embed', 'model-cache.js');

/** Built means the compiled entry point exists; nothing else is worth guessing about. */
export function isBuilt() {
  return fs.existsSync(CLI_PATH);
}

/**
 * Everything that must be in place, checked in the order setup puts it there.
 *
 * The model check is read from the built core rather than restated here, so
 * there is one definition of which files make a model present. That module is
 * deliberately light -- it stats files and reads the environment -- because the
 * hook asks this on every Read, Grep and Glob.
 */
export async function readiness() {
  if (!isBuilt()) {
    return { ready: false, missing: 'build', problem: 'dai-memory is installed but not built yet.' };
  }

  let embedding;
  try {
    const { embeddingReadiness } = await import(pathToFileURL(MODEL_CACHE_MODULE).href);
    embedding = embeddingReadiness();
  } catch (err) {
    return {
      ready: false,
      missing: 'build',
      problem: `dai-memory's build is incomplete (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  if (!embedding.ready) {
    return { ready: false, missing: 'model', problem: embedding.problem };
  }
  return { ready: true, missing: null, problem: null };
}

/**
 * Said the same way everywhere, and it names one command.
 *
 * "Install dependencies with pnpm, then build, then fetch the model, and enable
 * corepack first if you do not have pnpm" is four things to get right. The
 * setup script is the one thing, and re-running it finishes whatever is left.
 */
export function setupMessage(state) {
  return [
    state?.problem ?? 'dai-memory is not fully installed.',
    '',
    'A plugin install copies the repository. It does not install dependencies,',
    'compile TypeScript or download the embedding model, and the plugin does not',
    'run without all three. One command does them, and stops with a reason if any',
    'of them fails:',
    '',
    `    node "${path.join(PLUGIN_ROOT, 'bin', 'setup.mjs')}"`,
    '',
    'It needs network access (dependencies, and about 130 MB of model). Re-running',
    'it finishes whatever is left. Then restart Claude Code so the MCP server starts.',
  ].join('\n');
}
