/**
 * cURL command parser.
 *
 * Pasting a working `curl` line is how most people describe an API they
 * already have access to, which makes it the highest-fidelity input the system
 * accepts — it is a request that demonstrably worked — and also the most
 * dangerous, because it usually contains a live credential.
 *
 * Two properties follow from that:
 *
 * - **The command is tokenized, never executed.** The tokenizer implements
 *   POSIX quoting to recover the argument vector, and nothing is handed to a
 *   shell at any point. `$(...)` and backticks are inert text here; they are
 *   reported so the user knows a value did not survive the paste.
 * - **No credential is retained.** Detected credentials become an auth *scheme*
 *   with no value, plus a warning naming the environment variable to set. The
 *   literal never reaches the IR, so it cannot reach the catalog, the UI, a log,
 *   or a prompt.
 *
 * A cURL command describes a request, not an API: the concrete path is kept as
 * observed rather than guessed back into a template, and the response shape is
 * recorded as unknown because no response was seen.
 */

import type {
  ApiSpec,
  AuthScheme,
  Endpoint,
  HttpMethod,
  MediaTypeBody,
  ObjectProperty,
  Parameter,
  ParseWarning,
  SchemaNode,
  SecurityOption,
  Server,
} from '@aica/api-ir';
import {
  ParseWarningCode,
  checkSpecInvariants,
  endpointId,
  isHttpMethod,
  normalizePath,
  slugify,
  unknownSchema,
  warn,
} from '@aica/api-ir';
import { looksLikeCredential, looksSensitiveKey } from '@aica/security-engine';
import { AgentError, ErrorCode, err, ok } from '@aica/shared';
import type { Result } from '@aica/shared';

import { inferSchema } from './infer.js';
import { compact } from './json.js';

export interface CurlParseOptions {
  /** Recorded as provenance; defaults to a generic label. */
  readonly location?: string;
  readonly fallbackTitle?: string;
}

/** A header or form field as written on the command line. */
export interface NameValue {
  readonly name: string;
  readonly value: string;
}

/** The request a cURL command describes, before it is lowered into the IR. */
export interface CurlRequest {
  readonly method: HttpMethod;
  readonly url: URL;
  readonly headers: readonly NameValue[];
  readonly formFields: readonly NameValue[];
  readonly body?: string;
  /** True when `-u` was given; the credential itself is discarded. */
  readonly hasBasicAuth: boolean;
  /** True when the command disabled certificate verification. */
  readonly insecure: boolean;
  readonly warnings: readonly ParseWarning[];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a command line into its argument vector using POSIX quoting rules.
 *
 * This exists so the parser never needs a shell. An unterminated quote is an
 * error rather than a best guess, because silently completing a quote changes
 * which argument a value belongs to.
 */
export function tokenizeCommand(command: string): Result<string[]> {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let index = 0;

  const push = (): void => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };

  while (index < command.length) {
    const char = command[index] as string;

    if (char === '\\') {
      const next = command[index + 1];
      // A backslash or caret before a newline continues the line; both appear
      // in commands copied out of terminals and browser devtools.
      if (next === '\n' || next === '\r') {
        index += next === '\r' && command[index + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (next === undefined) {
        return err(
          new AgentError(ErrorCode.INVALID_INPUT, 'Command ends with a dangling backslash'),
        );
      }
      current += next;
      started = true;
      index += 2;
      continue;
    }

    if (char === '^' && (command[index + 1] === '\n' || command[index + 1] === '\r')) {
      index += command[index + 1] === '\r' && command[index + 2] === '\n' ? 3 : 2;
      continue;
    }

    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) {
        return err(new AgentError(ErrorCode.INVALID_INPUT, 'Unterminated single quote in command'));
      }
      current += command.slice(index + 1, end);
      started = true;
      index = end + 1;
      continue;
    }

    if (char === '"') {
      const result = readDoubleQuoted(command, index);
      if (!result.ok) return result;
      current += result.value.text;
      started = true;
      index = result.value.next;
      continue;
    }

    if (/\s/.test(char)) {
      push();
      index += 1;
      continue;
    }

    current += char;
    started = true;
    index += 1;
  }

