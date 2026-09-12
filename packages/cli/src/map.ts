import { MemoryStore } from '@memory-layer/core';
import { storeDirOrThrow } from './project.js';

/**
 * Looking at the code graph without opening the viewer.
 *
 * `.memory/ui.html` is where a person looks. These two are for the readers that
 * cannot open a browser: a tree for a terminal, and a Mermaid diagram for
 * anywhere markdown renders -- which includes the agent calling `dai_memory_map`,
 * the reader this has to serve best.
 */

export interface CodeMapSymbol {
  /** `file:qualifiedName` -- the same string the neighbour lists below use. */
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  memories: Array<{ id: string; title: string; layer: string }>;
  /** What this declaration calls, and what reaches it. `file:name`, deduplicated. */
  calls: string[];
  calledBy: string[];
  /** What it derives from -- the base class or interface, where the language has one. */
  inherits: string[];
}

export interface CodeMapFile {
  file: string;
  symbols: CodeMapSymbol[];
  /** Files this one imports, where the import resolved to a file in the repository. */
  imports: string[];
}

export interface CodeMap {
  files: CodeMapFile[];
  symbols: number;
  withMemory: number;
  /**
   * Edge counts, and how many of them leave the requested prefix.
   *
   * A map narrowed to a directory would otherwise read as if that directory
   * called nothing outside itself. The crossing count is the difference between
   * a boundary and an absence.
   */
  relations: { calls: number; inherits: number; imports: number; crossingPrefix: number };
}

export async function runMap(options: { from?: string; prefix?: string } = {}): Promise<CodeMap> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const rows = await store.symbolMap(options.prefix);
    const byFile = new Map<string, CodeMapFile>();
    const bySymbolId = new Map<string, CodeMapSymbol>();

    for (const row of rows) {
      let entry = byFile.get(row.filePath);
      if (!entry) {
        entry = { file: row.filePath, symbols: [], imports: [] };
        byFile.set(row.filePath, entry);
      }
      const symbol: CodeMapSymbol = {
        id: label(row.id),
        name: row.name,
        kind: row.kind,
        startLine: row.startLine,
        endLine: row.endLine,
        memories: row.memories,
        calls: [],
        calledBy: [],
        inherits: [],
      };
      entry.symbols.push(symbol);
      bySymbolId.set(row.id, symbol);
    }

    // The edges, attached to the declarations already in hand.
    //
    // This tool called itself the code graph while returning only declarations,
    // which is the half of the graph that answers "what is here" and none of the
    // half that answers "what reaches this". The viewer has drawn the edges
    // since they existed; the tool an agent actually calls did not have them.
    let crossing = 0;
    const counted = { calls: 0, inherits: 0, imports: 0 };

    for (const call of await store.allCalls()) {
      const from = bySymbolId.get(call.from);
      const to = bySymbolId.get(call.to);
      if (!from && !to) continue;
      counted.calls += 1;
      if (!from || !to) crossing += 1;
      if (from) push(from.calls, label(call.to));
      if (to) push(to.calledBy, label(call.from));
    }

    for (const edge of await store.allInherits()) {
      const from = bySymbolId.get(edge.from);
      const to = bySymbolId.get(edge.to);
      if (!from && !to) continue;
      counted.inherits += 1;
      if (!from || !to) crossing += 1;
      if (from) push(from.inherits, label(edge.to));
    }

    for (const edge of await store.allImports()) {
      const from = byFile.get(edge.from);
      const to = byFile.get(edge.to);
      if (!from && !to) continue;
      counted.imports += 1;
      if (!from || !to) crossing += 1;
      if (from) push(from.imports, edge.to);
    }

    return {
      files: [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)),
      symbols: rows.length,
      withMemory: rows.filter((row) => row.memories.length > 0).length,
      relations: { ...counted, crossingPrefix: crossing },
    };
  } finally {
    await store.close();
  }
}

/** Stored ids carry a `Symbol:` tag that means nothing to a reader. */
function label(symbolId: string): string {
  return symbolId.startsWith('Symbol:') ? symbolId.slice('Symbol:'.length) : symbolId;
}

/**
 * One entry per distinct neighbour.
 *
 * A loop calling the same function forty times is one fact about the code, and
 * forty identical lines is the map spending its budget saying it forty times.
 */
