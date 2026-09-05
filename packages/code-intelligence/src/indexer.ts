/**
 * The code index: every analyzed file, plus the cross-file resolution that
 * turns per-file facts into a picture of the whole repository.
 *
 * Resolution happens in two passes because it has to. A file's imports cannot
 * be resolved until the set of files is known, and a reference cannot be
 * attributed to a declaration until every file's exports are known. So the
 * indexer analyzes each file independently, then links them.
 *
 * **Unresolved is a first-class outcome, and it is graded.** A name may resolve
 * to a workspace declaration, come from an external package, or resolve to
 * nothing the index can see — a global, or a member reached through a value
 * whose type is not knowable syntactically. The three are counted separately,
 * because lumping them together would make a healthy index of a
 * dependency-heavy project look broken and hide the cases that are real gaps.
 * Nothing is guessed at: `resolutionRate` reports what the agent genuinely
 * knows, which is what makes an honest "I cannot see where this comes from"
 * possible instead of a confident wrong answer.
 */

import type { PathPolicy } from '@aica/security-engine';
import type { Logger, Result } from '@aica/shared';
import { Limits, err, errors, ok, silentLogger } from '@aica/shared';
import type { WorkspaceReader } from '@aica/fs-engine';

import { analyzeFile, isAnalyzableLanguage, languageOf } from './analyzer.js';
import type { FileIndex, ReferenceRecord, SymbolRecord } from './symbols.js';
import { symbolId } from './symbols.js';

/** Extensions tried, in order, when a specifier omits one. */
const RESOLVE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

const INDEX_BASENAMES: readonly string[] = ['index'];

export interface IndexStats {
  readonly files: number;
  readonly symbols: number;
  readonly references: number;
  /** References attributed to a declaration in the workspace. */
  readonly resolvedReferences: number;
  /**
   * References bound by an import from an external package. Their origin is
   * known; the declaration simply lives outside the workspace.
   */
  readonly externalReferences: number;
  /**
   * References reached through a property access. Resolving one needs the
   * receiver's type, so they are counted rather than attributed.
   */
  readonly memberReferences: number;
  /**
   * References to names neither declared in the workspace nor imported from a
   * package: globals such as `fetch` and built-ins such as `Promise`.
   */
  readonly unresolvedReferences: number;
  /** Local imports whose target file was not found. */
  readonly unresolvedImports: number;
  readonly durationMs: number;
  /** Files skipped for size, and files that failed to read. */
  readonly skipped: readonly string[];
}

export interface IndexerOptions {
  readonly reader: WorkspaceReader;
  readonly pathPolicy?: PathPolicy;
  readonly logger?: Logger;
  /** Largest file analyzed; beyond this only metadata is kept. */
  readonly maxFileBytes?: number;
}

export interface BuildOptions {
  /** Directory to index, workspace-relative. Defaults to the whole workspace. */
  readonly root?: string;
  readonly maxFiles?: number;
}

/**
 * A built index. Immutable: rebuilding produces a new one, so a consumer
 * holding an index never sees it change underneath.
 */
export class CodeIndex {
  private readonly byPath: ReadonlyMap<string, FileIndex>;
  private readonly symbolsById: ReadonlyMap<string, SymbolRecord>;
  private readonly symbolsByName: ReadonlyMap<string, readonly SymbolRecord[]>;
  /** file -> exported name -> symbol id, with re-exports followed. */
  private readonly exportsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>;

  constructor(
    files: readonly FileIndex[],
    readonly stats: IndexStats,
  ) {
    const byPath = new Map<string, FileIndex>();
    const symbolsById = new Map<string, SymbolRecord>();
    const symbolsByName = new Map<string, SymbolRecord[]>();

    for (const file of files) {
      byPath.set(file.path, file);
      for (const symbol of file.symbols) {
        symbolsById.set(symbol.id, symbol);
        const existing = symbolsByName.get(symbol.name);
        if (existing) existing.push(symbol);
        else symbolsByName.set(symbol.name, [symbol]);
      }
    }

    this.byPath = byPath;
    this.symbolsById = symbolsById;
    this.symbolsByName = symbolsByName;
    this.exportsByFile = buildExportTable(byPath);
  }

  get files(): readonly FileIndex[] {
    return [...this.byPath.values()];
  }

  get size(): number {
    return this.byPath.size;
  }

