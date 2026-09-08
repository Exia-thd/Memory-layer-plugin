import { Database, Connection } from '@ladybugdb/core';
import fs from 'node:fs';
import path from 'node:path';
import type { Capabilities, Capability } from '../types.js';
import { probeAstChunking } from '../ingest/languages.js';
import { log } from '../util/log.js';

/**
 * What this platform can actually do, probed once at init and recorded.
 *
 * Recording beats re-probing: a capability discovered at query time is a
 * capability nobody saw fail. `doctor` reads this block, and search reports any
 * branch it disables because of it.
 */
export async function probeCapabilities(storeDir: string): Promise<Capabilities> {
  const probeDir = path.join(storeDir, 'probe.lbug');
  const capabilities: Capabilities = {
    graph: { provider: 'ladybugdb', status: 'available' },
    fts: {
      provider: 'js-bm25',
      status: 'available',
      reason: 'BM25 is implemented in-process; the LadybugDB FTS extension is not required.',
    },
    vectorSearch: {
      provider: 'exact-scan',
      status: 'available',
      exactScanLimit: EXACT_SCAN_LIMIT,
      reason: 'No vector index on this platform; cosine similarity runs as an exact scan.',
    },
    embeddings: { provider: 'unknown', status: 'unavailable', reason: 'Not probed yet.' },
    // Ingest gets a capability line too. Anything that can be absent while the
    // system keeps working needs one -- the AST chunker was absent for its whole
    // existence, fell back to character windows, and reported nothing.
    astChunking: await probeAstChunking(),
  };

  let db: Database | null = null;
  let conn: Connection | null = null;
  try {
    // Probing happens before the real store exists, so the directory may not be there yet.
    fs.mkdirSync(storeDir, { recursive: true });
    db = new Database(probeDir);
    conn = new Connection(db);
    await conn.query('RETURN 1');
  } catch (err) {
    capabilities.graph = {
      provider: 'ladybugdb',
      status: 'unavailable',
      reason: `Could not open a LadybugDB database: ${message(err)}`,
    };
    return capabilities;
  }

  // The official extensions are frequently absent; that is expected, not fatal.
  for (const [name, key] of [['fts', 'fts'], ['vector', 'vectorSearch']] as const) {
    try {
      await conn.query(`LOAD ${name}`);
      capabilities[key] = {
        provider: `ladybugdb-${name}`,
        status: 'available',
        reason: `LadybugDB ${name} extension loaded.`,
      };
    } catch (err) {
      log('debug', `extension ${name} unavailable`, message(err));
    }
  }

  // The built-in cosine function needs no extension, and is what the exact scan uses.
  try {
    await conn.query('CREATE NODE TABLE IF NOT EXISTS CapProbe(id STRING, v FLOAT[4], PRIMARY KEY(id))');
    await conn.query("MERGE (c:CapProbe {id: 'probe'}) SET c.v = [1.0, 0.0, 0.0, 0.0]");
    const result = await conn.query(
      'MATCH (c:CapProbe) RETURN array_cosine_similarity(c.v, CAST([1.0,0.0,0.0,0.0] AS FLOAT[4])) AS s',
    );
    const rows = (await (result as { getAll(): Promise<unknown[]> }).getAll()) as { s?: number }[];
    if (!rows[0] || Math.abs(Number(rows[0].s) - 1) > 1e-3) {
      throw new Error(`array_cosine_similarity returned ${JSON.stringify(rows[0])}`);
    }
  } catch (err) {
    capabilities.vectorSearch = {
      provider: 'none',
      status: 'unavailable',
      reason: `Neither a vector index nor array_cosine_similarity is usable: ${message(err)}`,
    };
  }

  try {
    await conn.close();
  } catch {
    // Nothing depends on the probe connection closing cleanly.
  }
  // The probe database is scratch; leaving it behind would confuse anyone reading
  // the store directory, and it would hold a lock nobody asked for.
  fs.rmSync(probeDir, { recursive: true, force: true });
  return capabilities;
}

/** Ceiling on an exact scan, so a large store degrades in latency rather than falling over. */
export const EXACT_SCAN_LIMIT = 10_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The detail half of a capability line, without the name or status column. */
export function summarizeCapability(capability: Capability): string {
  return `${capability.provider}${capability.reason ? ` -- ${capability.reason}` : ''}`;
}
