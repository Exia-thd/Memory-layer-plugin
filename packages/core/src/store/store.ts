import fs from 'node:fs';
import path from 'node:path';
// Types only -- erased at compile time, so it does not load the binary.
import type { Database, Connection } from '@ladybugdb/core';
import { nativeLbug } from './native.js';
import type { MemoryNode, MemoryEdge, EdgeType, Layer, StoreStats, SymbolRow } from '../types.js';
import { EDGE_TYPES } from '../types.js';
import { ddl, SCHEMA_VERSION } from './schema.js';
import { readMeta, writeMeta, bumpWriteSeq, type StoreMeta } from './meta.js';
import { log } from '../util/log.js';
import { awaitHandleRelease } from './reopen.js';
import { tokenize } from '../util/tokenize.js';
import { decodePostings, encodePostings, type Postings } from '../search/postings.js';

/**
 * Lock behaviour, measured rather than assumed (see docs/m0-findings.md):
 *
 *   read-write handle  -> exclusive lock on the whole database directory.
 *                         A second writer fails fast; it does not corrupt.
 *   read-only handle   -> shared lock. Many readers coexist, and a writer can
 *                         commit while readers are open.
 *
 * That single flag is why this design needs no cross-platform process probing:
 * readers simply never take the lock that would block a writer.
 *
 * The cost is that a read-only handle serves the snapshot it saw when it opened,
 * and never sees later commits -- silently. `writeSeq` in meta.json is the guard:
 * a reader compares it before serving and reopens when it moved.
 */
export interface OpenOptions {
  readOnly?: boolean;
  bufferPoolBytes?: number;
}

/**
 * The store committed, but the counter that tells readers so did not advance.
 *
 * This is the worst state the store can be in and it must never pass quietly:
 * the data is durable, and every reader is pinned to the snapshot before it,
 * permanently. Louder than the write failing outright.
 */
export class WriteSeqError extends Error {
  constructor(dir: string, cause: unknown) {
    super(
      `Wrote to ${dir} successfully, but could not advance writeSeq in meta.json: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Readers will not see this write until meta.json is writable again.`,
    );
    this.name = 'WriteSeqError';
    this.cause = cause;
  }
}

export class StoreLockedError extends Error {
  constructor(dir: string, cause?: unknown) {
    super(
      `Another process holds the write lock on ${dir}. ` +
        `Writes are exclusive; retry, or let the session journal absorb the write.`,
    );
    this.name = 'StoreLockedError';
    this.cause = cause;
  }
}

function isLockError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not set lock|resource temporarily unavailable/i.test(message);
}

export class MemoryStore {
  readonly dir: string;
  readonly dbPath: string;
  readonly readOnly: boolean;
  private db: Database | null = null;
  private conn: Connection | null = null;
  private openedAtSeq = -1;
  private meta: StoreMeta | null = null;
  private transactionDepth = 0;
  /** Index updates accumulated during a transaction, written once at the end. */
  private termDelta = new Map<string, Postings>();
  private docDelta = new Map<string, number>();

  constructor(dir: string, private readonly options: OpenOptions = {}) {
    this.dir = dir;
    this.dbPath = path.join(dir, 'store.lbug');
    this.readOnly = options.readOnly ?? false;
  }

  /** Dimensions this store was created with. Fixed at init; never inferred later. */
  get dimensions(): number {
    return this.getMeta().dimensions;
  }

  getMeta(): StoreMeta {
    if (!this.meta) this.meta = readMeta(this.dir);
    return this.meta;
  }

  private async connection(): Promise<Connection> {
    const seq = readMeta(this.dir).writeSeq;

    // A read-only handle is frozen at its open point. When the store has moved on,
    // the handle is not stale-but-usable, it is wrong -- so replace it.
    if (this.conn && this.readOnly && seq !== this.openedAtSeq) {
      log('debug', 'reopening read-only handle after write', { was: this.openedAtSeq, now: seq });
      await this.close();
      // On Windows the old handle -- and its write-ahead log especially -- can
      // still be releasing. Reopening into that window fails on the first
      // statement, so wait for the release rather than discover it later.
      await awaitHandleRelease(this.dbPath);
    }

    if (this.conn) return this.conn;

    try {
      this.db = new (nativeLbug().Database)(
        this.dbPath,
        this.options.bufferPoolBytes ?? 0,
        true,
        this.readOnly,
      );
      this.conn = new (nativeLbug().Connection)(this.db);
      await this.conn.query('RETURN 1');
    } catch (err) {
      this.db = null;
      this.conn = null;
      if (!this.readOnly && isLockError(err)) throw new StoreLockedError(this.dir, err);
      throw err;
    }

    this.openedAtSeq = seq;
    this.meta = readMeta(this.dir);
    return this.conn;
  }

