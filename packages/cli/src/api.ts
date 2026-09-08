import {
  MemoryStore, StoreLockedError, ingest, search, neighbors, clusters, conflicts, doctor,
  probeCapabilities, selectProvider, parseDimensions, updateMeta, upsertProject, journal,
  nodeId, redact, type EmbeddingProvider, type Layer, type EdgeType, type MemoryNode,
  type SearchResult, type Subgraph, type Conflict, type Cluster, type DoctorReport,
  type IngestReport, log,
} from '@memory-layer/core';
import { resolveProject, storeDirFor, ensureGitignore, storeDirOrThrow, isStale } from './project.js';

/**
 * One implementation of each capability, shared by the CLI and the MCP server.
 *
 * Both front ends call these functions; neither reimplements one. Two code paths
 * for the same operation is how they drift until one of them is wrong.
 */

let cachedProvider: { provider: EmbeddingProvider; capability: unknown } | null = null;

export async function embedder(dimensions: number): Promise<EmbeddingProvider | null> {
  if (cachedProvider) return cachedProvider.provider;
  try {
    cachedProvider = await selectProvider(dimensions);
    return cachedProvider.provider;
  } catch (err) {
    log('warn', 'no embedding provider available', err);
    return null;
  }
}

export interface InitOptions {
  from?: string;
  dimensions?: string | number;
  seed?: string[];
}

export async function init(options: InitOptions = {}): Promise<{ storeDir: string; report: DoctorReport }> {
  const project = resolveProject(options.from);
  const dir = storeDirFor(project.root);
  const dimensions = parseDimensions(options.dimensions ?? process.env.MEMORY_LAYER_DIMS);

  // Capabilities are probed before anything is written, and recorded, so a broken
  // backend is reported at init rather than discovered on a query that returns nothing.
  const capabilities = await probeCapabilities(dir);
  const choice = await selectProvider(dimensions).catch(() => null);
  if (choice) {
    capabilities.embeddings = choice.capability;
    cachedProvider = choice;
  }

  await MemoryStore.create(dir, {
    projectName: project.name,
    projectRoot: project.root,
    remoteUrl: project.remoteUrl,
    branch: project.branch,
    lastCommit: project.lastCommit,
    dimensions,
    embedding: choice ? { model: choice.provider.identity.model, provider: choice.provider.identity.provider } : null,
    capabilities,
  });

  ensureGitignore(project.root, '.memory');
  upsertProject({
    name: project.name,
    path: project.root,
    storagePath: dir,
    remoteUrl: project.remoteUrl,
    branch: project.branch,
    lastCommit: project.lastCommit,
    indexedAt: new Date().toISOString(),
  });

  const store = new MemoryStore(dir);
  const report = await doctor(store, choice?.provider.identity ?? null);
  await store.close();
  return { storeDir: dir, report };
}

export async function runIngest(
  targets: string[],
  options: { from?: string; layer?: Layer; force?: boolean; embed?: boolean } = {},
): Promise<IngestReport> {
  const store = await writable(options.from);
  try {
    const provider = options.embed === false ? null : await embedder(store.dimensions);
    const report = await ingest(store, targets, {
      layer: options.layer ?? 'artifact',
      force: options.force ?? false,
      embedder: provider,
    });
    const meta = store.getMeta();
    upsertProject({
      name: meta.projectName,
      path: meta.projectRoot,
      storagePath: store.dir,
      remoteUrl: meta.remoteUrl,
      branch: meta.branch,
      lastCommit: meta.lastCommit,
      indexedAt: new Date().toISOString(),
      stats: await store.stats(),
    });
    return report;
  } finally {
    await store.close();
  }
}

export async function runSearch(
  query: string,
  options: { from?: string; limit?: number; layers?: Layer[]; disableBm25?: boolean } = {},
): Promise<SearchResult> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const provider = await embedder(store.dimensions);
    return await search(store, query, provider, {
      limit: options.limit ?? 10,
      layers: options.layers,
      disableBm25: options.disableBm25,
    });
  } finally {
    await store.close();
  }
}

export async function runGet(id: string, options: { from?: string } = {}): Promise<{
  node: MemoryNode;
  edges: Awaited<ReturnType<MemoryStore['edgesFor']>>;
} | null> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const node = await store.getNode(id);
    if (!node) return null;
    return { node, edges: await store.edgesFor([id]) };
  } finally {
    await store.close();
  }
}

/**
 * Decisions and constraints touching a file or symbol.
 *
 * This is the question someone actually asks when they open unfamiliar code, and
 * the one nothing else in the toolchain answers.
 */
