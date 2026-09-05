/**
 * Documentation parser: endpoints recovered from prose.
 *
 * Plenty of real APIs are described only by a README, a wiki page, or an HTML
 * reference. This extracts what such a document actually states and nothing
 * more — it is the weakest source in the system and is deliberately built to
 * behave that way:
 *
 * - **Only explicit statements count.** A `GET /users/{id}` heading, a fenced
 *   cURL block, a table of parameters. Nothing is inferred from surrounding
 *   sentences, so an endpoint that appears here was written down somewhere.
 * - **Prose is untrusted data.** API documentation is a documented prompt-
 *   injection vector (§7 of the architecture): instruction-shaped text found in
 *   a description is extracted as a description and never treated as an
 *   instruction.
 * - **Everything is provisional.** Response shapes are inferred from example
 *   payloads when the document shows them, and left `unknown` when it does not.
 *   A document that says "returns the user object" yields no schema, because it
 *   does not contain one.
 *
 * The result is a specification like any other, so an imported doc can be
 * compared against an OpenAPI file with `compareSpecs` — which is usually the
 * point, since the two disagreeing is why someone is reading the doc.
 */

import type {
  ApiResponse,
  ApiSpec,
  Endpoint,
  HttpMethod,
  Parameter,
  ParameterLocation,
  ParseWarning,
  SchemaNode,
  Server,
} from '@aica/api-ir';
import {
  HTTP_METHODS,
  ParseWarningCode,
  checkSpecInvariants,
  endpointId,
  isHttpMethod,
  normalizePath,
  slugify,
  toResponseStatus,
  warn,
} from '@aica/api-ir';
import { AgentError, ErrorCode, err, ok } from '@aica/shared';
import type { Result } from '@aica/shared';

import { parseCurlCommand } from './curl.js';
import { inferSchemaFromSamples } from './infer.js';
import { compact } from './json.js';

export interface DocParseOptions {
  readonly location?: string;
  readonly fallbackTitle?: string;
  /** Base URL to attach when the document never states one. */
  readonly baseUrl?: string;
}

/**
 * A `METHOD /path` statement, which is how documentation names an endpoint
 * almost universally. The method must be upper-case and the path must start
 * with a slash: lowering the bar to match `get users` produces false endpoints
 * out of ordinary sentences.
 */
