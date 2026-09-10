// Types only -- erased at compile time, so it does not load the binary.
import type { Database, Connection } from '@ladybugdb/core';
import { nativeLbug } from './native.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Capabilities, Capability } from '../types.js';
import { probeAstChunking } from '../ingest/languages.js';
import { TOKENIZER_SCRIPTS, TOKENIZER_VERSION } from '../util/tokenize.js';
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
      provider: 'persisted-bm25',
      status: 'available',
      reason:
        'Postings are stored alongside the nodes, so a query reads one row per term ' +
        'and no index is rebuilt at startup. The LadybugDB FTS extension is not required.',
    },
    vectorSearch: {
      provider: 'exact-scan',
      status: 'available',
      exactScanLimit: EXACT_SCAN_LIMIT,
      reason:
        'No vector index on this platform; cosine similarity is ranked inside the database ' +
        'by array_cosine_similarity, so cost grows with the number of embedded nodes.',
    },
    embeddings: { provider: 'unknown', status: 'unavailable', reason: 'Not probed yet.' },
    // The third fusion branch gets a line like the other two. It is unlikely to
    // fail, which is exactly the reasoning that left the AST chunker unwatched.
    recency: {
      provider: 'importance-halflife',
      status: 'available',
      reason: 'Ranks by importance and age; episodic memories fade, semantic ones do not.',
    },
    // The fourth branch, and the one this project spent a while not having while
    // calling itself GraphRAG. It contributes nothing on a store where nobody
    // has linked anything, which is a normal state and not a fault -- so it
    // reports the difference rather than returning an empty list that reads the
    // same as a branch that ran and found nothing.
    // The signal Mem0 calls entity linking. The store held the data -- ABOUT
    // edges from a memory to a named declaration -- and only `why` consulted
    // it, so an ordinary search ran three text branches over prose that may
    // never contain the symbol's name while the graph held the exact answer.
    entity: {
      provider: 'symbol-anchors',
      status: 'available',
      reason:
        'Returns memories anchored to a declaration the query names. Anchors are derived from ' +
        'a source_ref with a line span, so they appear as soon as decisions cite code.',
    },
    // `graph` above is the database engine; this is the retrieval branch that
    // walks it. Two different things, and one name for both would hide a failure
    // in either behind a healthy line about the other.
    graphWalk: {
      provider: 'one-hop-neighbours',
      status: 'available',
      reason:
        'Walks one hop from what the other branches found, in either direction, and ranks a ' +
        'neighbour by how many separate hits reach it. Contributes nothing until memories ' +
        'are linked to each other.',
    },
    // Which scripts survive tokenization. The first tokenizer was ASCII-only and
    // shredded every accented word without reporting anything.
    tokenizer: {
      provider: `unicode-fold-v${TOKENIZER_VERSION}`,
      status: 'available',
      version: TOKENIZER_VERSION,
      scripts: TOKENIZER_SCRIPTS,
      reason:
        'Unicode letters, folded to unaccented form so an unaccented query still matches, ' +
        'with CJK split into bigrams. English stopwords and stemming apply only to words ' +
        'that were ASCII before folding.',
    },
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
    db = new (nativeLbug().Database)(probeDir);
    conn = new (nativeLbug().Connection)(db);
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
