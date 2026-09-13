/**
 * An updated plugin must not run the previous version.
 *
 * "Built" used to mean the compiled CLI existed. Updating the plugin replaces the
 * sources and leaves `dist/` where it was, so that test kept passing: the plugin
 * reported itself installed, setup skipped the rebuild because the file it looked
 * for was there, and every command ran last version's code without a word.
 *
 * These run against a small plugin root of their own, with a stand-in CLI that
 * announces itself, so "it ran" and "it refused" are both directly visible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './helpers.js';

const RAN = 'STAND-IN CLI RAN';

/** The entry points, a few sources, and a build of those sources, stamped. */
async function builtPluginRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memstamp-'));
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(root, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'hooks'), path.join(root, 'hooks'), { recursive: true });

  const put = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  put('package.json', '{"name":"stand-in","type":"module"}\n');
  put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  put('packages/core/src/search.ts', 'export const rank = 1;\n');
  put('packages/cli/src/cli.ts', 'export const version = 1;\n');
  put('packages/cli/dist/cli.js', `process.stdout.write(${JSON.stringify(RAN)} + '\\n');\n`);

  const { writeStamp } = await import(pathToFileURL(path.join(root, 'bin', 'build-stamp.mjs')).href);
  writeStamp(root);
  return root;
}

function launch(root, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'bin', 'dai-memory.mjs'), ...args], {
    encoding: 'utf8',
  });
}

test('a current build runs', async () => {
  const root = await builtPluginRoot();
  try {
    const result = launch(root, '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(RAN), result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changed sources make the build refuse, and say it is out of date', async () => {
  const root = await builtPluginRoot();
  try {
    // What a plugin update does: new code, the old dist/ left in place.
    fs.writeFileSync(path.join(root, 'packages', 'core', 'src', 'search.ts'), 'export const rank = 2;\n');

    const result = launch(root, '--help');
    assert.notEqual(result.status, 0, 'the previous version ran after the code changed');
    assert.doesNotMatch(result.stdout, new RegExp(RAN), 'the stale CLI was executed');
    assert.match(result.stderr, /out of date/, result.stderr);
    assert.match(result.stderr, /setup\.mjs/, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a changed lockfile counts, even when no source moved', async () => {
  // Different dependencies are a different program. An update that only bumps
  // a package must rebuild as surely as one that edits a line.
  const root = await builtPluginRoot();
  try {
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# bumped\n');
    const result = launch(root, '--help');
    assert.notEqual(result.status, 0, 'a dependency change did not invalidate the build');
    assert.match(result.stderr, /out of date/, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('touching a file without changing it does not force a rebuild', async () => {
  // A checkout or a copy moves modification times constantly. The cheap stat
  // check notices; the content hash behind it must then clear it.
  const root = await builtPluginRoot();
  try {
    const file = path.join(root, 'packages', 'cli', 'src', 'cli.ts');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);

    const result = launch(root, '--help');
    assert.equal(result.status, 0, `an untouched build was called stale:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(RAN));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a build with no stamp is not trusted', async () => {
  // Built before stamps existed, or by something other than the build script:
  // nothing records what it was built from, so nothing vouches for it.
  const root = await builtPluginRoot();
  try {
    fs.rmSync(path.join(root, 'packages', 'cli', 'dist', '.build-stamp.json'));
    const result = launch(root, '--help');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /out of date/, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session start says the build is out of date', async () => {
  const root = await builtPluginRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memproj-'));
  try {
    fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'cli.ts'), 'export const version = 2;\n');
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'hooks', 'memory-hook.mjs'), 'session-start'],
      { input: JSON.stringify({ cwd }), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /out of date/, result.stdout);
    assert.match(context, /setup\.mjs/, result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the real build is stamped by the build script itself', () => {
  // Not by setup alone. A developer running `pnpm build` must produce a build
  // the launcher accepts, or the gate turns into a reason to bypass it.
  const stamp = path.join(REPO_ROOT, 'packages', 'cli', 'dist', '.build-stamp.json');
  assert.ok(fs.existsSync(stamp), 'pnpm build left no stamp');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /build-stamp\.mjs/, pkg.scripts.build);
});
