/**
 * Format detection and dispatch.
 *
 * The user pastes "an API" — a YAML specification, a JSON export, a cURL line —
 * and should not have to say which. Detection is structural rather than
 * extension-based, because the text often arrives from a clipboard with no
 * filename attached.
 *
 * Parsing stays pure: the caller reads the bytes, this decides what they are.
 */

import type { ApiSpec } from '@aica/api-ir';
import { AgentError, ErrorCode, err } from '@aica/shared';
import type { Result } from '@aica/shared';
import { parse as parseYaml } from 'yaml';

import { parseCurl } from './curl.js';
import { parseApiDocs, looksLikeApiDocumentation } from './docs.js';
import { isOpenApiDocument, parseOpenApi } from './openapi.js';
import { isPostmanCollection, parsePostman } from './postman.js';

export type SourceFormat = 'openapi' | 'postman' | 'curl' | 'docs' | 'unknown';

export interface ParseSourceOptions {
  readonly location?: string;
  readonly fallbackTitle?: string;
  /** Skip detection and use this parser. */
  readonly format?: Exclude<SourceFormat, 'unknown'>;
}

/**
 * Identify what a block of text is without fully parsing it.
 *
 * Returns `'unknown'` rather than guessing; a caller that wants a parse attempt
 * anyway can pass `format` explicitly.
 */
export function detectSourceFormat(text: string): SourceFormat {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'unknown';

  // A command is recognized by its program name, the same way the exec engine
  // allowlists one — never by scanning for substrings anywhere in the text.
  if (/^curl(\.exe)?[\s\\]/i.test(trimmed)) return 'curl';

  const document = parseStructured(trimmed);
  if (document !== undefined) {
    if (isOpenApiDocument(document)) return 'openapi';
    if (isPostmanCollection(document)) return 'postman';
  }

  // Prose is the last resort: it is checked only once the structured formats
  // have been ruled out, and only when it explicitly states an endpoint.
  return looksLikeApiDocumentation(text) ? 'docs' : 'unknown';
}

/** Parse JSON, falling back to YAML, which is a superset of JSON in practice. */
function parseStructured(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      // `maxAliasCount` bounds YAML alias expansion, which is otherwise a
      // denial-of-service vector against a parser fed an untrusted file.
      return parseYaml(text, { maxAliasCount: 100 });
    } catch {
      return undefined;
    }
  }
}

/**
 * Parse API source text into the IR, choosing the parser by content.
 *
 * A failure here means the text was not recognizable at all. A document that
 * parses but contradicts itself succeeds, carrying its problems in
 * `spec.warnings` — the caller decides what to do about them.
 */
export function parseApiSource(text: string, options: ParseSourceOptions = {}): Result<ApiSpec> {
  const format = options.format ?? detectSourceFormat(text);

  switch (format) {
    case 'curl':
      return parseCurl(text, options);

    case 'openapi':
    case 'postman': {
      const document = parseStructured(text);
      if (document === undefined) {
        return err(
          new AgentError(ErrorCode.INVALID_INPUT, 'Source is neither valid JSON nor valid YAML', {
            details: { location: options.location },
          }),
        );
      }
      return format === 'openapi'
        ? parseOpenApi(document, options)
        : parsePostman(document, options);
    }

    case 'docs':
      return parseApiDocs(text, options);

    case 'unknown':
    default:
      return err(
        new AgentError(
          ErrorCode.UNSUPPORTED,
          'Unrecognized API source: expected an OpenAPI or Swagger document, a Postman collection, a curl command, or documentation stating endpoints as "GET /path"',
          { details: { location: options.location } },
        ),
      );
  }
}

/**
 * Parse an already-decoded document (JSON or YAML already turned into values),
 * for callers that read structured data rather than text.
 */
export function parseApiDocument(
  document: unknown,
  options: ParseSourceOptions = {},
): Result<ApiSpec> {
  if (isOpenApiDocument(document)) return parseOpenApi(document, options);
  if (isPostmanCollection(document)) return parsePostman(document, options);

  return err(
    new AgentError(
      ErrorCode.UNSUPPORTED,
      'Unrecognized API document: expected an OpenAPI or Swagger document, or a Postman collection',
      { details: { location: options.location } },
    ),
  );
}