export async function runWhy(
  target: string,
  options: { from?: string; limit?: number } = {},
): Promise<SearchResult & { anchoredTo: string }> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const provider = await embedder(store.dimensions);
    const nodes = await store.allNodes();

    // Anchor on provenance first. A decision recorded against docs/billing.md#L3-L8
    // is about that file even though nobody set file_path, so both are checked.
    const anchored = nodes.filter((node) => anchorsTo(node, target));

    // Then widen by wording, so a bare symbol name works as well as a path.
    const result = await search(store, target.replace(/[/_.\\-]+/g, ' '), provider, {
      limit: options.limit ?? 10,
      layers: ['semantic', 'episodic', 'procedural'],
    });

    const seen = new Set(result.results.map((hit) => hit.id));
    // Explaining code means explaining decisions, so anchored reasoning outranks
    // whatever the text branches happened to surface.
    const ordered = [...anchored].sort((a, b) => rank(a) - rank(b) || b.importance - a.importance);

    for (const node of ordered.reverse()) {
      if (seen.has(node.id)) continue;
      result.results.unshift({
        id: node.id,
        title: node.title,
        score: Number.POSITIVE_INFINITY,
        layer: node.layer,
        sourceRef: node.sourceRef,
        snippet: node.body.slice(0, 220),
        createdAt: node.createdAt,
        ranks: { anchor: 1 },
      });
    }

    // Anchoring is a retrieval branch and is reported as one; otherwise a result
    // set answered entirely by anchors reads as "every branch found nothing".
    result.fusion.branches.anchor = anchored.length;
    if (anchored.length === 0) {
      result.fusion.degraded.push('anchor');
      result.fusion.reasons.anchor = `No memory is recorded against ${target}.`;
    }

    return { ...result, anchoredTo: target };
  } finally {
    await store.close();
  }
}

/** True when a node was recorded against this file path or symbol. */
function anchorsTo(node: MemoryNode, target: string): boolean {
  const normalized = target.replace(/\\/g, '/');
  const candidates = [node.filePath, node.sourceRef?.split('#')[0]].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    if (candidate === normalized) return true;
    if (candidate.endsWith(`/${normalized}`)) return true;
  }

  // A symbol name, matched as a whole word so `retry` does not pull in `retryable`.
  if (!normalized.includes('/') && !normalized.includes('.')) {
    const word = new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return word.test(node.title) || word.test(node.body);
  }
  return false;
}

/** Decisions and constraints before the events that prompted them. */
function rank(node: MemoryNode): number {
  return { semantic: 0, procedural: 1, episodic: 2, artifact: 3 }[node.layer] ?? 4;
}

export async function runNeighbors(
  id: string,
  options: { from?: string; depth?: number; edgeTypes?: EdgeType[] } = {},
): Promise<Subgraph> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    return await neighbors(store, id, { depth: options.depth, edgeTypes: options.edgeTypes });
  } finally {
    await store.close();
  }
}

export interface WriteInput {
  layer: Layer;
  title: string;
  body: string;
  sourceRef: string;
  importance?: number;
  confidence?: number;
  filePath?: string;
  links?: { to: string; type: EdgeType; weight?: number }[];
}

/**
 * Records a memory, falling back to the session journal when another process
 * holds the write lock.
 *
 * The fallback is reported to the caller rather than hidden: a memory that is
 * written but not yet searchable is a different outcome from one that is live,
 * and the difference matters to whoever wrote it.
 */
export async function runWrite(
  input: WriteInput,
  options: { from?: string } = {},
): Promise<{ id: string; queued: boolean; redactions: { rule: string; count: number }[] }> {
  if (!input.sourceRef) {
    throw new Error('source_ref is required: a memory that cannot be traced back cannot be checked.');
  }

  const { text: body, redactions } = redact(input.body);
  const { text: title } = redact(input.title);
  const now = Date.now();
  const node: MemoryNode = {
    id: nodeId(input.layer, input.sourceRef, body),
    layer: input.layer,
    title,
    body,
    sourceRef: input.sourceRef,
    filePath: input.filePath ?? null,
    importance: input.importance ?? 5,
    confidence: input.confidence ?? 0.8,
    createdAt: now,
    lastSeenAt: now,
    accessCount: 0,
    supersededAt: null,
    embedding: null,
  };

  const storeDir = storeDirOrThrow(options.from);
  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(storeDir);
    await store.upsertNode(node);

    const provider = await embedder(store.dimensions);
    if (provider) {
      try {
        const [vector] = await provider.embed([`${node.title}\n${node.body}`]);
        if (vector) await store.setEmbedding(node.id, vector, provider.identity);
      } catch (err) {
        log('warn', `could not embed ${node.id}`, err);
      }
    }

    for (const link of input.links ?? []) {
      await store.addEdge({
        from: node.id,
        to: link.to,
        type: link.type,
        weight: link.weight ?? 1,
        createdAt: now,
        evidenceRef: null,
      });
    }

    store.commit();
    return { id: node.id, queued: false, redactions };
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err;
    journal.appendNode(storeDir, node);
    for (const link of input.links ?? []) {
      journal.appendEdge(storeDir, {
        from: node.id, to: link.to, type: link.type,
        weight: link.weight ?? 1, createdAt: now, evidenceRef: null,
      });
    }
    return { id: node.id, queued: true, redactions };
  } finally {
    await store?.close();
  }
}

