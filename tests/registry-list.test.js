import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
      projectName: name, projectRoot: dir, schemaVersion: 3, dimensions: 384,
      embedding: null, writeSeq: 0, lastCommit: head,
    }),
  );

  return { name, path: dir, storagePath: store, lastCommit: head, stats: { nodes: 1, edges: 0, embedded: 0 } };
}

test('R6-a: fifty projects list without the cost adding up', () => {
  const repo = makeRepo({ 'a.md': '# a\n' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'many-'));
  try {
    cli(repo, ['init']);

    const entries = Array.from({ length: 50 }, (_, i) => fakeProject(root, `project-${i}`));
    const registry = path.join(repo.home, 'registry.json');

    // Timed against the same command on one project rather than against a fixed
    // number of milliseconds.
    //
    // What this guards is that freshness is resolved concurrently: listing fifty
    // must not cost fifty times listing one. An absolute bound measures the
    // machine instead -- process start and model load dominate a single run and
    // have nothing to do with the property -- so it passes on an idle laptop and
    // fails on a loaded CI box for no reason anyone can act on. A ratio moves
    // with the machine, because both runs pay the same fixed cost.
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

    // Measured concurrent: about 3x. Serial would be an order of magnitude,
    // because each project costs a git call of its own.
    assert.ok(
      fifty.elapsed < one.elapsed * 5,
      `listing 50 projects took ${fifty.elapsed}ms against ${one.elapsed}ms for one; ` +
        'freshness is being resolved serially',
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
