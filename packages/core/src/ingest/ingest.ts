import fs from 'node:fs';
import { TOKENIZER_VERSION } from '../util/tokenize.js';
import path from 'node:path';
import type { MemoryStore } from '../store/store.js';
import type { Layer, MemoryNode } from '../types.js';
import type { EmbeddingProvider } from '../embed/index.js';
import { chunk, declarations } from './chunker.js';
import { redact } from './redact.js';
import { loadMemIgnore, isIgnored, type MemIgnore } from './memignore.js';
import { nodeId, contentHash } from '../util/ids.js';
import { log } from '../util/log.js';

export interface IngestOptions {
  layer?: Layer;
  importance?: number;
  confidence?: number;
  /** Re-embed and rewrite even when the file hash is unchanged. */
  force?: boolean;
  /** Bytes past which a file found by walking is left alone. Naming it wins regardless. */
  maxFileBytes?: number;
  embedder?: EmbeddingProvider | null;
}

export interface IngestReport {
  files: number;
  skipped: number;
  created: number;
  refreshed: number;
  embedded: number;
  /** Declarations named while chunking, and tied to the memory about them. */
  symbols: number;
  /** Previous versions of a re-ingested file, dropped because nothing referenced them. */
  removed: number;
  /** Previous versions kept but retired, because an edge still points at them. */
  superseded: number;
  /** Files the store held that are no longer on disk, and were reclaimed. */
  vanished: number;
  /** Declarations dropped because the file stopped making them. */
  symbolsRemoved: number;
  /** Files the walk passed over, with the reason. Never silent. */
  ignored: IgnoredFile[];
  /** Files that produced far more chunks than their size suggests. */
  dense: { path: string; chunks: number; kb: number }[];
  redactions: { rule: string; count: number }[];
}

export type IgnoreReason =
  | '.memignore'
  | 'not text'
  | 'not indexed unless named'
  | 'secret or machine bookkeeping'
  | 'excluded directory'
  | 'too large';

export interface IgnoredFile {
  /** Repository-relative where possible, absolute otherwise. */
  path: string;
  reason: IgnoreReason;
  /** The extension, directory name, or size that decided it. */
  detail: string;
}

/**
 * Directories a walk never enters on its own.
 *
 * Everything here is either a dependency someone else wrote or the output of a
 * build, and indexing either one buries the project's own code under code
 * nobody in this repository is responsible for. Anything beginning with a dot
 * is already skipped by a separate rule, which covers `.next`, `.turbo`,
 * `.nuxt`, `.gradle`, `.terraform`, `.pytest_cache` and their kin -- so what is
 * listed here is only the build outputs that do not announce themselves that
 * way.
 *
 * `bin` is deliberately absent: plenty of repositories keep real, hand-written
 * scripts in it, and skipping those would lose source rather than output.
 *
 * Being wrong here is recoverable and visible: each skipped directory is
 * reported with the reason, and naming it outright indexes it anyway.
 */
const SKIP_DIRECTORIES = new Set([
  // Dependencies someone else wrote.
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'Pods',
  'site-packages', 'deps', '.venv', 'venv', '.git', '.memory',
  // Build and test output.
  'dist', 'build', '_build', 'target', 'out', 'obj', 'Debug', 'Release',
  'cmake-build-debug', 'cmake-build-release',
  '__pycache__', '.next', '.cache', 'coverage', 'htmlcov',
]);

/**
 * The size past which a *machine-generated* file is left alone.
 *
 * Source and prose are never refused for being large, whatever they weigh. A
 * big file of real code is a big part of the project, and a layer that quietly
 * declines to index the largest modules is worse than one that takes a while.
 * Cost is reported instead, per file, so it is a fact rather than a surprise.
 *
 * The limit applies only to the formats that are large *because* a tool wrote
 * them: an exported diagram is mostly coordinates, and megabytes of it carry
 * about as much searchable meaning as a filename. Even here it is a default,
 * not a rule -- naming the file outright bypasses it, and --max-file-size
 * moves it.
 */
