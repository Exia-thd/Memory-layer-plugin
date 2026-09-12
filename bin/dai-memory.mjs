#!/usr/bin/env node
/**
 * The entry point everything outside this repository names.
 *
 * `.mcp.json` and the hooks used to point straight at `packages/cli/dist/cli.js`.
 * That path is correct on a machine where somebody has already run a build, and
 * missing on every machine where they have not -- which includes every fresh
 * plugin install. Going through here means a missing build is reported as a
 * missing build, in the one place a person reads when a tool does not appear:
 * the MCP server's own stderr.
 *
 * When the build is there this costs one stat call and an import. The CLI is
 * imported rather than spawned, so there is no second process and no second
 * Node startup -- `process.argv` already holds the arguments it reads.
 */
import { pathToFileURL } from 'node:url';
import { CLI_PATH, isBuilt, setupMessage } from './resolve-cli.mjs';

if (!isBuilt()) {
  process.stderr.write(`${setupMessage()}\n`);
  process.exit(1);
}

await import(pathToFileURL(CLI_PATH).href);