function push(into: string[], value: string): void {
  if (!into.includes(value)) into.push(value);
}

/** A tree, for reading. */
export function formatMapTree(map: CodeMap): string {
  if (map.files.length === 0) {
    return 'No declarations recorded. Run `dai-memory ingest` over source files first.';
  }

  const lines: string[] = [];
  for (const file of map.files) {
    lines.push(file.file);
    file.symbols.forEach((symbol, index) => {
      const last = index === file.symbols.length - 1;
      const stem = last ? '  └─' : '  ├─';
      const cont = last ? '     ' : '  │  ';
      lines.push(`${stem} ${symbol.name}  (${symbol.kind} L${symbol.startLine}-${symbol.endLine})`);
      for (const memory of symbol.memories) {
        lines.push(`${cont} · [${memory.layer}] ${memory.title}`);
      }
      // Callers first: the question a person opens a map to answer is usually
      // "what breaks if I change this", not "what does this reach".
      for (const [arrow, names] of [['←', symbol.calledBy], ['→', symbol.calls], ['▸', symbol.inherits]] as const) {
        if (names.length > 0) lines.push(`${cont} ${arrow} ${summarise(names)}`);
      }
    });
    if (file.imports.length > 0) lines.push(`  imports: ${summarise(file.imports)}`);
    lines.push('');
  }

  lines.push(
    `${map.symbols} declarations across ${map.files.length} files; ${map.withMemory} carry memory.`,
  );
  lines.push(
    `${map.relations.calls} calls, ${map.relations.inherits} inherits, ${map.relations.imports} imports` +
    (map.relations.crossingPrefix > 0
      ? `; ${map.relations.crossingPrefix} of them reach outside this view.`
      : '.'),
  );
  return lines.join('\n');
}

/**
 * A tail of names, and the count of the ones it did not print.
 *
 * A declaration reached from ninety places is a fact worth stating; ninety
 * lines is not. What is cut is counted, because a list that stops without
 * saying so reads as a complete one.
 */
function summarise(names: string[], keep = 4): string {
  const shown = names.slice(0, keep).map((name) => name.split(':').pop() ?? name);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

/** A diagram, for looking at. */
export function formatMapMermaid(map: CodeMap): string {
  const lines = ['graph LR'];
  const nodeFor = new Map<string, string>();
  let fileIndex = 0;

  for (const file of map.files) {
    const fileId = `F${fileIndex++}`;
    lines.push(`  ${fileId}[${quote(file.file)}]`);

    file.symbols.forEach((symbol, index) => {
      const symbolId = `${fileId}S${index}`;
      nodeFor.set(symbol.id, symbolId);
      lines.push(`  ${fileId} --> ${symbolId}(${quote(symbol.name)})`);

      symbol.memories.forEach((memory, memoryIndex) => {
        const memoryId = `${symbolId}M${memoryIndex}`;
        lines.push(`  ${symbolId} -.->|about| ${memoryId}[${quote(memory.title)}]`);
      });
    });
  }

  // Drawn in a second pass: an edge can only be drawn once both ends have node
  // ids, and the target of a call is routinely declared in a later file.
  //
  // Only edges with both ends in view. A Mermaid arrow to an undeclared node
  // renders as an empty box, which says "there is something here" and nothing
  // about what -- the counts in the tree carry what left the view.
  for (const file of map.files) {
    for (const symbol of file.symbols) {
      const from = nodeFor.get(symbol.id);
      if (!from) continue;
      for (const target of symbol.calls) {
        const to = nodeFor.get(target);
        if (to) lines.push(`  ${from} ==>|calls| ${to}`);
      }
      for (const base of symbol.inherits) {
        const to = nodeFor.get(base);
        if (to) lines.push(`  ${from} -->|inherits| ${to}`);
      }
    }
  }

  if (fileIndex === 0) lines.push('  empty[No declarations recorded]');
  return lines.join('\n');
}

/**
 * Mermaid ends a label at the first bracket or quote it meets, and a label that
 * ends early takes the rest of the diagram with it: the whole thing renders as
 * nothing, with no error. Stripping them is cheaper than debugging that.
 */
function quote(text: string): string {
  const safe = text
    .replace(/[[\]{}()"'`<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `"${safe || 'unnamed'}"`;
}
