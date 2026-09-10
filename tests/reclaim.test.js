/**
 * What happens when things stop existing.
 *
 * Ingest only ever meets files that are on disk, so every reclamation it did
 * happened inside the loop over those files -- which is exactly why a deleted
 * file could never be reclaimed: it was never met. The store kept answering
 * with it, cited a line range in nothing, and doctor reported every check
 * green. Renamed declarations had the same shape: an upsert with no delete.
 *
 * These tests are all of the form "take something away, and check the store
 * agrees", because that is the direction that was broken. Adding always worked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

const CHARGE = 'export function chargeInvoice(a) { return a; }\n';

function symbolNames(repo) {
  const map = JSON.parse(cli(repo, ['map', '--json']));
  return map.files.flatMap((file) => file.symbols.map((symbol) => symbol.name));
}

test('a file deleted from disk stops answering queries', async () => {
  const repo = makeRepo({
    'docs/keep.md': '# Keep\n\nalpha alpha alpha.\n',
    'docs/gone.md': '# Gone\n\nQuyet dinh ve bravo zulu.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);
    assert.match(cli(repo, ['search', 'bravo zulu']), /gone\.md/, 'not indexed to begin with');

    fs.rmSync(path.join(repo.dir, 'docs/gone.md'));
    const report = cli(repo, ['ingest', 'docs']);
    assert.match(report, /reclaimed 1 file/, `no reclamation reported: ${report}`);

    const after = cli(repo, ['search', 'bravo zulu']);
    assert.doesNotMatch(after, /gone\.md/, 'a deleted file still answers');
    // The neighbour must be untouched: reclamation is not a rebuild.
    assert.match(cli(repo, ['search', 'alpha']), /keep\.md/, 'reclamation took a live file with it');
  } finally {
    repo.cleanup();
  }
});

test('reclamation stays inside the paths named in this run', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\nQuyet dinh ve charlie delta.\n',
    'src/charge.js': CHARGE,
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs', 'src']);

    // src is not named here, so its absence from this walk is not evidence that
    // anything was deleted. Getting this wrong would empty the store one
    // directory at a time.
    cli(repo, ['ingest', 'docs']);
    assert.ok(
      symbolNames(repo).includes('chargeInvoice'),
      'ingesting docs reclaimed memories belonging to src',
    );
  } finally {
    repo.cleanup();
  }
});

test('a file passed over for its extension is not treated as deleted', async () => {
  const repo = makeRepo({ 'docs/note.md': '# Note\n\nQuyet dinh ve echo foxtrot.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);

    // Rename it to something the walk does not collect. The file still exists,
    // so nothing about it was deleted -- but it is no longer in the walk, and
    // membership of the walk must not be what decides.
    fs.renameSync(path.join(repo.dir, 'docs/note.md'), path.join(repo.dir, 'docs/note.unknownext'));
    cli(repo, ['ingest', 'docs']);

    // The old path is genuinely gone, so this one *should* be reclaimed. The
    // point of the test is that it happens through existence on disk.
    const after = cli(repo, ['search', 'echo foxtrot']);
    assert.doesNotMatch(after, /note\.md#/, 'a path that no longer exists still answers');
  } finally {
    repo.cleanup();
  }
});

test('a renamed declaration leaves the graph', async () => {
  const repo = makeRepo({ 'src/charge.js': CHARGE });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);
    assert.deepEqual(symbolNames(repo), ['chargeInvoice']);

    fs.writeFileSync(
      path.join(repo.dir, 'src/charge.js'),
      'export function chargeInvoiceV2(a) { return a; }\nexport function refund(b) { return b; }\n',
    );
    const report = cli(repo, ['ingest', 'src']);
    assert.match(report, /dropped 1 declaration/, `no declaration dropped: ${report}`);

    const names = symbolNames(repo).sort();
    assert.deepEqual(names, ['chargeInvoiceV2', 'refund'], 'the old name survived the rename');
  } finally {
    repo.cleanup();
  }
});

test('doctor stops reporting green when the index cites files that are gone', async () => {
  const repo = makeRepo({ 'docs/gone.md': '# Gone\n\ngolf hotel.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);
    assert.match(cli(repo, ['doctor']), /file anchors\s+ok/, 'not healthy to begin with');

    fs.rmSync(path.join(repo.dir, 'docs/gone.md'));
    const report = cli(repo, ['doctor']);
    assert.match(report, /file anchors\s+WARN/, `doctor stayed green: ${report}`);
    assert.match(report, /docs\/gone\.md/, 'the warning does not say which file');
  } finally {
    repo.cleanup();
  }
});

test('symbols go with the file when the file does', async () => {
  const repo = makeRepo({ 'src/charge.js': CHARGE });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);
    assert.deepEqual(symbolNames(repo), ['chargeInvoice']);

    fs.rmSync(path.join(repo.dir, 'src/charge.js'));
    cli(repo, ['ingest', 'src']);
    assert.deepEqual(symbolNames(repo), [], 'declarations outlived their file');
  } finally {
    repo.cleanup();
  }
});

test('reclaiming does not corrupt what remains searchable', async () => {
  const repo = makeRepo({
    'docs/a.md': '# A\n\nindia juliett.\n',
    'docs/b.md': '# B\n\nindia kilo.\n',
    'docs/c.md': '# C\n\nindia lima.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);

    fs.rmSync(path.join(repo.dir, 'docs/b.md'));
    cli(repo, ['ingest', 'docs']);

    // Deleting a node rewrites term postings and the global length statistics.
    // Getting that wrong scores every surviving document against a corpus size
    // that no longer matches, which no single-document test would show.
    const hits = cli(repo, ['search', 'india']);
    assert.match(hits, /a\.md/);
    assert.match(hits, /c\.md/);
    assert.doesNotMatch(hits, /b\.md/);

    const doctor = cli(repo, ['doctor']);
    assert.doesNotMatch(doctor, /keyword index\s+(WARN|FAIL)/, `index left inconsistent: ${doctor}`);
    assert.doesNotMatch(doctor, /store\s+FAIL/, doctor);
  } finally {
    repo.cleanup();
  }
});

test('reclamation is reported, not silent', async () => {
  const repo = makeRepo({ 'docs/gone.md': '# Gone\n\nmike november.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);
    fs.rmSync(path.join(repo.dir, 'docs/gone.md'));

    const json = JSON.parse(cli(repo, ['ingest', 'docs', '--json']));
    assert.equal(json.vanished, 1, `vanished not counted: ${JSON.stringify(json)}`);
    assert.ok(json.removed >= 1, 'nothing was actually removed');
  } finally {
    repo.cleanup();
  }
});

test('a missing target is refused rather than read as a deletion', async () => {
  const repo = makeRepo({ 'docs/note.md': '# Note\n\noscar papa.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);

    // If a vanished directory were treated as "everything under it is deleted",
    // one typo would empty the store. It has to fail instead.
    const result = cliRaw(repo, ['ingest', 'docs-typo']);
    assert.equal(result.status, 1, 'a nonexistent path was accepted');
    assert.match(result.stderr, /No such path/);
    assert.match(cli(repo, ['search', 'oscar papa']), /note\.md/, 'the store was emptied by a typo');
  } finally {
    repo.cleanup();
  }
});
