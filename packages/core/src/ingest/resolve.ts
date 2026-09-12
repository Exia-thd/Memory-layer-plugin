import path from 'node:path';
import type { MemoryStore } from '../store/store.js';
import type { SymbolRow } from '../types.js';
import type { FileRelations } from './relations.js';
import { ruleForFile } from './languages.js';
import type { Declaration } from './chunker.js';

/**
 * Turning names into edges.
 *
 * A call site says `FindAsync`. Which declaration that is takes the rest of the
 * repository: what kind of thing can answer at all, the file's own
 * declarations, what it imports, what the receiver is called.
 *
 * Candidates are narrowed by kind first -- a construction can only be a type,
 * a call only something callable -- and then by where they live. Every edge
 * carries how it was resolved:
 *
 *   type      the receiver was declared with a type that declares it:
 *             `private readonly OrderRepository _repo` then `_repo.FindById`
 *   file      the only declaration of that name in the calling file
 *   receiver  the receiver names a type that declares it: `Mapper.ToDto`
 *   import    the only match among the files this one imports, or the only one
 *             in a namespace this file can see
 *   unique    the only declaration of that name in the repository
 *
 * Where that still leaves several, nothing is written: the call is counted as
 * ambiguous. Where it leaves none, the name belongs to a framework or the
 * standard library and is counted as going outside the repository -- measured
 * on a real C# service, 68,000 of 74,000 call sites. The two are different
 * facts and are reported as such.
 *
 * Nothing here reads types, and the limit shows: dozens of test classes in one namespace,
 * each declaring the same helper method, cannot be told apart by anything
 * short of inferring what the receiver is. Those stay ambiguous.
 */

export type Confidence = 'type' | 'file' | 'receiver' | 'import' | 'unique';

export interface RelationReport {
  calls: number;
  inherits: number;
  imports: number;
  /** Files whose relations could not be written. Counted, never silent. */
  failed: number;
  /**
   * Call sites that named something this repository does not declare: a
   * framework, the standard library, a package. Not a failure and not
   * resolvable -- on a real C# service these are most of the call sites, and
   * counting them as unresolved made a working graph look broken.
   */
  external: number;
  /** Call sites whose name matched more than one declaration here. */
  ambiguous: number;
  byConfidence: Record<string, number>;
}

export function emptyRelationReport(): RelationReport {
  return { calls: 0, inherits: 0, imports: 0, failed: 0, external: 0, ambiguous: 0, byConfidence: {} };
}

export interface RepoIndex {
  /** Every file the walk collected, repository-relative with forward slashes. */
  paths: Set<string>;
  /** Basename -> paths, for `#include "invoice.h"` and `./repository.js`. */
  byName: Map<string, string[]>;
}

export function repoIndex(relativePaths: string[]): RepoIndex {
  const byName = new Map<string, string[]>();
  for (const file of relativePaths) {
    const base = file.split('/').pop() ?? file;
    const list = byName.get(base) ?? [];
    list.push(file);
    byName.set(base, list);
  }
  return { paths: new Set(relativePaths), byName };
}

/**
 * Writes one file's relations, replacing whatever it wrote before.
 *
 * Runs inside the caller's transaction: a file's declarations, the memories
 * about them and the edges between them land together or not at all.
 */
