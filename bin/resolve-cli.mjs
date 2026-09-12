/**
 * Where the built CLI is, and what to say when it is not there.
 *
 * Installing this as a Claude plugin copies the repository and nothing else:
 * no dependency install, no TypeScript build. So the very first thing every
 * entry point does -- the MCP server, every hook -- is run a file that does not
 * exist yet. Node exits with "Cannot find module", the MCP server never
 * registers, the hooks fail open by design, and the result is a plugin that
 * looks installed and does nothing at all, with no error anywhere the person
 * who installed it will look.
 *
 * One shared answer to "is it built, and if not, what do I run", so that the
 * three places that need it cannot drift apart or word it differently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(PLUGIN_ROOT, 'packages', 'cli', 'dist', 'cli.js');

/** Built means the compiled entry point exists; nothing else is worth guessing about. */
export function isBuilt() {
  return fs.existsSync(CLI_PATH);
}

/**
 * Said the same way everywhere, and it names one command.
 *
 * "Run pnpm install and then pnpm build, from the plugin directory, and if you
 * do not have pnpm enable corepack first" is four things to get right. The
 * setup script is the one thing.
 */
export function setupMessage() {
  return [
    'dai-memory is installed but not built yet.',
    '',
    'A plugin install copies the repository; it does not install dependencies or',
    'compile TypeScript. One command does both:',
    '',
    `    node "${path.join(PLUGIN_ROOT, 'bin', 'setup.mjs')}"`,
    '',
    'It needs network access the first time (dependencies, and the embedding model',
    'on the first `init`). Then restart Claude Code so the MCP server starts.',
  ].join('\n');
}