  file(path: string): FileIndex | undefined {
    return this.byPath.get(path);
  }

  symbol(id: string): SymbolRecord | undefined {
    return this.symbolsById.get(id);
  }

  /** Every declaration of a name, across the workspace. */
  symbolsNamed(name: string): readonly SymbolRecord[] {
    return this.symbolsByName.get(name) ?? [];
  }

  get allSymbols(): readonly SymbolRecord[] {
    return [...this.symbolsById.values()];
  }

  /** Exported symbols of one file, by the name it exports them under. */
  exportsOf(path: string): ReadonlyMap<string, string> {
    return this.exportsByFile.get(path) ?? new Map();
  }

  /**
   * Every reference to a symbol, across every file.
   *
   * This is the question the agent asks before changing anything: who depends
   * on this declaration?
   */
  referencesTo(id: string): readonly ReferenceRecord[] {
    const found: ReferenceRecord[] = [];
    for (const file of this.byPath.values()) {
      for (const reference of file.references) {
        if (reference.symbolId === id) found.push(reference);
      }
    }
    return found;
  }

  /** Local files this file imports from. */
  dependenciesOf(path: string): readonly string[] {
    const file = this.byPath.get(path);
    if (!file) return [];
    return [
      ...new Set(
        file.imports
          .map((record) => record.resolvedFile)
          .filter((target): target is string => target !== undefined),
      ),
    ];
  }

  /** Files that import this one. */
  dependentsOf(path: string): readonly string[] {
    const found = new Set<string>();
    for (const file of this.byPath.values()) {
      if (file.imports.some((record) => record.resolvedFile === path)) found.add(file.path);
    }
    return [...found];
  }

  /**
   * How completely the workspace's own references were attributed, 0 to 1.
   *
   * References into external packages and through property accesses are
   * excluded from both sides: neither was ever resolvable to a workspace
   * declaration by syntax alone, so counting them as failures would make a
   * healthy index of a dependency-heavy project look broken. What remains
   * measures what it claims to.
   */
  get resolutionRate(): number {
    const inScope = this.stats.resolvedReferences + this.stats.unresolvedReferences;
    return inScope === 0 ? 1 : this.stats.resolvedReferences / inScope;
  }
}

export class Indexer {
  private readonly reader: WorkspaceReader;
  private readonly logger: Logger;
  private readonly maxFileBytes: number;

  constructor(options: IndexerOptions) {
    this.reader = options.reader;
    this.logger = (options.logger ?? silentLogger).child('index');
    this.maxFileBytes = options.maxFileBytes ?? Limits.maxIndexBytes;
  }

  /**
   * Walk the workspace, analyze every source file, then link them.
   *
   * Ignore rules come from the path policy the reader already enforces, so the
   * indexer cannot reach outside the project or into `node_modules` even by
   * accident.
   */
  async build(options: BuildOptions = {}): Promise<Result<CodeIndex>> {
    const started = Date.now();

    const listed = await this.reader.list(options.root ?? '.', {
      recursive: true,
      maxEntries: options.maxFiles ?? Limits.maxListEntries,
    });
    if (!listed.ok) return listed;

    const skipped: string[] = [];
    const analyzed: FileIndex[] = [];

    for (const entry of listed.value.entries) {
      if (entry.kind !== 'file') continue;
      if (!isAnalyzableLanguage(languageOf(entry.path))) continue;

      if (entry.bytes !== undefined && entry.bytes > this.maxFileBytes) {
        skipped.push(entry.path);
        continue;
      }

      const read = await this.reader.read(entry.path);
      if (!read.ok) {
        // One unreadable file must not abort indexing the repository.
        this.logger.debug('skipped unreadable file', { path: entry.path });
        skipped.push(entry.path);
        continue;
      }

      if (read.value.truncated) {
        // A partial file would yield a partial and misleading symbol table.
        skipped.push(entry.path);
        continue;
      }

      analyzed.push(
        analyzeFile(read.value.content, {
          path: entry.path,
          hash: read.value.hash,
          bytes: read.value.bytes,
        }),
      );
    }

    const linked = link(analyzed);

    const stats: IndexStats = {
      files: linked.files.length,
      symbols: linked.files.reduce((sum, file) => sum + file.symbols.length, 0),
      references: linked.files.reduce((sum, file) => sum + file.references.length, 0),
      resolvedReferences: linked.files.reduce(
        (sum, file) => sum + file.references.filter((entry) => entry.symbolId !== undefined).length,
        0,
      ),
      externalReferences: linked.externalReferences,
      memberReferences: linked.memberReferences,
      unresolvedReferences: linked.unresolvedReferences,
      unresolvedImports: linked.unresolvedImports,
      durationMs: Date.now() - started,
      skipped,
    };

    this.logger.debug('index built', {
      files: stats.files,
      symbols: stats.symbols,
      unresolvedReferences: stats.unresolvedReferences,
    });

    return ok(new CodeIndex(linked.files, stats));
  }