export const DEFAULT_MAX_FILE_BYTES = 20_000_000;


/**
 * The chunk count past which one file is worth mentioning on its own.
 *
 * Not a limit -- nothing is refused for being dense. It is the point at which a
 * single file has become a large fraction of the store, which is a fact the
 * person running the command would want to know and currently cannot see.
 */
const DENSE_CHUNK_COUNT = 500;

/**
 * Which files a walk picks up, decided by exclusion rather than by a list.
 *
 * An allow-list of code extensions is a list that is always slightly wrong:
 * GitHub's own catalogue runs to roughly a thousand entries, and any hand-kept
 * subset silently omits whichever language a project actually uses. The failure
 * is invisible -- the store just knows less, and says nothing.
 *
 * So the question is inverted. Anything that is text is indexed, whatever the
 * extension and whatever the size, and the only lists here are of things that
 * must NOT be swept up on their own. Those lists are short, they are about
 * categories rather than languages, and being wrong about one is visible: it is
 * reported as a skip, with the way to overrule it.
 */

/** Not text, so there is nothing to index. Read them with an agent instead. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.avif',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.webm', '.ogg', '.flac',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2', '.xz', '.jar', '.war',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.wasm',
  '.pyc', '.pyo', '.node', '.db', '.sqlite', '.sqlite3',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.psd', '.ai', '.sketch', '.fig', '.blend',
]);

/**
 * Text, but never swept up: it would be indexing a secret or a machine's
 * bookkeeping. A credential must not reach an embedding at all -- redaction
 * runs later, and later is too late if the file was never worth reading.
 */
const NEVER_AUTO = new Set([
  '.env', '.pem', '.key', '.pfx', '.p12', '.keystore', '.jks', '.crt', '.cer',
  '.lock', '.log', '.map', '.tsbuildinfo', '.pid', '.pack', '.idx',
  '.min.js', '.min.css', '.bundle.js', '.chunk.js',
]);

const NEVER_AUTO_NAMES = new Set([
  '.env.local', '.env.production', '.env.development',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'poetry.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum',
  'id_rsa', 'id_ed25519', '.npmrc', '.netrc', 'credentials',
]);

/**
 * Documents and exports: indexed when asked for by name, never by wandering in.
 *
 * Storing one of these wholesale is usually the wrong move. What is worth
 * keeping is the conclusion somebody drew from it, written with `memory write`
 * and a source_ref pointing back at the file -- not a few thousand chunks of
 * path coordinates. But sometimes the file itself is the reference, so:
 *
 *     memory ingest docs/figma/tokens.svg
 *
 * Markdown is the exception and is always swept up: it is the format things get
 * converted into precisely so that they can be read.
 */
const NAMED_ONLY_EXTENSIONS = new Set([
  // Exports from a design or diagram tool: mostly coordinates, and the useful
  // part is the conclusion somebody drew from looking at one.
  '.svg', '.drawio', '.puml', '.plantuml', '.mermaid', '.mmd', '.excalidraw',
  // Documents and tabular data. The binary members of this family -- .docx,
  // .xlsx, .pdf -- cannot be indexed at all and are refused outright; these are
  // the ones that happen to be text, and they get the same treatment for the
  // same reason.
  '.csv', '.tsv', '.rtf',
]);

// Deliberately NOT here: .html, .htm, .xml, .ini, .cfg, .conf, .properties.
// A template, an Android layout, a Spring config are source -- they are part of
// how the thing works, not documents about it.


/**
 * Whether the bytes are text.
 *
 * The extension lists cannot cover an extension nobody has seen, and a project
 * with a language this build has never heard of is exactly the case that must
 * still work. A NUL byte in the first few kilobytes is the same test `git` and
 `* `grep` use, and it is right often enough to be the last word here.
 */
function looksLikeText(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(8192);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, read).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * The single write path: files go straight into the one store.
 *
 * There is no intermediate format and no import step, because a pipeline that
 * writes one place and reads another is a pipeline that can be wired up wrong
 * and still look like it worked.
 */
