#!/usr/bin/env node
/**
 * Turns a copied repository into a working plugin: dependencies, then a build.
 *
 * This exists because the install instructions were three commands and a
 * precondition -- enable corepack, install, build, and know that the workspace
 * needs pnpm specifically because `workspace:*` is not a thing npm resolves.
 * Every one of those is a place to stop, and the failure when somebody uses the
 * wrong package manager is an unresolved dependency error that says nothing
 * about package managers.
 *
 * It is also what the "not built yet" message names, so the answer to seeing
 * that message is to copy the line above it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, CLI_PATH, isBuilt } from './resolve-cli.mjs';

/** Pinned, because a workspace resolved by two different pnpm majors is two different trees. */
const PNPM = 'pnpm@9.15.0';

async function run(command, args) {
  return new Promise((resolve) => {
    // shell: true so Windows finds `corepack.cmd`. Every argument here is a
    // constant in this file; nothing from the environment reaches the shell.
    const child = spawn(command, args, {
      cwd: PLUGIN_ROOT,
      stdio: 'inherit',
      shell: true,
    });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/**
 * corepack is part of Node and needs nothing installed; a pnpm already on PATH
 * is the fallback for a Node built without it.
 */
async function pnpm(args) {
  const viaCorepack = await run('corepack', [PNPM, ...args]);
  if (viaCorepack === 0) return 0;
  process.stderr.write(`\ncorepack could not run ${PNPM}; trying pnpm from PATH.\n`);
  return run('pnpm', args);
}

process.stdout.write(`Setting up dai-memory in ${PLUGIN_ROOT}\n\n`);

// Re-running after the model step failed must not skip the model step.
//
// The shortcut used to exit early on "already built", which is exactly the
// state a half-finished setup leaves behind -- so the one command offered to
// finish the job reported success without doing the part that had failed. It
// skips the work already done and goes on to the part that is not.
const rebuild = !isBuilt() || process.argv.includes('--force');

if (rebuild) {
  process.stdout.write('1/3 dependencies\n');
  // Not --frozen-lockfile: this runs on whatever Node and platform the person
  // installed on, and refusing to install because a platform-specific optional
  // dependency moved would fail the setup over something that does not matter.
  const installed = await pnpm(['install']);
  if (installed !== 0) {
    process.stderr.write(
      '\nDependency install failed. It needs network access the first time. ' +
      'Re-run this script once the network is back.\n',
    );
    process.exit(1);
  }

  process.stdout.write('\n2/3 build\n');
  const built = await pnpm(['build']);
  if (built !== 0) {
    process.stderr.write('\nBuild failed. The output above says why.\n');
    process.exit(1);
  }

  // Checked rather than assumed: a build can exit zero and still not produce the
  // file every entry point runs, and finding that out later reads as the plugin
  // being broken rather than as the build being incomplete.
  if (!isBuilt()) {
    process.stderr.write(`\nThe build reported success but ${CLI_PATH} is not there.\n`);
    process.exit(1);
  }
} else {
  process.stdout.write(`1/3 dependencies -- already installed\n\n2/3 build -- already built\n`);
}

/**
 * The model is downloaded here, not on the first `init`, and a failure ends the
 * setup.
 *
 * Deferring it meant the install "succeeded" on a machine that could not reach
 * the model, and the shortfall surfaced later as search results that were
 * merely disappointing -- the hardest kind of broken to attribute. Downloading
 * it while somebody is watching a setup script turns a silent, permanent
 * degradation into one failed command with a reason.
 */
process.stdout.write('\n3/3 embedding model (about 130 MB on the first run)\n');
const { selectProvider, parseDimensions } = await import(
  pathToFileURL(path.join(PLUGIN_ROOT, 'packages', 'core', 'dist', 'index.js')).href
);

try {
  const choice = await selectProvider(parseDimensions(process.env.MEMORY_LAYER_DIMS));
  const { model, provider } = choice.provider.identity;
  process.stdout.write(`    ${provider}: ${model}\n`);
} catch (err) {
  process.stderr.write(
    `\n${err instanceof Error ? err.message : String(err)}\n\n` +
    'Setup stopped. Dependencies and the build are in place, but without the model\n' +
    'this would index a project into a vector space that cannot be compared with\n' +
    'the real one -- so the setup does not report success.\n\n' +
    'Re-run this script with network access. On a machine that will never have it,\n' +
    'MEMORY_LAYER_EMBEDDINGS=hash is the deliberate opt-in to lexical-only search;\n' +
    'set it in the environment the plugin runs in, not just for this command.\n',
  );
  process.exit(1);
}

process.stdout.write(
  '\nReady. Restart Claude Code so the MCP server starts, then run `init` in a project:\n' +
  `    node "${path.join(PLUGIN_ROOT, 'bin', 'dai-memory.mjs')}" init\n`,
);
