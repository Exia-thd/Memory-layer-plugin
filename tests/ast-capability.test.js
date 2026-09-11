import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chunk, probeAstChunking, isLanguageAvailable } from '@memory-layer/core';
import { makeRepo, cli, env, CLI, REPO_ROOT } from './helpers.js';

/**
 * R3 -- AST chunking is a declared capability, not a silent fallback.
 *
 * The chunker ran as a character chunker for its whole existence: grammars
 * loaded, parsers never constructed, and a try/catch turned it into slightly
 * worse output with no symptom at all. A test that AST chunking works only
 * covers the machine it runs on; a capability line covers every machine.
 */

const LONG_TS = `import x from 'y';

function alpha() {
${'  // padding padding padding padding padding\n'.repeat(40)}}

function beta() {
${'  // padding padding padding padding padding\n'.repeat(40)}}
`;

test('R3-b: with a working parser, long code is cut on declaration boundaries', async () => {
  const capability = await probeAstChunking();
  assert.equal(capability.status, 'available', capability.reason);
  assert.ok(capability.languages.includes('typescript'));

  const pieces = await chunk('src/example.ts', LONG_TS);
  assert.ok(pieces.length > 1, 'a long file was not split at all');
  assert.ok(
    pieces.some((piece) => piece.mode.startsWith('AST')),
    'every chunk was a character window, so the AST path never ran',
  );
});

test('R3-a: a parser that cannot be built is reported, not absorbed', () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);

    // The capability probe is the thing under test, so the toolchain is switched
    // off at the same seam an actual breakage would appear at.
    const result = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: repo.dir,
      env: { ...env(repo), MEMORY_LAYER_DISABLE_AST: '1' },
      encoding: 'utf8',
    });

    assert.match(result.stdout, /astChunking/, 'doctor does not report AST chunking at all');
    assert.match(
      result.stdout,
      /astChunking\s+(WARN|FAIL)/,
      `a missing AST chunker was reported as healthy:\n${result.stdout}`,
    );
    assert.match(result.stdout, /character windows/i, 'the report does not say what was lost');
  } finally {
    repo.cleanup();
  }
});

test('R3-a2: init records the capability so it can be read back', () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const meta = JSON.parse(fs.readFileSync(path.join(repo.dir, '.memory', 'meta.json'), 'utf8'));
    assert.ok(meta.capabilities.astChunking, 'astChunking is absent from the recorded capabilities');
    assert.equal(meta.capabilities.astChunking.status, 'available');
    assert.ok(meta.capabilities.astChunking.reason, 'a capability was recorded with no reason');
  } finally {
    repo.cleanup();
  }
});

test('R3-c: one unparseable file does not downgrade the capability', async () => {
  // The boundary that matters. A file the parser chokes on is a file-level
  // problem; treating it as a toolchain problem would let one bad input turn
  // off declaration chunking for an entire repository.
  const broken = `function alpha( {{{ ]]] unclosed
${'  garbage garbage garbage garbage garbage\n'.repeat(60)}`;

  const pieces = await chunk('src/broken.ts', broken);
  assert.ok(pieces.length > 0, 'an unparseable file produced nothing at all');

  const after = await probeAstChunking();
  assert.equal(after.status, 'available', 'a single bad file downgraded the whole capability');
});

test('R3-c2: an unparseable file is still ingested and searchable', () => {
  const repo = makeRepo({
    'src/broken.ts': `function alpha( {{{ ]]] unclosed\n${'  // sentinelword garbage\n'.repeat(80)}`,
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);
    const { results } = JSON.parse(cli(repo, ['search', 'sentinelword', '--json']));
    assert.ok(results.length > 0, 'a file the parser rejected was dropped instead of chunked');
  } finally {
    repo.cleanup();
  }
});

test('R3-d: language availability is a predicate, not an exception', async () => {
  assert.equal(await isLanguageAvailable('typescript'), true);
  assert.equal(await isLanguageAvailable('markdown'), false, 'markdown has no grammar and must say so');
  assert.equal(await isLanguageAvailable('klingon'), false, 'an unknown language must answer, not throw');
});

test('R3-e: web-tree-sitter is required in exactly one place', () => {
  // The original bug was two call sites getting different objects from the same
  // require. One loader is what makes that impossible rather than unlikely.
  const root = path.join(REPO_ROOT, 'packages');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (
        entry.name.endsWith('.ts') &&
        // Every way of reaching the module: require(), require.resolve() -- the
        // loader resolves once and evaluates a fresh copy per grammar -- and import.
        /(require(\.resolve)?|import)\s*\(\s*['"]web-tree-sitter['"]\s*\)|from\s+['"]web-tree-sitter['"]/.test(
          fs.readFileSync(full, 'utf8'),
        )
      ) {
        offenders.push(path.basename(full));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, ['languages.ts'], `web-tree-sitter is loaded from ${offenders.join(', ')}`);
});
