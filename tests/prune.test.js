/**
 * Forgetting.
 *
 * Until this existed there was no way to remove anything, so the automatic write
 * path had to stay off: it records an episodic node for every failed command,
 * most of them typos, and decay only lowers their rank. They keep their postings
 * and go on diluting IDF for every real memory around them.
 *
 * The dangerous part is not the deletion, it is deleting *half* of one: a node
 * removed from the table but left in the posting lists gives a keyword index
 * that answers with ids resolving to nothing, and averages computed over
 * documents that are gone. No error, just quietly wrong answers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR_NAME } from '@memory-layer/core';
import { makeRepo, cli, cliRaw } from './helpers.js';

/**
 * Writes a memory.
 *
 * Age is handled by asking for a fractional cutoff rather than by backdating the
 * row: anything written a moment ago is already "older than 0.000001 days", and
 * a test that reaches into the store to rewrite timestamps is testing the test.
 */
function write(repo, { layer, title, body, sourceRef }) {
  return JSON.parse(
    cli(repo, ['write', '--layer', layer, '--title', title, '--body', body,
      '--source-ref', sourceRef, '--json']),
  ).id;
}

/** Small enough that everything already written counts as old. */
const ANY_AGE = '0.000001';

test('nothing is pruned when nothing is old enough', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    write(repo, { layer: 'episodic', title: 'Lệnh hỏng', body: 'npm test thất bại.', sourceRef: 'session:2026-09-10' });

    const report = JSON.parse(cli(repo, ['prune', '--json']));
    assert.equal(report.candidates.length, 0, 'a fresh memory was offered for pruning');
    assert.equal(report.removed, 0);
  } finally {
    repo.cleanup();
  }
});

test('a decision is never pruned, however old', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    write(repo, { layer: 'semantic', title: 'Chỉ thử lại hai lần',
      body: 'Chọn thay vì backoff.', sourceRef: 'docs/a.md#L1-L1' });

    // Even at a cutoff that matches everything: the default layer is episodic only.
    const report = JSON.parse(cli(repo, ['prune', '--older-than', ANY_AGE, '--json']));
    assert.equal(report.layer, 'episodic');
    assert.equal(report.candidates.length, 0, 'a decision was offered for pruning');
  } finally {
    repo.cleanup();
  }
});

test('a referenced memory is refused rather than quietly kept', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const error = write(repo, { layer: 'episodic', title: 'Double capture',
      body: 'Khoá dùng lại gây double-capture.', sourceRef: 'session:2026-01-01' });
    const decision = write(repo, { layer: 'semantic', title: 'Khoá theo từng lượt',
      body: 'Sinh khoá từ invoice và attempt.', sourceRef: 'docs/a.md#L1-L1' });
    cli(repo, ['link', decision, error, 'RESOLVES', '--json']);

    // The linked episodic node must not appear as a candidate at any cutoff:
    // something points at it, so it is part of somebody's reasoning.
    const report = JSON.parse(cli(repo, ['prune', '--older-than', ANY_AGE, '--json']));
    assert.ok(
      !report.candidates.some((item) => item.id === error),
      'a memory with an incoming edge was offered for pruning',
    );
  } finally {
    repo.cleanup();
  }
});

test('a dry run removes nothing', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const id = write(repo, { layer: 'episodic', title: 'Lệnh hỏng cũ',
      body: 'Một lỗi cũ.', sourceRef: 'session:2020-01-01' });

    const meta = path.join(repo.dir, PLUGIN_DIR_NAME, 'meta.json');
    assert.ok(fs.existsSync(meta), 'the store is not where the test expects it');

    const preview = JSON.parse(cli(repo, ['prune', '--older-than', ANY_AGE, '--dry-run', '--json']));
    assert.equal(preview.removed, 0, 'a dry run deleted something');

    // Whatever it listed must still be readable afterwards.
    for (const item of preview.candidates) {
      const got = JSON.parse(cli(repo, ['get', item.id, '--json']));
      assert.equal(got.node.id, item.id, 'a dry run removed a node it only previewed');
    }
    assert.doesNotThrow(() => cli(repo, ['get', id, '--json']));
  } finally {
    repo.cleanup();
  }
});

test('a nonsensical cutoff is refused', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const run = cliRaw(repo, ['prune', '--older-than', '0', '--json']);
    assert.notEqual(run.status, 0, 'pruning everything from today was accepted');
    assert.match(`${run.stdout}${run.stderr}`, /greater than 0/);
  } finally {
    repo.cleanup();
  }
});

test('a pruned memory leaves the keyword index consistent', async () => {
  // The failure this guards is deleting half of a node: the row goes, the
  // posting lists keep its id, and the global averages keep counting a document
  // that is not there. Search then answers with ids that resolve to nothing, and
  // scores everything else against a wrong average -- with no error anywhere.
  const repo = makeRepo({ 'docs/a.md': '# A\n\nGhi chú.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);

    const doomed = write(repo, {
      layer: 'episodic',
      title: 'Lệnh hỏng: npm run xyzzy',
      body: 'Chạy npm run xyzzy thất bại vì script không tồn tại.',
      sourceRef: 'session:2020-01-01',
    });

    const before = JSON.parse(cli(repo, ['search', 'xyzzy', '--json']));
    assert.ok(
      before.results.some((hit) => hit.id === doomed),
      'the memory was not searchable to begin with, so removing it proves nothing',
    );

    const report = JSON.parse(cli(repo, ['prune', '--older-than', ANY_AGE, '--json']));
    assert.ok(report.removed >= 1, `nothing was removed: ${JSON.stringify(report)}`);

    // Gone from the table.
    const gone = cliRaw(repo, ['get', doomed, '--json']);
    assert.notEqual(gone.status, 0, 'a pruned memory is still readable');

    // Gone from the index, not merely unreachable through it.
    const after = JSON.parse(cli(repo, ['search', 'xyzzy', '--json']));
    assert.ok(
      !after.results.some((hit) => hit.id === doomed),
      'the keyword index still returns the pruned id',
    );

    // And the counts agree, which is what a half-delete breaks.
    const health = JSON.parse(cli(repo, ['doctor', '--json']));
    const index = health.checks.find((check) => check.name === 'keyword index');
    assert.notEqual(index.status, 'fail', index.detail);
    assert.ok(
      !/are invisible to keyword search/.test(index.detail),
      `index and store disagree after pruning: ${index.detail}`,
    );
  } finally {
    repo.cleanup();
  }
});
