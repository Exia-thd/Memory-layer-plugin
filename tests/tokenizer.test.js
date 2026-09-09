/**
 * The tokenizer decides what the keyword branch can ever find.
 *
 * Its first version matched `[A-Za-z0-9_]+`, which erased most of a Vietnamese
 * corpus without reporting anything: "lỗi", "từ" and "lần" produced no tokens
 * at all, and "thẻ", "theo" and "thanh" all collapsed to "th". These tests pin
 * the properties that failure violated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tokenize, fold, TOKENIZER_VERSION, PLUGIN_DIR_NAME } from '@memory-layer/core';
import { makeRepo, cli, cliRaw } from './helpers.js';

test('an accented word survives tokenization', () => {
  // Each of these produced nothing, or a meaningless fragment, under v1.
  for (const word of ['lỗi', 'từ', 'lần', 'quyết', 'định', 'thẻ', 'đường']) {
    const tokens = tokenize(word);
    assert.ok(tokens.length > 0, `"${word}" produced no tokens`);
    assert.ok(
      tokens.every((token) => token.length >= 2),
      `"${word}" produced a fragment: ${JSON.stringify(tokens)}`,
    );
  }
});

test('an unaccented query reaches accented text', () => {
  // How people actually search their own notes.
  assert.deepEqual(tokenize('quyet dinh'), tokenize('quyết định'));
  assert.deepEqual(tokenize('loi thanh toan'), tokenize('lỗi thanh toán'));
});

test('distinct words stay distinct', () => {
  // Under v1 all four of these became "th".
  const words = ['thẻ', 'theo', 'thanh', 'thứ'];
  const seen = words.map((word) => tokenize(word).join('|'));
  assert.equal(new Set(seen).size, words.length, `collided: ${JSON.stringify(seen)}`);
});

test('English rules do not reach folded words from other languages', () => {
  // "thẻ" folds to "the", which is an English article. Applying the stopword
  // list after folding would delete a Vietnamese noun.
  assert.deepEqual(tokenize('thẻ'), ['the']);
  assert.deepEqual(tokenize('the'), []);
  // Stemming is likewise English-only; a folded syllable is left alone.
  assert.deepEqual(tokenize('retries'), tokenize('retry'));
});

test('CJK is split into bigrams rather than one long token', () => {
  assert.deepEqual(tokenize('記憶層'), ['記憶', '憶層']);
  assert.deepEqual(tokenize('層'), ['層']);
});

test('folding leaves ASCII untouched', () => {
  assert.equal(fold('retryDeclinedCard'), 'retryDeclinedCard');
  assert.equal(fold('quyết'), 'quyet');
  assert.equal(fold('đường'), 'duong');
});

test('search finds a Vietnamese decision by an unaccented query', async () => {
  const repo = makeRepo({
    'docs/adr.md': [
      '# Thanh toán',
      '',
      '## Chính sách retry',
      '',
      'Quyết định: worker chỉ thử lại thẻ bị từ chối hai lần, cách nhau 30 giây.',
      'Lần thử thứ ba đã bị bỏ vì cổng thanh toán tính nó thành một lượt mới.',
    ].join('\n'),
  });
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs/adr.md']);

    const accented = JSON.parse(cli(repo, ['search', 'quyết định retry thẻ', '--json']));
    assert.ok(accented.results.length > 0, 'accented query found nothing');

    const plain = JSON.parse(cli(repo, ['search', 'quyet dinh retry the', '--json']));
    assert.ok(plain.results.length > 0, 'unaccented query found nothing');
  } finally {
    repo.cleanup();
  }
});

test('doctor fails when the postings were built by another tokenizer', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n\nQuyết định một.\n' });
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs/a.md']);

    const clean = JSON.parse(cli(repo, ['doctor', '--json']));
    const before = clean.checks.find((check) => check.name === 'tokenizer version');
    assert.equal(before.status, 'ok', before.detail);

    // Rewind the recorded version: the postings are now from an older stream.
    const metaPath = path.join(repo.dir, PLUGIN_DIR_NAME, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.tokenizerVersion = TOKENIZER_VERSION - 1;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const staleRun = cliRaw(repo, ['doctor', '--json']);
    const stale = JSON.parse(staleRun.stdout);
    const after = stale.checks.find((check) => check.name === 'tokenizer version');
    assert.equal(after.status, 'fail', `expected a failure, got: ${after.detail}`);
    assert.match(after.detail, /ingest --force/);
  } finally {
    repo.cleanup();
  }
});
