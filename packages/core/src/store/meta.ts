import fs from 'node:fs';
import { writeFileAtomic } from '../util/atomic.js';
import path from 'node:path';
import type { Capabilities } from '../types.js';
import { SCHEMA_VERSION, MIGRATABLE_FROM } from './schema.js';

export interface StoreMeta {
  projectName: string;
  projectRoot: string;
  remoteUrl?: string | null;
  branch?: string | null;
  lastCommit?: string | null;
  schemaVersion: number;
  dimensions: number;
  embedding: { model: string; provider: string } | null;
  capabilities?: Capabilities;
  /** Monotonic counter; a read-only handle uses it to detect its snapshot is old. */
  writeSeq: number;
  /**
   * Per ingested file, `<chunker version>:<content hash>`, so a second ingest
   * only touches what moved -- or what an older reader read.
   */
  fileHashes?: Record<string, string>;
  /**
   * Which tokenizer built the postings. Indexing and querying must agree, so a
   * store written by an older tokenizer answers keyword queries with a
   * half-matching index and no error -- exactly the failure C4 exists to stop.
   */
  tokenizerVersion?: number;
  indexedAt?: string;
}

/**
 * Whether a store of this version can be brought forward in place.
 *
 * Versions from MIGRATABLE_FROM up added tables and nothing else, so running
 * the DDL again is the whole migration. Anything older changed the shape of
 * what was already there and is refused.
 */
export function migratable(version: number | undefined): boolean {
  return typeof version === 'number' && version >= MIGRATABLE_FROM && version <= SCHEMA_VERSION;
}

function metaPath(dir: string): string {
  return path.join(dir, 'meta.json');
}

export function readMeta(dir: string): StoreMeta {
  const file = metaPath(dir);
  if (!fs.existsSync(file)) {
    throw new Error(`No memory store at ${dir}. Run \`dai-memory init\` first.`);
  }
  const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as StoreMeta;
  if (meta.schemaVersion !== SCHEMA_VERSION && !migratable(meta.schemaVersion)) {
    throw new Error(
      `Store schema version ${meta.schemaVersion} does not match this build (${SCHEMA_VERSION}). ` +
        `Re-run \`dai-memory init\` in a fresh directory rather than reading it as-is.`,
    );
  }
  return meta;
}

export function writeMeta(dir: string, meta: StoreMeta): void {
  fs.mkdirSync(dir, { recursive: true });
  // Write-then-rename: a torn meta.json would make the whole store unreadable.
  writeFileAtomic(metaPath(dir), JSON.stringify(meta, null, 2));
}

export function updateMeta(dir: string, patch: Partial<StoreMeta>): StoreMeta {
  const next = { ...readMeta(dir), ...patch };
  writeMeta(dir, next);
  return next;
}

/**
 * Advances the write counter, optionally folding in other metadata changes.
 *
 * The patch rides along in the same write so there is no window where the
 * counter says the store moved but the metadata describing it has not -- and no
 * second meta write that could fail on its own.
 *
 * Only ever called from MemoryStore.transact, after a successful COMMIT.
 */
export function bumpWriteSeq(dir: string, patch: Partial<StoreMeta> = {}): StoreMeta {
  const meta = { ...readMeta(dir), ...patch };
  meta.writeSeq = readMeta(dir).writeSeq + 1;
  meta.indexedAt = new Date().toISOString();
  writeMeta(dir, meta);
  return meta;
}
