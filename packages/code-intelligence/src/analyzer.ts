/**
 * TypeScript/JavaScript analysis via the TypeScript compiler API.
 *
 * **Syntactic, deliberately.** Analysis uses `ts.createSourceFile` rather than a
 * `ts.Program`, so no type checker, no module resolution, and no `node_modules`
 * are required. That is a correctness decision as much as a speed one: the agent
 * has to index a repository it has just opened, whose dependencies may not be
 * installed and whose code may not currently compile. A type-aware pass would
 * fail exactly when the codebase is in the state the agent most needs to
 * understand it.
 *
 * The cost is that some facts are unavailable — the declared type of an
 * inferred variable, which overload a call resolves to. Those are recorded as
 * absent rather than guessed, and the compiler remains the authority whenever a
 * real answer is needed (it ranks first, above these AST facts).
 *
 * JSX is parsed for `.tsx`/`.jsx`, and a capitalised function returning JSX is
 * recorded as a `component`, because "which component renders this" is a
 * question the agent is asked constantly.
 */

import ts from 'typescript';

import type {
  ExportRecord,
  FileIndex,
  ImportRecord,
  LanguageId,
  Location,
  Position,
  ReferenceKind,
  ReferenceRecord,
  SymbolKind,
  SymbolRecord,
  UrlLiteral,
} from './symbols.js';
import { symbolId } from './symbols.js';

/** Longest signature text retained, so one generated file cannot dominate. */
const MAX_SIGNATURE_LENGTH = 400;
const MAX_DOC_LENGTH = 600;

export function languageOf(filePath: string): LanguageId {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts'))
    return 'typescript';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return 'javascript';
  return 'unknown';
}

export function isAnalyzableLanguage(language: LanguageId): boolean {
  return language !== 'unknown';
}

export interface AnalyzeOptions {
  /** Workspace-relative path recorded on every location. */
  readonly path: string;
  readonly hash: string;
}

export interface AnalysisResult {
  readonly symbols: SymbolRecord[];
  readonly references: ReferenceRecord[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly diagnostics: string[];
  readonly urlLiterals: UrlLiteral[];
}

/**
 * Analyze one file's source text.
 *
 * Never throws on malformed input: the TypeScript parser recovers from syntax
 * errors and reports them, and a file that does not parse cleanly is still
 * indexed for whatever it does contain.
 */
export function analyzeSource(content: string, options: AnalyzeOptions): AnalysisResult {
  const language = languageOf(options.path);
  const source = ts.createSourceFile(
    options.path,
    content,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseAll },
    /* setParentNodes */ true,
    scriptKindOf(language),
  );

  return new FileAnalyzer(source, options.path).run();
}

export function analyzeFile(
  content: string,
  options: AnalyzeOptions & { bytes?: number },
): FileIndex {
  const language = languageOf(options.path);
  const result = analyzeSource(content, options);

  return {
    path: options.path,
    language,
    hash: options.hash,
    lineCount: countLines(content),
    bytes: options.bytes ?? Buffer.byteLength(content, 'utf8'),
    symbols: result.symbols,
    references: result.references,
    imports: result.imports,
    exports: result.exports,
    diagnostics: result.diagnostics,
    urlLiterals: result.urlLiterals,
  };
}