  push();
  return ok(tokens);
}

function readDoubleQuoted(command: string, start: number): Result<{ text: string; next: number }> {
  let text = '';
  let index = start + 1;

  while (index < command.length) {
    const char = command[index] as string;

    if (char === '"') return ok({ text, next: index + 1 });

    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) break;
      if (next === '\n') {
        index += 2;
        continue;
      }
      // Inside double quotes a backslash is literal unless it precedes one of
      // the characters the shell would otherwise interpret.
      text += '"\\$`'.includes(next) ? next : `\\${next}`;
      index += 2;
      continue;
    }

    text += char;
    index += 1;
  }

  return err(new AgentError(ErrorCode.INVALID_INPUT, 'Unterminated double quote in command'));
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/** Flags that take a separate value argument. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-X',
  '--request',
  '-H',
  '--header',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--json',
  '-F',
  '--form',
  '--form-string',
  '-u',
  '--user',
  '-b',
  '--cookie',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '--url',
  '-o',
  '--output',
  '--connect-timeout',
  '--max-time',
  '-m',
  '--retry',
  '--proxy',
  '-x',
]);

export function parseCurlCommand(command: string): Result<CurlRequest> {
  const tokenized = tokenizeCommand(command);
  if (!tokenized.ok) return tokenized;

  const tokens = tokenized.value;
  if (tokens.length === 0) {
    return err(new AgentError(ErrorCode.INVALID_INPUT, 'Empty command'));
  }
  if (!/^curl(\.exe)?$/i.test(tokens[0] as string)) {
    return err(
      new AgentError(
        ErrorCode.INVALID_INPUT,
        `Not a curl command: it starts with "${tokens[0] as string}"`,
      ),
    );
  }

  const warnings: ParseWarning[] = [];
  if (/\$\(|`/.test(command)) {
    warnings.push(
      warn(
        ParseWarningCode.MALFORMED_ENTRY,
        'The command contains shell substitution, which is not evaluated; affected values were taken literally',
      ),
    );
  }

  const headers: NameValue[] = [];
  const formFields: NameValue[] = [];
  const dataParts: string[] = [];
  let urlText: string | undefined;
  let explicitMethod: string | undefined;
  let hasBasicAuth = false;
  let insecure = false;
  let headOnly = false;
  let dataAsQuery = false;
  let jsonShorthand = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    // `--header=value` is equivalent to `--header value`.
    const inlineSplit = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = inlineSplit > 0 ? token.slice(0, inlineSplit) : token;
    const inlineValue = inlineSplit > 0 ? token.slice(inlineSplit + 1) : undefined;

    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = tokens[index + 1];
      if (next === undefined) {
        warnings.push(warn(ParseWarningCode.MALFORMED_ENTRY, `${flag} has no value`));
        return undefined;
      }
      index += 1;
      return next;
    };

    if (!flag.startsWith('-')) {
      // A bare argument is the URL. Later ones replace earlier ones, matching
      // how curl treats repeated URLs for a single request.
      urlText = token;
      continue;
    }

    switch (flag) {
      case '-X':
      case '--request':
        explicitMethod = takeValue();
        break;

      case '-H':
      case '--header': {
        const value = takeValue();
        const header = value === undefined ? undefined : splitHeader(value);
        if (header) headers.push(header);
        else if (value !== undefined) {
          warnings.push(
            warn(
              ParseWarningCode.MALFORMED_ENTRY,
              `Header "${value}" is not in "Name: value" form`,
            ),
          );
        }
        break;
      }

      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
      case '--data-urlencode': {
        const value = takeValue();
        if (value !== undefined) {
          if (value.startsWith('@')) {
            warnings.push(
              warn(
                ParseWarningCode.UNSUPPORTED_FEATURE,
                `Body is read from the file "${value.slice(1)}", which is not read during parsing`,
              ),
            );
          } else {
            dataParts.push(value);
          }
        }
        break;
      }

      case '--json': {
        const value = takeValue();
        if (value !== undefined) dataParts.push(value);
        jsonShorthand = true;
        break;
      }

      case '-F':
      case '--form':
      case '--form-string': {
        const value = takeValue();
        const field = value === undefined ? undefined : splitFormField(value);
        if (field) formFields.push(field);
        break;
      }

      case '-u':
      case '--user':
        // The credential is consumed and discarded; only the fact is kept.
        takeValue();
        hasBasicAuth = true;
        break;

      case '-b':
      case '--cookie': {
        const value = takeValue();
        if (value !== undefined) headers.push({ name: 'Cookie', value });
        break;
      }

      case '-A':
      case '--user-agent': {
        const value = takeValue();
        if (value !== undefined) headers.push({ name: 'User-Agent', value });
        break;
      }

      case '-e':
      case '--referer': {
        const value = takeValue();
        if (value !== undefined) headers.push({ name: 'Referer', value });
        break;
      }

      case '--url':
        urlText = takeValue() ?? urlText;
        break;

      case '-G':
      case '--get':
        dataAsQuery = true;
        break;

      case '-I':
      case '--head':
        headOnly = true;
        break;

      case '-k':
      case '--insecure':
        insecure = true;
        break;

      default:
        // Unrecognized flags that take a value would otherwise swallow the URL.
        if (VALUE_FLAGS.has(flag)) takeValue();
        break;
    }
  }

  if (urlText === undefined) {
    return err(new AgentError(ErrorCode.INVALID_INPUT, 'Command contains no URL'));
  }

  const url = toUrl(urlText);
  if (!url.ok) return url;

  const body = dataParts.length > 0 ? dataParts.join('&') : undefined;

  if (dataAsQuery && body !== undefined) {
    // `-G` moves the data onto the query string instead of into a body.
    for (const [name, value] of new URLSearchParams(body))
      url.value.searchParams.append(name, value);
  }

  if (jsonShorthand) {
    if (!headers.some((header) => header.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: 'application/json' });
    }
    if (!headers.some((header) => header.name.toLowerCase() === 'accept')) {
      headers.push({ name: 'Accept', value: 'application/json' });
    }
  }

  const hasBody = !dataAsQuery && (body !== undefined || formFields.length > 0);

  return ok({
    method: resolveMethod(explicitMethod, { headOnly, hasBody, warnings }),
    url: url.value,
    headers,
    formFields,
    body: dataAsQuery ? undefined : body,
    hasBasicAuth,
    insecure,
    warnings,
  });
}

function resolveMethod(
  explicit: string | undefined,
  context: { headOnly: boolean; hasBody: boolean; warnings: ParseWarning[] },
): HttpMethod {
  if (explicit !== undefined) {
    if (isHttpMethod(explicit)) return explicit.toUpperCase() as HttpMethod;
    context.warnings.push(
      warn(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        `Unrecognized HTTP method "${explicit}"; assuming POST`,
      ),
    );
    return 'POST';
  }
  if (context.headOnly) return 'HEAD';
  // curl's own default: a body implies POST, otherwise GET.
  return context.hasBody ? 'POST' : 'GET';
}

function toUrl(raw: string): Result<URL> {
  // A pasted command often omits the scheme; curl itself assumes http.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return ok(new URL(candidate));
  } catch {
    return err(new AgentError(ErrorCode.INVALID_INPUT, `Could not parse "${raw}" as a URL`));
  }
}

function splitHeader(raw: string): NameValue | undefined {
  const separator = raw.indexOf(':');
  if (separator <= 0) return undefined;
  return { name: raw.slice(0, separator).trim(), value: raw.slice(separator + 1).trim() };
}

function splitFormField(raw: string): NameValue | undefined {
  const separator = raw.indexOf('=');
  if (separator <= 0) return undefined;
  return { name: raw.slice(0, separator).trim(), value: raw.slice(separator + 1) };
}

// ---------------------------------------------------------------------------
// Lowering into the IR
// ---------------------------------------------------------------------------

/** Headers that are modeled elsewhere in the IR rather than as parameters. */
const STRUCTURAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'content-type',
  'content-length',
  'host',
  'accept-encoding',
  'connection',
  'user-agent',
]);

