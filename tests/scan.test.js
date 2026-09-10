/**
 * Choosing what to read, and saying so.
 *
 * Three separate faults lived here, and they shared a shape: the command knew
 * something the user could not see. Paths resolved against the working
 * directory while everything else was anchored to the repository root, so the
 * same command worked at the root and failed one level down for a path that
 * plainly existed. The conventional-name list could not see a directory called
 * `repoA`, and said nothing about not seeing it. And the walk passed over nine
 * files in twenty-one under a line that read like success.
 *
 * A guess is fine. A guess nobody can check is not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

const CHARGE = 'export function chargeInvoice(a) { return a; }\n';

test('a command run from a subdirectory resolves paths against the repository root', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\nQuyet dinh ve alpha bravo.\n',
    'src/charge.js': CHARGE,
    'src/deep/nested/placeholder.md': '# P\n\nplaceholder.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);

    // `docs` is a repository path, not a path relative to wherever the shell
    // happens to be. Nobody works from the repository root.
    const from = path.join(repo.dir, 'src', 'deep', 'nested');
    const out = cli(repo, ['ingest', 'docs'], { cwd: from });
    assert.match(out, /1 new/, `ingest from a subdirectory failed: ${out}`);

    assert.match(
      cli(repo, ['search', 'alpha bravo'], { cwd: from }),
      /docs\/note\.md/,
      'the memory was not stored under a root-relative path',
    );
  } finally {
    repo.cleanup();
  }
});

test('init run from a subdirectory scans the whole project', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\ncharlie delta.\n',
    'src/charge.js': CHARGE,
  });
  try {
    const from = path.join(repo.dir, 'src');
    const out = cli(repo, ['init'], { cwd: from });
    assert.match(out, /scanning/, out);
    assert.match(out, /declarations from/, `init from a subdirectory scanned nothing: ${out}`);
    assert.doesNotMatch(out, /No such path/, out);
  } finally {
    repo.cleanup();
  }
});

test('ingest with no paths makes the same choice init does', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\necho foxtrot.\n',
    'src/charge.js': CHARGE,
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest']);
    assert.match(out, /scanning docs, src/, `no scan announced: ${out}`);
    assert.match(out, /2 new/, out);
  } finally {
    repo.cleanup();
  }
});

test('a directory the list cannot name is found by looking inside it', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\ngolf hotel.\n',
    // The layout people actually keep: several checkouts beside one shared docs
    // tree, named whatever the user named them. No list will ever contain these.
    'repoA/package.json': '{"name":"a"}\n',
    'repoA/src/a.js': 'export function alphaFn() {}\n',
    'repoB/src/b.js': 'export function bravoFn() {}\n',
    'notes-only/x.md': '# X\n\nnot a project.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest']);

    assert.match(out, /repoA/, `an obvious project was not found: ${out}`);
    assert.match(out, /repoB/, out);
    // The reason is printed, so a wrong guess is arguable rather than invisible.
    assert.match(out, /repoA\s+\(package\.json\)/, `no reason given: ${out}`);
    assert.match(out, /repoB\s+\(src\)/, out);

    // A directory of loose files is not a project, and is not swept in. This is
    // the half that keeps the first run from being a store full of noise.
    assert.doesNotMatch(out, /notes-only/, `a plain directory was swept in: ${out}`);

    const names = JSON.parse(cli(repo, ['map', '--json'])).files
      .flatMap((file) => file.symbols.map((symbol) => symbol.name))
      .sort();
    assert.deepEqual(names, ['alphaFn', 'bravoFn']);
  } finally {
    repo.cleanup();
  }
});

test('node_modules is never a project, whatever it contains', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\nindia juliett.\n',
    'node_modules/pkg/package.json': '{"name":"pkg"}\n',
    'node_modules/pkg/src/index.js': 'export function vendored() {}\n',
    'vendor/thing/package.json': '{"name":"thing"}\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest']);
    assert.doesNotMatch(out, /node_modules/, `vendored code was scanned: ${out}`);
    assert.doesNotMatch(out, /scanning[^\n]*vendor/, out);
  } finally {
    repo.cleanup();
  }
});

test('apps is recognised, not only app', async () => {
  const repo = makeRepo({ 'apps/web/main.js': 'export function webMain() {}\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest']);
    assert.match(out, /scanning apps/, `the plural spelling is still invisible: ${out}`);
  } finally {
    repo.cleanup();
  }
});

test('what the walk passed over is reported, with reasons', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\nkilo lima.\n',
    'docs/diagram.puml': '@startuml\nA -> B\n@enduml\n',
    'docs/style.css': '.a { color: redzulu; }\n',
    'docs/shot.png': 'not really a png\n',
    'docs/report.pdf': 'not really a pdf\n',
    'docs/build/generated.md': '# Generated\n\nmike.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest', 'docs']);

    // Skipping is a fine decision. Skipping quietly is how a store ends up
    // trusted and incomplete at once.
    assert.match(out, /skipped 4:/, `skips were not reported: ${out}`);
    assert.match(out, /2 not text \(\.pdf \.png\)/, out);
    assert.match(out, /1 not indexed unless named \(\.puml\)/, out);
    assert.match(out, /1 excluded directory \(build\)/, out);

    // A stylesheet is source, so it goes in without being asked for.
    assert.match(cli(repo, ['search', 'redzulu']), /style\.css/, 'stylesheet not indexed');

    // An export waits to be named -- and then goes in.
    assert.doesNotMatch(cli(repo, ['search', 'startuml']), /diagram\.puml/, 'export swept up');
    cli(repo, ['ingest', 'docs/diagram.puml']);
    assert.match(cli(repo, ['search', 'startuml']), /diagram\.puml/, 'naming it did not work');
  } finally {
    repo.cleanup();
  }
});

test('a language nobody has heard of is indexed anyway', async () => {
  const repo = makeRepo({
    'src/main.zig': 'pub fn zigMain() void {}\n',
    'src/app.nim': 'proc nimProc() = discard\n',
    // The case an extension list can never cover, and the reason there is no
    // list: a project using a language this build was never told about must
    // still work, and must not fail silently when it does not.
    'src/x.somethingnobodyhasheardof': 'function futureLang() { alphazulu }\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);

    assert.match(cli(repo, ['search', 'zigMain']), /main\.zig/, 'zig not indexed');
    assert.match(cli(repo, ['search', 'nimProc']), /app\.nim/, 'nim not indexed');
    assert.match(
      cli(repo, ['search', 'alphazulu']),
      /somethingnobodyhasheardof/,
      'an unknown extension was dropped',
    );
  } finally {
    repo.cleanup();
  }
});

test('secrets and machine bookkeeping are never swept up', async () => {
  const repo = makeRepo({
    'src/keep.js': 'export function keepMe() { return 1; }\n',
    'src/.env': 'SECRET_KEY=hunterzulu\n',
    'src/app.min.js': '!function(){ minjszulu }();\n',
    'src/yarn.lock': '# lockfile zululock\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest', 'src']);

    // A credential must not reach an embedding at all. Redaction runs later,
    // and later is too late for a file that was never worth reading.
    for (const secret of ['hunterzulu', 'minjszulu', 'zululock']) {
      assert.doesNotMatch(cli(repo, ['search', secret]), /src\//, `${secret} was indexed`);
    }
    assert.match(out, /secret or machine bookkeeping/, `no reason given: ${out}`);
    assert.match(cli(repo, ['search', 'keepMe']), /keep\.js/, 'the real source went with them');
  } finally {
    repo.cleanup();
  }
});

test('a large source file is indexed rather than refused', async () => {
  const repo = makeRepo({ 'docs/note.md': '# N\n\nsierra tango.\n' });
  try {
    // Big code is a big part of the project. A layer that quietly declines to
    // index the largest modules is worse than one that takes a while.
    fs.mkdirSync(path.join(repo.dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repo.dir, 'src/big.js'),
      'export function fnZulu() { return 1; }\n'.repeat(3000),
    );

    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest', 'src']);
    assert.doesNotMatch(out, /too large/, `source refused for its size: ${out}`);
    assert.match(cli(repo, ['search', 'fnZulu']), /big\.js/, 'large source not searchable');
  } finally {
    repo.cleanup();
  }
});

test('--verbose names the skipped files', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\nnovember oscar.\n',
    'docs/shot.png': 'bytes\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const terse = cli(repo, ['ingest', 'docs']);
    assert.match(terse, /--verbose to list them/);
    assert.doesNotMatch(terse, /docs\/shot\.png/, 'the terse form listed every file');

    fs.rmSync(path.join(repo.dir, '.memory'), { recursive: true, force: true });
    cli(repo, ['init', '--no-scan']);
    const loud = cli(repo, ['ingest', 'docs', '--verbose']);
    assert.match(loud, /docs\/shot\.png/, `--verbose named nothing: ${loud}`);
  } finally {
    repo.cleanup();
  }
});

test('an explicitly named directory is read whatever it is called', async () => {
  const repo = makeRepo({ 'docs/build/generated.md': '# Generated\n\npapa quebec.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    // The block list applies to what a walk wanders into, not to a path the
    // user typed. Naming it outright is the way past it.
    cli(repo, ['ingest', 'docs/build']);
    assert.match(cli(repo, ['search', 'papa quebec']), /generated\.md/);
  } finally {
    repo.cleanup();
  }
});

test('an export is left alone whatever it weighs, and said so', async () => {
  const repo = makeRepo({ 'docs/note.md': '# Note\n\nromeo sierra.\n' });
  try {
    fs.writeFileSync(path.join(repo.dir, 'docs/huge.svg'), `<svg>${'x'.repeat(1_100_000)}</svg>`);
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest', 'docs']);
    assert.match(out, /not indexed unless named/, `an export was swept up silently: ${out}`);
    assert.match(out, /name the file to index it anyway/, `no way out was offered: ${out}`);
  } finally {
    repo.cleanup();
  }
});

test('titles separate files that share a basename', async () => {
  const repo = makeRepo({
    'docs/api/README.md': '# API\n\nTong quan tango uniform.\n',
    'docs/db/README.md': '# DB\n\nTong quan tango uniform.\n',
    'docs/adr/README.md': '# ADR\n\nTong quan tango uniform.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);

    const hits = JSON.parse(cli(repo, ['search', 'tango uniform', '--limit', '3', '--json']));
    const titles = hits.results.map((hit) => hit.title);
    assert.equal(new Set(titles).size, titles.length, `identical titles: ${JSON.stringify(titles)}`);
    for (const title of titles) {
      assert.match(title, /^(api|db|adr) \//, `no directory context in ${JSON.stringify(title)}`);
    }
  } finally {
    repo.cleanup();
  }
});

test('--json output stays parseable when a scan is announced', async () => {
  const repo = makeRepo({ 'docs/note.md': '# Note\n\nvictor whiskey.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    // Announcing on stdout would make this no longer JSON.
    const out = cli(repo, ['ingest', '--json']);
    const parsed = JSON.parse(out);
    assert.equal(parsed.created, 1, JSON.stringify(parsed));
  } finally {
    repo.cleanup();
  }
});

test('a project with nothing conventional says so instead of failing obscurely', async () => {
  const repo = makeRepo({ 'random.md': '# R\n\nxray yankee.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const result = cliRaw(repo, ['ingest']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Point it somewhere/, result.stderr);
  } finally {
    repo.cleanup();
  }
});

test('--quiet prints nothing, because a post-commit hook should not chatter', async () => {
  const repo = makeRepo({
    'docs/note.md': '# Note\n\nyankee zulu.\n',
    'docs/shot.png': 'bytes\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    // The documented post-commit hook used this flag and it did not exist: it
    // parsed as an unknown flag and was ignored, so the hook printed a full
    // report on every commit. A flag a document promises has to be real.
    const out = cli(repo, ['ingest', '--quiet']);
    assert.equal(out.trim(), '', `--quiet still printed: ${JSON.stringify(out)}`);

    // Silent, not inert.
    assert.match(cli(repo, ['search', 'yankee zulu']), /note\.md/, '--quiet skipped the work');
  } finally {
    repo.cleanup();
  }
});

test('html, xml and config are source, not documents', async () => {
  const repo = makeRepo({
    // A template, an Android layout and a Spring config are part of how the
    // thing works, not documents about it. Making the user name them one by one
    // would leave the front half of a web project out of the store.
    'src/page.html': '<html><body>alphahtml</body></html>\n',
    'src/layout.xml': '<LinearLayout><Text>bravoxml</Text></LinearLayout>\n',
    'src/app.conf': 'timeout = charlieconf\n',
    'src/setup.ini': '[main]\nkey = deltaini\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest', 'src']);
    assert.doesNotMatch(out, /not indexed unless named/, `source treated as a document: ${out}`);

    for (const [term, file] of [
      ['alphahtml', /page\.html/], ['bravoxml', /layout\.xml/],
      ['charlieconf', /app\.conf/], ['deltaini', /setup\.ini/],
    ]) {
      assert.match(cli(repo, ['search', term]), file, `${term} not indexed`);
    }
  } finally {
    repo.cleanup();
  }
});

test('naming a binary file is refused rather than reported as success', async () => {
  const repo = makeRepo({ 'docs/note.md': '# N\n\nechozulu.\n' });
  try {
    fs.writeFileSync(
      path.join(repo.dir, 'docs/report.pdf'),
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0xff, 0xfe, 0x00]),
    );
    cli(repo, ['init', '--no-scan']);

    // Naming a file overrules policy, not physics. This used to report
    // `1 new, 1 embedded` and store the raw bytes as a vector, exit 0 -- a
    // success message for a node nobody could ever read.
    const result = cliRaw(repo, ['ingest', 'docs/report.pdf']);
    assert.equal(result.status, 1, `a binary was accepted: ${result.stdout}`);
    assert.match(result.stderr, /not a text file/, result.stderr);
    assert.match(result.stderr, /memory write/, 'no alternative offered');

    const doctor = cli(repo, ['doctor']);
    assert.match(doctor, /store\s+\w+\s+0 nodes/, `the store was polluted: ${doctor}`);
  } finally {
    repo.cleanup();
  }
});

test('build output and vendored dependencies stay out of the graph', async () => {
  const repo = makeRepo({
    'src/real.js': 'export function realCode() { return 1; }\n',
    'src/bin/deploy.sh': 'echo binscriptzulu\n',
    // What `npm build`, `mvn package`, `dotnet build` and friends leave behind,
    // placed where a walk of `src` will actually meet them. Naming a directory
    // outright still wins, so testing this by naming `dist` would test nothing.
    'src/dist/bundle.js': 'export function distZulu() {}\n',
    'src/out/app.js': 'export function outZulu() {}\n',
    'src/obj/gen.cs': 'class ObjZulu {}\n',
    'src/build/gen.js': 'export function buildZulu() {}\n',
    'src/target/T.java': 'class TargetZulu {}\n',
    'src/vendor/v.php': '<?php function vendorZulu() {}\n',
    'src/node_modules/pkg/i.js': 'export function nmZulu() {}\n',
    'src/.next/static/n.js': 'export function nextZulu() {}\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);

    for (const term of [
      'distZulu', 'outZulu', 'ObjZulu', 'buildZulu',
      'TargetZulu', 'vendorZulu', 'nmZulu', 'nextZulu',
    ]) {
      assert.doesNotMatch(cli(repo, ['search', term]), /#L/, `${term} was indexed`);
    }

    assert.match(cli(repo, ['search', 'realCode']), /real\.js/, 'real source was lost');
    // `bin` holds hand-written scripts often enough that skipping it would lose
    // source rather than output.
    assert.match(cli(repo, ['search', 'binscriptzulu']), /deploy\.sh/, 'bin/ was skipped');
  } finally {
    repo.cleanup();
  }
});
