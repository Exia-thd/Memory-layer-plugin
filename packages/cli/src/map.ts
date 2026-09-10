import { MemoryStore } from '@memory-layer/core';
import { storeDirOrThrow } from './project.js';

/**
 * Looking at the code graph.
 *
 * There is no viewer yet, and building one is the easiest way to mistake motion
 * for progress. What people actually want first is to see the shape, so: a tree
 * for reading in a terminal, and a Mermaid diagram that renders anywhere
 * markdown does. Neither needs a web app.
 */

export interface CodeMapSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  memories: Array<{ id: string; title: string; layer: string }>;
}

export interface CodeMapFile {
  file: string;
  symbols: CodeMapSymbol[];
}

export interface CodeMap {
  files: CodeMapFile[];
  symbols: number;
  withMemory: number;
}

export async function runMap(options: { from?: string; prefix?: string } = {}): Promise<CodeMap> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const rows = await store.symbolMap(options.prefix);
    const byFile = new Map<string, CodeMapFile>();

    for (const row of rows) {
      let entry = byFile.get(row.filePath);
      if (!entry) {
        entry = { file: row.filePath, symbols: [] };
        byFile.set(row.filePath, entry);
      }
      entry.symbols.push({
        name: row.name,
        kind: row.kind,
        startLine: row.startLine,
        endLine: row.endLine,
        memories: row.memories,
      });
    }

    return {
      files: [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)),
      symbols: rows.length,
      withMemory: rows.filter((row) => row.memories.length > 0).length,
    };
  } finally {
    await store.close();
  }
}

/** A tree, for reading. */
export function formatMapTree(map: CodeMap): string {
  if (map.files.length === 0) {
    return 'No declarations recorded. Run `memory ingest` over source files first.';
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
    });
    lines.push('');
  }

  lines.push(
    `${map.symbols} declarations across ${map.files.length} files; ${map.withMemory} carry memory.`,
  );
  return lines.join('\n');
}

/** A diagram, for looking at. */
export function formatMapMermaid(map: CodeMap): string {
  const lines = ['graph LR'];
  let fileIndex = 0;

  for (const file of map.files) {
    const fileId = `F${fileIndex++}`;
    lines.push(`  ${fileId}[${quote(file.file)}]`);

    file.symbols.forEach((symbol, index) => {
      const symbolId = `${fileId}S${index}`;
      lines.push(`  ${fileId} --> ${symbolId}(${quote(symbol.name)})`);

      symbol.memories.forEach((memory, memoryIndex) => {
        const memoryId = `${symbolId}M${memoryIndex}`;
        lines.push(`  ${symbolId} -.->|about| ${memoryId}[${quote(memory.title)}]`);
      });
    });
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
