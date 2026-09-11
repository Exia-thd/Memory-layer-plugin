import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore, conflicts, doctor, type MemoryNode } from '@memory-layer/core';
import { storeDirOrThrow, resolveProject } from './project.js';
import { embedder } from './api.js';
import { renderUi, type UiPayload } from './ui-template.js';

/**
 * Builds the viewer.
 *
 * A snapshot rather than a live view, and the page says so. Serving live data
 * would mean a process holding the store open, which is the one thing this
 * design avoids: every write is short-lived so that several sessions can run at
 * once. A file you can mail to someone is worth more here than a localhost port.
 */

/**
 * Past this the browser starts to struggle and the picture stops being readable.
 * `--max-nodes` moves it for a machine that copes; a path narrows it instead.
 */
const MAX_GRAPH_NODES = 1500;

type UiOptions = { from?: string; out?: string; prefix?: string; maxNodes?: number };

export async function runUi(
  options: UiOptions = {},
): Promise<{ file: string; nodes: number; truncated: boolean }> {
  const storeDir = storeDirOrThrow(options.from);
  const store = new MemoryStore(storeDir, { readOnly: true });
  try {
    return await buildUi(store, storeDir, options);
  } finally {
    await store.close();
  }
}

/**
 * The same work, on a handle somebody else owns.
 *
 * A LadybugDB path can be opened once per process, and closing it does not
 * release the file immediately on Windows -- so `init`, which holds the store
 * open to scan, cannot hand off to a function that opens its own. It failed
 * intermittently rather than always, which is worse: the page was there or not
 * depending on timing.
 */
