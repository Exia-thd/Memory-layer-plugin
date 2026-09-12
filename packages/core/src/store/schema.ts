import { EDGE_TYPES } from '../types.js';

/**
 * Bumped whenever the DDL below changes shape. `doctor` compares it against the
 * value recorded in meta.json and refuses to guess.
 */
export const SCHEMA_VERSION = 7;

/**
 * The oldest schema this build can open by adding to it.
 *
 * Every statement in `ddl` is `IF NOT EXISTS`, so a store written by an older
 * build gains the new tables and keeps its rows. Refusing instead would throw
 * away a store because a table it has never heard of is missing.
 */
export const MIGRATABLE_FROM = 4;

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
/**
 * What a migration has to do before the DDL runs again.
 *
 * `CREATE TABLE IF NOT EXISTS` adds a missing table and silently leaves an
 * existing one alone -- including its columns. A store upgraded into version 6
 * kept a PendingCall table with no `reason` column, and every write to it
 * failed mid-ingest. Tables that are pure derived data are dropped here and
 * rebuilt by the next read of each file; anything holding recorded memory is
 * never on this list.
 */
export function migrationsTo(from: number): string[] {
  const statements: string[] = [];
  if (from < 6) statements.push('DROP TABLE IF EXISTS PendingCall');
  if (from < 7) {
    // The relation tables hang off File, so they go first. All three are read
    // back from the files themselves on the next ingest.
    statements.push(
      'DROP TABLE IF EXISTS IMPORTS',
      'DROP TABLE IF EXISTS DECLARES',
      'DROP TABLE IF EXISTS File',
    );
  }
  return statements;
}

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

  // The code graph: what a file declares, which memory is about it, and what
  // one declaration does to another. A call is stored with the confidence it
  // was resolved at, because a name matched across a repository is a different
  // claim from a name resolved through an import, and an impact report that
  // cannot tell them apart is worse than no impact report.
  statements.push(
    `CREATE NODE TABLE IF NOT EXISTS Symbol(
        id STRING,
        name STRING,
        file_path STRING,
        kind STRING,
        start_line INT64,
        end_line INT64,
        PRIMARY KEY(id)
     )`,
    `CREATE REL TABLE IF NOT EXISTS ABOUT(
        FROM Memory TO Symbol,
        weight DOUBLE,
        created_at INT64
     )`,
    `CREATE NODE TABLE IF NOT EXISTS File(
        path STRING,
        language STRING,
        container STRING,
        uses STRING,
        PRIMARY KEY(path)
     )`,
    `CREATE REL TABLE IF NOT EXISTS DECLARES(
        FROM File TO Symbol
     )`,
    `CREATE REL TABLE IF NOT EXISTS CALLS(
        FROM Symbol TO Symbol,
        name STRING,
        line INT64,
        confidence STRING
     )`,
    `CREATE REL TABLE IF NOT EXISTS INHERITS(
        FROM Symbol TO Symbol,
        confidence STRING
     )`,
    `CREATE REL TABLE IF NOT EXISTS IMPORTS(
        FROM File TO File,
        module STRING
     )`,
    // Call sites whose name matched nothing, kept rather than dropped: a later
    // ingest of the file that declares it resolves them, and until then the
    // count is what `doctor` reports instead of implying the graph is complete.
    `CREATE NODE TABLE IF NOT EXISTS PendingCall(
        id STRING,
        file_path STRING,
        from_symbol STRING,
        name STRING,
        receiver STRING,
        line INT64,
        kind STRING,
        reason STRING,
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
