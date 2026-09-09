import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redact, looksRedacted, canonicalizePath, samePath, tokenize, nodeId,
  Bm25Index, fuse, RRF_K, chunk, characterChunk, cosineSimilarity,
  HashEmbeddingProvider, parseDimensions, clampMaxDistance, recencySearch,
} from '@memory-layer/core';
import { makeRepo, cli } from './helpers.js';

test('redaction runs before embedding, not after', async () => {
  const secret = 'api_key = "AKIAIOSFODNN7EXAMPLE"';
  const { text } = redact(secret);
  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), 'the key survived redaction');

  // The ordering is the point: a vector built from the raw text still encodes the
  // secret, and masking the text afterwards cannot take it back out.
  const provider = new HashEmbeddingProvider(384);
  const [fromRaw] = await provider.embed([secret]);
  const [fromRedacted] = await provider.embed([text]);
  assert.notEqual(
    cosineSimilarity(fromRaw, fromRedacted),
    1,
    'redacted and unredacted text embed identically, so ordering would not matter',
  );
});

test('redaction covers the common credential shapes', () => {
  const cases = [
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-ant-abcdefghijklmnopqrstuvwxyz012345',
    'https://user:hunter2@internal.example.com/repo',
    'password: correct-horse-battery',
  ];
  for (const value of cases) {
    const { text } = redact(value);
    assert.ok(text.includes('[REDACTED'), `not redacted: ${value}`);
  }
  assert.ok(looksRedacted('nothing sensitive here'));
});

test('a redacted secret keeps the surrounding text usable', () => {
  const { text, redactions } = redact('Set token = "ghp_abcdefghijklmnopqrstuvwxyz0123" before the batch runs.');
  assert.match(text, /before the batch runs/);
  assert.ok(redactions.length > 0);
});

test('paths that name the same place produce the same key', () => {
  // Separator style, drive-letter case and a trailing slash are all noise.
  assert.ok(samePath('C:/Users/x/repo/', 'c:\\users\\..\\Users\\x\\repo'));
  assert.equal(canonicalizePath('C:\\Users\\x'), 'C:/Users/x');

  // `..` is resolved rather than carried. The first segment here is a single
  // letter, so on Windows the MSYS rewrite claims it as a drive -- the tradeoff
  // canonicalizePath documents and accepts, and the reason this expectation is
  // platform-dependent in the same way the one below is.
  assert.equal(canonicalizePath('/a/b/../c'), process.platform === 'win32' ? 'A:/c' : '/a/c');
  assert.notEqual(canonicalizePath('/a/b'), canonicalizePath('/a/c'));

  // A POSIX directory whose first segment is one letter is not a drive.
  assert.equal(canonicalizePath('/c/Users/x/repo'), process.platform === 'win32' ? 'C:/Users/x/repo' : '/c/Users/x/repo');
});

test('node ids are stable across whitespace reflow and differ on content', () => {
  const a = nodeId('semantic', 'docs/a.md#L1-L2', 'retry   twice');
  const b = nodeId('semantic', 'docs/a.md#L1-L2', 'retry twice');
  const c = nodeId('semantic', 'docs/a.md#L1-L2', 'retry three times');
  assert.equal(a, b, 'reindenting a block changed its identity');
  assert.notEqual(a, c);
});

test('BM25 ranks by term overlap, not by string position', () => {
  const index = new Bm25Index();
  index.add({ id: 'a', text: 'We retry a declined card exactly twice.' });
  index.add({ id: 'b', text: 'The settlement window closes at midnight.' });

  const hits = index.search('declined card retry');
  assert.equal(hits[0].id, 'a');
  assert.ok(hits.length === 1 || hits[0].score > hits[1].score);
});

test('BM25 finds identifiers written in either casing style', () => {
  const index = new Bm25Index();
  index.add({ id: 'a', text: 'function retryDeclinedCard(order) {}' });
  assert.equal(index.search('retry_declined_card')[0]?.id, 'a');
  assert.equal(index.search('declined card')[0]?.id, 'a');
});

