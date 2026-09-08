import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { log } from '../util/log.js';

const require = createRequire(import.meta.url);

/**
 * Which grammar handles which extension, and how a file of that kind is cut.
 *
 * A table keyed by label, rather than a chain of extension tests, so adding a
 * language is a row rather than a branch.
 */
export type ChunkMode = 'AST_DECLARATION' | 'MARKDOWN_HEADING' | 'CHARACTER';

export interface LanguageRule {
  label: string;
  grammar: string | null;
  mode: ChunkMode;
  /** Node types that mark a chunk boundary. */
  boundaries: string[];
}

const RULES: Record<string, LanguageRule> = {
  typescript: {
    label: 'typescript',
    grammar: 'tree-sitter-typescript.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'function_declaration', 'class_declaration', 'method_definition',
      'interface_declaration', 'type_alias_declaration', 'enum_declaration',
      'lexical_declaration', 'export_statement',
    ],
  },
  javascript: {
    label: 'javascript',
    grammar: 'tree-sitter-javascript.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'function_declaration', 'class_declaration', 'method_definition',
      'lexical_declaration', 'export_statement',
    ],
  },
  python: {
    label: 'python',
    grammar: 'tree-sitter-python.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_definition', 'class_definition', 'decorated_definition'],
  },
  go: {
    label: 'go',
    grammar: 'tree-sitter-go.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_declaration', 'method_declaration', 'type_declaration'],
  },
  rust: {
    label: 'rust',
    grammar: 'tree-sitter-rust.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_item', 'struct_item', 'impl_item', 'trait_item', 'enum_item'],
  },
  java: {
    label: 'java',
    grammar: 'tree-sitter-java.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['class_declaration', 'method_declaration', 'interface_declaration'],
  },
  markdown: { label: 'markdown', grammar: null, mode: 'MARKDOWN_HEADING', boundaries: [] },
  text: { label: 'text', grammar: null, mode: 'CHARACTER', boundaries: [] },
};

const BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
};

export function ruleForFile(filePath: string): LanguageRule {
  const label = BY_EXTENSION[path.extname(filePath).toLowerCase()];
  return (label && RULES[label]) || RULES.text!;
}

interface TreeSitterModule {
  init(): Promise<void>;
  Language: { load(path: string): Promise<unknown> };
  Parser: new () => TreeSitterParser;
}

export interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(source: string): unknown;
}

let runtime: Promise<TreeSitterModule | null> | null = null;
const grammars = new Map<string, unknown>();

function grammarDir(): string | null {
  try {
    return `${path.dirname(require.resolve('tree-sitter-wasms/package.json'))}/out`;
  } catch {
    return null;
  }
}

/**
 * Loads and initialises web-tree-sitter once, normalising its export shape.
 *
 * The module is required exactly here. Calling require() again after init()
 * returns a different object -- one without the constructor -- so a second call
 * site silently loses the ability to build a parser while still being able to
 * load grammars.
 */
async function treeSitter(): Promise<TreeSitterModule | null> {
  runtime ??= (async () => {
    let module: Record<string, unknown>;
    try {
      module = require('web-tree-sitter') as Record<string, unknown>;
    } catch (err) {
      log('warn', 'web-tree-sitter unavailable; chunking falls back to character windows', err);
      return null;
    }

    try {
      // Older builds export the Parser class directly; newer ones export a
      // namespace holding it. Both are accepted so the pin can move.
      const asParser = typeof module === 'function' ? (module as unknown as TreeSitterModule) : null;
      const init = (asParser ?? (module as unknown as TreeSitterModule)).init;
      await init.call(asParser ?? module);

      const Parser = (asParser ?? (module.Parser as TreeSitterModule['Parser'])) as TreeSitterModule['Parser'];
      const Language =
        ((asParser as unknown as TreeSitterModule)?.Language ??
          (module.Language as TreeSitterModule['Language']));

      if (typeof Parser !== 'function' || !Language) {
        log('warn', 'web-tree-sitter exports an unexpected shape; falling back to character chunking');
        return null;
      }
      return { init, Language, Parser } as TreeSitterModule;
    } catch (err) {
      log('warn', 'web-tree-sitter failed to initialise', err);
      return null;
    }
  })();

  return runtime;
}

/**
 * Loads a grammar, returning null when it is unavailable.
 *
 * Null is a normal answer, not an error: the chunker falls back to character
 * windows, so a missing or broken grammar costs chunk quality and nothing else.
 */
export async function loadGrammar(rule: LanguageRule): Promise<unknown | null> {
  if (!rule.grammar) return null;
  if (grammars.has(rule.label)) return grammars.get(rule.label) ?? null;

  const ts = await treeSitter();
  if (!ts) {
    grammars.set(rule.label, null);
    return null;
  }

  const dir = grammarDir();
  if (!dir) {
    log('warn', 'tree-sitter-wasms not resolvable; chunking falls back to character windows');
    grammars.set(rule.label, null);
    return null;
  }

  const file = path.join(dir, rule.grammar);
  if (!fs.existsSync(file)) {
    log('warn', `grammar missing: ${file}`);
    grammars.set(rule.label, null);
    return null;
  }

  try {
    const language = await ts.Language.load(file);
    grammars.set(rule.label, language);
    return language;
  } catch (err) {
    log('warn', `failed to load grammar ${rule.label}`, err);
    grammars.set(rule.label, null);
    return null;
  }
}

export async function newParser(rule: LanguageRule): Promise<TreeSitterParser | null> {
  const language = await loadGrammar(rule);
  if (!language) return null;

  const ts = await treeSitter();
  if (!ts) return null;

  try {
    const parser = new ts.Parser();
    parser.setLanguage(language);
    return parser;
  } catch (err) {
    log('warn', `failed to construct parser for ${rule.label}`, err);
    return null;
  }
}

export const KNOWN_LANGUAGES = Object.keys(RULES);
