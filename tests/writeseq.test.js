import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

/**
 * C11 -- the write counter advances only after a durable commit.
 *
 * writeSeq lives in meta.json, outside the database, so the ordering of the two
 * steps is a contract rather than an implementation detail. Getting it backwards
 * turns the guard against stale snapshots into a guard that asserts a falsehood:
 * a reader would see the new counter, reopen, read the old data, and cache it as
 * current. That is worse than not having the guard.
 */

function seq(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo.dir, '.memory', 'meta.json'), 'utf8')).writeSeq;
}

async function openStore(repo, options = {}) {
  const { MemoryStore } = await import('@memory-layer/core');
  return new MemoryStore(path.join(repo.dir, '.memory'), options);
}

test('C11-a: a failed write leaves both the data and the counter untouched', async () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['write', '--layer', 'semantic', '--title', 'Kept', '--body', 'This one lands.', '--source-ref', 'docs/a.md#L1-L2']);

    const before = seq(repo);
    const store = await openStore(repo);

    await assert.rejects(
      store.transact(async () => {
        await store.upsertNode({
          id: 'mem_rolledback000000000000', layer: 'semantic', title: 'Rolled back',
          body: 'This must not survive.', sourceRef: 'docs/a.md#L3-L4', filePath: null,
          importance: 5, confidence: 1, createdAt: Date.now(), lastSeenAt: Date.now(),
          accessCount: 0, supersededAt: null, embedding: null,
        });
        throw new Error('deliberate failure after a write');
      }),
      /deliberate failure/,
    );

    assert.equal(seq(repo), before, 'the counter advanced for a write that rolled back');
    assert.equal(await store.getNode('mem_rolledback000000000000'), null, 'a rolled-back node survived');
    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('C11-b: a commit that lands but cannot be announced fails loudly', () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const metaDir = path.join(repo.dir, '.memory');

    // meta.json is written to a temporary file and renamed into place. Putting a
    // directory where that temporary file goes breaks the write and nothing else:
    // reading the current meta still works, so the failure lands exactly where it
    // needs to -- after the data is durable, at the moment of announcing it.
    const blocker = path.join(metaDir, 'meta.json.tmp');
    fs.mkdirSync(blocker, { recursive: true });
    try {
      const result = cliRaw(repo, [
        'write', '--layer', 'semantic', '--title', 'Announced?',
        '--body', 'The data lands but the counter cannot move.', '--source-ref', 'docs/a.md#L1-L2',
      ]);

      assert.notEqual(result.status, 0, 'a store nobody can read back exited zero');
      assert.match(
        result.stderr,
        /writeSeq|readers will not see/i,
        `the failure did not name the problem: ${result.stderr}`,
      );

      // The point of the error: the data is there, and only the announcement failed.
      fs.rmSync(blocker, { recursive: true, force: true });
      const { results } = JSON.parse(cli(repo, ['search', 'counter cannot move', '--json']));
      assert.equal(results.length, 1, 'the write was reported as durable but is not there');
    } finally {
      fs.rmSync(blocker, { recursive: true, force: true });
    }
  } finally {
    repo.cleanup();
  }
});

test('C11-c: inside the transaction the counter has not moved yet', async () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const before = seq(repo);
    const store = await openStore(repo);

    let seenDuring = null;
    await store.transact(async () => {
      await store.upsertNode({
        id: 'mem_ordering0000000000000a', layer: 'semantic', title: 'Ordering',
        body: 'Written inside the transaction.', sourceRef: 'docs/a.md#L1-L2', filePath: null,
        importance: 5, confidence: 1, createdAt: Date.now(), lastSeenAt: Date.now(),
        accessCount: 0, supersededAt: null, embedding: null,
      });
      // The data is written but not yet committed. Any reader looking now must
      // still see the old counter -- old counter with old data is consistent and
      // self-correcting; new counter with old data is not.
      seenDuring = seq(repo);
    });

    assert.equal(seenDuring, before, 'the counter moved before the commit landed');
    assert.equal(seq(repo), before + 1, 'the counter did not move after the commit');
    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('C11-d: a write is visible to a process that starts afterwards', () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const before = seq(repo);

    cli(repo, ['write', '--layer', 'semantic', '--title', 'Visible everywhere', '--body', 'Retries are capped at two.', '--source-ref', 'docs/a.md#L1-L2']);
    assert.equal(seq(repo), before + 1);

    const { results } = JSON.parse(cli(repo, ['search', 'retries capped', '--json']));
    assert.equal(results.length, 1, 'a committed write was not visible to a later process');
  } finally {
    repo.cleanup();
  }
});

test('C11-e: nested units of work commit once, with one counter advance', async () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const before = seq(repo);
    const store = await openStore(repo);

    await store.transact(async () => {
      assert.ok(store.inTransaction);
      // A nested call joins the outer transaction rather than opening its own;
      // BEGIN inside BEGIN is an error, and a nested unit has no business
      // committing on behalf of its caller.
      await store.transact(async () => {
        await store.upsertNode({
          id: 'mem_nested00000000000000aa', layer: 'semantic', title: 'Nested',
          body: 'Written by an inner unit of work.', sourceRef: 'docs/a.md#L1-L2', filePath: null,
          importance: 5, confidence: 1, createdAt: Date.now(), lastSeenAt: Date.now(),
          accessCount: 0, supersededAt: null, embedding: null,
        });
      });
      assert.equal(seq(repo), before, 'an inner unit of work advanced the counter on its own');
    });

    assert.equal(seq(repo), before + 1, 'nesting produced more than one counter advance');
    assert.ok(await store.getNode('mem_nested00000000000000aa'));
    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('C11-f: a read-only handle refuses to write rather than half-writing', async () => {
  const repo = makeRepo({ 'docs/a.md': '# T\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const store = await openStore(repo, { readOnly: true });
    await assert.rejects(store.transact(async () => undefined), /read-only/i);
    await store.close();
  } finally {
    repo.cleanup();
  }
});