export function parseCurl(command: string, options: CurlParseOptions = {}): Result<ApiSpec> {
  const parsed = parseCurlCommand(command);
  if (!parsed.ok) return parsed;

  const request = parsed.value;
  const warnings: ParseWarning[] = [...request.warnings];
  const source = compact({
    format: 'curl' as const,
    location: options.location ?? 'pasted cURL command',
  });

  if (request.insecure) {
    warnings.push(
      warn(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        'The command disables TLS certificate verification (-k); requests issued from the IR will verify certificates',
      ),
    );
  }

  const { schemes, security } = extractAuth(request, warnings);
  const path = normalizePath(request.url.pathname);
  const title = options.fallbackTitle ?? request.url.hostname;

  const endpoint: Endpoint = compact({
    id: endpointId(request.method, path),
    method: request.method,
    path,
    summary: `Observed ${request.method} ${path}`,
    tags: [],
    parameters: [...queryParameters(request), ...headerParameters(request)],
    requestBody: buildRequestBody(request, warnings),
    // A command records what was sent, never what came back.
    responses: [],
    security: security.length > 0 ? [security] : [],
    servers: [],
    source,
  });

  warnings.push(
    warn(
      ParseWarningCode.MISSING_SCHEMA,
      `${endpoint.id} has no documented response: a cURL command records a request only`,
    ),
  );

  const servers: Server[] = [{ url: request.url.origin, variables: [] }];

  const spec: ApiSpec = {
    id: slugify(title),
    title,
    servers,
    endpoints: [endpoint],
    authSchemes: schemes,
    security: [],
    components: {},
    source,
    warnings,
  };

  return ok({ ...spec, warnings: [...warnings, ...checkSpecInvariants(spec)] });
}

