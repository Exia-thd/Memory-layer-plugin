import fs from 'node:fs';
import nodePath from 'node:path';
import {
  MemoryStore, StoreLockedError, ingest, search, neighbors, clusters, conflicts, doctor,
  probeCapabilities, selectProvider, parseDimensions, upsertProject, journal,
  nodeId, redact, type EmbeddingProvider, type Layer, type EdgeType, type MemoryNode,
  type SearchResult, type Subgraph, type Conflict, type Cluster, type DoctorReport,
  type IngestReport, log,
} from '@memory-layer/core';
import {
  resolveProject, storeDirFor, ensureGitignore, storeDirOrThrow, isStale, isStaleAsync,
  mapWithLimit, changedFiles, type Staleness,
} from './project.js';
import { readRegistry, type RegistryEntry } from '@memory-layer/core';

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

export async function init(
  options: InitOptions & { scan?: string[]; embed?: boolean; ui?: boolean } = {},
): Promise<{
  storeDir: string;
  report: DoctorReport;
  scanned: IngestReport | null;
  page: string | null;
}> {
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

  // The store stays open from here to the end of init. A LadybugDB path opened
  // once in a process cannot be opened a second time in it, so doctor has to run
  // on this handle rather than on one of its own.
  const store = await MemoryStore.create(dir, {
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

  // Scanning happens on this handle, not a fresh one.
  //
  // A LadybugDB path can be opened for writing once per process, so an init that
  // closed and then called runIngest would take the lock against itself -- which
  // is exactly what the first attempt did. Passing the open store through is the
  // only way to do both in one command.
  let scanned: IngestReport | null = null;
  if (options.scan && options.scan.length > 0) {
    scanned = await ingest(store, options.scan, {
      layer: 'artifact',
      force: false,
      embedder: options.embed === false ? null : choice?.provider ?? null,
    });
  }

  const report = await doctor(store, choice?.provider.identity ?? null);

  // Built here for the same reason the scan is: closing this handle does not
  // release the file at once on Windows, so a viewer that opened its own store
  // succeeded or failed depending on timing.
  let page: string | null = null;
  if (scanned && options.ui !== false) {
    try {
      const { buildUi } = await import('./ui.js');
      page = (await buildUi(store, dir)).file;
    } catch (err) {
      log('warn', 'could not write the viewer', err);
    }
  }

  await store.close();
  return { storeDir: dir, report, scanned, page };
}

export async function runIngest(
  targets: string[],
  options: {
    from?: string; layer?: Layer; force?: boolean; embed?: boolean; maxFileBytes?: number;
  } = {},
): Promise<IngestReport> {
  const store = await writable(options.from);
  try {
    const provider = options.embed === false ? null : await embedder(store.dimensions);
    const report = await ingest(store, targets, {
      layer: options.layer ?? 'artifact',
      force: options.force ?? false,
      maxFileBytes: options.maxFileBytes,
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
  options: {
    from?: string; limit?: number; offset?: number; layers?: Layer[]; disableBm25?: boolean;
  } = {},
): Promise<SearchResult> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const provider = await embedder(store.dimensions);
    return await search(store, query, provider, {
      limit: options.limit ?? 10,
      offset: options.offset,
      layers: options.layers,
      disableBm25: options.disableBm25,
    });
  } finally {
    await store.close();
  }
}

export interface IndexEntry {
  id: string;
  title: string;
  layer: string;
  sourceRef: string;
  stale?: boolean;
}

export interface IndexResult {
  results: IndexEntry[];
  total: number;
  omitted: number;
  offset: number;
  fusion: SearchResult['fusion'];
}

/**
 * The same ranking, at a fifth of the cost per result.
 *
 * A full hit carries a 220-character snippet and runs about sixty tokens. On a
 * four-hundred-token budget that buys six of them, which is why the hook could
 * only ever show a handful and then apologise for the rest. Dropping the
 * snippet leaves title, layer and source_ref -- roughly fifteen tokens, so the
 * same budget covers twenty-six.
 *
 * That is the whole idea: decide what to read *from* a list you can see, rather
 * than being handed the first few in full and told there were more. The
 * snippets are still there; `memory search` and `memory get` fetch them for the
 * entries worth opening.
 */
export async function runIndex(
  query: string,
  options: { from?: string; limit?: number; offset?: number; layers?: Layer[] } = {},
): Promise<IndexResult> {
  const found = await runSearch(query, {
    from: options.from,
    limit: options.limit ?? 30,
    offset: options.offset,
    layers: options.layers,
  });

  return {
    results: found.results.map((hit) => ({
      id: hit.id,
      title: hit.title,
      layer: hit.layer,
      sourceRef: hit.sourceRef,
      ...(hit.stale ? { stale: true } : {}),
    })),
    total: found.total ?? found.results.length,
    omitted: found.omitted ?? 0,
    offset: found.offset ?? 0,
    fusion: found.fusion,
  };
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
  options: { from?: string; limit?: number; offset?: number; anchorOnly?: boolean } = {},
): Promise<SearchResult & { anchoredTo: string }> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    // Loading the embedding model costs about 2.5 seconds, and the hook that
    // fires on every Read, Grep and Glob only ever needed the anchor branch --
    // one Cypher query. It was paying for a model it did not use, on every file
    // the agent touched. `anchorOnly` skips constructing the provider at all;
    // the skipped branch is still declared, because a branch that quietly does
    // not run is the failure C4 exists to stop.
    const provider = options.anchorOnly ? null : await embedder(store.dimensions);
    const limit = options.limit ?? 10;

    // Anchor on provenance first, filtered in the database rather than by reading
    // every node. A path anchors on file_path or source_ref; a bare symbol has
    // neither, so it falls through to the text branches below.
    // A path anchors on provenance; a bare name anchors on the declaration the
    // chunker recorded. Before symbols existed the second case had nothing to
    // hold on to and quietly became a text search over prose that may never
    // mention the symbol.
    const anchored = looksLikePath(target)
      ? await store.nodesAnchoredToPath(target)
      : await store.nodesAboutSymbol(target);

    // Then widen by wording, so a symbol name works as well as a path.
    const found = await search(store, target.replace(/[/_.\\-]+/g, ' '), provider, {
      // No offset here. Paging is applied once, after the anchored hits merge
      // in -- paging twice would skip a different set than the caller asked for
      // on any file that carries recorded reasoning.
      limit: limit + Math.max(0, options.offset ?? 0),
      layers: ['semantic', 'episodic', 'procedural'],
    });

    // Explaining code means explaining decisions, so anchored reasoning leads --
    // including a node the text branches also found, which would otherwise be
    // ranked below one that only anchored.
    const anchoredIds = new Set(anchored.map((node) => node.id));
    const lead = [...anchored]
      .sort((a, b) => rank(a) - rank(b) || b.importance - a.importance)
      .map((node) => ({
        id: node.id,
        title: node.title,
        score: Number.POSITIVE_INFINITY,
        layer: node.layer,
        sourceRef: node.sourceRef,
        snippet: node.body.slice(0, 220),
        createdAt: node.createdAt,
        ranks: { anchor: 1 },
      }));

    const merged = [...lead, ...found.results.filter((hit) => !anchoredIds.has(hit.id))];
    // Paged once, here, over the merged order.
    const offset = Math.max(0, options.offset ?? 0);
    found.results = merged.slice(offset, offset + limit);
    found.offset = offset;
    // Anchored hits are found here, not by `search`, so the totals it returned
    // do not know about them. Recount after the merge or the number is a lie in
    // exactly the case that matters -- a file with a lot of recorded reasoning.
    found.total = Math.max(found.total ?? 0, merged.length);
    found.omitted = Math.max(0, found.total - (offset + found.results.length));

    // Anchoring is a retrieval branch and is reported as one; otherwise a result
    // set answered entirely by anchors reads as "every branch found nothing".
    found.fusion.branches.anchor = anchored.length;
    if (options.anchorOnly) {
      // Said out loud: this run never asked the semantic branch, which is not
      // the same as asking and getting nothing back.
      if (!found.fusion.degraded.includes('semantic')) found.fusion.degraded.push('semantic');
      found.fusion.reasons.semantic =
        'Skipped: --anchor-only avoids loading the embedding model, which costs about 2.5s.';
    }
    if (anchored.length === 0) {
      found.fusion.degraded.push('anchor');
      found.fusion.reasons.anchor = looksLikePath(target)
        ? `No memory is recorded against ${target}.`
        : `No declaration named ${target} carries recorded memory; this is a text search.`;
    }

    return { ...found, anchoredTo: target };
  } finally {
    await store.close();
  }
}

/** A path has a separator or an extension; a bare symbol has neither. */
function looksLikePath(target: string): boolean {
  return target.includes('/') || target.includes('\\') || /\.[a-z0-9]{1,6}$/i.test(target);
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
/**
 * The open session, if any, so a memory written now can say when it happened.
 *
 * `OCCURRED_IN` existed as an edge label from the start with nothing that could
 * ever create one -- the same shape as an edge type declared in a schema and
 * never produced, which is how a graph ends up with nodes and no relationships.
 * A session node is the missing producer.
 */
function sessionPath(storeDir: string): string {
  return nodePath.join(storeDir, 'session.json');
}

export function currentSession(storeDir: string): { id: string; label: string; startedAt: number } | null {
  try {
    const raw = fs.readFileSync(sessionPath(storeDir), 'utf8');
    const parsed = JSON.parse(raw) as { id: string; label: string; startedAt: number };
    return parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

export async function runSessionStart(
  label: string,
  options: { from?: string } = {},
): Promise<{ id: string; label: string }> {
  const storeDir = storeDirOrThrow(options.from);
  const startedAt = Date.now();
  const written = await runWrite(
    {
      layer: 'episodic',
      title: `Session: ${label}`,
      body: `Work session "${label}" opened at ${new Date(startedAt).toISOString()}.`,
      sourceRef: `session://${startedAt}`,
      importance: 2,
    },
    options,
  );
  fs.writeFileSync(sessionPath(storeDir), JSON.stringify({ id: written.id, label, startedAt }, null, 2));
  return { id: written.id, label };
}

export async function runSessionEnd(
  options: { from?: string; summary?: string } = {},
): Promise<{ closed: string | null }> {
  const storeDir = storeDirOrThrow(options.from);
  const open = currentSession(storeDir);
  if (!open) return { closed: null };

  if (options.summary) {
    await runWrite(
      {
        layer: 'episodic',
        title: `Session outcome: ${open.label}`,
        body: options.summary,
        sourceRef: `session://${open.startedAt}#outcome`,
        importance: 4,
        links: [{ to: open.id, type: 'OCCURRED_IN' as EdgeType, weight: 1 }],
      },
      options,
    );
  }
  fs.rmSync(sessionPath(storeDir), { force: true });
  return { closed: open.id };
}

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

    // Embed first: the model call is slow, and a write transaction holds the
    // store's exclusive lock for as long as it is open.
    let vector: number[] | null = null;
    const provider = await embedder(store.dimensions);
    if (provider) {
      try {
        vector = (await provider.embed([`${node.title}\n${node.body}`]))[0] ?? null;
      } catch (err) {
        log('warn', `could not embed ${node.id}`, err);
      }
    }

    await store.transact(async () => {
      await store!.upsertNode(node);
      if (vector && provider) await store!.setEmbedding(node.id, vector, provider.identity);

      for (const link of sessionLinks(storeDir, node, input.links)) {
        await store!.addEdge({
          from: node.id,
          to: link.to,
          type: link.type,
          weight: link.weight ?? 1,
          createdAt: now,
          evidenceRef: null,
        });
      }
    });

    return { id: node.id, queued: false, redactions };
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err;
    journal.appendNode(storeDir, node);
    for (const link of sessionLinks(storeDir, node, input.links)) {
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
    await store.transact(async () => store!.addEdge(edge));
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
    const merged = await store.transact(async () => {
      let count = 0;
      for (const file of files) {
        for (const entry of journal.readEntries(file)) {
          if (entry.kind === 'node' && entry.node) {
            await store!.upsertNode(entry.node);
            count += 1;
          } else if (entry.kind === 'edge' && entry.edge) {
            // An edge whose endpoints never merged is dropped with a reason
            // rather than losing the whole batch to one bad reference.
            try {
              await store!.addEdge(entry.edge);
              count += 1;
            } catch (err) {
              log('warn', 'dropping journal edge with missing endpoint', err);
            }
          }
        }
      }
      return count;
    });

    // Journals are discarded only once the merge is durable; a crash before this
    // point replays them, and upserts are idempotent.
    for (const file of files) journal.discard(file);
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
export interface ListedProject extends RegistryEntry {
  freshness: Staleness;
}

/**
 * Every registered project with its index freshness.
 *
 * The freshness check spawns git per project, so the checks run concurrently
 * with a cap: done one at a time, a large registry turns a listing into a long
 * wait, and a listing nobody is willing to run is a listing that never reports
 * a stale index.
 */
export async function runList(options: { concurrency?: number } = {}): Promise<ListedProject[]> {
  const entries = readRegistry();
  const freshness = await mapWithLimit(entries, options.concurrency ?? 8, (entry) =>
    isStaleAsync(entry.storagePath),
  );
  return entries.map((entry, index) => ({ ...entry, freshness: freshness[index]! }));
}

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

export interface ChangedFileMemory {
  file: string;
  /** Decisions, constraints and events recorded against this file. */
  memories: Array<{
    id: string;
    layer: Layer;
    title: string;
    sourceRef: string;
    importance: number;
    /** True when this node is one side of an unresolved CONTRADICTS pair. */
    contested: boolean;
  }>;
  /** Memories that matched but were not listed, so the cut is visible. */
  omitted: number;
}

export interface ChangesReport {
  scope: 'staged' | 'working' | 'compare';
  baseRef?: string;
  /** Files the diff touched, whether or not memory knows anything about them. */
  changed: string[];
  /** Only the files memory has something to say about. */
  covered: ChangedFileMemory[];
  /** Files with nothing recorded -- reported so silence is visible, not implied. */
  uncovered: string[];
  contested: number;
}

/**
 * What memory knows about the code you are about to commit.
 *
 * This is the moment memory is worth the most: not while exploring, but just
 * before a change lands that may contradict a decision someone already made and
 * wrote down. `uncovered` is reported alongside `covered` because "memory found
 * nothing" and "memory was never asked" look identical otherwise.
 */
export async function runChanges(
  options: {
    from?: string;
    scope?: 'staged' | 'working' | 'compare';
    baseRef?: string;
    perFile?: number;
  } = {},
): Promise<ChangesReport> {
  const project = resolveProject(options.from);
  const perFile = options.perFile ?? 5;
  const scope = options.scope ?? 'staged';
  const files = changedFiles(project.root, scope, options.baseRef);
  if (files === null) {
    throw new Error(
      `Could not read ${scope} changes from git in ${project.root}. ` +
        'An unborn branch or a bad base ref reports no changes, which would read as "nothing to check".',
    );
  }

  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const contestedIds = new Set<string>();
    for (const conflict of await conflicts(store)) {
      contestedIds.add(conflict.a.id);
      contestedIds.add(conflict.b.id);
    }

    const covered: ChangedFileMemory[] = [];
    const uncovered: string[] = [];

    for (const file of files) {
      const nodes = await store.nodesAnchoredToPath(file);
      if (nodes.length === 0) {
        uncovered.push(file);
        continue;
      }
      // Decisions first, then the chunks of the file itself. A commit check that
      // lists fourteen artifact fragments per file floods the context this layer
      // exists to protect -- and buries the one recorded decision that matters.
      const ranked = nodes.sort(
        (a, b) => rank(a) - rank(b) || b.importance - a.importance,
      );
      const reasoning = ranked.filter((node) => node.layer !== 'artifact');
      const shown = (reasoning.length > 0 ? reasoning : ranked).slice(0, perFile);

      covered.push({
        file,
        memories: shown.map((node) => ({
          id: node.id,
          layer: node.layer,
          title: node.title,
          sourceRef: node.sourceRef,
          importance: node.importance,
          contested: contestedIds.has(node.id),
        })),
        omitted: nodes.length - shown.length,
      });
    }

    const contested = covered.reduce(
      (total, entry) => total + entry.memories.filter((memory) => memory.contested).length,
      0,
    );
    return { scope, baseRef: options.baseRef, changed: files, covered, uncovered, contested };
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

/**
 * Records a summary somebody wrote for a group of memories.
 *
 * This is the summarisation stage, and it is deliberately not automatic: the
 * body comes from the caller. Nothing here calls a model, so a read path can
 * never quietly become a generation path -- and the summary is linked to the
 * members, not to a community id that changes on the next run.
 */
export async function runSummarize(
  clusterId: number,
  body: string,
  options: { from?: string; title?: string } = {},
): Promise<{ id: string; covers: number }> {
  if (!body.trim()) throw new Error('A summary needs a body; an empty one is worse than none.');

  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  let found: Cluster | undefined;
  try {
    found = (await clusters(store)).find((cluster) => cluster.id === clusterId);
  } finally {
    await store.close();
  }
  if (!found) throw new Error(`No cluster ${clusterId} in the current grouping. Run \`memory clusters\` first.`);

  const title = options.title ?? `Area: ${found.terms.slice(0, 3).join(', ') || `cluster ${clusterId}`}`;
  const written = await runWrite(
    {
      layer: 'semantic',
      title,
      body,
      sourceRef: `cluster://${found.memberIds.length}-members`,
      importance: 6,
      links: found.memberIds.map((id) => ({ to: id, type: 'DERIVED_FROM' as EdgeType, weight: 1 })),
    },
    options,
  );
  return { id: written.id, covers: found.memberIds.length };
}

export interface PruneReport {
  layer: string;
  olderThanDays: number;
  dryRun: boolean;
  /** What was removed, or what would have been. */
  candidates: Array<{ id: string; title: string; ageDays: number }>;
  removed: number;
}

/**
 * Forgetting, on purpose and on the narrowest terms that are useful.
 *
 * Without this there is no way to forget anything, and the automatic write path
 * has to stay off: it records an episodic node for every failed command, most of
 * which are typos, and nothing ever removes them. Decay only lowers their rank --
 * they keep their postings, so they go on diluting IDF for every real memory
 * around them.
 *
 * Three conditions, all required. Episodic only, because a decision does not
 * become noise by getting old. Older than the cutoff. And unreferenced, because
 * a memory something points at is part of somebody's reasoning.
 */
export async function runPrune(
  options: { from?: string; olderThanDays?: number; layer?: string; dryRun?: boolean } = {},
): Promise<PruneReport> {
  const olderThanDays = options.olderThanDays ?? 90;
  const layer = options.layer ?? 'episodic';
  // Fractions are allowed on purpose: a noisy session from an hour ago is a fair
  // thing to clear, and a whole-day floor was an arbitrary number rather than a
  // property. Zero and below are refused, because "older than now" is everything.
  if (!(olderThanDays > 0)) {
    throw new Error('--older-than must be greater than 0; "older than now" would match everything.');
  }

  const storeDir = storeDirOrThrow(options.from);
  const now = Date.now();

  // Read through a read-only handle, so a preview never takes the write lock.
  const reader = new MemoryStore(storeDir, { readOnly: true });
  let candidates: Array<{ id: string; title: string; ageDays: number }>;
  try {
    candidates = (await reader.prunable({ layer, olderThanDays })).map((node) => ({
      id: node.id,
      title: node.title,
      ageDays: Math.floor((now - node.createdAt) / (24 * 60 * 60 * 1000)),
    }));
  } finally {
    await reader.close();
  }

  if (options.dryRun || candidates.length === 0) {
    return { layer, olderThanDays, dryRun: Boolean(options.dryRun), candidates, removed: 0 };
  }

  const store = new MemoryStore(storeDir);
  try {
    const removed = await store.transact(() => store.deleteNodes(candidates.map((c) => c.id)));
    return { layer, olderThanDays, dryRun: false, candidates, removed };
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
    let skipped = 0;

    // Every vector is computed before the transaction opens, so the exclusive
    // lock is held for the writes alone rather than for the whole model run.
    const pending: { id: string; vector: number[] }[] = [];
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
      if (vector) pending.push({ id: node.id, vector });
    }

    await store.transact(
      async () => {
        for (const { id, vector } of pending) await store.setEmbedding(id, vector, identity);
      },
      { embedding: { model: identity.model, provider: identity.provider } },
    );

    return { embedded: pending.length, skipped };
  } finally {
    await store.close();
  }
}

async function writable(from?: string): Promise<MemoryStore> {
  return new MemoryStore(storeDirOrThrow(from));
}

/**
 * The caller's links, plus the open session when there is one.
 *
 * A session node does not occur in itself, so it is excluded by source_ref.
 */
function sessionLinks(
  storeDir: string,
  node: MemoryNode,
  links: WriteInput['links'],
): NonNullable<WriteInput['links']> {
  const explicit = links ?? [];
  if (node.sourceRef.startsWith('session://')) return explicit;

  const open = currentSession(storeDir);
  if (!open) return explicit;
  if (explicit.some((link) => link.to === open.id)) return explicit;
  return [...explicit, { to: open.id, type: 'OCCURRED_IN' as EdgeType, weight: 1 }];
}
