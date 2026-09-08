import fs from 'node:fs';
import path from 'node:path';
import type { Capabilities } from '../types.js';
import { SCHEMA_VERSION } from './schema.js';

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
  /** content hash per ingested file, so a second ingest only touches what moved. */
  fileHashes?: Record<string, string>;
  indexedAt?: string;
}

function metaPath(dir: string): string {
  return path.join(dir, 'meta.json');
}

export function readMeta(dir: string): StoreMeta {
  const file = metaPath(dir);
  if (!fs.existsSync(file)) {
    throw new Error(`No memory store at ${dir}. Run \`memory init\` first.`);
  }
  const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as StoreMeta;
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Store schema version ${meta.schemaVersion} does not match this build (${SCHEMA_VERSION}). ` +
        `Re-run \`memory init\` in a fresh directory rather than reading it as-is.`,
    );
  }
  return meta;
}

export function writeMeta(dir: string, meta: StoreMeta): void {
  fs.mkdirSync(dir, { recursive: true });
  // Write-then-rename: a torn meta.json would make the whole store unreadable.
  const tmp = `${metaPath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath(dir));
}

export function updateMeta(dir: string, patch: Partial<StoreMeta>): StoreMeta {
  const next = { ...readMeta(dir), ...patch };
  writeMeta(dir, next);
  return next;
}

export function bumpWriteSeq(dir: string): StoreMeta {
  const meta = readMeta(dir);
  meta.writeSeq += 1;
  meta.indexedAt = new Date().toISOString();
  writeMeta(dir, meta);
  return meta;
}