/**
 * Recognize the credential the command carries, record the *scheme*, and drop
 * the value. The warning names the environment variable to set so the user can
 * finish the configuration without pasting the secret again.
 */
function extractAuth(
  request: CurlRequest,
  warnings: ParseWarning[],
): { schemes: AuthScheme[]; security: SecurityOption } {
  const schemes: AuthScheme[] = [];
  const requirements: { schemeId: string; scopes: readonly string[] }[] = [];

  const add = (scheme: AuthScheme, advice: string): void => {
    // `-u` alongside an explicit Authorization header describes one credential
    // twice; recording it twice would make the endpoint look doubly guarded.
    if (schemes.some((existing) => existing.id === scheme.id)) return;
    schemes.push(scheme);
    requirements.push({ schemeId: scheme.id, scopes: [] });
    warnings.push(warn(ParseWarningCode.LITERAL_CREDENTIAL, advice));
  };

  if (request.hasBasicAuth) {
    add(
      { id: 'basic', kind: 'basic' },
      'The command supplied basic credentials with -u; they were discarded. Set a username and password reference such as env:API_USERNAME and env:API_PASSWORD.',
    );
  }

  for (const header of request.headers) {
    const name = header.name.toLowerCase();

    if (name === 'authorization') {
      const [scheme = '', ...rest] = header.value.split(/\s+/);
      const token = rest.join(' ');
      const kind = scheme.toLowerCase();

      if (kind === 'bearer') {
        add(
          compact({
            id: 'bearer',
            kind: isJwt(token) ? ('jwt' as const) : ('bearer' as const),
            bearerFormat: isJwt(token) ? 'JWT' : undefined,
          }),
          'The command carried a bearer token in the Authorization header; it was discarded. Set a reference such as env:API_TOKEN.',
        );
      } else if (kind === 'basic') {
        add(
          { id: 'basic', kind: 'basic' },
          'The command carried basic credentials in the Authorization header; they were discarded. Set references such as env:API_USERNAME and env:API_PASSWORD.',
        );
      } else {
        add(
          {
            id: 'authorization',
            kind: 'custom',
            headerNames: ['Authorization'],
            instructions: `Authorization: ${scheme} <credential>`,
          },
          `The command carried an Authorization header using the "${scheme}" scheme; its value was discarded. Set a reference such as env:API_CREDENTIAL.`,
        );
      }
      continue;
    }

    if (name === 'cookie') {
      add(
        { id: 'cookie', kind: 'cookie', name: header.value.split('=')[0]?.trim() ?? 'session' },
        'The command carried a Cookie header; its value was discarded. Session cookies are usually short-lived, so prefer a documented authentication scheme.',
      );
      continue;
    }

    if (looksSensitiveKey(header.name) || looksLikeCredential(header.value)) {
      add(
        { id: header.name.toLowerCase(), kind: 'apiKey', in: 'header', name: header.name },
        `The command carried a credential in the ${header.name} header; it was discarded. Set a reference such as env:${toEnvName(header.name)}.`,
      );
    }
  }

  for (const [name, value] of request.url.searchParams) {
    if (looksSensitiveKey(name) || looksLikeCredential(value)) {
      add(
        { id: name.toLowerCase(), kind: 'apiKey', in: 'query', name },
        `The command carried a credential in the "${name}" query parameter; it was discarded. Set a reference such as env:${toEnvName(name)}.`,
      );
    }
  }

  return { schemes, security: requirements };
}