  async close(): Promise<void> {
    try {
      await this.conn?.close();
    } catch (err) {
      log('warn', 'closing connection failed', err);
    }

    // The Database owns the file handle; the Connection does not. Dropping the
    // reference without closing it leaves the handle to the garbage collector.
    //
    // Closing it does not make the path reopenable in this process on Windows --
    // measured, and the reason `create` now hands back an open store -- but a
    // handle that is released as soon as it is finished with is still the
    // behaviour to write, and it is what lets a fresh process open the store.
    try {
      await this.db?.close();
    } catch (err) {
      log('warn', 'closing database failed', err);
    }

    this.conn = null;
    this.db = null;
    this.openedAtSeq = -1;
  }

  async query(cypher: string): Promise<Record<string, unknown>[]> {
    const conn = await this.connection();
    return rows(await conn.query(cypher));
  }

  async run(cypher: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const conn = await this.connection();
    const statement = await conn.prepare(cypher);
    return rows(await conn.execute(statement, params as never));
  }

  /**
   * Creates the store directory, applies DDL and writes meta.json.
   *
   * The returned store is left **open**, and closing it is the caller's job.
   *
   * This is not a convenience. On Windows a LadybugDB path that has been opened
   * once in a process cannot be opened again in that same process, even after
   * `close()` -- the second open is refused as though another process held the
   * lock, and the process it names is this one. Closing here would therefore
   * hand back a store that nothing in this process could reopen, which is what
   * made `init` fail on its own doctor run.
   */
  static async create(dir: string, meta: Omit<StoreMeta, 'schemaVersion' | 'writeSeq'>): Promise<MemoryStore> {
    fs.mkdirSync(dir, { recursive: true });
    const full: StoreMeta = { ...meta, schemaVersion: SCHEMA_VERSION, writeSeq: 0 };
    writeMeta(dir, full);

    const store = new MemoryStore(dir);
    for (const statement of ddl(full.dimensions)) await store.query(statement);
    return store;
  }

