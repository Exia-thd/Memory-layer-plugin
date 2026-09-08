import fs from 'node:fs';
import path from 'node:path';
import type { MemoryStore } from '../store/store.js';
import type { Layer, MemoryNode } from '../types.js';
import type { EmbeddingProvider } from '../embed/index.js';
import { chunk } from './chunker.js';
import { redact } from './redact.js';
import { nodeId, contentHash } from '../util/ids.js';
import { updateMeta } from '../store/meta.js';
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
    files: 0, skipped: 0, created: 0, refreshed: 0, embedded: 0, redactions: [],
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

    for (const [index, piece] of pieces.entries()) {
      // Redaction happens here, before the text reaches an embedder. Once a secret
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
      const title = titleFor(piece.headingPath, relative, index, pieces.length);
      const node: MemoryNode = {
        id: nodeId(layer, sourceRef, text),
        layer,
        title,
        body: text,
        sourceRef,
        filePath: relative,
        importance: options.importance ?? 3,
        confidence: options.confidence ?? 0.7,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        accessCount: 0,
        supersededAt: null,
        embedding: null,
      };

      const outcome = await store.upsertNode(node);
      if (outcome === 'created') report.created += 1;
      else report.refreshed += 1;

      if (options.embedder && outcome === 'created') {
        try {
          const [vector] = await options.embedder.embed([`${title}\n${text}`]);
          if (vector) {
            await store.setEmbedding(node.id, vector, options.embedder.identity);
            report.embedded += 1;
          }
        } catch (err) {
          // The node is already stored; losing its vector costs recall on one
          // branch, and is reported rather than aborting the whole ingest.
          log('warn', `embedding failed for ${sourceRef}`, err);
        }
      }
    }

    fileHashes[relative] = hash;
  }

  updateMeta(store.dir, { fileHashes });
  store.commit();

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