export async function ingest(
  store: MemoryStore,
  targets: string[],
  options: IngestOptions = {},
): Promise<IngestReport> {
  const report: IngestReport = {
    files: 0, skipped: 0, created: 0, refreshed: 0, embedded: 0, symbols: 0,
    removed: 0, superseded: 0, vanished: 0, symbolsRemoved: 0,
    ignored: [], dense: [], redactions: [],
  };
  const redactionTotals = new Map<string, number>();
  const meta = store.getMeta();
  const fileHashes = { ...(meta.fileHashes ?? {}) };
  const projectRoot = meta.projectRoot;

  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const ignore = loadMemIgnore(projectRoot);
  const files = targets.flatMap((target) =>
    collectFiles(target, projectRoot, report.ignored, maxBytes, ignore));

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relative = path.relative(projectRoot, file).split(path.sep).join('/');
    const hash = contentHash(content);

    // Embedding is the expensive step; an unchanged file is not worth paying for.
    if (!options.force && fileHashes[relative] === hash) {
      report.skipped += 1;
      continue;
    }

    report.files += 1;
    const pieces = await chunk(file, content);

    // Cost is chunks, not bytes, and the two come apart badly.
    //
    // Measured: 3 MB of prose becomes 3,444 chunks; 300 KB of densely declared
    // source becomes 7,494, because chunking cuts at declaration boundaries. A
    // size limit therefore guards the obvious case and misses the expensive
    // one. Reported rather than refused -- a generated API client and a
    // hand-written core module look identical from here, and only the person
    // who has read the file knows which it is.
    if (pieces.length >= DENSE_CHUNK_COUNT && pieces.length > content.length / 400) {
      report.dense.push({
        path: relative,
        chunks: pieces.length,
        kb: Math.round(content.length / 1024),
      });
    }
    // Named once per file, not once per chunk: a file small enough to fit in a
    // single chunk is never cut, and would otherwise declare nothing.
    const declared = await declarations(file, content);

    // Redaction and embedding happen before the transaction opens. Both are slow,
    // and a write transaction holds the store's exclusive lock -- there is no
    // reason for an embedding round trip to block every other writer.
    const prepared: {
      node: MemoryNode;
      vector: number[] | null;
      symbols: { name: string; kind: string; startLine: number; endLine: number }[];
    }[] = [];

    for (const [index, piece] of pieces.entries()) {
      // Redaction runs here, before the text reaches an embedder. Once a secret
      // is in a vector, masking the text afterwards changes nothing.
      const { text, redactions } = redact(piece.text);
      for (const entry of redactions) {
        redactionTotals.set(entry.rule, (redactionTotals.get(entry.rule) ?? 0) + entry.count);
      }

      const sourceRef = `${relative}#L${piece.startLine}-L${piece.endLine}`;
      if (!sourceRef.includes('#L')) {
        throw new Error(`Refusing to write a chunk without a traceable source_ref: ${relative}`);
      }

      const layer = options.layer ?? 'artifact';
      // The title is derived from a heading or a path, and both are authored
      // text that can carry a secret. It is embedded alongside the body and
      // indexed for keyword search, so it goes through redaction on the same
      // terms -- as `write` already does for the title it is handed.
      const { text: title, redactions: titleRedactions } = redact(
        titleFor(piece.headingPath, relative, index, pieces.length),
      );
      for (const entry of titleRedactions) {
        redactionTotals.set(entry.rule, (redactionTotals.get(entry.rule) ?? 0) + entry.count);
      }
      const now = Date.now();
      const node: MemoryNode = {
        id: nodeId(layer, sourceRef, text),
        layer,
        title,
        body: text,
        sourceRef,
        filePath: relative,
        importance: options.importance ?? 3,
        confidence: options.confidence ?? 0.7,
        createdAt: now,
        lastSeenAt: now,
        accessCount: 0,
        supersededAt: null,
        embedding: null,
      };

      let vector: number[] | null = null;
      if (options.embedder) {
        try {
          vector = (await options.embedder.embed([`${title}\n${text}`]))[0] ?? null;
        } catch (err) {
          // The node is still worth storing; losing its vector costs recall on
          // one branch, and is reported rather than aborting the whole ingest.
          log('warn', `embedding failed for ${sourceRef}`, err);
        }
      }

      const covered = declared.filter(
        (item) => item.startLine >= piece.startLine && item.startLine <= piece.endLine,
      );
      prepared.push({ node, vector, symbols: covered });
    }

    // One transaction per file, matching the granularity of fileHashes: an ingest
    // that fails halfway leaves whole files done and the rest untouched, so the
    // next run picks up exactly where this one stopped.
    const fileHash = { ...fileHashes, [relative]: hash };
    const counts = await store.transact(async () => {
      let created = 0;
      let refreshed = 0;
      let embedded = 0;
      let symbols = 0;

      for (const { node, vector, symbols: declaredHere } of prepared) {
        const outcome = await store.upsertNode(node);
        if (outcome === 'created') created += 1;
        else refreshed += 1;

        // The declaration and the memory about it land in the same transaction:
        // a symbol with no memory, or a memory whose symbol never arrived, is a
        // half-written graph nobody would notice.
        for (const declaration of declaredHere) {
          const symbolId = `Symbol:${relative}:${declaration.name}`;
          await store.upsertSymbol({
            id: symbolId,
            name: declaration.name,
            filePath: relative,
            kind: declaration.kind,
            startLine: declaration.startLine,
            endLine: declaration.endLine,
          });
          await store.linkAbout(node.id, symbolId);
          symbols += 1;
        }

        if (vector && options.embedder && outcome === 'created') {
          await store.setEmbedding(node.id, vector, options.embedder.identity);
          embedded += 1;
        }
      }
      // Declarations the file has stopped making.
      //
      // Symbols were upserted and never removed, so renaming a function left
      // the old name in the graph with its original line range, pointing at
      // code that is gone. The file was just parsed, so what it declares is
      // known exactly -- this is the one moment the answer is available.
      const declaredIds = new Set(declared.map((item) => `Symbol:${relative}:${item.name}`));
      const goneSymbols = (await store.symbolsInFile(relative))
        .filter((symbol) => !declaredIds.has(symbol.id))
        .map((symbol) => symbol.id);
      const symbolsRemoved = await store.deleteSymbols(goneSymbols);

      // Everything this file used to produce and no longer does.
      //
      // Chunk ids come from content, so an edited file yields new ids and the
      // previous versions stay behind: one file edited three times became three
      // nodes, all indexed, all answering the same query. Removed if nothing
      // points at them, superseded if something does -- a decision whose
      // DERIVED_FROM leads nowhere is worse than a stale chunk.
      const stale = await store.staleArtifacts(relative, prepared.map((item) => item.node.id));
      const removable: string[] = [];
      const keepable: string[] = [];
      for (const node of stale) {
        if (await store.hasEdges(node.id)) keepable.push(node.id);
        else removable.push(node.id);
      }
      const removed = await store.deleteNodes(removable);
      const superseded = await store.supersede(keepable);

      return { created, refreshed, embedded, symbols, removed, superseded, symbolsRemoved };
    }, { fileHashes: fileHash, tokenizerVersion: TOKENIZER_VERSION });

    report.created += counts.created;
    report.refreshed += counts.refreshed;
    report.embedded += counts.embedded;
    report.symbols += counts.symbols;
    report.removed += counts.removed;
    report.superseded += counts.superseded;
    report.symbolsRemoved += counts.symbolsRemoved;
    fileHashes[relative] = hash;
  }

  await reclaimVanished(store, targets, projectRoot, fileHashes, report);

  report.redactions = [...redactionTotals.entries()].map(([rule, count]) => ({ rule, count }));
  return report;
}

