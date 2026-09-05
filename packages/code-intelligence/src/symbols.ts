/**
 * The symbol model: what the indexer knows about a codebase.
 *
 * These are AST-derived facts, which rank third in the authority order — above
 * the API specification and far above anything the model says. So the model is
 * built to record only what the syntax actually states:
 *
 * - A symbol's `signature` is the source text of its declaration, not a
 *   reconstruction. If the agent quotes a signature, it is quoting the file.
 * - `exported` is set from an explicit `export` keyword or export statement,
 *   never inferred from naming or directory position.
 * - A reference is a *syntactic* occurrence of a name. Resolution to a
 *   declaration is a separate, explicitly-fallible step, because a name can be
 *   shadowed, re-exported, or come from a dependency that is not installed.
 *
 * Positions are 1-based lines and columns, matching what editors and compilers
 * report, so a location can be handed to the user or to a diagnostic unchanged.
 */

export const SymbolKind = {
  function: 'function',
  method: 'method',
  class: 'class',
  interface: 'interface',
  typeAlias: 'typeAlias',
  enum: 'enum',
  enumMember: 'enumMember',
  variable: 'variable',
  property: 'property',
  parameter: 'parameter',
  module: 'module',
  component: 'component',
} as const;

export type SymbolKind = (typeof SymbolKind)[keyof typeof SymbolKind];

export interface Position {
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location extends Range {
  /** Workspace-relative, POSIX separators. */
  readonly file: string;
}

export interface SymbolRecord {
  /** `path/to/file.ts#Name` — unique within a project. */
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly location: Location;
  /** Whether the declaration carries an explicit `export`. */
  readonly exported: boolean;
  /** Verbatim declaration text, truncated; never reconstructed. */
  readonly signature?: string;
  /** Leading JSDoc or line comment, stripped of markers. */
  readonly doc?: string;
  /** Enclosing symbol id, e.g. the class a method belongs to. */
  readonly container?: string;
  readonly async?: boolean;
  readonly deprecated?: boolean;
  /** For a default export, the name it is exported under is `default`. */
  readonly defaultExport?: boolean;
}

/** How a name is used at a particular place in a file. */
export const ReferenceKind = {
  /** The name appears in a call position: `foo()`. */
  call: 'call',
  /** The name is constructed: `new Foo()`. */
  construct: 'construct',
  /** The name appears in a type position. */
  type: 'type',
  /** The name is imported. */
  import: 'import',
  /** The name is exported by name. */
  export: 'export',
  /** Any other read of the name. */
  read: 'read',
  /** The name is assigned to. */
  write: 'write',
} as const;

export type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];

export interface ReferenceRecord {
  readonly name: string;
  readonly kind: ReferenceKind;
  readonly location: Location;
  /**
   * Declaration this reference resolves to, when it is declared in the
   * workspace. Absent means the declaration is not in the workspace, which is
   * preserved rather than guessed at.
   */
  readonly symbolId?: string;
  /**
   * True when the name is bound by an import from an external package. The
   * declaration is outside the workspace, so `symbolId` is absent — but this is
   * a known origin rather than an unknown one, and the two must not be counted
   * together.
   */
  readonly external?: boolean;
  /**
   * True when the name was reached through a property access — `order.status`,
   * `service.list()`. Which declaration such a name refers to depends on the
   * type of the receiver, which syntactic analysis cannot know, so these are
   * never resolved by name: a member `format()` is not the imported `format`,
   * and pretending otherwise would attribute calls to the wrong function.
   */
  readonly member?: boolean;
  /** Symbol whose body contains this reference, when inside one. */
  readonly fromSymbolId?: string;
}

export const ImportKind = {
  named: 'named',
  default: 'default',
  namespace: 'namespace',
  sideEffect: 'sideEffect',
  /** `export ... from` — an import and a re-export at once. */
  reExport: 'reExport',
} as const;

export type ImportKind = (typeof ImportKind)[keyof typeof ImportKind];

export interface ImportRecord {
  /** Specifier as written, e.g. `./config.js` or `react`. */
  readonly moduleSpecifier: string;
  /** Workspace-relative file the specifier resolves to, when it is local. */
  readonly resolvedFile?: string;
  readonly kind: ImportKind;
  /** Imported name; `*` for a namespace import. */
  readonly importedName?: string;
  /** Local binding, when renamed with `as`. */
  readonly localName?: string;
  /** True for `import type` / `export type`, which vanish at runtime. */
  readonly typeOnly: boolean;
  readonly location: Location;
  /** True when the specifier names a package rather than a file. */
  readonly external: boolean;
}

export interface ExportRecord {
  readonly name: string;
  readonly localName?: string;
  readonly typeOnly: boolean;
  readonly location: Location;
  /** Set when the export re-exports from another module. */
  readonly fromModule?: string;
  readonly resolvedFile?: string;
}

export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'unknown';

/** Everything the indexer knows about one file. */
export interface FileIndex {
  /** Workspace-relative, POSIX separators. */
  readonly path: string;
  readonly language: LanguageId;
  /** SHA-256 of the content indexed, so staleness is detectable. */
  readonly hash: string;
  readonly lineCount: number;
  readonly bytes: number;
  readonly symbols: readonly SymbolRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly imports: readonly ImportRecord[];
  readonly exports: readonly ExportRecord[];
  /** Syntax errors found while parsing; the file is still indexed. */
  readonly diagnostics: readonly string[];
}

export function symbolId(file: string, name: string, container?: string): string {
  return container ? `${file}#${container}.${name}` : `${file}#${name}`;
}

/** The file part of a symbol id. */
export function fileOfSymbol(id: string): string {
  const hash = id.indexOf('#');
  return hash === -1 ? id : id.slice(0, hash);
}

export function isTypeKind(kind: SymbolKind): boolean {
  return kind === 'interface' || kind === 'typeAlias' || kind === 'enum';
}

/** One-line description for search results and prompts. */
export function describeSymbol(symbol: SymbolRecord): string {
  const modifiers = [symbol.exported ? 'exported' : undefined, symbol.async ? 'async' : undefined]
    .filter(Boolean)
    .join(' ');
  const prefix = modifiers.length > 0 ? `${modifiers} ` : '';
  return `${prefix}${symbol.kind} ${symbol.name} (${symbol.location.file}:${symbol.location.start.line})`;
}
