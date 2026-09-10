import fs from 'node:fs';
import { TOKENIZER_VERSION } from '../util/tokenize.js';
import path from 'node:path';
import type { MemoryStore } from '../store/store.js';
import type { Layer, MemoryNode } from '../types.js';
import type { EmbeddingProvider } from '../embed/index.js';
import { chunk, declarations } from './chunker.js';
import { redact } from './redact.js';
import { nodeId, contentHash } from '../util/ids.js';
import { log } from '../util/log.js';

export interface IngestOptions {
  layer?: Layer;
  importance?: number;
  confidence?: number;
  /** Re-embed and rewrite even when the file hash is unchanged. */
  force?: boolean;
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
  redactions: { rule: string; count: number }[];
}

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv',
  '__pycache__', '.next', '.cache', 'coverage', '.memory',
]);

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.h', '.cpp', '.hpp',
  '.json', '.yaml', '.yml', '.toml',
]);

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
    removed: 0, superseded: 0, redactions: [],
  };
  const redactionTotals = new Map<string, number>();
  const meta = store.getMeta();
  const fileHashes = { ...(meta.fileHashes ?? {}) };
  const projectRoot = meta.projectRoot;

  const files = targets.flatMap((target) => collectFiles(target));

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

      return { created, refreshed, embedded, symbols, removed, superseded };
    }, { fileHashes: fileHash, tokenizerVersion: TOKENIZER_VERSION });

    report.created += counts.created;
    report.refreshed += counts.refreshed;
    report.embedded += counts.embedded;
    report.symbols += counts.symbols;
    report.removed += counts.removed;
    report.superseded += counts.superseded;
    fileHashes[relative] = hash;
  }

  report.redactions = [...redactionTotals.entries()].map(([rule, count]) => ({ rule, count }));
  return report;
}

function titleFor(
  headingPath: string[] | undefined,
  relative: string,
  index: number,
  total: number,
): string {
  if (headingPath && headingPath.length > 0) return headingPath.join(' > ');
  const base = path.basename(relative);
  // The piece number is part of the title so a reference stays locatable by eye.
  return total > 1 ? `${base} (${index + 1}/${total})` : base;
}

function collectFiles(target: string): string[] {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) throw new Error(`No such path: ${target}`);

  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];

  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  };
  walk(resolved);
  return found;
}
