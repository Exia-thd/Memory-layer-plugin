#!/usr/bin/env node
/**
 * Turns a copied repository into a working plugin: dependencies, a build, and
 * the embedding model -- all three, or a failure that says which one is missing.
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
import { PLUGIN_ROOT, CLI_PATH, buildState } from './resolve-cli.mjs';

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
//
// "Already built" means built from this code. An updated plugin has new sources
// and the old `dist/`, and skipping the build there left it running the previous
// version under a line that said it was installed.
const before = buildState();
const rebuild = !before.ready || process.argv.includes('--force');

if (rebuild) {
  if (before.missing === 'rebuild') process.stdout.write(`${before.problem}\n\n`);
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
  const after = buildState();
  if (!after.ready) {
    process.stderr.write(
      `\nThe build reported success but is not usable: ${after.problem ?? CLI_PATH}\n`,
    );
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

let core;
try {
  core = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'packages', 'core', 'dist', 'index.js')).href);
} catch (err) {
  // Built output without the dependencies it imports: node_modules was removed
  // or never finished. The build step is skipped when output exists, so say how
  // to force it rather than letting the stack trace be the message.
  process.stderr.write(
    `\nThe build is present but cannot load (${err instanceof Error ? err.message : String(err)}).\n` +
    'Run this script again with --force to reinstall dependencies and rebuild.\n',
  );
  process.exit(1);
}

try {
  const choice = await core.selectProvider(core.parseDimensions(process.env.MEMORY_LAYER_DIMS), {
    allowDownload: true,
  });
  // Loaded is not the same as on disk. Every later command reads the model from
  // the cache without downloading, so the files themselves are the thing that
  // has to be true before this can report success.
  const missing = core.missingModelFiles();
  if (missing.length > 0) {
    throw new Error(
      `The model loaded, but ${missing.join(', ')} did not reach ${core.modelCacheDir()}, ` +
      'so no later command could read it. Check that directory is writable, or set ' +
      'MEMORY_LAYER_MODEL_CACHE to one that is.',
    );
  }
  const { model, provider } = choice.provider.identity;
  process.stdout.write(`    ${provider}: ${model}\n    cached in ${core.modelCacheDir()}\n`);
} catch (err) {
  process.stderr.write(
    `\n${err instanceof Error ? err.message : String(err)}\n\n` +
    'Setup stopped. Dependencies and the build are in place, but the plugin does not\n' +
    'run without the embedding model, so the setup does not report success.\n' +
    'Re-run this script with network access; it picks up from here.\n',
  );
  process.exit(1);
}

process.stdout.write(
  '\nReady. Restart Claude Code so the MCP server starts, then run `init` in a project:\n' +
  `    node "${path.join(PLUGIN_ROOT, 'bin', 'dai-memory.mjs')}" init\n`,
);