export async function writeRelations(
  store: MemoryStore,
  input: {
    filePath: string;
    language: string;
    relations: FileRelations;
    declared: Declaration[];
    index: RepoIndex;
  },
  report: RelationReport,
): Promise<void> {
  const { filePath, language, relations, declared, index } = input;

  await store.clearRelationsFrom(filePath);
  // The row has to exist before an edge can start from it. Created here and
  // filled in below: an import edge written against a file with no row is
  // counted and silently lost, which is how the first version reported two
  // imports for a repository with hundreds.
  await store.ensureFile(filePath, language);
  for (const declaration of declared) {
    await store.linkDeclares(filePath, symbolId(filePath, declaration.qualifiedName));
  }

  // Imports first: they are what makes the calls resolvable.
  const importedFiles = new Set<string>();
  /**
   * Namespaces this file can see: what it imports, and its own.
   *
   * A C# `using Billing.Domain` names a namespace spread over fifty files,
   * so it is not one import edge -- but it is exactly what tells `FindAsync`
   * apart from the other three declarations of that name.
   */
  const visibleContainers = new Set<string>();
  if (relations.container) visibleContainers.add(relations.container);
  for (const site of relations.imports) {
    for (const candidate of containerCandidates(site.module)) visibleContainers.add(candidate);
    const target = await resolveImport(store, site.module, filePath, index);
    if (!target || target === filePath) continue;
    importedFiles.add(target);
    // The imported file may not have been read yet; the edge needs a row at
    // both ends, and the walk will fill in its language and namespace later.
    await store.ensureFile(target, ruleForFile(target).label);
    await store.addImport(filePath, target, site.module);
    report.imports += 1;
  }

  // Written after the imports are read, so the row carries what this file can
  // see: the retry pass resolves against it without opening the file again.
  await store.upsertFile({
    path: filePath,
    language,
    container: relations.container,
    uses: [...visibleContainers],
  });

  const names = [
    ...new Set([...relations.calls.map((call) => call.name), ...relations.heritage.map((item) => item.base)]),
  ];
  const rows = await store.symbolsNamed(names);
  const candidates = new Map<string, SymbolRow[]>();
  for (const row of rows) {
    const list = candidates.get(row.name) ?? [];
    list.push(row);
    candidates.set(row.name, list);
  }
  const containers = await store.containersFor([...new Set(rows.map((row) => row.filePath))]);

  // A line can hold the same name twice -- `text.Replace(a).Replace(b)` -- so
  // the position in the file, not the line, is what makes a pending row unique.
  // Keyed on line and name alone, that line aborted the whole ingest of a real
  // repository on a duplicate primary key.
  let callIndex = 0;
  for (const call of relations.calls) {
    callIndex += 1;
    const from = call.fromQualified ? symbolId(filePath, call.fromQualified) : null;
    if (!from) continue; // A call at file level belongs to no declaration.

    const picked = choose(candidates.get(call.name) ?? [], {
      filePath,
      receiver: call.receiver,
      receiverType: call.receiverType,
      construction: call.construction,
      imported: importedFiles,
      visibleContainers,
      containers,
    });
    if (!picked.row) {
      if (picked.reason === 'external') report.external += 1;
      else report.ambiguous += 1;
      await store.addPendingCall({
        id: `Pending:call:${filePath}:${callIndex}:${call.name}`,
        filePath,
        fromSymbol: from,
        name: call.name,
        receiver: call.receiver,
        line: call.line,
        kind: call.construction ? 'construct' : 'call',
        reason: picked.reason ?? 'external',
      });
      continue;
    }
    if (picked.row.id === from) continue; // Recursion is not an edge worth drawing.
    await store.addCall(from, picked.row.id, {
      name: call.name,
      line: call.line,
      confidence: picked.confidence!,
    });
    report.calls += 1;
    report.byConfidence[picked.confidence!] = (report.byConfidence[picked.confidence!] ?? 0) + 1;
  }

  let baseIndex = 0;
  for (const item of relations.heritage) {
    baseIndex += 1;
    const from = symbolId(filePath, item.qualified);
    // A base type is a type, whatever the grammar calls the clause.
    const picked = choose(candidates.get(item.base) ?? [], {
      filePath,
      receiver: null,
      construction: true,
      imported: importedFiles,
      visibleContainers,
      containers,
    });
    if (!picked.row) {
      // The base type may live in a file this walk has not reached yet, or
      // outside the repository altogether -- a framework base class.
      if (picked.reason === 'external') report.external += 1;
      else report.ambiguous += 1;
      await store.addPendingCall({
        id: `Pending:inherits:${filePath}:${baseIndex}:${item.base}`,
        filePath,
        fromSymbol: from,
        name: item.base,
        receiver: null,
        line: item.line,
        kind: 'inherits',
        reason: picked.reason ?? 'external',
      });
      continue;
    }
    if (picked.row.id === from) continue;
    await store.addInherits(from, picked.row.id, picked.confidence!);
    report.inherits += 1;
  }
}

/**
 * Retries the calls that had nothing to point at.
 *
 * A file read before the file it calls into has no candidate to resolve
 * against. Rather than leave the edge missing until something happens to touch
 * the caller again, the names declared in this run are matched against what is
 * pending -- which is how a first full ingest ends up with a complete graph
 * whatever order the walk happened to take.
 */