function queryParameters(request: CurlRequest): Parameter[] {
  const seen = new Map<string, string[]>();
  for (const [name, value] of request.url.searchParams) {
    seen.set(name, [...(seen.get(name) ?? []), value]);
  }

  return [...seen].map(([name, values]): Parameter => {
    const credential = looksSensitiveKey(name) || values.some(looksLikeCredential);
    const schema: SchemaNode = credential
      ? { kind: 'string' }
      : inferSchema(values.length > 1 ? values : values[0]);

    return compact({
      name,
      in: 'query' as const,
      // Observed in one request; whether the API demands it is not knowable
      // from a single call.
      required: false,
      schema,
      description: credential ? 'Credential; the observed value was discarded' : undefined,
    });
  });
}

function headerParameters(request: CurlRequest): Parameter[] {
  return request.headers
    .filter((header) => !STRUCTURAL_HEADERS.has(header.name.toLowerCase()))
    .filter((header) => !looksSensitiveKey(header.name) && !looksLikeCredential(header.value))
    .map((header) =>
      compact({
        name: header.name,
        in: 'header' as const,
        required: false,
        schema: inferSchema(header.value),
      }),
    );
}

function buildRequestBody(
  request: CurlRequest,
  warnings: ParseWarning[],
): { required: boolean; content: MediaTypeBody[] } | undefined {
  if (request.formFields.length > 0) {
    const properties: ObjectProperty[] = request.formFields.map((field) => ({
      name: field.name,
      required: true,
      schema: looksSensitiveKey(field.name)
        ? { kind: 'string' as const }
        : inferSchema(field.value.startsWith('@') ? '' : field.value),
    }));

    return {
      required: true,
      content: [
        {
          mediaType: request.formFields.some((field) => field.value.startsWith('@'))
            ? 'multipart/form-data'
            : 'application/x-www-form-urlencoded',
          schema: { kind: 'object', properties },
        },
      ],
    };
  }

  if (request.body === undefined) return undefined;

  const declared = request.headers
    .find((header) => header.name.toLowerCase() === 'content-type')
    ?.value.split(';')[0]
    ?.trim()
    .toLowerCase();

  if (
    declared === 'application/x-www-form-urlencoded' ||
    (!declared && !looksLikeJson(request.body))
  ) {
    const properties: ObjectProperty[] = [...new URLSearchParams(request.body)].map(
      ([name, value]) => ({
        name,
        required: true,
        schema: looksSensitiveKey(name) ? { kind: 'string' as const } : inferSchema(value),
      }),
    );

    if (properties.length > 0) {
      return {
        required: true,
        content: [
          {
            mediaType: declared ?? 'application/x-www-form-urlencoded',
            schema: { kind: 'object', properties },
          },
        ],
      };
    }
  }

  const mediaType = declared ?? 'application/json';

  try {
    const parsed: unknown = JSON.parse(request.body);
    return { required: true, content: [{ mediaType, schema: inferSchema(parsed) }] };
  } catch {
    warnings.push(
      warn(
        ParseWarningCode.MISSING_SCHEMA,
        'The request body is not JSON and its structure could not be determined',
      ),
    );
    return {
      required: true,
      content: [{ mediaType, schema: unknownSchema('body was sent as an opaque string') }],
    };
  }
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}

/** Turn a header or parameter name into the environment variable to suggest. */
function toEnvName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}