function scriptKindOf(language: LanguageId): ts.ScriptKind {
  switch (language) {
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'jsx':
      return ts.ScriptKind.JSX;
    case 'javascript':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (const char of content) if (char === '\n') lines += 1;
  return lines;
}

class FileAnalyzer {
  private readonly symbols: SymbolRecord[] = [];
  private readonly references: ReferenceRecord[] = [];
  private readonly imports: ImportRecord[] = [];
  private readonly exports: ExportRecord[] = [];
  private readonly diagnostics: string[] = [];
  private readonly urlLiterals: UrlLiteral[] = [];
  /** Stack of enclosing symbol ids, so a reference knows where it sits. */
  private readonly containers: string[] = [];
  /**
   * Names bound by enclosing function scopes: parameters, locals, and type
   * parameters. References to these are not recorded — a local cannot be a
   * dependency on anything outside the file, and including them would bury the
   * cross-file references the index exists to answer questions about.
   */
  private readonly scopes: Set<string>[] = [];

  constructor(
    private readonly source: ts.SourceFile,
    private readonly path: string,
  ) {}

  run(): AnalysisResult {
    for (const diagnostic of parseDiagnosticsOf(this.source)) {
      this.diagnostics.push(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').slice(0, 200),
      );
    }

    this.source.forEachChild((node) => this.visit(node));

    return {
      symbols: this.symbols,
      references: this.references,
      imports: this.imports,
      exports: this.exports,
      diagnostics: this.diagnostics,
      urlLiterals: this.urlLiterals,
    };
  }

  // -------------------------------------------------------------------------
  // Positions
  // -------------------------------------------------------------------------

  private positionAt(offset: number): Position {
    const { line, character } = this.source.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, column: character + 1 };
  }

  private locationOf(node: ts.Node): Location {
    return {
      file: this.path,
      start: this.positionAt(node.getStart(this.source)),
      end: this.positionAt(node.getEnd()),
    };
  }

  // -------------------------------------------------------------------------
  // Declarations
  // -------------------------------------------------------------------------

  private visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      this.readImport(node);
      return;
    }

    if (ts.isExportDeclaration(node)) {
      this.readExportDeclaration(node);
      return;
    }

    if (ts.isExportAssignment(node)) {
      this.readExportAssignment(node);
      return;
    }

    if (ts.isFunctionDeclaration(node)) {
      this.readFunction(node);
      return;
    }

    if (ts.isClassDeclaration(node)) {
      this.readClass(node);
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      this.readInterface(node);
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      this.record(node, node.name.text, 'typeAlias');
      this.walkBody(node);
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      this.readEnum(node);
      return;
    }

    if (ts.isVariableStatement(node)) {
      this.readVariableStatement(node);
      return;
    }

    this.walkBody(node);
  }

  private readFunction(node: ts.FunctionDeclaration): void {
    const name = node.name?.text;
    if (name === undefined) {
      // `export default function () {}` has no name of its own.
      if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
        this.record(node, 'default', 'function', { defaultExport: true });
      }
      this.walkBody(node);
      return;
    }

    const kind: SymbolKind = this.looksLikeComponent(name, node) ? 'component' : 'function';
    const id = this.record(node, name, kind, {
      async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
      defaultExport: hasModifier(node, ts.SyntaxKind.DefaultKeyword),
    });

    this.withContainer(id, () => this.withScope(node, () => this.walkBody(node)));
  }

  private readClass(node: ts.ClassDeclaration): void {
    const name = node.name?.text ?? 'default';
    const id = this.record(node, name, 'class', {
      defaultExport: hasModifier(node, ts.SyntaxKind.DefaultKeyword),
    });

    // A heritage clause is a reference to another type, and is how the graph
    // learns about inheritance.
    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) {
        if (ts.isIdentifier(type.expression)) {
          this.addReference(type.expression.text, 'type', type.expression, { fromSymbolId: id });
        }
      }
    }

    this.withContainer(id, () => {
      for (const member of node.members) this.readClassMember(member, name);
    });
  }

  private readClassMember(member: ts.ClassElement, className: string): void {
    const name = memberName(member);

    if (
      name !== undefined &&
      (ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member))
    ) {
      const id = this.record(member, name, 'method', {
        container: className,
        async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
        // A class member is reachable whenever its class is; `export` is not
        // written on members, so exportedness is the class's.
        exported: false,
      });
      this.withContainer(id, () => this.withScope(member, () => this.walkBody(member)));
      return;
    }

    if (name !== undefined && ts.isPropertyDeclaration(member)) {
      this.record(member, name, 'property', { container: className, exported: false });
      this.walkBody(member);
      return;
    }

    this.walkBody(member);
  }

  private readInterface(node: ts.InterfaceDeclaration): void {
    const id = this.record(node, node.name.text, 'interface');

    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) {
        if (ts.isIdentifier(type.expression)) {
          this.addReference(type.expression.text, 'type', type.expression, { fromSymbolId: id });
        }
      }
    }

    this.withContainer(id, () => {
      for (const member of node.members) {
        const name = memberName(member);
        if (name !== undefined) {
          this.record(member, name, 'property', { container: node.name.text, exported: false });
        }
        this.walkBody(member);
      }
    });
  }

  private readEnum(node: ts.EnumDeclaration): void {
    const id = this.record(node, node.name.text, 'enum');

    this.withContainer(id, () => {
      for (const member of node.members) {
        const name = memberName(member);
        if (name !== undefined) {
          this.record(member, name, 'enumMember', { container: node.name.text, exported: false });
        }
      }
    });
  }

  private readVariableStatement(node: ts.VariableStatement): void {
    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);

    // Only module-scope variables are symbols. A `const response` inside a
    // function body is not addressable from anywhere else, and indexing it
    // would bury the real declarations under locals while colliding with every
    // other function that happens to use the same name.
    if (!isModuleScope(node)) {
      this.walkBody(node);
      return;
    }

    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        // A destructuring declaration binds several names at once.
        this.walkBody(declaration);
        continue;
      }

      const name = declaration.name.text;
      const initializer = declaration.initializer;
      const isFunctionValued =
        initializer !== undefined &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));

      const kind: SymbolKind = isFunctionValued
        ? this.looksLikeComponent(name, initializer)
          ? 'component'
          : 'function'
        : 'variable';

      const id = this.record(declaration, name, kind, {
        exported,
        async:
          initializer !== undefined && hasModifier(initializer, ts.SyntaxKind.AsyncKeyword)
            ? true
            : undefined,
        // The whole statement carries the doc comment, not the declarator.
        docNode: node,
      });

      this.withContainer(id, () => this.walkBody(declaration));
    }
  }

  // -------------------------------------------------------------------------
  // Imports and exports
  // -------------------------------------------------------------------------

  private readImport(node: ts.ImportDeclaration): void {
    const specifier = moduleSpecifierOf(node.moduleSpecifier);
    if (specifier === undefined) return;

    const location = this.locationOf(node);
    const external = isExternalSpecifier(specifier);
    const typeOnly = node.importClause?.isTypeOnly === true;

    if (!node.importClause) {
      this.imports.push({
        moduleSpecifier: specifier,
        kind: 'sideEffect',
        typeOnly: false,
        location,
        external,
      });
      return;
    }

    if (node.importClause.name) {
      this.imports.push({
        moduleSpecifier: specifier,
        kind: 'default',
        importedName: 'default',
        localName: node.importClause.name.text,
        typeOnly,
        location,
        external,
      });
    }

    const bindings = node.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      this.imports.push({
        moduleSpecifier: specifier,
        kind: 'namespace',
        importedName: '*',
        localName: bindings.name.text,
        typeOnly,
        location,
        external,
      });
    }

    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        this.imports.push({
          moduleSpecifier: specifier,
          kind: 'named',
          importedName: imported,
          localName: element.name.text,
          // `import { type A }` is type-only per element as well as per clause.
          typeOnly: typeOnly || element.isTypeOnly,
          location: this.locationOf(element),
          external,
        });
        this.addReference(element.name.text, 'import', element.name);
      }
    }
  }

  private readExportDeclaration(node: ts.ExportDeclaration): void {
    const specifier = moduleSpecifierOf(node.moduleSpecifier);
    const typeOnly = node.isTypeOnly;
    const location = this.locationOf(node);

    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        this.exports.push({
          name: element.name.text,
          localName: local,
          typeOnly: typeOnly || element.isTypeOnly,
          location: this.locationOf(element),
          fromModule: specifier,
        });
        this.addReference(local, 'export', element.name);

        if (specifier !== undefined) {
          // `export { x } from './y'` both imports and re-exports.
          this.imports.push({
            moduleSpecifier: specifier,
            kind: 'reExport',
            importedName: local,
            localName: element.name.text,
            typeOnly: typeOnly || element.isTypeOnly,
            location: this.locationOf(element),
            external: isExternalSpecifier(specifier),
          });
        }
      }
      return;
    }

    if (specifier !== undefined) {
      // `export * from './y'`.
      this.exports.push({ name: '*', typeOnly, location, fromModule: specifier });
      this.imports.push({
        moduleSpecifier: specifier,
        kind: 'reExport',
        importedName: '*',
        typeOnly,
        location,
        external: isExternalSpecifier(specifier),
      });
    }
  }

  private readExportAssignment(node: ts.ExportAssignment): void {
    const name = ts.isIdentifier(node.expression) ? node.expression.text : 'default';
    this.exports.push({
      name: 'default',
      localName: name,
      typeOnly: false,
      location: this.locationOf(node),
    });
    if (ts.isIdentifier(node.expression)) {
      this.addReference(node.expression.text, 'export', node.expression);
    }
  }

  // -------------------------------------------------------------------------
  // References
  // -------------------------------------------------------------------------

  /**
   * Walk an arbitrary subtree, recording name occurrences.
   *
   * Declaration names are skipped here — they are recorded as symbols, and
   * counting a declaration as a reference to itself would make every symbol
   * look used.
   */
  private walkBody(node: ts.Node): void {
    node.forEachChild((child) => this.visitExpression(child));
  }

  private visitExpression(node: ts.Node): void {
    if (isDeclarationLike(node)) {
      this.visit(node);
      return;
    }

    // A function introduces a scope; its parameters and locals are bound
    // names, not references to anything the index tracks.
    if (isFunctionLike(node)) {
      this.withScope(node, () => this.walkBody(node));
      return;
    }

    if (ts.isIdentifier(node)) {
      if (!this.isDeclarationName(node)) {
        this.addReference(node.text, this.referenceKindOf(node), node);
      }
      return;
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      this.recordUrlLiteral(node.text, node, false);
      return;
    }

    if (ts.isTemplateExpression(node)) {
      this.recordTemplate(node);
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      // `service.list()` is a use of `service` and a use of the member `list`.
      // The receiver is visited normally; the member is recorded explicitly so
      // that it is never mistaken for a bare identifier of the same name.
      this.visitExpression(node.expression);
      this.addReference(node.name.text, this.memberKindOf(node), node.name, { member: true });
      return;
    }

    this.walkBody(node);
  }

  /**
   * Reconstruct a template literal with its interpolations collapsed to `{}`.
   *
   * `` `/orders/${id}` `` becomes `/orders/{}`, which is exactly what
   * `pathSignature` produces for a documented `/orders/{orderId}`. The two
   * become comparable without either being guessed at — and the interpolated
   * expressions are still walked, so a value used to build a URL is not lost as
   * a reference.
   */
  private recordTemplate(node: ts.TemplateExpression): void {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += `{}${span.literal.text}`;
      this.visitExpression(span.expression);
    }
    this.recordUrlLiteral(text, node, true);
  }

  private recordUrlLiteral(value: string, node: ts.Node, interpolated: boolean): void {
    if (!looksLikeUrlOrPath(value)) return;

    const from = this.currentContainer();
    this.urlLiterals.push({
      value,
      location: this.locationOf(node),
      interpolated,
      ...(from ? { fromSymbolId: from } : {}),
    });
  }

  /** How a member name is used: called, assigned to, or read. */
  private memberKindOf(node: ts.PropertyAccessExpression): ReferenceKind {
    const parent = node.parent as ts.Node | undefined;
    if (parent && ts.isCallExpression(parent) && parent.expression === node) return 'call';
    if (
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignment(parent.operatorToken)
    ) {
      return 'write';
    }
    return 'read';
  }

  private isDeclarationName(node: ts.Identifier): boolean {
    const parent = node.parent as ts.Node | undefined;
    if (!parent) return false;

    return (
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
      (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
      (ts.isEnumDeclaration(parent) && parent.name === node) ||
      (ts.isEnumMember(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isPropertySignature(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isMethodSignature(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.name === node) ||
      (ts.isImportSpecifier(parent) && parent.name === node) ||
      (ts.isExportSpecifier(parent) && parent.name === node)
    );
  }

  private referenceKindOf(node: ts.Identifier): ReferenceKind {
    const parent = node.parent as ts.Node | undefined;
    if (!parent) return 'read';

    if (ts.isCallExpression(parent) && parent.expression === node) return 'call';
    if (ts.isNewExpression(parent) && parent.expression === node) return 'construct';
    if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) return 'type';
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignment(parent.operatorToken)
    ) {
      return 'write';
    }
    // A JSX element name is a use of the component.
    if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) return 'read';

    return 'read';
  }

  private addReference(
    name: string,
    kind: ReferenceKind,
    node: ts.Node,
    options: { fromSymbolId?: string; member?: boolean } = {},
  ): void {
    // An import binding is a reference worth keeping even though it shadows;
    // everything else that a local scope binds is not. A member name is never
    // locally bound — it belongs to whatever the receiver turns out to be.
    if (kind !== 'import' && !options.member && this.isLocallyBound(name)) return;

    const from = options.fromSymbolId ?? this.currentContainer();

    this.references.push({
      name,
      kind,
      location: this.locationOf(node),
      ...(options.member ? { member: true } : {}),
      ...(from ? { fromSymbolId: from } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  private record(
    node: ts.Node,
    name: string,
    kind: SymbolKind,
    options: {
      container?: string;
      exported?: boolean;
      async?: boolean;
      defaultExport?: boolean;
      docNode?: ts.Node;
    } = {},
  ): string {
    const id = symbolId(this.path, name, options.container);
    const exported = options.exported ?? this.isExported(node);
    const doc = this.docOf(options.docNode ?? node);

    this.symbols.push({
      id,
      name,
      kind,
      location: this.locationOf(node),
      exported,
      ...(options.container ? { container: options.container } : {}),
      ...(options.async ? { async: true } : {}),
      ...(options.defaultExport ? { defaultExport: true } : {}),
      ...(doc ? { doc } : {}),
      signature: this.signatureOf(node),
    });

    // A declaration carrying `export` is an export, exactly like one named in
    // an export statement. Recording both here means "what does this module
    // expose" has a single answer rather than two half-answers.
    if (exported && options.container === undefined) {
      this.exports.push({
        name: options.defaultExport ? 'default' : name,
        localName: name,
        typeOnly: false,
        location: this.locationOf(node),
      });
    }

    return id;
  }

  private isExported(node: ts.Node): boolean {
    if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) return true;
    // A variable declarator carries no modifiers; its statement does.
    const parent = node.parent as ts.Node | undefined;
    if (parent && ts.isVariableDeclarationList(parent)) {
      const statement = parent.parent as ts.Node | undefined;
      return statement !== undefined && hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    }
    return false;
  }

  /**
   * The declaration's own source text, up to its body. Quoting the file is the
   * point: a reconstructed signature could disagree with what is written.
   */
  private signatureOf(node: ts.Node): string | undefined {
    const full = node.getText(this.source);
    const bodyStart = bodyStartOf(node, this.source);
    const text = (bodyStart === undefined ? full : full.slice(0, bodyStart)).trim();
    const collapsed = text.replace(/\s*\n\s*/g, ' ').trim();

    if (collapsed.length === 0) return undefined;
    return collapsed.length > MAX_SIGNATURE_LENGTH
      ? `${collapsed.slice(0, MAX_SIGNATURE_LENGTH)}…`
      : collapsed;
  }

  private docOf(node: ts.Node): string | undefined {
    const ranges = ts.getLeadingCommentRanges(this.source.text, node.getFullStart()) ?? [];
    const last = ranges.at(-1);
    if (!last) return undefined;

    const raw = this.source.text.slice(last.pos, last.end);
    const cleaned = raw
      .replace(/^\/\*\*?/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*\*ic?\s?/, '')
          .replace(/^\s*\*\s?/, '')
          .replace(/^\/\/\s?/, ''),
      )
      .join('\n')
      .trim();

    if (cleaned.length === 0) return undefined;
    return cleaned.length > MAX_DOC_LENGTH ? `${cleaned.slice(0, MAX_DOC_LENGTH)}…` : cleaned;
  }

  private withContainer(id: string, body: () => void): void {
    this.containers.push(id);
    try {
      body();
    } finally {
      this.containers.pop();
    }
  }

  private withScope(node: ts.Node, body: () => void): void {
    this.scopes.push(collectBoundNames(node));
    try {
      body();
    } finally {
      this.scopes.pop();
    }
  }

  private isLocallyBound(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  private currentContainer(): string | undefined {
    return this.containers.at(-1);
  }

  /**
   * A capitalised function that returns JSX is a component.
   *
   * Both halves are required: `Foo()` returning a string is not a component,
   * and a lower-case function returning JSX is a render helper, which React
   * itself will not treat as a component.
   */
  private looksLikeComponent(name: string, node: ts.Node): boolean {
    if (!/^[A-Z]/.test(name)) return false;
    const language = languageOf(this.path);
    if (language !== 'tsx' && language !== 'jsx') return false;
    return containsJsx(node);
  }
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/**
 * Syntax errors the parser recovered from.
 *
 * `parseDiagnostics` is not in the public typings — the supported route to
 * diagnostics is a `ts.Program`, which is exactly the type-aware machinery this
 * analyzer avoids. The shape is stable and the access is guarded, and losing
 * the diagnostics would mean silently indexing a broken file as though it were
 * fine.
 */
function parseDiagnosticsOf(source: ts.SourceFile): readonly ts.Diagnostic[] {
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  return Array.isArray(diagnostics) ? diagnostics : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function memberName(
  member: ts.NamedDeclaration | ts.ClassElement | ts.TypeElement,
): string | undefined {
  const name = (member as ts.NamedDeclaration).name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function moduleSpecifierOf(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

/** A specifier is external unless it is explicitly relative or absolute. */
function isExternalSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

function isAssignment(token: ts.BinaryOperatorToken): boolean {
  return (
    token.kind === ts.SyntaxKind.EqualsToken ||
    (token.kind >= ts.SyntaxKind.FirstCompoundAssignment &&
      token.kind <= ts.SyntaxKind.LastCompoundAssignment)
  );
}

/**
 * Whether a string literal is worth keeping as a URL or request path.
 *
 * The bar is deliberately specific. Every codebase is full of strings, and a
 * loose test would fill the index with CSS classes and log messages. A literal
 * qualifies when it is an absolute URL, or when it starts with `/` and looks
 * like a path segment rather than a regex or a comment.
 */
function looksLikeUrlOrPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 512) return false;

  if (/^https?:\/\//i.test(trimmed)) return true;

  if (!trimmed.startsWith('/')) return false;
  // `//` starts a comment or a protocol-relative URL; `/.../` is a regex.
  if (trimmed.startsWith('//')) return false;
  if (trimmed.endsWith('/') && trimmed.length > 1) return false;

  // Path segments: letters, digits, and the punctuation URLs actually use,
  // plus `{}` where an interpolation was collapsed.
  return /^\/[A-Za-z0-9\-._~%{}$:/]*$/.test(trimmed);
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/**
 * Names a function scope binds: its parameters, its type parameters, and the
 * variables and functions declared directly inside it.
 *
 * The walk stops at nested function boundaries, because a name declared inside
 * an inner function is bound by *that* scope and will be collected when the
 * walker descends into it. This is an approximation of lexical scoping — block
 * scoping and shadowing are not modelled exactly — and it is deliberately
 * conservative: over-binding a name drops a reference, which is a smaller error
 * than inventing one.
 */
function collectBoundNames(node: ts.Node): Set<string> {
  const names = new Set<string>();

  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    // Destructuring binds every element it names.
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBindingName(element.name);
    }
  };

  const signature = node as ts.SignatureDeclarationBase;
  for (const parameter of signature.parameters ?? []) addBindingName(parameter.name);
  for (const typeParameter of signature.typeParameters ?? []) names.add(typeParameter.name.text);

  const walk = (current: ts.Node): void => {
    current.forEachChild((child) => {
      if (
        isFunctionLike(child) ||
        ts.isFunctionDeclaration(child) ||
        ts.isClassDeclaration(child)
      ) {
        // Its own scope; its declarations are not ours.
        if (ts.isFunctionDeclaration(child) && child.name) names.add(child.name.text);
        if (ts.isClassDeclaration(child) && child.name) names.add(child.name.text);
        return;
      }
      if (ts.isVariableDeclaration(child)) addBindingName(child.name);
      if (ts.isCatchClause(child) && child.variableDeclaration) {
        addBindingName(child.variableDeclaration.name);
      }
      walk(child);
    });
  };

  const body = (node as ts.FunctionLikeDeclarationBase).body;
  if (body) walk(body);

  return names;
}

/** True when a statement sits at the top level of a file or a module block. */
function isModuleScope(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  return parent !== undefined && (ts.isSourceFile(parent) || ts.isModuleBlock(parent));
}

function isDeclarationLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isExportAssignment(node)
  );
}

/** Offset of the declaration's body, so a signature can stop before it. */
function bodyStartOf(node: ts.Node, source: ts.SourceFile): number | undefined {
  const start = node.getStart(source);
  const body =
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node)) &&
    node.body
      ? node.body
      : ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)
        ? node.members[0]
        : undefined;

  return body ? body.getStart(source) - start : undefined;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;

  const walk = (current: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      found = true;
      return;
    }
    current.forEachChild(walk);
  };

  walk(node);
  return found;
}