export async function resolvePending(
  store: MemoryStore,
  declaredNames: string[],
  report: RelationReport,
): Promise<void> {
  const pending = await store.pendingCallsNamed([...new Set(declaredNames)]);
  if (pending.length === 0) return;

  const rows = await store.symbolsNamed([...new Set(pending.map((item) => item.name))]);
  const candidates = new Map<string, SymbolRow[]>();
  for (const row of rows) {
    const list = candidates.get(row.name) ?? [];
    list.push(row);
    candidates.set(row.name, list);
  }
  // The same context the first attempt had: what each calling file imports and
  // which namespace each candidate is declared in. Without it the retry could
  // only resolve names that are unique repository-wide, which left the graph
  // dependent on the order the walk read the files in.
  const containers = await store.containersFor([...new Set(rows.map((row) => row.filePath))]);
  const visible = await store.visibleFor([...new Set(pending.map((item) => item.filePath))]);
  const importedByFile = new Map<string, Set<string>>();
  for (const edge of await store.allImports()) {
    const set = importedByFile.get(edge.from) ?? new Set<string>();
    set.add(edge.to);
    importedByFile.set(edge.from, set);
  }

  const resolved: string[] = [];
  for (const item of pending) {
    const picked = choose(candidates.get(item.name) ?? [], {
      filePath: item.filePath,
      receiver: item.receiver || null,
      // `construct` and `inherits` both name a type; only a plain call does not.
      construction: item.kind !== 'call',
      imported: importedByFile.get(item.filePath) ?? new Set(),
      visibleContainers: new Set(visible.get(item.filePath) ?? []),
      containers,
    });
    if (!picked.row || picked.row.id === item.fromSymbol) continue;
    if (item.kind === 'inherits') {
      await store.addInherits(item.fromSymbol, picked.row.id, picked.confidence!);
      report.inherits += 1;
    } else {
      await store.addCall(item.fromSymbol, picked.row.id, {
        name: item.name,
        line: item.line,
        confidence: picked.confidence!,
      });
      report.calls += 1;
      report.byConfidence[picked.confidence!] = (report.byConfidence[picked.confidence!] ?? 0) + 1;
    }
    report.external = Math.max(0, report.external - 1);
    resolved.push(item.id);
  }
  await store.deletePendingCalls(resolved);
}

/** Kinds that can be constructed: a type, by any grammar's name for one. */
const TYPE_KIND = /class|record|struct|interface|enum|type|trait|object|contract|module/i;
/** Kinds that can be called. */
const CALLABLE_KIND = /function|method|constructor|def|macro|command|predicate|init/i;

interface Context {
  filePath: string;
  receiver: string | null;
  /** The type the receiver was declared with, when the file said so. */
  receiverType?: string | null;
  /** `new Order()`: only a type can answer. */
  construction?: boolean;
  /** Files this one imports by path. */
  imported: Set<string>;
  /** Namespaces this one can see, its own included. */
  visibleContainers: Set<string>;
  /** The namespace each candidate's file declares. */
  containers: Map<string, string>;
}

interface Choice {
  row?: SymbolRow;
  confidence?: Confidence;
  /**
   * Why there is no row: `external` means this repository declares nothing of
   * that name -- a framework or standard-library call -- and `ambiguous` means
   * it declares several and nothing here tells them apart.
   */
  reason?: 'external' | 'ambiguous';
}

