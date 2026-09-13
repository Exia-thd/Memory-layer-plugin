#!/usr/bin/env node
/**
 * The entry point everything outside this repository names.
 *
 * `.mcp.json` and the hooks used to point straight at `packages/cli/dist/cli.js`.
 * That path is correct on a machine where somebody has already run a build, and
 * missing on every machine where they have not -- which includes every fresh
 * plugin install. Going through here means an incomplete install is reported as
 * one, in the place a person reads when a tool does not appear: the MCP server's
 * own stderr.
 *
 * The MCP server requires everything, model included: it is how an agent uses
 * the plugin, and an agent cannot act on a half-installed one. Other commands
 * require a current build -- not merely an existing one -- so that `doctor` and
 * `--help` still run on the machine where the model is missing, and each command
 * that needs the model refuses on its own, with the same instruction.
 *
 * When everything is in place this costs a few stat calls and an import. The CLI
 * is imported rather than spawned, so there is no second Node startup --
 * `process.argv` already holds the arguments it reads.
 */
import { pathToFileURL } from 'node:url';
import { CLI_PATH, buildState, readiness, setupMessage } from './resolve-cli.mjs';

const command = process.argv[2];

if (command === 'serve') {
  const state = await readiness();
  if (!state.ready) {
    process.stderr.write(`${setupMessage(state)}\n`);
    process.exit(1);
  }
} else {
  // A stale build refuses too, and not only for the server: every command it
  // runs is the previous version's, and none of them would say so.
  const state = buildState();
  if (!state.ready) {
    process.stderr.write(`${setupMessage(state)}\n`);
    process.exit(1);
  }
}

await import(pathToFileURL(CLI_PATH).href);