export async function runLink(
  from: string,
  to: string,
  type: EdgeType,
  options: { weight?: number; evidenceRef?: string; from_?: string } = {},
): Promise<{ queued: boolean }> {
  const storeDir = storeDirOrThrow(options.from_);
  const edge = {
    from, to, type,
    weight: options.weight ?? 1,
    createdAt: Date.now(),
    evidenceRef: options.evidenceRef ?? null,
  };

  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(storeDir);
    await store.addEdge(edge);
    store.commit();
    return { queued: false };
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err;
    journal.appendEdge(storeDir, edge);
    return { queued: true };
  } finally {
    await store?.close();
  }
}

/** Folds queued session writes into the store. Skipped, with a reason, when locked. */
export async function runMerge(options: { from?: string } = {}): Promise<{ merged: number; files: number; skipped: string | null }> {
  const storeDir = storeDirOrThrow(options.from);
  const files = journal.pendingFiles(storeDir);
  if (files.length === 0) return { merged: 0, files: 0, skipped: null };

  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(storeDir);
    let merged = 0;
    for (const file of files) {
      for (const entry of journal.readEntries(file)) {
        if (entry.kind === 'node' && entry.node) {
          await store.upsertNode(entry.node);
          merged += 1;
        } else if (entry.kind === 'edge' && entry.edge) {
          // An edge whose endpoints never merged is dropped with a reason rather
          // than aborting the rest of the batch.
          try {
            await store.addEdge(entry.edge);
            merged += 1;
          } catch (err) {
            log('warn', 'dropping journal edge with missing endpoint', err);
          }
        }
      }
      journal.discard(file);
    }
    store.commit();
    return { merged, files: files.length, skipped: null };
  } catch (err) {
    if (err instanceof StoreLockedError) {
      return { merged: 0, files: files.length, skipped: err.message };
    }
    throw err;
  } finally {
    await store?.close();
  }
}

/**
 * The constraints currently in force: live semantic memories, most important first.
 *
 * Distinct from search because there is no query -- this answers "what rules
 * apply here", which is what a session needs before it has a question.
 */
export async function runConstraints(
  options: { from?: string; limit?: number } = {},
): Promise<MemoryNode[]> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const nodes = await store.allNodes();
    return nodes
      .filter((node) => node.layer === 'semantic' && !node.supersededAt)
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, options.limit ?? 10);
  } finally {
    await store.close();
  }
}

export async function runConflicts(options: { from?: string } = {}): Promise<Conflict[]> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    return await conflicts(store);
  } finally {
    await store.close();
  }
}

export async function runClusters(options: { from?: string } = {}): Promise<Cluster[]> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    return await clusters(store);
  } finally {
    await store.close();
  }
}

export async function runDoctor(options: { from?: string } = {}): Promise<DoctorReport & { stale: ReturnType<typeof isStale> }> {
  const storeDir = storeDirOrThrow(options.from);
  const store = new MemoryStore(storeDir, { readOnly: true });
  try {
    const provider = await embedder(store.dimensions);
    const report = await doctor(store, provider?.identity ?? null);
    return { ...report, stale: isStale(storeDir) };
  } finally {
    await store.close();
  }
}

/** Re-embeds nodes that have no vector, or whose vector is from another space. */
export async function runEmbed(options: { from?: string; force?: boolean } = {}): Promise<{ embedded: number; skipped: number }> {
  const store = await writable(options.from);
  try {
    const provider = await embedder(store.dimensions);
    if (!provider) throw new Error('No embedding provider available; nothing to embed with.');

    const identity = provider.identity;
    const nodes = await store.allNodes();
    let embedded = 0;
    let skipped = 0;

    for (const node of nodes) {
      const current =
        node.embeddingModel === identity.model &&
        node.embeddingProvider === identity.provider &&
        node.embedding?.length === identity.dimensions;
      if (current && !options.force) {
        skipped += 1;
        continue;
      }
      const [vector] = await provider.embed([`${node.title}\n${node.body}`]);
      if (!vector) continue;
      await store.setEmbedding(node.id, vector, identity);
      embedded += 1;
    }

    updateMeta(store.dir, { embedding: { model: identity.model, provider: identity.provider } });
    store.commit();
    return { embedded, skipped };
  } finally {
    await store.close();
  }
}

async function writable(from?: string): Promise<MemoryStore> {
  return new MemoryStore(storeDirOrThrow(from));
}
