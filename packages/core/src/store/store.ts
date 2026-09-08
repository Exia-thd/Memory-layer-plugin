import fs from 'node:fs';
import path from 'node:path';
import { Database, Connection } from '@ladybugdb/core';
import type { MemoryNode, MemoryEdge, EdgeType, Layer, StoreStats } from '../types.js';
import { EDGE_TYPES } from '../types.js';
import { ddl, SCHEMA_VERSION } from './schema.js';
import { readMeta, writeMeta, bumpWriteSeq, type StoreMeta } from './meta.js';
import { log } from '../util/log.js';

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
    }

    if (this.conn) return this.conn;

    try {
      this.db = new Database(
        this.dbPath,
        this.options.bufferPoolBytes ?? 0,
        true,
        this.readOnly,
      );
      this.conn = new Connection(this.db);
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

  /** Creates the store directory, applies DDL and writes meta.json. */
  static async create(dir: string, meta: Omit<StoreMeta, 'schemaVersion' | 'writeSeq'>): Promise<MemoryStore> {
    fs.mkdirSync(dir, { recursive: true });
    const full: StoreMeta = { ...meta, schemaVersion: SCHEMA_VERSION, writeSeq: 0 };
    writeMeta(dir, full);

    const store = new MemoryStore(dir);
    for (const statement of ddl(full.dimensions)) await store.query(statement);
    await store.close();
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
    return 'created';
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

  /** Records that the store changed, so read-only handles know to reopen. */
  commit(): void {
    this.meta = bumpWriteSeq(this.dir);
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
