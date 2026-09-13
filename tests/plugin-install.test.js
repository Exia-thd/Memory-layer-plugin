/**
 * What a fresh plugin install actually gets.
 *
 * Installing a Claude plugin copies the repository. It does not install
 * dependencies and it does not compile TypeScript, and `dist/` is not committed
 * -- so on a newly installed machine the file that `.mcp.json` and every hook
 * used to name is simply absent. The MCP server then fails to start, the tools
 * never appear, and the hooks fail open by design and say nothing. The plugin
 * looks installed and does nothing, with no error anywhere the person who
 * installed it will look.
 *
 * These tests run against a plugin root with no build in it, which is the state
 * that was never exercised: every other test in this suite builds first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { REPO_ROOT } from './helpers.js';

/** A copy of what ships: the entry points, without the build they need. */
function unbuiltPluginRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meminstall-'));
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'hooks'), path.join(dir, 'hooks'), { recursive: true });
  return dir;
}

test('the entry points name files that a fresh install actually has', () => {
  // git decides what ships. A path that is only correct after a build is a path
  // that is wrong on every machine where nobody has run one.
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  for (const entry of ['bin/dai-memory.mjs', 'bin/resolve-cli.mjs', 'bin/setup.mjs', 'hooks/memory-hook.mjs']) {
    assert.ok(tracked.has(entry), `${entry} is not committed, so an install would not get it`);
  }

  const mcp = fs.readFileSync(path.join(REPO_ROOT, '.mcp.json'), 'utf8');
  const hooks = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8');
  for (const [label, text] of [['.mcp.json', mcp], ['hooks.json', hooks]]) {
    assert.ok(
      !text.includes('dist/'),
      `${label} points into dist/, which no install produces`,
    );
  }
});

test('without a build, the launcher says so and names one command to fix it', () => {
  const root = unbuiltPluginRoot();
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'bin', 'dai-memory.mjs'), 'serve'], {
      encoding: 'utf8',
    });

    // Non-zero, so the MCP server is reported as failed rather than as a server
    // with no tools -- those look the same from the tool list and are not.
    assert.notEqual(result.status, 0, 'an unbuilt plugin exited zero, which reads as working');
    const said = `${result.stderr}${result.stdout}`;
    assert.match(said, /not built/i, said);
    assert.match(said, /setup\.mjs/, `the message does not name what to run:\n${said}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session start reports an unbuilt plugin instead of staying silent', () => {
  const root = unbuiltPluginRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memproj-'));
  try {
    // No `.memory` here on purpose: an unbuilt plugin cannot run `init`, so a
    // store never exists. A notice placed after the store check would be
    // unreachable in exactly the case it is written for.
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'hooks', 'memory-hook.mjs'), 'session-start'],
      { input: JSON.stringify({ cwd }), encoding: 'utf8' },
    );

    // Fail open is still the rule: the session must not break.
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const context = payload?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /not built/i, result.stdout);
    assert.match(context, /setup\.mjs/, result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a built plugin passes arguments through to the CLI unchanged', () => {
  // The launcher imports the CLI rather than spawning it, which only works if
  // process.argv still reads the way the CLI expects.
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'bin', 'dai-memory.mjs'), '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ingest/, result.stdout);
});

/**
 * The embedding model is part of the install. There is no fallback.
 *
 * It was once what happened automatically when the model could not be had, and
 * then something anyone could select. Either way the store that came out
 * answered every question with something, in a vector space that cannot be
 * compared with the model's, with nothing in the results to say so. The hash
 * embedder now exists for this suite alone, behind MEMORY_LAYER_TEST=1.
 */
test('the model is required, and the fallback answers only to the test suite', async () => {
  const { embeddingMode } = await import('@memory-layer/core');

  assert.equal(embeddingMode({}), 'local');
  assert.equal(embeddingMode({ MEMORY_LAYER_EMBEDDINGS: 'LOCAL' }), 'local');
  // A value nobody recognises is the strict mode, never a lenient one: a typo in
  // a deployment script must not become a quiet downgrade.
  assert.equal(embeddingMode({ MEMORY_LAYER_EMBEDDINGS: 'hashh' }), 'local');

  assert.equal(embeddingMode({ MEMORY_LAYER_EMBEDDINGS: 'hash', MEMORY_LAYER_TEST: '1' }), 'hash');
  assert.throws(
    () => embeddingMode({ MEMORY_LAYER_EMBEDDINGS: 'hash' }),
    /test suite only/,
    'the lexical fallback is selectable outside a test run',
  );
  // Refused by name. Somebody who set `auto` expects a fallback and has to find
  // out they are no longer getting one, not have it silently mean something else.
  assert.throws(() => embeddingMode({ MEMORY_LAYER_EMBEDDINGS: 'auto' }), /no longer supported/);
});

/** Everything present except the model: a built tree and an empty model cache. */
function withoutModel(extra = {}) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'memnomodel-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memnohome-'));
  const env = { ...process.env, MEMORY_LAYER_MODEL_CACHE: cache, MEMORY_LAYER_HOME: home, ...extra };
  delete env.MEMORY_LAYER_EMBEDDINGS;
  delete env.MEMORY_LAYER_TEST;
  return {
    env,
    cleanup: () => {
      fs.rmSync(cache, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('the MCP server will not start without the model', () => {
  const machine = withoutModel();
  try {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'dai-memory.mjs'), 'serve'], {
      env: machine.env,
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0, 'a server with no model started as if installed');
    assert.match(result.stderr, /not downloaded/, result.stderr);
    assert.match(result.stderr, /setup\.mjs/, result.stderr);
  } finally {
    machine.cleanup();
  }
});

test('session start reports a missing model, not only a missing build', () => {
  const machine = withoutModel();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memproj-'));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'hooks', 'memory-hook.mjs'), 'session-start'],
      { input: JSON.stringify({ cwd }), env: machine.env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout)?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /not downloaded/, result.stdout);
    assert.match(context, /setup\.mjs/, result.stdout);
  } finally {
    machine.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
