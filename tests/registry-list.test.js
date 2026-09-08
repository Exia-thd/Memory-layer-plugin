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
    fs.writeFileSync(path.join(repo.home, 'registry.json'), JSON.stringify(entries));

    const started = Date.now();
    const listed = JSON.parse(cli(repo, ['list', '--json']));
    const elapsed = Date.now() - started;

    assert.equal(listed.length, 50);
    assert.ok(listed.every((entry) => entry.freshness), 'freshness was not reported per project');
    assert.ok(elapsed < 3000, `listing 50 projects took ${elapsed}ms`);
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
