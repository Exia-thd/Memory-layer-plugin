import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  MemoryStore, Bm25Index, persistedBm25Search, encodePostings, decodePostings, search,
  HashEmbeddingProvider,
} from '@memory-layer/core';
import { makeRepo, cli } from './helpers.js';

/**
 * R4 -- the keyword index lives in the store.
 *
 * Rebuilding an inverted index in memory means reading and tokenising every node
 * before answering anything, and a short-lived CLI process pays that on every
 * single command. Persisting it turns the cost of a query into a function of the
 * query rather than of how much has been remembered.
 */

const CORPUS = {
  'docs/billing.md': `# Billing

## Retry policy

We retry a declined card exactly twice, three seconds apart. Three or more
retries tripped the processor fraud heuristic and flagged the merchant account.

## Settlement

The settlement window closes at midnight and the ledger batch runs after it.
`,
  'docs/queues.md': `# Queues

## Worker pool

Workers are capped at the core count minus one. A larger pool caused a deadlock
against the replica shard during the nightly migration.
`,
};

async function openStore(repo, options = {}) {
  return new MemoryStore(path.join(repo.dir, '.memory'), options);
}

test('R4-a: a fresh process searches without rebuilding an index', async () => {
  const repo = makeRepo(CORPUS);
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);

    // A new process, exactly as the CLI runs. If the persisted index were missing
    // the branch would answer anyway, from an in-memory rebuild, and say so --
    // which is the thing being ruled out here.
    const { fusion } = JSON.parse(cli(repo, ['search', 'declined card retry', '--json']));
    assert.ok(fusion.branches.bm25 > 0, 'the keyword branch found nothing');
    assert.ok(
      !(fusion.reasons.bm25 ?? '').includes('rebuilt in memory'),
      `the keyword branch fell back to an in-memory rebuild: ${fusion.reasons.bm25}`,
    );

    const store = await openStore(repo, { readOnly: true });
    const hits = await persistedBm25Search(store, 'declined card retry', 10);
    assert.notEqual(hits, null, 'no persisted index was written during ingest');
    assert.ok(hits.length > 0);
    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('R4-b: persisted and in-memory ranking agree', async () => {
  const repo = makeRepo(CORPUS);
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);

    const store = await openStore(repo, { readOnly: true });
    const nodes = await store.allNodes();

    const memory = new Bm25Index();
    memory.addAll(nodes.map((node) => ({ id: node.id, text: `${node.title}\n${node.body}` })));

    // Changing where the postings live must not change what comes back. A storage
    // change that quietly reorders results would cost more than the time it saves.
    for (const query of [
      'declined card retry',
      'settlement window ledger',
      'deadlock replica shard',
      'worker pool core count',
      'retries of declined cards',
    ]) {
      const fromMemory = memory.search(query, 10);
      const fromStore = await persistedBm25Search(store, query, 10);

      assert.deepEqual(
        fromStore.map((hit) => hit.id),
        fromMemory.map((hit) => hit.id),
        `ranking differs for ${JSON.stringify(query)}`,
      );

      for (const [index, hit] of fromStore.entries()) {
        assert.ok(
          Math.abs(hit.score - fromMemory[index].score) < 1e-9,
          `score differs for ${JSON.stringify(query)} at rank ${index + 1}`,
        );
      }
    }
    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('R4-c: a write is reflected in the persisted index, not served stale', async () => {
  const repo = makeRepo(CORPUS);
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);

    const store = await openStore(repo, { readOnly: true });
    const before = await persistedBm25Search(store, 'thermospectral anomaly', 10);
    assert.equal(before.length, 0);

    cli(repo, [
      'write', '--layer', 'episodic', '--title', 'Thermospectral anomaly',
      '--body', 'A thermospectral anomaly appeared in the nightly batch.',
      '--source-ref', 'session:1',
    ]);

    const after = await persistedBm25Search(store, 'thermospectral anomaly', 10);
    assert.equal(after.length, 1, 'a node written after the reader opened is missing from the index');
    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('R4-c2: index and nodes commit together or not at all', async () => {
  const repo = makeRepo(CORPUS);
  try {
    cli(repo, ['init']);
    const store = await openStore(repo);

    await assert.rejects(
      store.transact(async () => {
        await store.upsertNode({
          id: 'mem_rollback000000000000ab', layer: 'semantic', title: 'Zygomorphic',
          body: 'A zygomorphic decision that must not survive.', sourceRef: 'docs/x.md#L1-L2',
          filePath: null, importance: 5, confidence: 1, createdAt: Date.now(),
          lastSeenAt: Date.now(), accessCount: 0, supersededAt: null, embedding: null,
        });
        throw new Error('deliberate failure');
      }),
      /deliberate failure/,
    );
    // A second transaction, this one successful, and read back through the same
    // handle rather than a reopened one.
    //
    // The rolled-back terms were accumulated in memory before the failure, so a
    // store that rolled the data back but forgot to discard its pending index
    // delta would flush them here, attached to a node that does not exist. That
    // is the sharper half of this invariant, and a reopened reader could never
    // have caught it: reopening throws the delta away on the way past.
    await store.transact(async () => {
      await store.upsertNode({
        id: 'mem_survivor0000000000ab', layer: 'semantic', title: 'Peduncle',
        body: 'A peduncle decision written after the rollback.', sourceRef: 'docs/y.md#L1-L2',
        filePath: null, importance: 5, confidence: 1, createdAt: Date.now(),
        lastSeenAt: Date.now(), accessCount: 0, supersededAt: null, embedding: null,
      });
    });

    // The node rolled back, so its terms must have rolled back with it. An index
    // holding ids that no longer exist would return hits that cannot be fetched.
    const rolled = await persistedBm25Search(store, 'zygomorphic', 10);
    assert.deepEqual(rolled ?? [], [], 'the index kept terms for a node that was rolled back');

    // ...and the index is still writing, so the emptiness above is a rollback
    // rather than an index that quietly stopped working.
    const kept = await persistedBm25Search(store, 'peduncle', 10);
    assert.equal(kept?.length, 1, 'the node written after the rollback was not indexed');

    await store.close();
  } finally {
    repo.cleanup();
  }
});

test('R4-e: postings survive a round trip, including awkward ids', () => {
  const postings = new Map([
    ['mem_aaaa', { tf: 3, length: 120 }],
    ['mem_bbbb', { tf: 1, length: 4000 }],
  ]);
  assert.deepEqual(decodePostings(encodePostings(postings)), postings);

  assert.deepEqual(decodePostings(''), new Map());
  // A malformed entry is skipped rather than taking the whole term row with it.
  assert.deepEqual(decodePostings('broken mem_ok:2:50'), new Map([['mem_ok', { tf: 2, length: 50 }]]));
});

test('R4-f: search returns the same top results through the whole pipeline', async () => {
  const repo = makeRepo(CORPUS);
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);

    const store = await openStore(repo, { readOnly: true });
    const provider = new HashEmbeddingProvider(384);
    const result = await search(store, 'declined card retry', provider, { limit: 5 });

    assert.ok(result.results.length > 0);
    assert.match(result.results[0].sourceRef, /docs\/billing\.md/);
    // Every returned hit was loaded in full, so a shortlist that dropped a node
    // between ranking and fetching would show up as a missing result.
    for (const hit of result.results) {
      assert.ok(hit.title, 'a hit came back without a title');
      assert.ok(hit.sourceRef, 'a hit came back without provenance');
    }
    await store.close();
  } finally {
    repo.cleanup();
  }
});
