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

/** Past this the browser starts to struggle and the picture stops being readable. */
const MAX_GRAPH_NODES = 1500;

export async function runUi(
  options: { from?: string; out?: string; prefix?: string } = {},
): Promise<{ file: string; nodes: number; truncated: boolean }> {
  const project = resolveProject(options.from);
  const storeDir = storeDirOrThrow(options.from);
  const store = new MemoryStore(storeDir, { readOnly: true });

  try {
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

    const graph = buildGraph(memories, allEdges, symbols);
    const total = graph.nodes.length;
    const truncated = total > MAX_GRAPH_NODES;

    if (truncated) {
      // Trimmed by importance, so what survives is what someone thought mattered.
      // The page reports the cut; a silently shortened picture is a lie about the
      // shape of the graph.
      const keep = new Set(graph.nodes.slice(0, MAX_GRAPH_NODES).map((node) => node.id));
      graph.nodes = graph.nodes.filter((node) => keep.has(node.id));
      graph.links = graph.links.filter((link) => keep.has(link.source) && keep.has(link.target));
    }

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
      truncated: truncated ? { nodes: total } : null,
    };

    const file = path.resolve(options.out ?? path.join(storeDir, 'ui.html'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderUi(payload), 'utf8');

    return { file, nodes: graph.nodes.length, truncated };
  } finally {
    await store.close();
  }
}

function matchesPrefix(node: MemoryNode, prefix?: string): boolean {
  if (!prefix) return true;
  return (node.filePath ?? node.sourceRef ?? '').replace(/\\/g, '/').startsWith(prefix);
}

type Graph = UiPayload['graph'];

function buildGraph(
  memories: UiPayload['memories'],
  edges: Array<{ from: string; to: string; type: string }>,
  symbols: Array<{ id: string; name: string; filePath: string; kind: string; startLine: number; memories: Array<{ id: string }> }>,
): Graph {
  const nodes: Graph['nodes'] = [];
  const links: Graph['links'] = [];
  const present = new Set<string>();

  const add = (node: Graph['nodes'][number]) => {
    if (present.has(node.id)) return;
    present.add(node.id);
    nodes.push(node);
  };

  // Memories first: they are the point, and truncation trims from the end.
  for (const memory of memories) {
    add({
      id: memory.id,
      label: memory.title,
      kind: memory.layer,
      group: memory.layer,
      detail: memory.sourceRef,
    });
  }

  const files = new Set<string>();
  for (const symbol of symbols) files.add(symbol.filePath);
  for (const file of files) {
    add({ id: `file:${file}`, label: file, kind: 'file', group: 'file' });
  }

  for (const symbol of symbols) {
    add({
      id: symbol.id,
      label: symbol.name,
      kind: symbol.kind,
      group: 'symbol',
      detail: `${symbol.filePath}:${symbol.startLine}`,
    });
    links.push({ source: `file:${symbol.filePath}`, target: symbol.id, kind: 'DECLARES' });
    for (const memory of symbol.memories) {
      if (present.has(memory.id)) links.push({ source: memory.id, target: symbol.id, kind: 'ABOUT' });
    }
  }

  for (const edge of edges) {
    if (present.has(edge.from) && present.has(edge.to)) {
      links.push({ source: edge.from, target: edge.to, kind: edge.type });
    }
  }

  return { nodes, links };
}
