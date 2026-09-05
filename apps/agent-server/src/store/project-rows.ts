/**
 * Domain objects to store rows.
 *
 * This is where "metadata only, never file contents" is actually enforced. The
 * schema has no column to put source text in, but a schema is a passive
 * defence; these functions are the active one, and they are pure, so a test can
 * hold them to it directly.
 *
 * The specific thing being dropped is worth naming. A `SymbolRecord` carries
 * both `signature` — the declaration line as written — and `doc`, the JSDoc
 * above it. The signature is kept: it says what something *is*, which is the
 * whole point of an index. The doc is dropped: it is prose from the file,
 * frequently the most sensitive prose in it, and nothing the database serves
 * needs it. `RetrievedItem.snippet` is dropped for the same reason and read
 * from disk instead, where the path policy still governs it.
 */

import type { ApiSpec } from '@aica/api-ir';
import { isPublic } from '@aica/api-ir';
import type { CodeGraph } from '@aica/code-graph';
import type { CodeIndex } from '@aica/code-intelligence';

import type {
  ApiSnapshot,
  EdgeRow,
  FileRecord,
  IndexSnapshot,
  ReferenceRow,
  SymbolRow,
} from './contract.js';

export function toIndexSnapshot(index: CodeIndex, graph?: CodeGraph): IndexSnapshot {
  const files: FileRecord[] = [];
  const symbols: SymbolRow[] = [];
  const references: ReferenceRow[] = [];

  for (const file of index.files) {
    files.push({
      path: file.path,
      ...(file.language ? { language: file.language } : {}),
      bytes: file.bytes,
      lines: file.lineCount,
      ...(file.hash ? { digest: file.hash } : {}),
    });

    for (const symbol of file.symbols) {
      symbols.push({
        id: symbol.id,
        path: file.path,
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported,
        // Signature yes, `symbol.doc` deliberately not. See the note above.
        ...(symbol.signature ? { signature: symbol.signature } : {}),
        ...(symbol.container ? { container: symbol.container } : {}),
        startLine: symbol.location.start.line,
        startColumn: symbol.location.start.column,
        endLine: symbol.location.end.line,
        endColumn: symbol.location.end.column,
        isAsync: symbol.async === true,
        deprecated: symbol.deprecated === true,
      });
    }

    for (const reference of file.references) {
      references.push({
        path: file.path,
        name: reference.name,
        kind: reference.kind,
        line: reference.location.start.line,
        column: reference.location.start.column,
        ...(reference.symbolId ? { symbolId: reference.symbolId } : {}),
        isMember: reference.member === true,
        // `external` says the name is bound by an import from a package: a
        // known origin outside the workspace, which must not be counted with
        // the genuinely unattributed.
        ...(reference.external === true ? { externalModule: 'external' } : {}),
      });
    }
  }

  const edges: EdgeRow[] = (graph?.edges ?? []).map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    count: edge.count,
  }));

  return {
    files,
    symbols,
    references,
    edges,
    stats: {
      files: index.stats.files,
      symbols: index.stats.symbols,
      references: index.stats.references,
      resolutionRate: index.resolutionRate,
    },
  };
}

/**
 * An API specification as stored rows.
 *
 * Unlike the code index this is the user's own API documentation, not their
 * source, so it is kept in full — including the component schemas, which are
 * what makes a stored catalog useful without the original document.
 */
export function toApiSnapshot(spec: ApiSpec, format: string): ApiSnapshot {
  return {
    api: {
      id: spec.id,
      title: spec.title,
      ...(spec.version ? { version: spec.version } : {}),
      format,
      ...(spec.source.location ? { sourceLocation: spec.source.location } : {}),
      servers: spec.servers.map((server) => ({ url: server.url, description: server.description })),
      authSchemes: spec.authSchemes.map((scheme) => ({ id: scheme.id, kind: scheme.kind })),
      warnings: spec.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        pointer: warning.pointer,
      })),
    },
    endpoints: spec.endpoints.map((endpoint) => ({
      apiId: spec.id,
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      ...(endpoint.operationId ? { operationId: endpoint.operationId } : {}),
      ...(endpoint.summary ? { summary: endpoint.summary } : {}),
      tags: [...endpoint.tags],
      requiresAuth: !isPublic(endpoint.security.length > 0 ? endpoint.security : spec.security),
      deprecated: endpoint.deprecated === true,
    })),
    schemas: Object.entries(spec.components).map(([name, definition]) => ({ name, definition })),
  };
}
