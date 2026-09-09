/**
 * `memory changes` answers the question at the moment it is worth the most:
 * before a commit lands, does memory already record a decision about the files
 * being changed?
 *
 * The property that matters is not that it finds things. It is that it reports
 * the files it found *nothing* for, so "memory is quiet" and "memory was never
 * asked" cannot look the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, cli, cliRaw } from './helpers.js';

function git(repo, args) {
  execFileSync('git', args, { cwd: repo.dir, stdio: 'ignore' });
}

function seeded() {
  const repo = makeRepo({
    'docs/billing.md': [
      '# Billing',
      '',
      '## Retry policy',
      '',
      'Quyết định: chỉ thử lại thẻ bị từ chối hai lần. Lần thứ ba đã bị bỏ.',
    ].join('\n'),
    'src/charge.js': 'export function charge(invoice) {\n  return psp.capture(invoice.amount);\n}\n',
    'src/unrelated.js': 'export const noop = () => {};\n',
  });
  cli(repo, ['init']);
  cli(repo, ['ingest', 'docs/billing.md']);
  return repo;
}

test('a staged change reports the memory recorded against it', async () => {
  const repo = seeded();
  try {
    fs.appendFileSync(path.join(repo.dir, 'docs/billing.md'), '\nMột dòng mới.\n');
    git(repo, ['add', 'docs/billing.md']);

    const report = JSON.parse(cli(repo, ['changes', '--json']));
    assert.equal(report.scope, 'staged');
    assert.deepEqual(report.changed, ['docs/billing.md']);
    assert.equal(report.covered.length, 1, JSON.stringify(report));
    assert.equal(report.covered[0].file, 'docs/billing.md');
    assert.ok(report.covered[0].memories.length > 0, 'no memories anchored to the changed file');
  } finally {
    repo.cleanup();
  }
});

test('files with nothing recorded are reported, not omitted', async () => {
  const repo = seeded();
  try {
    fs.appendFileSync(path.join(repo.dir, 'src/unrelated.js'), 'export const other = 1;\n');
    git(repo, ['add', 'src/unrelated.js']);

    const report = JSON.parse(cli(repo, ['changes', '--json']));
    // The whole point: silence is stated rather than implied.
    assert.deepEqual(report.uncovered, ['src/unrelated.js']);
    assert.equal(report.covered.length, 0);
    assert.deepEqual(report.changed, ['src/unrelated.js']);
  } finally {
    repo.cleanup();
  }
});

test('a flood of chunks is capped, and the cut is stated', async () => {
  // A commit check that lists every chunk of a changed file floods the context
  // this layer exists to protect, and buries the one decision that matters.
  const filler = 'Nội dung dài để vượt ngưỡng một chunk duy nhất. '.repeat(6);
  const many = Array.from({ length: 40 }, (_, i) => `## Mục ${i}\n\n${filler} ${i}.\n`).join('\n');
  const repo = makeRepo({ 'docs/long.md': `# Dài\n\n${many}` });
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs/long.md']);
    fs.appendFileSync(path.join(repo.dir, 'docs/long.md'), '\nthêm.\n');
    git(repo, ['add', 'docs/long.md']);

    const report = JSON.parse(cli(repo, ['changes', '--json']));
    const entry = report.covered[0];
    assert.ok(entry.memories.length <= 5, `listed ${entry.memories.length} memories`);
    assert.ok(entry.omitted > 0, 'a cut happened but was not reported');
  } finally {
    repo.cleanup();
  }
});

test('a recorded decision outranks the chunks of the file', async () => {
  const repo = seeded();
  try {
    cli(repo, ['write', '--layer', 'semantic', '--title', 'Retry twice',
      '--body', 'Chỉ thử lại hai lần.', '--source-ref', 'docs/billing.md#L1-L5', '--json']);
    fs.appendFileSync(path.join(repo.dir, 'docs/billing.md'), '\nthay đổi.\n');
    git(repo, ['add', 'docs/billing.md']);

    const report = JSON.parse(cli(repo, ['changes', '--json']));
    const layers = report.covered[0].memories.map((memory) => memory.layer);
    assert.ok(!layers.includes('artifact'), `artifact chunks crowded out reasoning: ${layers}`);
    assert.ok(layers.includes('semantic'), 'the decision was not listed');
  } finally {
    repo.cleanup();
  }
});

test('the working scope sees an untracked file', async () => {
  const repo = seeded();
  try {
    fs.writeFileSync(path.join(repo.dir, 'src/new-thing.js'), 'export const x = 1;\n');

    const staged = JSON.parse(cli(repo, ['changes', '--json']));
    assert.equal(staged.changed.length, 0, 'nothing is staged yet');

    const working = JSON.parse(cli(repo, ['changes', '--scope', 'working', '--json']));
    assert.ok(
      working.changed.includes('src/new-thing.js'),
      `untracked file missing: ${JSON.stringify(working.changed)}`,
    );
  } finally {
    repo.cleanup();
  }
});

test('a bad base ref fails loudly instead of reporting no changes', async () => {
  const repo = seeded();
  try {
    const run = cliRaw(repo, ['changes', '--scope', 'compare', '--base', 'no-such-ref', '--json']);
    assert.notEqual(run.status, 0, 'a bad ref exited zero');
    assert.match(
      `${run.stdout}${run.stderr}`,
      /nothing to check|Could not read/,
      'the failure did not explain itself',
    );
  } finally {
    repo.cleanup();
  }
});

test('a contested memory is marked on the changed file', async () => {
  const repo = seeded();
  try {
    const first = JSON.parse(
      cli(repo, ['write', '--layer', 'semantic', '--title', 'Retry twice',
        '--body', 'Charge retries twice.', '--source-ref', 'docs/billing.md#L1-L5', '--json']),
    );
    const second = JSON.parse(
      cli(repo, ['write', '--layer', 'semantic', '--title', 'Retry once',
        '--body', 'Charge retries once.', '--source-ref', 'docs/billing.md#L1-L5', '--json']),
    );
    cli(repo, ['link', second.id, first.id, 'CONTRADICTS', '--json']);

    fs.appendFileSync(path.join(repo.dir, 'docs/billing.md'), '\nthay đổi.\n');
    git(repo, ['add', 'docs/billing.md']);

    const report = JSON.parse(cli(repo, ['changes', '--json']));
    assert.ok(report.contested > 0, `expected a contested memory: ${JSON.stringify(report)}`);
    const marked = report.covered.flatMap((entry) => entry.memories).filter((m) => m.contested);
    assert.ok(marked.length >= 2, 'both sides of the contradiction should be marked');
  } finally {
    repo.cleanup();
  }
});