/**
 * Reclaims memories whose file is no longer on disk.
 *
 * The walk only ever meets files that exist, so a deleted file was never
 * revisited: its chunks stayed indexed, kept winning queries, and cited a
 * source_ref resolving to nothing. Every other reclamation happens inside the
 * loop over files, which is exactly why this case could not be caught there.
 *
 * Scope is the guard. Only paths under a target named in this run are
 * considered, because absence is evidence of deletion only where we actually
 * looked -- without that, `memory ingest docs` would reclaim the whole of src.
 * Existence on disk is the test, not membership of the walk: a file passed over
 * for its extension is ignored, not gone, and must survive untouched.
 */
async function reclaimVanished(
  store: MemoryStore,
  targets: string[],
  projectRoot: string,
  fileHashes: Record<string, string>,
  report: IngestReport,
): Promise<void> {
  const scopes: string[] = [];
  for (const target of targets) {
    const resolved = resolveTarget(target, projectRoot);
    const relative = path.relative(projectRoot, resolved).split(path.sep).join('/');
    // A target outside the repository has no comparable stored path; skip rather
    // than let `..` match a prefix by accident.
    if (relative.startsWith('..')) continue;
    scopes.push(relative);
  }
  if (scopes.length === 0) return;

  const inScope = (file: string) =>
    scopes.some((scope) => scope === '' || file === scope || file.startsWith(`${scope}/`));

  const vanished = (await store.artifactFiles()).filter(
    (file) => inScope(file) && !fs.existsSync(path.join(projectRoot, file)),
  );
  if (vanished.length === 0) return;

  const remaining = { ...fileHashes };
  for (const file of vanished) delete remaining[file];

  const counts = await store.transact(async () => {
    let removed = 0;
    let superseded = 0;
    let symbolsRemoved = 0;
    for (const file of vanished) {
      // Nothing is kept, so every id this file produced is stale.
      const stale = await store.staleArtifacts(file, []);
      const removable: string[] = [];
      const keepable: string[] = [];
      for (const node of stale) {
        if (await store.hasEdges(node.id)) keepable.push(node.id);
        else removable.push(node.id);
      }
      removed += await store.deleteNodes(removable);
      superseded += await store.supersede(keepable);
      symbolsRemoved += await store.deleteSymbols(
        (await store.symbolsInFile(file)).map((symbol) => symbol.id),
      );
      log('info', `reclaimed ${file}: no longer on disk`);
    }
    return { removed, superseded, symbolsRemoved };
  }, { fileHashes: remaining });

  report.vanished += vanished.length;
  report.removed += counts.removed;
  report.superseded += counts.superseded;
  report.symbolsRemoved += counts.symbolsRemoved;
}