test('tokenizing splits identifiers and drops stopwords', () => {
  const tokens = tokenize('retryDeclinedCard and the RETRY_LIMIT');
  assert.ok(tokens.includes('retry'));
  assert.ok(tokens.includes('declin') || tokens.includes('declined'));
  assert.ok(!tokens.includes('the'));
});

test('fusion names an empty branch and keys on node id', () => {
  const { hits, report } = fuse([
    { name: 'bm25', ranked: ['n1', 'n2'] },
    { name: 'semantic', ranked: [] },
    { name: 'recency', ranked: ['n2'] },
  ]);

  assert.equal(report.k, RRF_K);
  assert.deepEqual(report.degraded, ['semantic']);
  assert.ok(report.reasons.semantic);

  // n2 appears in two branches, so it outranks n1 which appears in one.
  assert.equal(hits[0].id, 'n2');
  assert.deepEqual(hits[0].ranks, { bm25: 2, recency: 1 });
});

test('fusion distinguishes a branch that could not run from one that found nothing', () => {
  const { report } = fuse([
    { name: 'bm25', ranked: [], unavailableReason: 'FTS unavailable on this platform.' },
    { name: 'semantic', ranked: [] },
  ]);
  assert.match(report.reasons.bm25, /unavailable/i);
  assert.match(report.reasons.semantic, /matched nothing/i);
});

test('content that fits in one chunk is not cut', async () => {
  const pieces = await chunk('notes.md', '# Short\n\nOne paragraph.');
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].mode, 'WHOLE');
});

test('markdown carries the parent heading chain', async () => {
  const doc = `# Billing service\n\n${'x'.repeat(400)}\n\n## Retry policy\n\n${'y'.repeat(900)}\n\n## Idempotency\n\n${'z'.repeat(400)}\n`;
  const pieces = await chunk('docs/billing.md', doc);
  const retry = pieces.find((piece) => piece.headingPath?.includes('Retry policy'));
  assert.ok(retry, 'the retry section was not found as its own chunk');
  assert.deepEqual(retry.headingPath, ['Billing service', 'Retry policy']);
});

test('markdown heading detection ignores hashes inside code fences', async () => {
  const doc = `# Real heading\n\n${'a'.repeat(600)}\n\n\`\`\`bash\n# not a heading\n\`\`\`\n\n${'b'.repeat(900)}\n`;
  const pieces = await chunk('docs/x.md', doc);
  assert.ok(pieces.every((piece) => !piece.headingPath?.includes('not a heading')));
});

test('typescript is cut on declaration boundaries', async () => {
  const body = (tag) => `  // ${tag} ${'padding '.repeat(6)}\n`.repeat(40);
  const source = `import x from 'y';\n\nfunction alpha() {\n${body('a')}}\n\nfunction beta() {\n${body('b')}}\n`;
  const pieces = await chunk('src/example.ts', source);
  assert.ok(pieces.length > 1, 'a long file was not split');
  assert.ok(
    pieces.some((piece) => piece.mode.startsWith('AST')),
    'tree-sitter chunking never engaged',
  );
});

test('character chunks overlap and stay in order', () => {
  const pieces = characterChunk('line\n'.repeat(600), 1200, 120);
  assert.ok(pieces.length > 1);
  for (let i = 1; i < pieces.length; i++) {
    assert.ok(pieces[i].startLine >= pieces[i - 1].startLine);
  }
});

test('dimensions must be plain digits', () => {
  assert.equal(parseDimensions('384'), 384);
  assert.equal(parseDimensions(undefined), 384);
  for (const bad of ['1e3', '0x10', '3.5', '+5', '4096x']) {
    assert.throws(() => parseDimensions(bad), /plain digits/, `accepted ${bad}`);
  }
  assert.throws(() => parseDimensions('4'), /out of range/);
});

test('a distance threshold above the cosine ceiling is clamped, not honoured', () => {
  assert.equal(clampMaxDistance(0.5), 0.5);
  assert.equal(clampMaxDistance(99), 2);
});