  static exists(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'meta.json'));
  }

  /**
   * Writes a node, or refreshes one already present.
   *
   * Same id means same content from the same place, so the body is left alone and
   * only the access bookkeeping moves. That is what makes re-ingest idempotent.
   */
  async upsertNode(node: MemoryNode): Promise<'created' | 'refreshed'> {
    const existing = await this.run('MATCH (m:Memory) WHERE m.id = $id RETURN m.id AS id', {
      id: node.id,
    });

    if (existing.length > 0) {
      await this.run(
        `MATCH (m:Memory) WHERE m.id = $id
         SET m.last_seen_at = $lastSeenAt,
             m.access_count = m.access_count + 1,
             m.importance = $importance`,
        { id: node.id, lastSeenAt: node.lastSeenAt, importance: node.importance },
      );
      return 'refreshed';
    }

    await this.run(
      `CREATE (m:Memory {
          id: $id, layer: $layer, title: $title, body: $body,
          source_ref: $sourceRef, file_path: $filePath,
          importance: $importance, confidence: $confidence,
          created_at: $createdAt, last_seen_at: $lastSeenAt, access_count: $accessCount,
          superseded_at: $supersededAt,
          embedding_model: $embeddingModel, embedding_dims: $embeddingDims,
          embedding_provider: $embeddingProvider, embedding: $embedding
       })`,
      {
        id: node.id,
        layer: node.layer,
        title: node.title,
        body: node.body,
        sourceRef: node.sourceRef,
        filePath: node.filePath ?? '',
        importance: node.importance,
        confidence: node.confidence,
        createdAt: node.createdAt,
        lastSeenAt: node.lastSeenAt,
        accessCount: node.accessCount,
        supersededAt: node.supersededAt ?? 0,
        embeddingModel: node.embeddingModel ?? '',
        embeddingDims: node.embeddingDims ?? 0,
        embeddingProvider: node.embeddingProvider ?? '',
        embedding: node.embedding ?? zeros(this.dimensions),
      },
    );

    // Indexing happens here rather than in a separate pass, so there is no way to
    // write a node that the keyword index does not know about.
    this.stageForIndex(node);
    return 'created';
  }

  /**
   * Queues a node's terms for the index.
   *
   * Buffered rather than written immediately: a node touches dozens of terms, and
   * a read-modify-write per term per node would make ingest quadratic in row
   * updates. The buffer is flushed once, inside the same transaction.
   */
  private stageForIndex(node: MemoryNode): void {
    const tokens = tokenize(`${node.title}\n${node.body}`);
    this.docDelta.set(node.id, tokens.length);

    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    for (const [term, tf] of counts) {
      let postings = this.termDelta.get(term);
      if (!postings) {
        postings = new Map();
        this.termDelta.set(term, postings);
      }
      postings.set(node.id, { tf, length: tokens.length });
    }
  }

  /** Writes the buffered index updates. Called inside the transaction, before COMMIT. */
  private async flushIndex(): Promise<void> {
    if (this.termDelta.size === 0 && this.docDelta.size === 0) return;

    const terms = [...this.termDelta.keys()];
    const existing = new Map<string, string>();

    // Read the affected rows in batches rather than one query per term.
    for (let offset = 0; offset < terms.length; offset += 256) {
      const batch = terms.slice(offset, offset + 256);
      const rows = await this.run(
        'MATCH (t:Bm25Term) WHERE list_contains($terms, t.term) RETURN t.term AS term, t.postings AS postings',
        { terms: batch },
      );
      for (const row of rows) existing.set(row.term as string, (row.postings as string) ?? '');
    }

    for (const [term, delta] of this.termDelta) {
      const current = existing.has(term) ? decodePostings(existing.get(term)!) : (new Map() as Postings);
      for (const [id, entry] of delta) current.set(id, entry);
      const encoded = encodePostings(current);

      if (existing.has(term)) {
        await this.run('MATCH (t:Bm25Term) WHERE t.term = $term SET t.postings = $postings, t.df = $df', {
          term, postings: encoded, df: current.size,
        });
      } else {
        await this.run('CREATE (t:Bm25Term {term: $term, postings: $postings, df: $df})', {
          term, postings: encoded, df: current.size,
        });
      }
    }

    let addedDocs = 0;
    let addedLength = 0;
    for (const [id, length] of this.docDelta) {
      const found = await this.run('MATCH (d:Bm25Doc) WHERE d.node_id = $id RETURN d.length AS length', { id });
      if (found.length > 0) {
        addedLength += length - Number(found[0]!.length ?? 0);
        await this.run('MATCH (d:Bm25Doc) WHERE d.node_id = $id SET d.length = $length', { id, length });
      } else {
        addedDocs += 1;
        addedLength += length;
        await this.run('CREATE (d:Bm25Doc {node_id: $id, length: $length})', { id, length });
      }
    }

    const stat = await this.query(
      "MATCH (s:Bm25Stat) WHERE s.id = 'global' RETURN s.doc_count AS docs, s.total_length AS total",
    );
    if (stat.length > 0) {
      await this.run(
        `MATCH (s:Bm25Stat) WHERE s.id = 'global'
         SET s.doc_count = s.doc_count + $docs, s.total_length = s.total_length + $total`,
        { docs: addedDocs, total: addedLength },
      );
    } else {
      await this.run(
        "CREATE (s:Bm25Stat {id: 'global', doc_count: $docs, total_length: $total})",
        { docs: addedDocs, total: addedLength },
      );
    }

    this.termDelta.clear();
    this.docDelta.clear();
  }

  /** Posting lists for the given terms, read straight from the store. */
  async postingsFor(terms: string[]): Promise<Map<string, Postings>> {
    const found = new Map<string, Postings>();
    if (terms.length === 0) return found;

    for (let offset = 0; offset < terms.length; offset += 256) {
      const batch = terms.slice(offset, offset + 256);
      const rows = await this.run(
        'MATCH (t:Bm25Term) WHERE list_contains($terms, t.term) RETURN t.term AS term, t.postings AS postings',
        { terms: batch },
      );
      for (const row of rows) found.set(row.term as string, decodePostings((row.postings as string) ?? ''));
    }
    return found;
  }

  async indexStats(): Promise<{ docCount: number; totalLength: number }> {
    const rows = await this.query(
      "MATCH (s:Bm25Stat) WHERE s.id = 'global' RETURN s.doc_count AS docs, s.total_length AS total",
    );
    const row = rows[0];
    return {
      docCount: Number(row?.docs ?? 0),
      totalLength: Number(row?.total ?? 0),
    };
  }

  async setEmbedding(
    id: string,
    vector: number[],
    identity: { model: string; dimensions: number; provider: string },
  ): Promise<void> {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Embedding width mismatch: store is FLOAT[${this.dimensions}], got ${vector.length}. ` +
          `Changing dimensions requires rebuilding the store.`,
      );
    }
    await this.run(
      `MATCH (m:Memory) WHERE m.id = $id
       SET m.embedding = $embedding,
           m.embedding_model = $model,
           m.embedding_dims = $dims,
           m.embedding_provider = $provider`,
      {
        id,
        embedding: vector,
        model: identity.model,
        dims: identity.dimensions,
        provider: identity.provider,
      },
    );
  }

  async addEdge(edge: MemoryEdge): Promise<void> {
    if (!EDGE_TYPES.includes(edge.type)) {
      throw new Error(`Unknown edge type ${edge.type}. Known: ${EDGE_TYPES.join(', ')}`);
    }
    const endpoints = await this.run(
      'MATCH (m:Memory) WHERE m.id = $a OR m.id = $b RETURN m.id AS id',
      { a: edge.from, b: edge.to },
    );
    const found = new Set(endpoints.map((row) => row.id as string));
    const missing = [edge.from, edge.to].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`Cannot link: no such node(s) ${missing.join(', ')}`);
    }

    await this.run(
      `MATCH (a:Memory), (b:Memory) WHERE a.id = $from AND b.id = $to
       CREATE (a)-[:${edge.type} {weight: $weight, created_at: $createdAt, evidence_ref: $evidenceRef}]->(b)`,
      {
        from: edge.from,
        to: edge.to,
        weight: edge.weight,
        createdAt: edge.createdAt,
        evidenceRef: edge.evidenceRef ?? '',
      },
    );
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const rows = await this.run(`MATCH (m:Memory) WHERE m.id = $id RETURN ${NODE_COLUMNS}`, { id });
    const row = rows[0];
    return row ? rowToNode(row) : null;
  }

  async allNodes(includeSuperseded = false): Promise<MemoryNode[]> {
    const filter = includeSuperseded ? '' : 'WHERE m.superseded_at = 0';
    const rows = await this.query(`MATCH (m:Memory) ${filter} RETURN ${NODE_COLUMNS}`);
    return rows.map(rowToNode);
  }

  /**
   * The fields a ranking needs, without the body or the vector.
   *
   * Search used to load every node in full to rank them, which meant moving
   * bodies and 384-float vectors for rows that were never going to be returned.
   */
  async nodeSummaries(ids: string[]): Promise<Map<string, NodeSummary>> {
    const summaries = new Map<string, NodeSummary>();
    if (ids.length === 0) return summaries;

    for (let offset = 0; offset < ids.length; offset += 512) {
      const batch = ids.slice(offset, offset + 512);
      const rows = await this.run(
        `MATCH (m:Memory) WHERE list_contains($ids, m.id)
         RETURN m.id AS id, m.layer AS layer, m.importance AS importance,
                m.created_at AS createdAt, m.superseded_at AS supersededAt`,
        { ids: batch },
      );
      for (const row of rows) {
        summaries.set(row.id as string, {
          id: row.id as string,
          layer: row.layer as Layer,
          importance: Number(row.importance ?? 0),
          createdAt: Number(row.createdAt ?? 0),
          supersededAt: Number(row.supersededAt ?? 0) || null,
        });
      }
    }
    return summaries;
  }

  /**
   * Nodes recorded against a file path.
   *
   * Matches provenance as well as file_path, because a decision written with a
   * source_ref of docs/billing.md#L3-L8 is about that file whether or not anyone
   * also set file_path. Filtering in the database keeps this from being a reason
   * to load the whole store.
   */
  /**
   * Records a declaration and ties the memory chunk that is it to that name.
   *
   * The id is derived, not random, so re-ingesting the same file lands on the
   * same symbol instead of accumulating duplicates.
   */
  async upsertSymbol(symbol: SymbolRow): Promise<void> {
    const existing = await this.run('MATCH (s:Symbol) WHERE s.id = $id RETURN s.id AS id', {
      id: symbol.id,
    });
    if (existing.length > 0) {
      await this.run(
        `MATCH (s:Symbol) WHERE s.id = $id
         SET s.start_line = $startLine, s.end_line = $endLine, s.kind = $kind`,
        { id: symbol.id, startLine: symbol.startLine, endLine: symbol.endLine, kind: symbol.kind },
      );
      return;
    }
    await this.run(
      `CREATE (s:Symbol {
          id: $id, name: $name, file_path: $filePath, kind: $kind,
          start_line: $startLine, end_line: $endLine
       })`,
      symbol as unknown as Record<string, unknown>,
    );
  }

  async linkAbout(memoryId: string, symbolId: string): Promise<void> {
    const existing = await this.run(
      'MATCH (m:Memory)-[r:ABOUT]->(s:Symbol) WHERE m.id = $m AND s.id = $s RETURN s.id AS id',
      { m: memoryId, s: symbolId },
    );
    if (existing.length > 0) return;
    await this.run(
      `MATCH (m:Memory), (s:Symbol) WHERE m.id = $m AND s.id = $s
       CREATE (m)-[:ABOUT {weight: 1.0, created_at: $now}]->(s)`,
      { m: memoryId, s: symbolId, now: Date.now() },
    );
  }

  /**
   * Memory recorded against a named declaration.
   *
   * Without this, `why <symbol>` had nothing to anchor on and degraded to a text
   * search over prose that may never mention the symbol by name.
   */
  async nodesAboutSymbol(name: string): Promise<MemoryNode[]> {
    const rows = await this.run(
      `MATCH (m:Memory)-[:ABOUT]->(s:Symbol)
       WHERE s.name = $name AND m.superseded_at = 0
       RETURN ${NODE_COLUMNS}`,
      { name },
    );
    return rows.map(rowToNode);
  }

  /**
   * Every declaration, with the memories recorded about each.
   *
   * One query rather than one per symbol: a map of a real repository is
   * thousands of rows, and a round trip each would make looking at the graph
   * cost more than building it.
   */
  /**
   * Removes nodes and everything the index knows about them.
   *
   * Four things, not one. Deleting the row and stopping would leave the node in
   * every posting list that mentions it, in Bm25Doc, and in the global counts --
   * a keyword index that answers with ids that no longer resolve, and averages
   * computed over documents that are gone. None of that raises an error; it just
   * makes search quietly wrong, which is the failure this project keeps finding.
   *
   * Only nodes with no relationships are accepted. That is a real restriction and
   * a deliberate one: a memory that something points at is part of somebody's
   * reasoning, and deleting it silently breaks that chain.
   */
  /**
   * Ingest-derived nodes for a file that this pass did not produce.
   *
   * Chunk ids are derived from content, so editing a file yields new ids and
   * leaves the previous versions behind. Nothing removed them, so one file
   * edited three times became three nodes -- all still indexed, all competing
   * for the same query. Only the artifact layer is considered: everything else
   * was written by a person and is not ingest's to reclaim.
   */
  async staleArtifacts(filePath: string, keep: string[]): Promise<MemoryNode[]> {
    const rows = await this.run(
      `MATCH (m:Memory)
       WHERE m.layer = 'artifact' AND m.file_path = $filePath
         AND NOT list_contains($keep, m.id)
         AND m.superseded_at = 0
       RETURN ${NODE_COLUMNS}`,
      { filePath, keep },
    );
    return rows.map(rowToNode);
  }

  /**
   * Marks a node superseded rather than removing it.
   *
   * For a node something points at, deletion would break the chain: a decision
   * whose DERIVED_FROM leads nowhere is worse than a stale chunk. Superseded
   * nodes drop out of retrieval but the edge still resolves.
   */
  async supersede(ids: string[], at = Date.now()): Promise<number> {
    let marked = 0;
    for (const id of ids) {
      await this.run(
        'MATCH (m:Memory) WHERE m.id = $id AND m.superseded_at = 0 SET m.superseded_at = $at',
        { id, at },
      );
      marked += 1;
    }
    return marked;
  }

  async hasEdges(id: string): Promise<boolean> {
    const rows = await this.run(
      'MATCH (m:Memory)-[]-() WHERE m.id = $id RETURN m.id AS id LIMIT 1',
      { id },
    );
    return rows.length > 0;
  }

  async deleteNodes(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    let removed = 0;
    for (const id of ids) {
      const rows = await this.run(
        `MATCH (m:Memory) WHERE m.id = $id
         RETURN m.title AS title, m.body AS body`,
        { id },
      );
      const node = rows[0] as { title?: string; body?: string } | undefined;
      if (!node) continue;

      const connected = await this.run(
        'MATCH (m:Memory)-[]-() WHERE m.id = $id RETURN m.id AS id LIMIT 1',
        { id },
      );
      if (connected.length > 0) {
        throw new Error(
          `Refusing to delete ${id}: it has edges, so something points at it. ` +
            'Unlink it first if that is really what you want.',
        );
      }

      // The terms to touch come from the node's own text, so this costs one read
      // per term the node used rather than a scan of every term in the store.
      const terms = [...new Set(tokenize(`${node.title ?? ''}\n${node.body ?? ''}`))];
      for (let offset = 0; offset < terms.length; offset += 256) {
        const batch = terms.slice(offset, offset + 256);
        const found = await this.run(
          'MATCH (t:Bm25Term) WHERE list_contains($terms, t.term) RETURN t.term AS term, t.postings AS postings',
          { terms: batch },
        );
        for (const row of found) {
          const postings = decodePostings((row.postings as string) ?? '');
          if (!postings.delete(id)) continue;
          if (postings.size === 0) {
            await this.run('MATCH (t:Bm25Term) WHERE t.term = $term DELETE t', { term: row.term });
          } else {
            await this.run(
              'MATCH (t:Bm25Term) WHERE t.term = $term SET t.postings = $postings, t.df = $df',
              { term: row.term, postings: encodePostings(postings), df: postings.size },
            );
          }
        }
      }

      const doc = await this.run(
        'MATCH (d:Bm25Doc) WHERE d.node_id = $id RETURN d.length AS length',
        { id },
      );
      const length = Number((doc[0] as { length?: number } | undefined)?.length ?? 0);
      if (doc.length > 0) {
        await this.run('MATCH (d:Bm25Doc) WHERE d.node_id = $id DELETE d', { id });
        await this.run(
          `MATCH (s:Bm25Stat) WHERE s.id = 'global'
           SET s.doc_count = s.doc_count - 1, s.total_length = s.total_length - $length`,
          { length },
        );
      }

      await this.run('MATCH (m:Memory) WHERE m.id = $id DELETE m', { id });
      removed += 1;
    }
    return removed;
  }

  /**
   * Nodes old enough, unreferenced, and of a layer that is safe to forget.
   *
   * Episodic only by default. A decision is not noise however old it gets, and
   * an artifact chunk belongs to a file that ingest will re-derive anyway.
   */
  async prunable(options: { layer?: string; olderThanDays: number }): Promise<MemoryNode[]> {
    const cutoff = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000;
    const rows = await this.run(
      `MATCH (m:Memory)
       WHERE m.layer = $layer AND m.created_at < $cutoff
         AND NOT EXISTS { MATCH (m)-[]-() }
       RETURN ${NODE_COLUMNS}
       ORDER BY m.created_at`,
      { layer: options.layer ?? 'episodic', cutoff },
    );
    return rows.map(rowToNode);
  }

  async symbolMap(prefix?: string): Promise<Array<SymbolRow & { memories: Array<{ id: string; title: string; layer: string }> }>> {
    const rows = await this.run(
      `MATCH (s:Symbol)
       ${prefix ? 'WHERE starts_with(s.file_path, $prefix)' : ''}
       OPTIONAL MATCH (m:Memory)-[:ABOUT]->(s)
       RETURN s.id AS id, s.name AS name, s.file_path AS filePath, s.kind AS kind,
              s.start_line AS startLine, s.end_line AS endLine,
              m.id AS memoryId, m.title AS memoryTitle, m.layer AS memoryLayer
       ORDER BY s.file_path, s.start_line`,
      prefix ? { prefix } : {},
    );

    const bySymbol = new Map<string, SymbolRow & { memories: Array<{ id: string; title: string; layer: string }> }>();
    for (const raw of rows as Array<Record<string, unknown>>) {
      const id = String(raw.id);
      let entry = bySymbol.get(id);
      if (!entry) {
        entry = {
          id,
          name: String(raw.name),
          filePath: String(raw.filePath),
          kind: String(raw.kind),
          startLine: Number(raw.startLine ?? 0),
          endLine: Number(raw.endLine ?? 0),
          memories: [],
        };
        bySymbol.set(id, entry);
      }
      if (raw.memoryId) {
        entry.memories.push({
          id: String(raw.memoryId),
          title: String(raw.memoryTitle ?? ''),
          layer: String(raw.memoryLayer ?? ''),
        });
      }
    }
    return [...bySymbol.values()];
  }

  async symbolsInFile(filePath: string): Promise<SymbolRow[]> {
    const rows = await this.run(
      `MATCH (s:Symbol) WHERE s.file_path = $filePath
       RETURN s.id AS id, s.name AS name, s.file_path AS filePath, s.kind AS kind,
              s.start_line AS startLine, s.end_line AS endLine
       ORDER BY s.start_line`,
      { filePath },
    );
    return rows as unknown as SymbolRow[];
  }

  /**
   * Recorded memories that connect to nothing at all.
   *
   * Counted in the database and across *every* relationship type, including
   * ABOUT. Walking only the memory-to-memory labels made `doctor` report "259
   * edges" and "486 nodes with no edges" in the same breath.
   *
   * Artifact chunks are excluded: an ingested paragraph standing on its own is
   * the normal case, and a warning that fires on every fresh ingest teaches
   * people to stop reading warnings.
   */
  async orphanedMemories(): Promise<number> {
    const rows = await this.run(
      `MATCH (m:Memory)
       WHERE m.layer <> 'artifact' AND m.superseded_at = 0
         AND NOT EXISTS { MATCH (m)-[]-() }
       RETURN count(*) AS n`,
      {},
    );
    return Number((rows[0] as { n?: number })?.n ?? 0);
  }

  async nodesAnchoredToPath(target: string): Promise<MemoryNode[]> {
    const normalized = target.replace(/\\/g, '/');
    const rows = await this.run(
      `MATCH (m:Memory)
       WHERE m.superseded_at = 0
         AND (m.file_path = $exact
              OR ends_with(m.file_path, $suffix)
              OR starts_with(m.source_ref, $prefix)
              OR contains(m.source_ref, $suffix))
       RETURN ${NODE_COLUMNS}`,
      { exact: normalized, suffix: `/${normalized}`, prefix: `${normalized}#` },
    );
    return rows.map(rowToNode);
  }

  async getNodes(ids: string[]): Promise<Map<string, MemoryNode>> {
    const nodes = new Map<string, MemoryNode>();
    if (ids.length === 0) return nodes;
    const rows = await this.run(
      `MATCH (m:Memory) WHERE list_contains($ids, m.id) RETURN ${NODE_COLUMNS}`,
      { ids },
    );
    for (const row of rows) {
      const node = rowToNode(row);
      nodes.set(node.id, node);
    }
    return nodes;
  }

  /**
   * Nearest neighbours, ranked inside the database.
   *
   * array_cosine_similarity is a built-in function rather than part of the
   * vector extension, so it works on platforms where no vector index can be
   * installed. Ranking here rather than in JavaScript means the vectors never
   * leave the store -- only the winning ids do.
   */
  async semanticTopK(
    queryVector: number[],
    options: { limit: number; model: string; provider: string; layers?: Layer[] },
  ): Promise<{ id: string; similarity: number }[]> {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector is ${queryVector.length} wide but this store is FLOAT[${this.dimensions}].`,
      );
    }

    const layerFilter =
      options.layers && options.layers.length > 0 ? 'AND list_contains($layers, m.layer)' : '';

    // The width is interpolated because CAST needs a literal type; it comes from
    // meta.json and is validated as digits at init, never from a caller.
    const rows = await this.run(
      `MATCH (m:Memory)
       WHERE m.embedding_model = $model AND m.embedding_provider = $provider
         AND m.superseded_at = 0 ${layerFilter}
       RETURN m.id AS id,
              array_cosine_similarity(m.embedding, CAST($q AS FLOAT[${this.dimensions}])) AS sim
       ORDER BY sim DESC LIMIT ${Math.max(1, Math.floor(options.limit))}`,
      {
        q: queryVector,
        model: options.model,
        provider: options.provider,
        ...(layerFilter ? { layers: options.layers as string[] } : {}),
      },
    );

    return rows.map((row) => ({ id: row.id as string, similarity: Number(row.sim ?? 0) }));
  }

  /** How many nodes carry a vector from the given space. */
  async embeddedCount(model?: string, provider?: string): Promise<number> {
    if (model === undefined) {
      const rows = await this.query(
        `MATCH (m:Memory) WHERE m.embedding_model <> '' RETURN count(*) AS n`,
      );
      return Number(rows[0]?.n ?? 0);
    }
    const rows = await this.run(
      'MATCH (m:Memory) WHERE m.embedding_model = $model AND m.embedding_provider = $provider RETURN count(*) AS n',
      { model, provider: provider ?? '' },
    );
    return Number(rows[0]?.n ?? 0);
  }

  async edgesFor(ids: string[]): Promise<MemoryEdge[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    const edges: MemoryEdge[] = [];
    for (const type of EDGE_TYPES) {
      const rows = await this.query(
        `MATCH (a:Memory)-[r:${type}]->(b:Memory)
         RETURN a.id AS src, b.id AS dst, r.weight AS weight, r.created_at AS createdAt, r.evidence_ref AS evidenceRef`,
      );
      for (const row of rows) {
        const from = row.src as string;
        const to = row.dst as string;
        if (!wanted.has(from) && !wanted.has(to)) continue;
        edges.push({
          from,
          to,
          type,
          weight: Number(row.weight ?? 1),
          createdAt: Number(row.createdAt ?? 0),
          evidenceRef: (row.evidenceRef as string) || null,
        });
      }
    }
    return edges;
  }

  async allEdges(): Promise<MemoryEdge[]> {
    const edges: MemoryEdge[] = [];
    for (const type of EDGE_TYPES) {
      const rows = await this.query(
        `MATCH (a:Memory)-[r:${type}]->(b:Memory)
         RETURN a.id AS src, b.id AS dst, r.weight AS weight, r.created_at AS createdAt, r.evidence_ref AS evidenceRef`,
      );
      for (const row of rows) {
        edges.push({
          from: row.src as string,
          to: row.dst as string,
          type,
          weight: Number(row.weight ?? 1),
          createdAt: Number(row.createdAt ?? 0),
          evidenceRef: (row.evidenceRef as string) || null,
        });
      }
    }
    return edges;
  }

  async markSuperseded(id: string, at: number): Promise<void> {
    await this.run('MATCH (m:Memory) WHERE m.id = $id SET m.superseded_at = $at', { id, at });
  }

  async noteAccess(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.run(
        'MATCH (m:Memory) WHERE m.id = $id SET m.access_count = m.access_count + 1, m.last_seen_at = $now',
        { id, now: Date.now() },
      );
    }
  }

  async stats(): Promise<StoreStats> {
    const [{ n = 0 } = {}] = (await this.query(
      'MATCH (m:Memory) RETURN count(*) AS n',
    )) as { n?: number }[];

    const byLayerRows = await this.query('MATCH (m:Memory) RETURN m.layer AS layer, count(*) AS n');
    const byLayer: Record<string, number> = {};
    for (const row of byLayerRows) byLayer[String(row.layer)] = Number(row.n);

    const [{ e = 0 } = {}] = (await this.query(
      `MATCH ()-[r]->() RETURN count(r) AS e`,
    )) as { e?: number }[];

    const [{ v = 0 } = {}] = (await this.query(
      `MATCH (m:Memory) WHERE m.embedding_model <> '' RETURN count(*) AS v`,
    )) as { v?: number }[];

    return { nodes: Number(n), edges: Number(e), embedded: Number(v), byLayer };
  }

  /**
   * Runs a unit of work as one transaction, then advances the write counter.
   *
   * The order is the contract, not an implementation detail. writeSeq lives in
   * meta.json, outside the database, so the two steps can only be sequenced by
   * hand:
   *
   *   COMMIT succeeds  ->  then bump.   A reader in the gap sees old data under
   *                                     the old counter: consistent, and it will
   *                                     pick the write up on its next look.
   *   bump first       ->  a reader sees the new counter, reopens, reads the old
   *                        data, and caches it as current. The guard against
   *                        stale snapshots would then be asserting a falsehood --
   *                        worse than not having one.
   *
   * So the bump lives here and nowhere else. Rolling back skips it, because
   * nothing was written for a reader to miss.
   */
  async transact<T>(fn: () => Promise<T>, metaPatch: Partial<StoreMeta> = {}): Promise<T> {
    if (this.readOnly) {
      throw new Error(`Cannot write through a read-only handle on ${this.dir}.`);
    }

    // Nested calls join the outer transaction; BEGIN inside BEGIN is an error,
    // and a nested unit of work has no business committing on its own.
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return await fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }

    const conn = await this.connection();
    await conn.query('BEGIN TRANSACTION');
    this.transactionDepth = 1;

    let result: T;
    try {
      result = await fn();
      // The index is part of the same write: it commits with the nodes or not at all.
      await this.flushIndex();
    } catch (err) {
      try {
        await conn.query('ROLLBACK');
      } catch (rollbackErr) {
        log('error', 'rollback failed after a failed write', rollbackErr);
      }
      this.termDelta.clear();
      this.docDelta.clear();
      this.transactionDepth = 0;
      throw err;
    }

    try {
      await conn.query('COMMIT');
    } catch (err) {
      // Nothing became durable, so there is nothing for readers to miss.
      this.transactionDepth = 0;
      throw err;
    }
    this.transactionDepth = 0;

    try {
      this.meta = bumpWriteSeq(this.dir, metaPatch);
    } catch (err) {
      throw new WriteSeqError(this.dir, err);
    }

    return result;
  }

  /** True while a transaction is open. Used by tests asserting the ordering. */
  get inTransaction(): boolean {
    return this.transactionDepth > 0;
  }
}

/**
 * A statement can return several result sets; every query here returns one, so
 * the first is taken and the shape is narrowed in exactly one place.
 */
async function rows(result: unknown): Promise<Record<string, unknown>[]> {
  const first = Array.isArray(result) ? result[0] : result;
  if (!first) return [];
  return (await (first as { getAll(): Promise<unknown[]> }).getAll()) as Record<string, unknown>[];
}

export interface NodeSummary {
  id: string;
  layer: Layer;
  importance: number;
  createdAt: number;
  supersededAt: number | null;
}

const NODE_COLUMNS = `m.id AS id, m.layer AS layer, m.title AS title, m.body AS body,
  m.source_ref AS sourceRef, m.file_path AS filePath, m.importance AS importance,
  m.confidence AS confidence, m.created_at AS createdAt, m.last_seen_at AS lastSeenAt,
  m.access_count AS accessCount, m.superseded_at AS supersededAt,
  m.embedding_model AS embeddingModel, m.embedding_dims AS embeddingDims,
  m.embedding_provider AS embeddingProvider, m.embedding AS embedding`;

function rowToNode(row: Record<string, unknown>): MemoryNode {
  return {
    id: row.id as string,
    layer: row.layer as Layer,
    title: row.title as string,
    body: row.body as string,
    sourceRef: row.sourceRef as string,
    filePath: (row.filePath as string) || null,
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    createdAt: Number(row.createdAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? 0),
    accessCount: Number(row.accessCount ?? 0),
    supersededAt: Number(row.supersededAt ?? 0) || null,
    embeddingModel: (row.embeddingModel as string) || null,
    embeddingDims: Number(row.embeddingDims ?? 0) || null,
    embeddingProvider: (row.embeddingProvider as string) || null,
    embedding: (row.embedding as number[]) ?? null,
  };
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

export type { EdgeType };