const ENDPOINT_PATTERN =
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(https?:\/\/[^\s`"'<>()|]+|\/[^\s`"'<>()|]*)/;

/** Fenced code blocks, whose language tag tells us how to read the contents. */
const FENCE_PATTERN = /^([ \t]*)(?:```|~~~)([^\n`]*)\n([\s\S]*?)^[ \t]*(?:```|~~~)\s*$/gm;

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** True when the text states at least one endpoint this parser could extract. */
export function looksLikeApiDocumentation(text: string): boolean {
  return ENDPOINT_PATTERN.test(stripHtml(text));
}

export function parseApiDocs(text: string, options: DocParseOptions = {}): Result<ApiSpec> {
  if (text.length > MAX_DOCUMENT_BYTES) {
    return err(
      new AgentError(
        ErrorCode.LIMIT_EXCEEDED,
        `Document is ${text.length} bytes, above the ${MAX_DOCUMENT_BYTES} byte limit for documentation parsing`,
        { details: { location: options.location } },
      ),
    );
  }

  const parser = new DocParser(stripHtml(text), options);
  const spec = parser.parse();

  if (spec.endpoints.length === 0) {
    return err(
      new AgentError(
        ErrorCode.UNSUPPORTED,
        'No endpoints found: documentation must state them as "GET /path" for them to be extracted',
        { details: { location: options.location } },
      ),
    );
  }

  return ok(spec);
}

interface Section {
  readonly title: string;
  readonly level: number;
  readonly lines: readonly string[];
  readonly startLine: number;
}

interface CodeBlock {
  readonly language: string;
  readonly content: string;
  readonly line: number;
}

/** A `METHOD /path` statement, resolved to a path the IR can hold. */
interface Statement {
  readonly method: HttpMethod;
  readonly path: string;
  readonly line: number;
}

class DocParser {
  private readonly warnings: ParseWarning[] = [];
  private readonly lines: readonly string[];
  private readonly blocks: readonly CodeBlock[];
  private readonly baseUrls = new Set<string>();

  constructor(
    private readonly text: string,
    private readonly options: DocParseOptions,
  ) {
    this.lines = text.split(/\r?\n/);
    this.blocks = collectCodeBlocks(text);
  }

  parse(): ApiSpec {
    const title = this.options.fallbackTitle ?? this.documentTitle() ?? 'API Documentation';

    if (this.options.baseUrl) this.baseUrls.add(this.options.baseUrl.replace(/\/+$/, ''));

    const endpoints = this.collectEndpoints();
    const servers: Server[] = [...this.baseUrls].map((url) => ({ url, variables: [] }));

    if (servers.length === 0) {
      this.warnings.push(
        warn(
          ParseWarningCode.MISSING_SCHEMA,
          'The documentation never states a base URL, so requests cannot be built without one being supplied',
        ),
      );
    }

    const spec: ApiSpec = compact({
      id: slugify(title),
      title,
      servers,
      endpoints,
      authSchemes: [],
      security: [],
      components: {},
      source: compact({ format: 'manual' as const, location: this.options.location }),
      warnings: this.warnings,
    });

    return { ...spec, warnings: [...this.warnings, ...checkSpecInvariants(spec)] };
  }

  private documentTitle(): string | undefined {
    for (const line of this.lines) {
      const heading = /^#\s+(.+)$/.exec(line.trim());
      if (heading) return (heading[1] as string).trim();
    }
    return undefined;
  }

  /**
   * Walk the document section by section. A heading that names an endpoint
   * owns everything until the next heading of the same or higher level, which
   * is what makes the parameter table under it belong to it.
   */
  private collectEndpoints(): Endpoint[] {
    const sections = this.splitSections();
    // Scanned before sections are walked so that base-URL resolution sees the
    // whole document, not just the section in hand.
    const statements = this.scanStatements();
    const found = new Map<string, Endpoint>();

    for (const section of sections) {
      for (const endpoint of this.endpointsInSection(section, statements)) {
        // A document commonly states an endpoint in a heading and repeats it in
        // an example; the first, richer statement wins.
        if (!found.has(endpoint.id)) found.set(endpoint.id, endpoint);
      }
    }

    return [...found.values()];
  }

  private splitSections(): Section[] {
    const sections: Section[] = [];
    let current: { title: string; level: number; lines: string[]; startLine: number } | undefined;

    for (const [index, line] of this.lines.entries()) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        if (current) sections.push({ ...current, lines: current.lines });
        current = {
          title: (heading[2] as string).trim(),
          level: (heading[1] as string).length,
          lines: [],
          startLine: index,
        };
        continue;
      }
      if (current) current.lines.push(line);
      else {
        // Content before the first heading still belongs to the document.
        current = { title: '', level: 0, lines: [line], startLine: index };
      }
    }

    if (current) sections.push({ ...current, lines: current.lines });
    return sections;
  }

  private endpointsInSection(section: Section, all: readonly Statement[]): Endpoint[] {
    const end = section.startLine + section.lines.length;
    const statements = all.filter(
      (statement) => statement.line >= section.startLine && statement.line <= end,
    );

    if (statements.length === 0) return [];

    const parameters = this.parametersIn(section);
    const responses = this.responsesIn(section);
    const description = this.descriptionOf(section);

    // Parameters and responses documented in a section belong to the endpoint
    // that section is about. Where a section names several, the shared table is
    // the only information available for each.
    return statements.map((statement) =>
      compact({
        id: endpointId(statement.method, statement.path),
        method: statement.method,
        path: statement.path,
        summary: section.title.length > 0 ? section.title : undefined,
        description,
        tags: [],
        parameters: mergeWithPathParameters(statement.path, parameters),
        requestBody: this.requestBodyIn(section),
        responses,
        security: [],
        servers: [],
        source: compact({
          format: 'manual' as const,
          location: this.options.location,
          pointer: `line ${statement.line + 1}`,
        }),
      }),
    );
  }

  /**
   * Find every `METHOD target` statement in the document, in one pass.
   *
   * A single pass over the whole document is what makes the absolute-URL case
   * resolvable: documentation routinely writes most endpoints relatively
   * (`GET /orders`) and one of them in full (`POST https://api.test/v1/orders`).
   * Knowing the relative paths lets the full URL be split at the right point,
   * recovering `https://api.test/v1` as the base rather than guessing that the
   * base is the bare origin.
   */
  private scanStatements(): Statement[] {
    const pattern = new RegExp(ENDPOINT_PATTERN.source, 'g');
    const raw: { method: HttpMethod; target: string; line: number }[] = [];

    for (const [index, line] of this.lines.entries()) {
      for (const match of line.matchAll(pattern)) {
        const method = (match[1] as string).toUpperCase();
        if (!isHttpMethod(method)) continue;
        raw.push({
          method: method as HttpMethod,
          target: stripTrailingPunctuation(match[2] as string),
          line: index,
        });
      }
    }

    const relativePaths = raw
      .filter((entry) => entry.target.startsWith('/'))
      .map((entry) => normalizePath(entry.target))
      // Longest first, so the most specific split wins.
      .sort((left, right) => right.length - left.length);

    return raw.map((entry) => {
      if (!entry.target.startsWith('/')) {
        return { ...entry, ...this.splitAbsolute(entry.target, relativePaths) };
      }
      return { method: entry.method, path: normalizePath(entry.target), line: entry.line };
    });
  }

  /** Split a fully-written URL into a base URL and a path. */
  private splitAbsolute(target: string, relativePaths: readonly string[]): { path: string } {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return { path: normalizePath(target) };
    }

    const pathname = normalizePath(url.pathname);
    const suffix = relativePaths.find(
      (candidate) => candidate !== '/' && pathname.endsWith(candidate),
    );

    if (suffix) {
      const prefix = pathname.slice(0, pathname.length - suffix.length);
      this.baseUrls.add(`${url.origin}${prefix}`.replace(/\/+$/, ''));
      return { path: suffix };
    }

    // Nothing else in the document pins where the base ends, so only the origin
    // is claimed and the whole pathname is the endpoint.
    this.baseUrls.add(url.origin);
    return { path: pathname };
  }

  /**
   * Read a markdown parameter table.
   *
   * Tables are the one structured element documentation reliably uses, and the
   * column headings say what each column means, so nothing has to be guessed
   * from position.
   */
  private parametersIn(section: Section): Parameter[] {
    const parameters: Parameter[] = [];

    for (const table of collectTables(section.lines)) {
      const nameColumn = findColumn(table.headings, [
        'name',
        'parameter',
        'field',
        'key',
        'argument',
      ]);
      if (nameColumn === undefined) continue;

      const typeColumn = findColumn(table.headings, ['type', 'datatype', 'data type']);
      const inColumn = findColumn(table.headings, ['in', 'location', 'where', 'sent in']);
      const requiredColumn = findColumn(table.headings, ['required', 'requirement', 'mandatory']);
      const descriptionColumn = findColumn(table.headings, [
        'description',
        'details',
        'notes',
        'meaning',
      ]);

      for (const row of table.rows) {
        const name = cleanCell(row[nameColumn] ?? '');
        if (name.length === 0) continue;

        const description =
          descriptionColumn === undefined ? undefined : cleanCell(row[descriptionColumn] ?? '');
        const declaredType =
          typeColumn === undefined ? undefined : cleanCell(row[typeColumn] ?? '');
        const declaredIn = inColumn === undefined ? undefined : cleanCell(row[inColumn] ?? '');
        const requiredCell =
          requiredColumn === undefined ? undefined : cleanCell(row[requiredColumn] ?? '');

        parameters.push(
          compact({
            name,
            in: parameterLocation(declaredIn),
            required: isRequired(requiredCell, description),
            schema: schemaFromTypeName(declaredType),
            description: description && description.length > 0 ? description : undefined,
          }),
        );
      }
    }

    return parameters;
  }

  /** A request body is taken from a JSON example under a request-ish heading. */
  private requestBodyIn(section: Section): Endpoint['requestBody'] {
    const block = this.blocksIn(section).find(
      (candidate) =>
        isJsonLanguage(candidate.language) &&
        /request|body|payload|input/i.test(candidate.language),
    );

    const sample = block ? tryParse(block.content) : undefined;
    if (sample === undefined) return undefined;

    return {
      required: true,
      content: [{ mediaType: 'application/json', schema: inferSchemaFromSamples([sample]) }],
    };
  }

  /**
   * Responses come from example payloads. A status code stated near the example
   * is used; otherwise the example is recorded under 200, which is what an
   * unlabelled "example response" means in practice.
   */
  private responsesIn(section: Section): ApiResponse[] {
    const byStatus = new Map<ApiResponse['status'], unknown[]>();

    for (const block of this.blocksIn(section)) {
      if (!isJsonLanguage(block.language)) continue;
      if (/request|payload|input/i.test(block.language)) continue;

      const sample = tryParse(block.content);
      if (sample === undefined) continue;

      const status = this.statusNear(block.line) ?? 200;
      byStatus.set(status, [...(byStatus.get(status) ?? []), sample]);
    }

    // A cURL example proves the endpoint exists but shows no response.
    if (byStatus.size === 0) return [];

    return [...byStatus].map(([status, samples]) => ({
      status,
      content: [{ mediaType: 'application/json', schema: inferSchemaFromSamples(samples) }],
      headers: [],
    }));
  }

  /** A status code mentioned on the three lines before an example block. */
  private statusNear(line: number): ApiResponse['status'] | undefined {
    for (let offset = 1; offset <= 3; offset += 1) {
      const candidate = this.lines[line - offset];
      if (candidate === undefined) continue;

      const match = /\b([1-5]\d{2})\b/.exec(candidate);
      if (!match) continue;

      const status = toResponseStatus(match[1] as string);
      if (status !== undefined) return status;
    }
    return undefined;
  }

  private blocksIn(section: Section): CodeBlock[] {
    const end = section.startLine + section.lines.length + 1;
    return this.blocks.filter((block) => block.line >= section.startLine && block.line <= end);
  }

  /** The first prose paragraph of a section, with markup stripped. */
  private descriptionOf(section: Section): string | undefined {
    const paragraph: string[] = [];

    for (const line of section.lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) break;
      if (trimmed.startsWith('|') || trimmed.startsWith('#')) break;
      if (trimmed.length === 0) {
        if (paragraph.length > 0) break;
        continue;
      }

      // An endpoint statement is the subject, not a description of it — but the
      // rest of the sentence around it usually is, as in
      // "`GET /orders` returns the orders for the account".
      const remainder = trimmed.replace(new RegExp(ENDPOINT_PATTERN.source, 'g'), '').trim();
      if (remainder.length === 0) continue;
      paragraph.push(remainder);
    }

    const text = paragraph
      .join(' ')
      .replace(/\s+/g, ' ')
      // Drop the separator left behind by "GET /orders — fetch one order".
      .replace(/^[\s`—–-]+/, '')
      .trim();

    return text.length > 0 ? stripInlineMarkup(text) : undefined;
  }
}

// ---------------------------------------------------------------------------
// cURL blocks
// ---------------------------------------------------------------------------

/**
 * Extract the cURL commands a document contains.
 *
 * A worked command is the strongest statement documentation makes — it shows a
 * request that was run — so it is worth surfacing separately from the prose
 * around it. The commands are parsed, never executed.
 */
export function extractCurlCommands(text: string): string[] {
  const commands: string[] = [];

  for (const block of collectCodeBlocks(stripHtml(text))) {
    const content = block.content.trim();
    if (!/^curl(\.exe)?[\s\\]/i.test(content)) continue;
    // Confirm it parses rather than trusting the fence's language tag.
    if (parseCurlCommand(content).ok) commands.push(content);
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

interface Table {
  readonly headings: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function collectTables(lines: readonly string[]): Table[] {
  const tables: Table[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index];
    const divider = lines[index + 1];
    if (!heading?.trim().startsWith('|') || !divider) continue;
    // The divider row is what makes a run of pipes a table.
    if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(divider) || !divider.includes('-')) continue;

    const headings = splitRow(heading).map((cell) => cell.toLowerCase());
    const rows: string[][] = [];

    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor]?.trim().startsWith('|')) {
      rows.push(splitRow(lines[cursor] as string));
      cursor += 1;
    }

    tables.push({ headings, rows });
    index = cursor - 1;
  }

  return tables;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function findColumn(
  headings: readonly string[],
  candidates: readonly string[],
): number | undefined {
  const index = headings.findIndex((heading) =>
    candidates.some((candidate) => heading === candidate || heading.includes(candidate)),
  );
  return index >= 0 ? index : undefined;
}

function cleanCell(cell: string): string {
  return stripInlineMarkup(cell).trim();
}

function stripInlineMarkup(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** Reduce HTML to its text so an HTML reference page reads like markdown. */
function stripHtml(text: string): string {
  if (!/<\/?(?:html|body|div|table|h[1-6]|p|pre|code)\b/i.test(text)) return text;

  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, inner: string) => {
      return `\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`;
    })
    .replace(/<(?:pre|code)\b[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi, '\n```\n$1\n```\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function collectCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const pattern = new RegExp(FENCE_PATTERN.source, FENCE_PATTERN.flags);

  for (const match of text.matchAll(pattern)) {
    blocks.push({
      language: (match[2] ?? '').trim().toLowerCase(),
      content: match[3] ?? '',
      line: text.slice(0, match.index ?? 0).split('\n').length - 1,
    });
  }

  return blocks;
}

/**
 * Trim sentence punctuation from a path without damaging it.
 *
 * A path legitimately ends in `}` — `/orders/{orderId}` — so a closing bracket
 * is only dropped when it has no opener to match, which is what distinguishes
 * "see GET /orders (below)" from a path template.
 */
function stripTrailingPunctuation(path: string): string {
  let result = path;

  for (;;) {
    const last = result.at(-1);
    if (last === undefined) return result;

    if ('.,;:'.includes(last)) {
      result = result.slice(0, -1);
      continue;
    }

    const opener = { ')': '(', ']': '[', '}': '{' }[last];
    if (opener === undefined) return result;

    const closers = result.split(last).length - 1;
    const openers = result.split(opener).length - 1;
    if (closers <= openers) return result;

    result = result.slice(0, -1);
  }
}

function isJsonLanguage(language: string): boolean {
  return language.length === 0 || /json|javascript|js/.test(language);
}

function tryParse(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parameterLocation(declared: string | undefined): ParameterLocation {
  const value = declared?.toLowerCase() ?? '';
  if (value.includes('path') || value.includes('url')) return 'path';
  if (value.includes('header')) return 'header';
  if (value.includes('cookie')) return 'cookie';
  // Documentation tables overwhelmingly describe query parameters, and saying
  // "query" where the document was silent is the least-wrong default; the doc
  // parser's output is provisional by construction.
  return 'query';
}

function isRequired(cell: string | undefined, description: string | undefined): boolean {
  const haystack = `${cell ?? ''} ${description ?? ''}`.toLowerCase();
  if (/\boptional\b|\bno\b/.test(cell?.toLowerCase() ?? '')) return false;
  return /\brequired\b|\byes\b|\bmandatory\b/.test(haystack);
}

/** Map a documented type name onto the IR, leaving anything unrecognized open. */
function schemaFromTypeName(declared: string | undefined): SchemaNode {
  const value = declared?.toLowerCase().trim() ?? '';
  if (value.length === 0) return { kind: 'unknown', reason: 'the documentation states no type' };

  if (/^(string|str|text|uuid|date|datetime|timestamp|email)/.test(value)) {
    return { kind: 'string' };
  }
  if (/^(int|integer|long|number\[int\])/.test(value)) return { kind: 'integer' };
  if (/^(number|float|double|decimal)/.test(value)) return { kind: 'number' };
  if (/^(bool|boolean)/.test(value)) return { kind: 'boolean' };
  if (/^(array|list)/.test(value)) {
    return { kind: 'array', items: { kind: 'unknown', reason: 'element type not documented' } };
  }
  if (/^(object|map|dict|json)/.test(value)) return { kind: 'object', properties: [] };

  return { kind: 'unknown', reason: `unrecognized documented type "${declared ?? ''}"` };
}

/**
 * A `{param}` in the path is a path parameter whether or not the table says so.
 * The table's entry wins where it exists, since it carries the description.
 */
function mergeWithPathParameters(path: string, documented: readonly Parameter[]): Parameter[] {
  const names = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string);
  const merged: Parameter[] = [];

  for (const name of names) {
    const found = documented.find((parameter) => parameter.name === name);
    merged.push(
      found
        ? { ...found, in: 'path', required: true }
        : { name, in: 'path', required: true, schema: { kind: 'string' } },
    );
  }

  for (const parameter of documented) {
    if (!names.includes(parameter.name)) merged.push(parameter);
  }

  return merged;
}

/** Methods a document may state, exported so callers can explain the format. */
export const DOCUMENTED_METHODS: readonly HttpMethod[] = HTTP_METHODS;