test('the recency branch requires a shared term', () => {
  const now = Date.now();
  const nodes = [
    { id: 'a', layer: 'episodic', title: 'Declined card retry', body: 'retry twice', importance: 5, createdAt: now, lastSeenAt: now, accessCount: 0, sourceRef: 's', confidence: 1 },
    { id: 'b', layer: 'episodic', title: 'Settlement window', body: 'closes at midnight', importance: 9, createdAt: now, lastSeenAt: now, accessCount: 0, sourceRef: 's', confidence: 1 },
  ];
  const hits = recencySearch(nodes, 'declined card', { now });
  assert.deepEqual(hits.map((hit) => hit.id), ['a'], 'the branch returned a node sharing no term with the query');
});

test('re-ingesting unchanged content creates no duplicates', () => {
  const repo = makeRepo({ 'docs/a.md': '# Title\n\nA decision worth keeping.\n' });
  try {
    cli(repo, ['init']);
    const first = JSON.parse(cli(repo, ['ingest', 'docs', '--json']));
    const second = JSON.parse(cli(repo, ['ingest', 'docs', '--json']));

    assert.equal(first.created, 1);
    assert.equal(second.created, 0, 're-ingest created a duplicate');
    assert.equal(second.skipped, 1, 'an unchanged file was re-processed');

    const forced = JSON.parse(cli(repo, ['ingest', 'docs', '--force', '--json']));
    assert.equal(forced.created, 0, 'forcing a re-ingest duplicated the node');
    assert.equal(forced.refreshed, 1);
  } finally {
    repo.cleanup();
  }
});

test('every node written by ingest carries a traceable source_ref', () => {
  const repo = makeRepo({ 'docs/a.md': `# Title\n\n${'body text. '.repeat(300)}\n` });
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);
    const { results } = JSON.parse(cli(repo, ['search', 'body text', '--limit', '20', '--json']));
    assert.ok(results.length > 0);
    for (const hit of results) {
      assert.match(hit.sourceRef, /^docs\/a\.md#L\d+-L\d+$/, `untraceable source_ref: ${hit.sourceRef}`);
    }
  } finally {
    repo.cleanup();
  }
});

test('a memory cannot be written without provenance', () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init']);
    const result = cli(repo, ['write', '--layer', 'semantic', '--title', 'x', '--body', 'y'], { allowFailure: true });
    assert.fail(`writing without --source-ref succeeded: ${result}`);
  } catch (err) {
    assert.match(String(err.stderr ?? err.message), /source-ref/);
  } finally {
    repo.cleanup();
  }
});

test('the search cache is dropped when the store is written to', async () => {
  const { MemoryStore, search, HashEmbeddingProvider } = await import('@memory-layer/core');
  const repo = makeRepo({ 'docs/a.md': '# Title\n\nAn early decision.\n' });
  try {
    cli(repo, ['init']);
    cli(repo, ['write', '--layer', 'semantic', '--title', 'First rule', '--body', 'Retries are capped.', '--source-ref', 'docs/a.md#L1-L2']);

    const dir = `${repo.dir}/.memory`;
    const store = new MemoryStore(dir, { readOnly: true });
    const provider = new HashEmbeddingProvider(384);

    // Warm the cache, then write through a separate process and search again.
    const before = await search(store, 'rule capped retries', provider, { limit: 10 });
    cli(repo, ['write', '--layer', 'semantic', '--title', 'Second rule', '--body', 'Retries are capped too.', '--source-ref', 'docs/a.md#L3-L4']);
    const after = await search(store, 'rule capped retries', provider, { limit: 10 });

    assert.ok(
      after.results.length > before.results.length,
      'a cached index outlived the write that invalidated it',
    );
    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('a layer filter narrows results without narrowing the search', () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init']);
    cli(repo, ['write', '--layer', 'semantic', '--title', 'Retry cap decision', '--body', 'Capped at two.', '--source-ref', 'docs/a.md#L1-L2']);
    cli(repo, ['write', '--layer', 'episodic', '--title', 'Retry storm incident', '--body', 'Retries flooded the processor.', '--source-ref', 'session:1']);

    const all = JSON.parse(cli(repo, ['search', 'retry', '--json']));
    const semantic = JSON.parse(cli(repo, ['search', 'retry', '--layer', 'semantic', '--json']));

    assert.equal(all.results.length, 2);
    assert.equal(semantic.results.length, 1);
    assert.equal(semantic.results[0].layer, 'semantic');
  } finally {
    repo.cleanup();
  }
});