/**
 * A title that says which file it came from, not merely what the file is called.
 *
 * A documentation tree that is organised has a README.md in every section, an
 * overview.md under each area, a 0001.md in each year. Titled by basename they
 * arrive as several identical lines and the reader has to drop to the
 * source_ref to tell them apart -- which is the moment a citation goes to the
 * wrong section. One directory of context is enough to separate them and short
 * enough to stay readable.
 */
function titleFor(
  headingPath: string[] | undefined,
  relative: string,
  index: number,
  total: number,
): string {
  const parent = path.dirname(relative).split('/').filter((part) => part && part !== '.').pop();
  const qualify = (label: string) => (parent ? `${parent} / ${label}` : label);

  if (headingPath && headingPath.length > 0) return qualify(headingPath.join(' > '));
  const base = path.basename(relative);
  // The piece number is part of the title so a reference stays locatable by eye.
  return qualify(total > 1 ? `${base} (${index + 1}/${total})` : base);
}

/**
 * Resolves a target the way every other part of the store reads a path.
 *
 * Paths were resolved against the current directory while the store, the
 * source_ref and the scan list were all anchored to the repository root. Two
 * origins in one command, so `memory ingest docs` worked at the root and failed
 * one directory down with `No such path: docs` -- for a path that plainly
 * exists. The root wins; the current directory is kept as a fallback so an
 * absolute or genuinely local path still resolves.
 */
function resolveTarget(target: string, root: string): string {
  if (path.isAbsolute(target)) return path.resolve(target);

  const fromRoot = path.resolve(root, target);
  if (fs.existsSync(fromRoot)) return fromRoot;

  const fromCwd = path.resolve(target);
  if (fs.existsSync(fromCwd)) return fromCwd;

  throw new Error(
    `No such path: ${target} (looked in ${fromRoot}` +
      (fromCwd === fromRoot ? ')' : ` and ${fromCwd})`),
  );
}

