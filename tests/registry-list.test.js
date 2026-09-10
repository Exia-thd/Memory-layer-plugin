import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SCHEMA_VERSION } from '@memory-layer/core';
import { makeRepo, cli, cliRaw } from './helpers.js';

/**
 * R6 -- listing many projects.
 *
 * Each freshness check spawns git. Done one after another the cost is the sum of
 * all of them, and a listing slow enough that nobody runs it is a listing that
 * never reports a stale index -- which is what keeps the whole memory layer from
 * confidently answering out of date.
 */

function fakeProject(root, name) {
  const dir = path.join(root, name);
  const store = path.join(dir, '.memory');
  fs.mkdirSync(store, { recursive: true });

  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@e.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'a.txt'), name);
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'x'], { stdio: 'ignore' });
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  fs.writeFileSync(
    path.join(store, 'meta.json'),
    JSON.stringify({
      // Read the constant rather than pinning a number: this test is about a
      // registry surviving broken entries, and a hardcoded version made it fail
      // for an unrelated schema bump.
      projectName: name, projectRoot: dir, schemaVersion: SCHEMA_VERSION, dimensions: 384,
      embedding: null, writeSeq: 0, lastCommit: head,
    }),
  );

  return { name, path: dir, storagePath: store, lastCommit: head, stats: { nodes: 1, edges: 0, embedded: 0 } };
}

test('R6-a: listing many projects keeps a small cost per project', () => {
  const repo = makeRepo({ 'a.md': '# a\n' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'many-'));
  try {
    cli(repo, ['init']);

    const entries = Array.from({ length: 50 }, (_, i) => fakeProject(root, `project-${i}`));
    const registry = path.join(repo.home, 'registry.json');

    const time = (count) => {
      fs.writeFileSync(registry, JSON.stringify(entries.slice(0, count)));
      const started = Date.now();
      const listed = JSON.parse(cli(repo, ['list', '--json']));
      return { elapsed: Date.now() - started, listed };
    };

    const one = time(1);
    const fifty = time(50);

    assert.equal(fifty.listed.length, 50);
    assert.ok(fifty.listed.every((entry) => entry.freshness), 'freshness was not reported per project');

    // What this measures, and what it deliberately does not.
    //
    // It used to assert that fifty projects cost less than five times one, on
    // the reasoning that freshness is resolved concurrently. Measuring the shape
    // showed that is not what happens here: marginal cost per project runs
    // 14.5ms at five projects, 16.9 at ten, 19.7 at twenty-five and 20.8 at
    // fifty -- flat, which is serial, even though the pool limit is eight.
    // Process spawn on Windows barely overlaps, so the pool buys almost nothing
    // and the ratio bound was passing on the size of the fixed startup cost
    // rather than on concurrency. Making startup twice as fast broke it, without
    // the behaviour it claimed to guard having changed at all.
    //
    // So it guards what is actually true and still worth protecting: the
    // marginal cost of one more project stays small. That catches the
    // regression that matters -- somebody adding per-project work heavy enough
    // to make a registry of fifty unusable -- and does not claim a concurrency
    // win that this platform does not deliver.
    const perProject = (fifty.elapsed - one.elapsed) / 49;
    assert.ok(
      perProject < 60,
      `each extra project costs ${perProject.toFixed(1)}ms (50 took ${fifty.elapsed}ms, ` +
        `1 took ${one.elapsed}ms); something per-project got expensive`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('R6-b: one broken project does not take the listing down with it', () => {
  const repo = makeRepo({ 'a.md': '# a\n' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'many-'));
  try {
    cli(repo, ['init']);

    const good = fakeProject(root, 'good');
    const moved = fakeProject(root, 'moved');
    const notGit = fakeProject(root, 'not-git');

    // Three ways a registry entry goes bad: the directory is gone, the git
    // repository is gone, and the store metadata is unreadable.
    fs.rmSync(moved.path, { recursive: true, force: true });
    fs.rmSync(path.join(notGit.path, '.git'), { recursive: true, force: true });
    const corrupt = fakeProject(root, 'corrupt');
    fs.writeFileSync(path.join(corrupt.storagePath, 'meta.json'), '{ not json');

    fs.writeFileSync(
      path.join(repo.home, 'registry.json'),
      JSON.stringify([good, moved, notGit, corrupt]),
    );

    const result = cliRaw(repo, ['list', '--json']);
    assert.equal(result.status, 0, `listing exited ${result.status}: ${result.stderr}`);

    const listed = JSON.parse(result.stdout);
    assert.equal(listed.length, 4, 'a bad entry removed other projects from the listing');

    const byName = Object.fromEntries(listed.map((entry) => [entry.name, entry]));
    assert.ok(!byName.good.freshness.unavailable, 'a healthy project was reported as unreachable');
    // Each broken one says what is wrong with it rather than being silently fine.
    for (const name of ['moved', 'not-git', 'corrupt']) {
      assert.ok(byName[name].freshness.unavailable, `${name} was reported as healthy`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('R6-c: a project whose HEAD moved is reported stale', () => {
  const repo = makeRepo({ 'a.md': '# a\n' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'many-'));
  try {
    cli(repo, ['init']);
    const project = fakeProject(root, 'drifting');
    fs.writeFileSync(path.join(repo.home, 'registry.json'), JSON.stringify([project]));

    const before = JSON.parse(cli(repo, ['list', '--json']));
    assert.equal(before[0].freshness.stale, false);

    fs.writeFileSync(path.join(project.path, 'b.txt'), 'more');
    execFileSync('git', ['-C', project.path, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', project.path, 'commit', '-qm', 'moved on'], { stdio: 'ignore' });

    const after = JSON.parse(cli(repo, ['list', '--json']));
    assert.equal(after[0].freshness.stale, true, 'a store built at an older commit was reported current');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    repo.cleanup();
  }
});
