import { EDGE_TYPES } from '../types.js';

/**
 * Bumped whenever the DDL below changes shape. `doctor` compares it against the
 * value recorded in meta.json and refuses to guess.
 */
export const SCHEMA_VERSION = 3;

/**
 * Vector width is a schema decision, not a runtime setting: it is baked into the
 * DDL as FLOAT[dims]. Changing it means rebuilding the table and re-embedding
 * everything, so it is fixed at init and recorded in meta.json.
 */
export const DEFAULT_DIMENSIONS = 384;

/**
 * Accepts plain digits only.
 *
 * `1e3` parses as 1000 by Number() but reads as FLOAT[1] to anything doing a
 * digit-wise read, which yields a table whose width disagrees with the embedder
 * at runtime. Rejecting the notation outright is cheaper than reconciling it.
 */
export function parseDimensions(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DIMENSIONS;
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(
      `Invalid embedding dimensions ${JSON.stringify(text)}: use plain digits only ` +
        `(got a form like 1e3, 0x10, 3.5, +5 or 4096x).`,
    );
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 8 || value > 8192) {
    throw new Error(`Embedding dimensions out of range: ${value} (expected 8..8192).`);
  }
  return value;
}

/**
 * One store holds nodes, edges and vectors together (C1). There is no second
 * store and therefore no migration step between writing and reading.
 */
export function ddl(dimensions: number): string[] {
  const statements: string[] = [
    `CREATE NODE TABLE IF NOT EXISTS Memory(
        id STRING,
        layer STRING,
        title STRING,
        body STRING,
        source_ref STRING,
        file_path STRING,
        importance DOUBLE,
        confidence DOUBLE,
        created_at INT64,
        last_seen_at INT64,
        access_count INT64,
        superseded_at INT64,
        embedding_model STRING,
        embedding_dims INT64,
        embedding_provider STRING,
        embedding FLOAT[${dimensions}],
        PRIMARY KEY(id)
     )`,
  ];

  // The keyword index lives in the same store as the nodes it describes, so it
  // cannot drift out of step with them and there is nothing to rebuild on start.
  // Postings are held per term rather than per (term, node) pair: a query reads
  // one row per query term instead of scanning millions of pairs.
  statements.push(
    `CREATE NODE TABLE IF NOT EXISTS Bm25Term(
        term STRING,
        postings STRING,
        df INT64,
        PRIMARY KEY(term)
     )`,
    `CREATE NODE TABLE IF NOT EXISTS Bm25Doc(
        node_id STRING,
        length INT64,
        PRIMARY KEY(node_id)
     )`,
    `CREATE NODE TABLE IF NOT EXISTS Bm25Stat(
        id STRING,
        doc_count INT64,
        total_length INT64,
        PRIMARY KEY(id)
     )`,
  );

  for (const type of EDGE_TYPES) {
    statements.push(
      `CREATE REL TABLE IF NOT EXISTS ${type}(
          FROM Memory TO Memory,
          weight DOUBLE,
          created_at INT64,
          evidence_ref STRING
       )`,
    );
  }

  return statements;
}