function collectFiles(
  target: string,
  root: string,
  ignored: IgnoredFile[],
  maxBytes: number,
  ignore: MemIgnore,
): string[] {
  const resolved = resolveTarget(target, root);
  const label = (full: string) => {
    const rel = path.relative(root, full);
    return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : full;
  };

  const stat = fs.statSync(resolved);
  // A path named outright is a decision already made: honour it whatever it is
  // called and whatever it weighs. `memory ingest docs/build` is the way past
  // the block list, and `memory ingest docs/figma/export.svg` past the
  // named-only rule -- a default the user can always overrule for one file.
  //
  // But naming a file overrules policy, not physics. `memory ingest report.pdf`
  // used to report `1 new, 1 embedded` and put the raw bytes in the store, as a
  // vector, exit 0 -- a success message for a node nobody can ever read. What
  // to index is the user's call; whether there is anything there to index is
  // not a matter of opinion.
  if (stat.isFile()) {
    if (!looksLikeText(resolved)) {
      throw new Error(
        `${target} is not a text file, so there is nothing to index. ` +
          'Read it with an agent and record the conclusion with `memory write`.',
      );
    }
    return [resolved];
  }

  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Dot-directories are dependency caches, tool state and build output.
      //
      // `.claude` was excepted here, but nothing ever made it a scan target, so
      // the exception could not fire -- a reader would conclude the layer
      // indexes a project's agent configuration, and it does not. An exception
      // that cannot run is worse than none: it describes behaviour that is not
      // there. Name it to index it, like any other skipped directory.
      if (entry.name.startsWith('.')) {
        if (entry.isDirectory()) {
          ignored.push({ path: label(full), reason: 'excluded directory', detail: entry.name });
        }
        continue;
      }
      const relative = path.relative(root, full).split(path.sep).join('/');

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          ignored.push({ path: label(full), reason: 'excluded directory', detail: entry.name });
          continue;
        }
        // Checked before descending, so an ignored tree costs one test rather
        // than one per file inside it.
        const rule = isIgnored(ignore, relative, true);
        if (rule) {
          ignored.push({ path: label(full), reason: '.memignore', detail: rule.source });
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const fileRule = isIgnored(ignore, relative, false);
      if (fileRule) {
        ignored.push({ path: label(full), reason: '.memignore', detail: fileRule.source });
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      const lower = entry.name.toLowerCase();
      // From the first dot, so `app.min.js` is `.min.js` and not `.js`.
      const compound = lower.slice(lower.indexOf('.'));

      if (NAMED_ONLY_EXTENSIONS.has(extension)) {
        ignored.push({ path: label(full), reason: 'not indexed unless named', detail: extension });
        continue;
      }
      if (BINARY_EXTENSIONS.has(extension)) {
        ignored.push({ path: label(full), reason: 'not text', detail: extension });
        continue;
      }
      if (
        NEVER_AUTO.has(extension) ||
        NEVER_AUTO.has(compound) ||
        NEVER_AUTO_NAMES.has(entry.name) ||
        NEVER_AUTO_NAMES.has(lower)
      ) {
        ignored.push({ path: label(full), reason: 'secret or machine bookkeeping', detail: entry.name });
        continue;
      }
      if (!looksLikeText(full)) {
        ignored.push({ path: label(full), reason: 'not text', detail: extension || '(none)' });
        continue;
      }
      // A runaway guard, not a policy: source and prose are indexed whatever
      // they weigh, and the default sits far above any file a person wrote.
      const size = fs.statSync(full).size;
      if (size > maxBytes) {
        ignored.push({
          path: label(full),
          reason: 'too large',
          detail: `${Math.round(size / 1024)} KB > ${Math.round(maxBytes / 1024)} KB`,
        });
        continue;
      }
      found.push(full);
    }
  };
  walk(resolved);
  return found;
}
