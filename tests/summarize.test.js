/**
 * The summarisation stage that clustering deliberately left out.
 *
 * Community ids come out of Louvain and change between runs, so a summary that
 * pointed at an id would go stale silently -- still displayed, attached to a
 * different group. It is anchored to the members instead, and rediscovered
 * through those links.
 *
 * Nothing here calls a model. The body comes from the caller, so a read path
 * cannot quietly become a generation path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cli, cliRaw } from './helpers.js';

/** Three linked memories, so Louvain has something to group. */
function grouped(repo) {
  const ids = [];
  const facts = [
    ['Retry twice', 'Charge retries a declined card twice.'],
    ['Idempotency key per attempt', 'The key is derived from invoice and attempt.'],
    ['Third retry removed', 'A third attempt counted as a new authorisation.'],
  ];
  for (const [title, body] of facts) {
    ids.push(JSON.parse(cli(repo, [
      'write', '--layer', 'semantic', '--title', title, '--body', body,
      '--source-ref', `docs/billing.md#L${ids.length + 1}-L${ids.length + 2}`, '--json',
    ])).id);
  }
  for (let i = 1; i < ids.length; i++) {
    cli(repo, ['link', ids[i], ids[0], 'CONSTRAINS', '--json']);
  }
  return ids;
}

test('a cluster carries no summary until one is written', async () => {
  const repo = makeRepo({ 'docs/billing.md': '# Billing\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    grouped(repo);
    const before = JSON.parse(cli(repo, ['clusters', '--json']));
    assert.ok(before.length > 0, 'no clusters were found');
    for (const cluster of before) {
      assert.equal(cluster.summary, undefined, 'a summary appeared from nowhere');
      assert.ok(Array.isArray(cluster.memberIds) && cluster.memberIds.length > 0);
    }
  } finally {
    repo.cleanup();
  }
});

test('a written summary is found again through its members', async () => {
  const repo = makeRepo({ 'docs/billing.md': '# Billing\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    grouped(repo);
    const clusterId = JSON.parse(cli(repo, ['clusters', '--json']))[0].id;

    const written = JSON.parse(cli(repo, [
      'summarize', String(clusterId),
      '--body', 'Thanh toán: retry hai lần, khoá idempotency theo từng lượt.',
      '--json',
    ]));
    assert.ok(written.id, 'nothing was written');
    assert.ok(written.covers >= 2, `a summary should cover the group, covered ${written.covers}`);

    const after = JSON.parse(cli(repo, ['clusters', '--json']));
    const summarised = after.filter((cluster) => cluster.summary);
    assert.equal(summarised.length, 1, JSON.stringify(after.map((c) => c.summary ?? null)));
    assert.match(summarised[0].summary.body, /retry hai lần/);
    assert.ok(summarised[0].summary.covers >= 2);
  } finally {
    repo.cleanup();
  }
});

test('a note derived from one memory is not mistaken for a summary', async () => {
  const repo = makeRepo({ 'docs/billing.md': '# Billing\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const ids = grouped(repo);

    const note = JSON.parse(cli(repo, [
      'write', '--layer', 'semantic', '--title', 'A note',
      '--body', 'A comment on one memory only.',
      '--source-ref', 'docs/billing.md#L9-L9', '--json',
    ]));
    cli(repo, ['link', note.id, ids[0], 'DERIVED_FROM', '--json']);

    const after = JSON.parse(cli(repo, ['clusters', '--json']));
    for (const cluster of after) {
      assert.equal(cluster.summary, undefined, 'a single-member note was promoted to a summary');
    }
  } finally {
    repo.cleanup();
  }
});

test('an empty summary is refused', async () => {
  const repo = makeRepo({ 'docs/billing.md': '# Billing\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    grouped(repo);
    const clusterId = JSON.parse(cli(repo, ['clusters', '--json']))[0].id;

    const run = cliRaw(repo, ['summarize', String(clusterId), '--body', '   ', '--json']);
    assert.notEqual(run.status, 0, 'an empty summary was accepted');
    assert.match(`${run.stdout}${run.stderr}`, /needs a body/);
  } finally {
    repo.cleanup();
  }
});