export async function buildUi(
  store: MemoryStore,
  storeDir: string,
  options: UiOptions = {},
): Promise<{ file: string; nodes: number; truncated: boolean }> {
  const project = resolveProject(options.from);

  {
    const provider = await embedder(store.dimensions);

    // One at a time, not Promise.all.
    //
    // The store holds a single lazily-opened connection, so concurrent queries
    // race each other opening and closing it -- the first attempt at this used
    // Promise.all and every query after the first failed with "Cannot read
    // properties of null". Reading five things in sequence costs nothing here
    // and is the only correct way to use this handle.
    const report = await doctor(store, provider?.identity ?? null);
    const allNodes = await store.allNodes();
    const allEdges = await store.allEdges();
    const symbols = await store.symbolMap(options.prefix);
    const stats = await store.stats();

    const contested = new Set<string>();
    for (const conflict of await conflicts(store)) {
      contested.add(conflict.a.id);
      contested.add(conflict.b.id);
    }

    const degree = new Map<string, number>();
    for (const edge of allEdges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }

    const now = Date.now();
    const memories = allNodes
      .filter((node) => matchesPrefix(node, options.prefix))
      .map((node) => ({
        id: node.id,
        layer: node.layer,
        title: node.title,
        body: node.body,
        sourceRef: node.sourceRef,
        importance: node.importance,
        ageDays: Math.floor((now - node.createdAt) / (24 * 60 * 60 * 1000)),
        edges: degree.get(node.id) ?? 0,
        contested: contested.has(node.id),
      }))
      .sort((a, b) => b.importance - a.importance || a.ageDays - b.ageDays);

    // The page reports any cut; a silently shortened picture is a lie about the
    // shape of the graph.
    const { graph, total, omitted } = buildGraph(memories, allEdges, symbols, options.maxNodes ?? MAX_GRAPH_NODES);
    const truncated = total > graph.nodes.length;

    const payload: UiPayload = {
      project: project.name,
      generatedAt: new Date().toISOString(),
      stats: {
        nodes: stats.nodes,
        edges: allEdges.length,
        symbols: symbols.length,
        files: new Set(symbols.map((symbol) => symbol.filePath)).size,
      },
      health: report.checks.map((check) => ({
        name: check.name,
        status: check.status,
        detail: check.detail,
      })),
      graph,
      memories,
      truncated: truncated ? { nodes: total, omitted } : null,
    };

    const file = path.resolve(options.out ?? path.join(storeDir, 'ui.html'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderUi(payload), 'utf8');

    return { file, nodes: graph.nodes.length, truncated };
  }
}

function matchesPrefix(node: MemoryNode, prefix?: string): boolean {
  if (!prefix) return true;
  return (node.filePath ?? node.sourceRef ?? '').replace(/\\/g, '/').startsWith(prefix);
}

type Graph = UiPayload['graph'];
type GraphNode = Graph['nodes'][number];
type SymbolRow = {
  id: string; name: string; filePath: string; kind: string; startLine: number; memories: Array<{ id: string }>;
};

/**
 * The picture, within a node budget, and what the budget left out.
 *
 * Tiers claim the budget in order; the one the budget runs out in is cut
 * part-way, in the order given, and the ones after it get nothing:
 *
 *   1. memories a person recorded -- decisions, constraints, what broke
 *   2. files with what they declare at the top: classes, interfaces, functions
 *   3. what those declare in turn: methods, properties
 *   4. chunks of the files themselves
 *
 * The order used to be "memories first", which on a real repository meant
 * 7,567 chunks took every one of the 1,500 places and not one file or
 * declaration was drawn: a code graph page with no code graph on it. Chunks go
 * last because they are the one kind the Memories tab lists in full anyway.
 *
 * A declaration hangs off the declaration that encloses it, not off the file,
 * so the graph shows OrderService holding Get instead of a file holding both.
 */
function buildGraph(
  memories: UiPayload['memories'],
  edges: Array<{ from: string; to: string; type: string }>,
  symbols: SymbolRow[],
  budget: number,
): { graph: Graph; total: number; omitted: Record<string, number> } {
  const recorded = memories.filter((memory) => memory.layer !== 'artifact');
  const chunks = memories.filter((memory) => memory.layer === 'artifact');
  const recordedIds = new Set(recorded.map((memory) => memory.id));
  const symbolIds = new Set(symbols.map((symbol) => symbol.id));

  // `Symbol:<file>:<Outer.Inner>` -- the enclosing declaration is the prefix.
  const parentOf = (symbol: SymbolRow): string | null => {
    const qualified = symbol.id.slice(`Symbol:${symbol.filePath}:`.length);
    const dot = qualified.lastIndexOf('.');
    if (dot === -1) return null;
    const parent = `Symbol:${symbol.filePath}:${qualified.slice(0, dot)}`;
    return symbolIds.has(parent) ? parent : null;
  };

  const byFile = new Map<string, SymbolRow[]>();
  for (const symbol of symbols) {
    const list = byFile.get(symbol.filePath) ?? [];
    list.push(symbol);
    byFile.set(symbol.filePath, list);
  }
  // Files something was decided about first, then the ones that declare most.
  const decidedAbout = (file: string) =>
    (byFile.get(file) ?? []).reduce(
      (count, symbol) => count + symbol.memories.filter((memory) => recordedIds.has(memory.id)).length, 0);
  const files = [...byFile.keys()].sort((a, b) =>
    decidedAbout(b) - decidedAbout(a) || byFile.get(b)!.length - byFile.get(a)!.length || a.localeCompare(b));

  const memoryNode = (memory: UiPayload['memories'][number]): GraphNode => ({
    id: memory.id, label: memory.title, kind: memory.layer, group: memory.layer, detail: memory.sourceRef,
  });
  const symbolNode = (symbol: SymbolRow): GraphNode => ({
    id: symbol.id, label: symbol.name, kind: symbol.kind, group: 'symbol',
    detail: `${symbol.filePath}:${symbol.startLine}`,
  });

  const tiers: GraphNode[][] = [
    recorded.map(memoryNode),
    files.flatMap((file) => [
      { id: `file:${file}`, label: file, kind: 'file', group: 'file' },
      ...byFile.get(file)!.filter((symbol) => !parentOf(symbol)).map(symbolNode),
    ]),
    files.flatMap((file) => byFile.get(file)!.filter((symbol) => parentOf(symbol)).map(symbolNode)),
    chunks.map(memoryNode),
  ];

  const nodes: GraphNode[] = [];
  const present = new Set<string>();
  for (const tier of tiers) {
    for (const node of tier) {
      if (nodes.length >= budget) break;
      if (present.has(node.id)) continue;
      present.add(node.id);
      nodes.push(node);
    }
  }
  const total = new Set(tiers.flat().map((node) => node.id)).size;

  const links: Graph['links'] = [];
  for (const symbol of symbols) {
    if (!present.has(symbol.id)) continue;
    const parent = parentOf(symbol);
    const owner = parent && present.has(parent) ? parent : `file:${symbol.filePath}`;
    if (present.has(owner)) links.push({ source: owner, target: symbol.id, kind: 'DECLARES' });
    for (const memory of symbol.memories) {
      if (present.has(memory.id)) links.push({ source: memory.id, target: symbol.id, kind: 'ABOUT' });
    }
  }
  for (const edge of edges) {
    if (present.has(edge.from) && present.has(edge.to)) {
      links.push({ source: edge.from, target: edge.to, kind: edge.type });
    }
  }

  const missing = (list: GraphNode[]) => list.filter((node) => !present.has(node.id)).length;
  const omitted: Record<string, number> = {
    'recorded memories': missing(tiers[0]!),
    files: missing(tiers[1]!.filter((node) => node.group === 'file')),
    declarations: missing(tiers[1]!.filter((node) => node.group === 'symbol')) + missing(tiers[2]!),
    chunks: missing(tiers[3]!),
  };

  // Every relation, drawn or not. A click is answered from these rather than
  // from the drawn links: once the budget left chunks out, their ABOUT links
  // went with them, and clicking a class on a real repository answered
  // "nothing is recorded" about code that had chunks all over it.
  const relations: Graph['relations'] = { owner: {}, about: {} };
  for (const symbol of symbols) {
    relations.owner[symbol.id] = parentOf(symbol) ?? `file:${symbol.filePath}`;
    if (symbol.memories.length > 0) relations.about[symbol.id] = symbol.memories.map((memory) => memory.id);
  }
  return { graph: { nodes, links, relations }, total, omitted };
}