  /** Re-analyze one file against an existing index, for incremental updates. */
  async updateFile(index: CodeIndex, path: string): Promise<Result<CodeIndex>> {
    if (!isAnalyzableLanguage(languageOf(path))) {
      return err(errors.unsupported(`${path} is not a language the indexer analyzes`, { path }));
    }

    const read = await this.reader.read(path);
    if (!read.ok) return read;

    const replaced = analyzeFile(read.value.content, {
      path,
      hash: read.value.hash,
      bytes: read.value.bytes,
    });

    // Linking again is what keeps resolution correct: a changed export must be
    // reflected in every file that imports it, not only in the file that moved.
    const files = index.files.filter((file) => file.path !== path);
    const linked = link([...files, replaced]);

    return ok(
      new CodeIndex(linked.files, {
        ...index.stats,
        files: linked.files.length,
        symbols: linked.files.reduce((sum, file) => sum + file.symbols.length, 0),
        references: linked.files.reduce((sum, file) => sum + file.references.length, 0),
        resolvedReferences: linked.files.reduce(
          (sum, file) =>
            sum + file.references.filter((entry) => entry.symbolId !== undefined).length,
          0,
        ),
        externalReferences: linked.externalReferences,
        memberReferences: linked.memberReferences,
        unresolvedReferences: linked.unresolvedReferences,
        unresolvedImports: linked.unresolvedImports,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

interface LinkResult {
  readonly files: FileIndex[];
  readonly unresolvedReferences: number;
  readonly externalReferences: number;
  readonly memberReferences: number;
  readonly unresolvedImports: number;
}

/**
 * Second pass: resolve import specifiers to files, then references to symbols.
 */
function link(files: readonly FileIndex[]): LinkResult {
  const paths = new Set(files.map((file) => file.path));

  let unresolvedImports = 0;
  const withImports = files.map((file) => {
    const imports = file.imports.map((record) => {
      if (record.external) return record;

      const resolved = resolveSpecifier(file.path, record.moduleSpecifier, paths);
      if (resolved === undefined) {
        unresolvedImports += 1;
        return record;
      }
      return { ...record, resolvedFile: resolved };
    });

    const exports = file.exports.map((record) => {
      if (record.fromModule === undefined) return record;
      const resolved = resolveSpecifier(file.path, record.fromModule, paths);
      return resolved === undefined ? record : { ...record, resolvedFile: resolved };
    });

    return { ...file, imports, exports };
  });

  const byPath = new Map(withImports.map((file) => [file.path, file]));
  const exportTable = buildExportTable(byPath);

  let unresolvedReferences = 0;
  let externalReferences = 0;
  let memberReferences = 0;

  const linked = withImports.map((file) => {
    const local = localDeclarations(file);
    const imported = importedBindings(file, exportTable);
    const external = externalBindings(file);

    const references = file.references.map((reference) => {
      // A member name belongs to whatever the receiver's type turns out to be,
      // which syntax cannot tell us. Matching it against a same-named import
      // would attribute `obj.format()` to an imported `format` — a wrong answer
      // dressed up as a resolved one.
      if (reference.member === true) {
        memberReferences += 1;
        return reference;
      }

      const target = imported.get(reference.name) ?? local.get(reference.name);
      if (target !== undefined) return { ...reference, symbolId: target };

      // Bound by a package import: the declaration is real and its origin is
      // known, it simply is not in this workspace.
      if (external.has(reference.name)) {
        externalReferences += 1;
        return { ...reference, external: true };
      }

      unresolvedReferences += 1;
      return reference;
    });

    return { ...file, references };
  });

  return {
    files: linked,
    unresolvedReferences,
    externalReferences,
    memberReferences,
    unresolvedImports,
  };
}

/** Top-level declarations of a file, by the name they bind. */
function localDeclarations(file: FileIndex): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const symbol of file.symbols) {
    // Members are addressed through their container, not by bare name.
    if (symbol.container !== undefined) continue;
    if (!declarations.has(symbol.name)) declarations.set(symbol.name, symbol.id);
  }
  return declarations;
}

/** Local names a file binds by importing them from an external package. */
function externalBindings(file: FileIndex): Set<string> {
  const names = new Set<string>();
  for (const record of file.imports) {
    if (!record.external) continue;
    const local = record.localName ?? record.importedName;
    if (local !== undefined && local !== '*') names.add(local);
  }
  return names;
}

/** Names a file binds by importing them, mapped to the declaration imported. */
function importedBindings(
  file: FileIndex,
  exportTable: ReadonlyMap<string, ReadonlyMap<string, string>>,
): Map<string, string> {
  const bindings = new Map<string, string>();

  for (const record of file.imports) {
    if (record.resolvedFile === undefined) continue;
    if (record.importedName === undefined || record.importedName === '*') continue;

    const exported = exportTable.get(record.resolvedFile)?.get(record.importedName);
    if (exported === undefined) continue;

    bindings.set(record.localName ?? record.importedName, exported);
  }

  return bindings;
}

/**
 * What each file exports, by exported name, following re-export chains.
 *
 * `export { x } from './y'` means asking this file for `x` must yield the
 * declaration in `y` — otherwise a barrel file would break every reference that
 * goes through it, which in a real codebase is most of them.
 */
function buildExportTable(files: ReadonlyMap<string, FileIndex>): Map<string, Map<string, string>> {
  const table = new Map<string, Map<string, string>>();
  for (const path of files.keys()) table.set(path, new Map());

  const MAX_DEPTH = 10;

  const resolveIn = (path: string, name: string, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) return undefined;

    const file = files.get(path);
    if (!file) return undefined;

    const record = file.exports.find((entry) => entry.name === name);

    if (record?.fromModule !== undefined) {
      // Re-exported: the declaration lives in the module it came from.
      return record.resolvedFile === undefined
        ? undefined
        : resolveIn(record.resolvedFile, record.localName ?? name, depth + 1);
    }

    const localName = record?.localName ?? name;
    const declaration = file.symbols.find(
      (symbol) => symbol.container === undefined && symbol.name === localName,
    );
    if (declaration) return declaration.id;

    // `export * from './y'` — the name may come from any starred module.
    for (const star of file.exports.filter((entry) => entry.name === '*')) {
      if (star.resolvedFile === undefined) continue;
      const found = resolveIn(star.resolvedFile, name, depth + 1);
      if (found !== undefined) return found;
    }

    return undefined;
  };

  for (const [path, file] of files) {
    const entries = table.get(path) as Map<string, string>;
    for (const record of file.exports) {
      if (record.name === '*') continue;
      const resolved = resolveIn(path, record.name, 0);
      if (resolved !== undefined) entries.set(record.name, resolved);
    }
  }

  return table;
}

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a relative specifier against the set of indexed files.
 *
 * This implements the part of Node/TypeScript resolution that actually matters
 * for a source index: relative paths, the TypeScript convention of writing
 * `./x.js` for `./x.ts`, extensionless specifiers, and directory indexes.
 * Package resolution is not attempted — an external specifier is marked
 * external and left alone rather than half-resolved.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined;

  const base = joinPath(dirname(fromFile), specifier);

  // An emitted-JS specifier standing for a TypeScript source: `./config.js`
  // is how ESM TypeScript must refer to `./config.ts`.
  const withoutExtension = base.replace(/\.(js|jsx|mjs|cjs)$/, '');

  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((extension) => `${withoutExtension}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...INDEX_BASENAMES.flatMap((name) =>
      RESOLVE_EXTENSIONS.map((extension) => `${base}/${name}${extension}`),
    ),
  ];

  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }

  return undefined;
}

function dirname(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

/** Join POSIX-style, collapsing `.` and `..` without touching the filesystem. */
function joinPath(base: string, relative: string): string {
  const segments = base.length > 0 ? base.split('/') : [];

  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }

  return segments.join('/');
}

export { symbolId };