/** The one declaration this name means, or why it is not knowable. */
function choose(all: SymbolRow[], context: Context): Choice {
  if (all.length === 0) return { reason: 'external' };

  // A construction names a type; a call names something callable. Narrowing by
  // kind first is what keeps `new Customer()` off the property named Customer,
  // and what leaves one candidate where there were three.
  const wanted = context.construction ? TYPE_KIND : CALLABLE_KIND;
  const byKind = all.filter((row) => wanted.test(row.kind));
  const rows = byKind.length > 0 ? byKind : all;

  // The declared type of the receiver, where the file gave one. Nothing else
  // available here is this specific: it is the difference between one
  // `FindById` and the thirty others in a repository.
  if (context.receiverType) {
    const owned = rows.filter((row) => owner(row) === context.receiverType);
    if (owned.length === 1) return { row: owned[0]!, confidence: 'type' };
  }

  const sameFile = rows.filter((row) => row.filePath === context.filePath);
  if (sameFile.length === 1) return { row: sameFile[0]!, confidence: 'file' };

  if (context.receiver) {
    // `Mapper.ToDto` and `_repo.FindAsync` both name their owner; the first is
    // a type, the second a field named after one often enough to be worth
    // trying. Only an exact match on the enclosing declaration counts.
    const owned = rows.filter((row) => owner(row) === context.receiver);
    if (owned.length === 1) return { row: owned[0]!, confidence: 'receiver' };
  }

  const fromImports = rows.filter((row) => context.imported.has(row.filePath));
  if (fromImports.length === 1) return { row: fromImports[0]!, confidence: 'import' };

  // A namespace the file can see. This is what resolves most of a C# or Java
  // repository: the import is a namespace over many files, not a file.
  const visible = rows.filter((row) => {
    const container = context.containers.get(row.filePath);
    return container ? context.visibleContainers.has(container) : false;
  });
  if (visible.length === 1) return { row: visible[0]!, confidence: 'import' };

  if (rows.length === 1) return { row: rows[0]!, confidence: 'unique' };
  return { reason: 'ambiguous' };
}

async function resolveImport(
  store: MemoryStore,
  module: string,
  fromPath: string,
  index: RepoIndex,
): Promise<string | null> {
  const clean = module.trim().replace(/^["'<]|[">']$/g, '');
  if (!clean) return null;

  // A path, relative or not: `./repository.js`, `domain/invoice.h`,
  // `package:billing/domain.dart`.
  const asPath = clean.replace(/^package:/, '').split('?')[0]!;
  if (asPath.includes('/') || asPath.includes('.')) {
    const direct = matchPath(asPath, fromPath, index);
    if (direct) return direct;
  }

  // A namespace or package: the file that declares it.
  const files = await store.filesWithContainer(containerCandidates(clean));
  if (files.length === 1) return files[0]!.path;
  return null;
}

function matchPath(module: string, fromPath: string, index: RepoIndex): string | null {
  const fromDir = path.posix.dirname(fromPath);
  const written = module.startsWith('.')
    ? [path.posix.normalize(path.posix.join(fromDir, module))]
    : [module, path.posix.normalize(path.posix.join(fromDir, module))];

  // TypeScript is imported by the name of what it compiles to: `./repo.js` is
  // `./repo.ts` on disk. So each path is also tried with its extension removed.
  const bases = written.flatMap((base) => {
    const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    return stripped === base ? [base] : [base, stripped];
  });

  const suffixes = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.php', '.dart',
    '.kt', '.scala', '.rs', '.swift', '.lua', '.sh', '.ex', '.exs', '.h', '.hpp', '.cs',
    '/index.ts', '/index.js', '/__init__.py', '/mod.rs'];
  for (const base of bases) {
    for (const suffix of suffixes) {
      const candidate = trimLeading(`${base}${suffix}`);
      if (index.paths.has(candidate)) return candidate;
    }
    // `#include "invoice.h"` names a file, not a path from the root.
    const byName = index.byName.get(base.split('/').pop() ?? '');
    if (byName?.length === 1) return byName[0]!;
  }
  return null;
}

function trimLeading(value: string): string {
  return value.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** `billing.domain.Invoice` might be a namespace, or a type inside one. */
function containerCandidates(module: string): string[] {
  const parts = module.replace(/\\/g, '.').split('.').filter(Boolean);
  const out: string[] = [];
  for (let end = parts.length; end > 0 && out.length < 4; end--) out.push(parts.slice(0, end).join('.'));
  return out;
}

/** The declaration that encloses this one, by qualified name: `OrderService` of `OrderService.Get`. */
function owner(row: SymbolRow): string {
  return qualifiedOf(row).split('.').slice(0, -1).join('.');
}

function qualifiedOf(row: SymbolRow): string {
  return row.id.slice(`Symbol:${row.filePath}:`.length);
}

export function symbolId(filePath: string, qualifiedName: string): string {
  return `Symbol:${filePath}:${qualifiedName}`;
}
