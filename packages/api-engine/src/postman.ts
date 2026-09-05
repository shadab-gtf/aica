/**
 * Postman collection parser (schema v2.0 and v2.1).
 *
 * A collection is a set of saved *requests*, not a specification, which changes
 * what can honestly be extracted from it:
 *
 * - Paths are written with `:param` placeholders and Postman `{{variable}}`
 *   templates. The former is a real path parameter and is normalized; the
 *   latter is a collection variable, resolved from the collection's own
 *   variable list when it is defined there and left visible when it is not.
 * - Bodies and saved responses are examples, so schemas are *inferred* from
 *   them and every response example for a status is merged into one shape.
 * - Collections routinely contain live tokens in headers and variables. As in
 *   the cURL parser, a recognized credential becomes a scheme with no value and
 *   a warning naming the environment variable to set.
 *
 * Folders are flattened: the IR indexes endpoints, and the folder a request was
 * filed under becomes a tag so the grouping survives without shaping the model.
 */

import type {
  ApiResponse,
  ApiSpec,
  AuthScheme,
  Endpoint,
  HttpMethod,
  MediaTypeBody,
  ObjectProperty,
  Parameter,
  ParseWarning,
  ResponseStatus,
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
  toResponseStatus,
  unknownSchema,
  warn,
} from '@aica/api-ir';
import { looksLikeCredential, looksSensitiveKey } from '@aica/security-engine';
import { AgentError, ErrorCode, err, ok } from '@aica/shared';
import type { Result } from '@aica/shared';

import { inferSchemaFromSamples } from './infer.js';
import type { JsonRecord } from './json.js';
import { asArray, asRecord, asString, asText, compact } from './json.js';

export interface PostmanParseOptions {
  readonly location?: string;
  readonly fallbackTitle?: string;
}

/** True when the value looks like a Postman collection this parser can read. */
export function isPostmanCollection(document: unknown): boolean {
  const info = asRecord(asRecord(document)?.info);
  const schema = asString(info?.schema) ?? '';
  return (
    schema.includes('schema.getpostman.com') ||
    (info !== undefined && Array.isArray(asRecord(document)?.item))
  );
}

export function parsePostman(
  document: unknown,
  options: PostmanParseOptions = {},
): Result<ApiSpec> {
  const root = asRecord(document);
  if (!root || !isPostmanCollection(root)) {
    return err(
      new AgentError(
        ErrorCode.INVALID_INPUT,
        'Not a Postman collection: expected an "info" object and an "item" array',
        { details: { location: options.location } },
      ),
    );
  }

  return ok(new PostmanParser(root, options).parse());
}

/** How deep folder nesting may go before the parser stops descending. */
const MAX_FOLDER_DEPTH = 16;

class PostmanParser {
  private readonly warnings: ParseWarning[] = [];
  private readonly authSchemes: AuthScheme[] = [];
  private readonly variables = new Map<string, string>();

  constructor(
    private readonly root: JsonRecord,
    private readonly options: PostmanParseOptions,
  ) {}

  parse(): ApiSpec {
    const info = asRecord(this.root.info) ?? {};
    const title = asText(info.name) ?? this.options.fallbackTitle ?? 'Untitled Collection';

    this.collectVariables(this.root.variable);

    const collectionSecurity = this.parseAuth(this.root.auth, 'collection');
    const endpoints = this.collectItems(this.root.item, [], 0);

    const spec: ApiSpec = compact({
      id: slugify(title),
      title,
      description: asText(info.description) ?? this.describeFromRecord(info.description),
      servers: this.deriveServers(endpoints),
      endpoints,
      authSchemes: this.authSchemes,
      security: collectionSecurity ? [collectionSecurity] : [],
      components: {},
      source: this.sourceRef(),
      warnings: this.warnings,
    });

    return { ...spec, warnings: [...this.warnings, ...checkSpecInvariants(spec)] };
  }

  private sourceRef(pointer?: string) {
    return compact({
      format: 'postman' as const,
      location: this.options.location,
      pointer,
    });
  }

  private note(code: ParseWarning['code'], message: string, pointer?: string): void {
    this.warnings.push(warn(code, message, pointer));
  }

  /** Postman descriptions are sometimes a string, sometimes `{content, type}`. */
  private describeFromRecord(value: unknown): string | undefined {
    return asText(asRecord(value)?.content);
  }

  private collectVariables(value: unknown): void {
    for (const entry of asArray(value) ?? []) {
      const record = asRecord(entry);
      const key = asText(record?.key);
      const resolved = asString(record?.value);
      if (key !== undefined && resolved !== undefined) this.variables.set(key, resolved);
    }
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private collectItems(value: unknown, folders: readonly string[], depth: number): Endpoint[] {
    const items = asArray(value);
    if (!items) return [];

    if (depth > MAX_FOLDER_DEPTH) {
      this.note(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        `Folder nesting deeper than ${MAX_FOLDER_DEPTH} levels was not traversed`,
      );
      return [];
    }

    const endpoints: Endpoint[] = [];

    for (const [index, entry] of items.entries()) {
      const item = asRecord(entry);
      if (!item) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          'Collection item is not an object',
          `item/${index}`,
        );
        continue;
      }

      const name = asText(item.name) ?? `item ${index}`;

      // A folder holds further items; a request holds a `request`.
      if (item.item !== undefined) {
        endpoints.push(...this.collectItems(item.item, [...folders, name], depth + 1));
        continue;
      }

      const endpoint = this.parseRequestItem(item, name, folders);
      if (endpoint) endpoints.push(endpoint);
    }

    return endpoints;
  }

  private parseRequestItem(
    item: JsonRecord,
    name: string,
    folders: readonly string[],
  ): Endpoint | undefined {
    const pointer = [...folders, name].join('/');
    const request = asRecord(item.request);

    if (!request) {
      // A string `request` is the shorthand form: just a URL, method GET.
      const shorthand = asText(item.request);
      if (shorthand === undefined) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          `Request "${name}" has no request object`,
          pointer,
        );
        return undefined;
      }
      return this.buildEndpoint({ method: 'GET', urlValue: shorthand, name, folders, pointer });
    }

    const method = asString(request.method)?.toUpperCase();
    if (method !== undefined && !isHttpMethod(method)) {
      this.note(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        `Request "${name}" uses unrecognized method "${method}"`,
        pointer,
      );
      return undefined;
    }

    return this.buildEndpoint({
      method: (method as HttpMethod | undefined) ?? 'GET',
      urlValue: request.url,
      name,
      folders,
      pointer,
      request,
      responses: item.response,
      description: asText(request.description) ?? this.describeFromRecord(request.description),
    });
  }

  private buildEndpoint(input: {
    method: HttpMethod;
    urlValue: unknown;
    name: string;
    folders: readonly string[];
    pointer: string;
    request?: JsonRecord;
    responses?: unknown;
    description?: string;
  }): Endpoint | undefined {
    const url = this.parseUrl(input.urlValue, input.pointer);
    if (!url) return undefined;

    const request = input.request;
    const headers = request ? this.parseHeaders(request.header) : [];
    const security = request ? this.parseAuth(request.auth, input.pointer) : undefined;

    const credentialSecurity = this.extractHeaderCredentials(headers, input.pointer);
    const combined = [...(security ?? []), ...credentialSecurity];

    return compact({
      id: endpointId(input.method, url.path),
      method: input.method,
      path: url.path,
      summary: input.name,
      description: input.description,
      tags: [...input.folders],
      parameters: [
        ...url.pathParameters,
        ...url.queryParameters,
        ...this.headerParameters(headers),
      ],
      requestBody: request ? this.parseBody(request.body, input.pointer) : undefined,
      responses: this.parseResponses(input.responses, input.pointer),
      security: combined.length > 0 ? [combined] : [],
      servers: url.origin ? [{ url: url.origin, variables: [] }] : [],
      source: this.sourceRef(input.pointer),
    });
  }

  // -------------------------------------------------------------------------
  // URLs
  // -------------------------------------------------------------------------

  private parseUrl(
    value: unknown,
    pointer: string,
  ):
    | {
        path: string;
        origin?: string;
        pathParameters: Parameter[];
        queryParameters: Parameter[];
      }
    | undefined {
    // The URL is either a raw string or an object with host/path/query arrays.
    const record = asRecord(value);
    const raw = asText(value) ?? asText(record?.raw);

    const segments = asArray(record?.path);
    const hostParts = asArray(record?.host);

    let path: string;
    let origin: string | undefined;

    if (segments) {
      path = normalizePath(
        segments.map((segment) => this.resolveTemplate(String(segment))).join('/'),
      );
      const host = hostParts?.map((part) => this.resolveTemplate(String(part))).join('.');
      const protocol = asString(record?.protocol) ?? 'https';
      origin = host && host.length > 0 ? `${protocol}://${host}` : undefined;
    } else if (raw !== undefined) {
      const resolved = this.resolveTemplate(raw);
      const parsed = safeUrl(resolved);
      if (parsed) {
        path = normalizePath(parsed.pathname);
        origin = parsed.origin;
      } else {
        // An unresolved `{{baseUrl}}` leaves a string that is not a URL. The
        // part after it is a usable path, but the variable may itself hold a
        // path prefix (`https://api.test/v1`), so what is dropped is reported
        // rather than assumed to be only a host.
        path = normalizePath(stripOrigin(resolved));
        for (const name of unresolvedVariables(resolved)) {
          this.note(
            ParseWarningCode.UNRESOLVED_REF,
            `The collection does not define "{{${name}}}", so the base URL of ${path} is unknown; any path prefix it carries is missing`,
            pointer,
          );
        }
      }
    } else {
      this.note(ParseWarningCode.MALFORMED_ENTRY, 'Request has no URL', pointer);
      return undefined;
    }

    return compact({
      path,
      origin,
      pathParameters: this.pathParameters(path, record, pointer),
      queryParameters: this.queryParameters(record, raw),
    });
  }

  /**
   * Resolve `{{variable}}` against the collection's own variables. An unknown
   * variable is left in place: showing `{{baseUrl}}` tells the user something is
   * missing, whereas substituting a plausible value would be a fabrication.
   */
  private resolveTemplate(value: string): string {
    return value.replace(/\{\{([^{}]+)\}\}/g, (all, name: string) => {
      const resolved = this.variables.get(name.trim());
      return resolved ?? all;
    });
  }

  private pathParameters(
    path: string,
    record: JsonRecord | undefined,
    pointer: string,
  ): Parameter[] {
    const declared = new Map<string, JsonRecord>();
    for (const entry of asArray(record?.variable) ?? []) {
      const variable = asRecord(entry);
      const key = asText(variable?.key);
      if (key !== undefined && variable) declared.set(key, variable);
    }

    const names = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string);

    for (const key of declared.keys()) {
      if (!names.includes(key)) {
        this.note(
          ParseWarningCode.UNUSED_PATH_PARAMETER,
          `Path variable "${key}" is declared but does not appear in the path`,
          pointer,
        );
      }
    }

    return names.map((name): Parameter => {
      const variable = declared.get(name);
      const example = asString(variable?.value);
      return compact({
        name,
        in: 'path' as const,
        required: true,
        schema:
          example !== undefined ? inferSchemaFromSamples([example]) : { kind: 'string' as const },
        description:
          asText(variable?.description) ?? this.describeFromRecord(variable?.description),
      });
    });
  }

  private queryParameters(record: JsonRecord | undefined, raw: string | undefined): Parameter[] {
    const declared = asArray(record?.query);

    if (declared) {
      return (
        declared
          .map((entry) => asRecord(entry))
          .filter((entry): entry is JsonRecord => entry !== undefined)
          // Postman keeps disabled parameters in the file; they were not sent.
          .filter((entry) => entry.disabled !== true)
          .map((entry): Parameter | undefined => {
            const name = asText(entry.key);
            if (name === undefined) return undefined;
            const value = asString(entry.value);
            const credential =
              looksSensitiveKey(name) || (value !== undefined && looksLikeCredential(value));
            return compact({
              name,
              in: 'query' as const,
              required: false,
              schema:
                credential || value === undefined
                  ? { kind: 'string' as const }
                  : inferSchemaFromSamples([this.resolveTemplate(value)]),
              description:
                asText(entry.description) ??
                this.describeFromRecord(entry.description) ??
                (credential ? 'Credential; the saved value was discarded' : undefined),
            });
          })
          .filter((parameter): parameter is Parameter => parameter !== undefined)
      );
    }

    const parsed = raw === undefined ? undefined : safeUrl(this.resolveTemplate(raw));
    if (!parsed) return [];

    return [...new Set([...parsed.searchParams.keys()])].map((name) =>
      compact({
        name,
        in: 'query' as const,
        required: false,
        schema: { kind: 'string' as const },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Headers, auth, body
  // -------------------------------------------------------------------------

  private parseHeaders(value: unknown): { name: string; value: string }[] {
    return (asArray(value) ?? [])
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonRecord => entry !== undefined)
      .filter((entry) => entry.disabled !== true)
      .map((entry) => ({
        name: asText(entry.key) ?? '',
        value: this.resolveTemplate(asString(entry.value) ?? ''),
      }))
      .filter((header) => header.name.length > 0);
  }

  private headerParameters(headers: readonly { name: string; value: string }[]): Parameter[] {
    return headers
      .filter(
        (header) =>
          !STRUCTURAL_HEADERS.has(header.name.toLowerCase()) &&
          !looksSensitiveKey(header.name) &&
          !looksLikeCredential(header.value),
      )
      .map((header) =>
        compact({
          name: header.name,
          in: 'header' as const,
          required: false,
          schema: inferSchemaFromSamples([header.value]),
        }),
      );
  }

  /** Credential-bearing headers become schemes; their values are discarded. */
  private extractHeaderCredentials(
    headers: readonly { name: string; value: string }[],
    pointer: string,
  ): SecurityOption {
    const requirements: { schemeId: string; scopes: readonly string[] }[] = [];

    for (const header of headers) {
      const name = header.name.toLowerCase();
      const isCredential =
        name === 'authorization' ||
        looksSensitiveKey(header.name) ||
        looksLikeCredential(header.value);
      if (!isCredential) continue;

      const scheme: AuthScheme =
        name === 'authorization'
          ? { id: 'authorization', kind: 'bearer', headerName: 'Authorization' }
          : { id: name, kind: 'apiKey', in: 'header', name: header.name };

      this.registerScheme(scheme);
      requirements.push({ schemeId: scheme.id, scopes: [] });
      this.note(
        ParseWarningCode.LITERAL_CREDENTIAL,
        `The saved request carried a credential in the ${header.name} header; it was discarded. Set a reference such as env:${toEnvName(header.name)}.`,
        pointer,
      );
    }

    return requirements;
  }

  /** Postman's own `auth` block, at collection, folder, or request level. */
  private parseAuth(value: unknown, pointer: string): SecurityOption | undefined {
    const record = asRecord(value);
    const type = asString(record?.type)?.toLowerCase();
    if (!record || type === undefined || type === 'noauth') return undefined;

    const scheme = this.toAuthScheme(type, record, pointer);
    if (!scheme) return undefined;

    this.registerScheme(scheme);
    return [{ schemeId: scheme.id, scopes: [] }];
  }

  private toAuthScheme(type: string, record: JsonRecord, pointer: string): AuthScheme | undefined {
    switch (type) {
      case 'bearer':
        return { id: 'bearer', kind: 'bearer', headerName: 'Authorization' };
      case 'basic':
        return { id: 'basic', kind: 'basic' };
      case 'apikey': {
        // Postman stores the block as a list of `{key, value}` settings.
        const settings = this.authSettings(record.apikey);
        const name = settings.get('key') ?? 'X-Api-Key';
        const location = settings.get('in') === 'query' ? 'query' : 'header';
        return { id: `apikey-${name.toLowerCase()}`, kind: 'apiKey', in: location, name };
      }
      case 'oauth2': {
        const settings = this.authSettings(record.oauth2);
        return compact({
          id: 'oauth2',
          kind: 'oauth2' as const,
          flow: 'authorizationCode' as const,
          authorizationUrl: settings.get('authUrl'),
          tokenUrl: settings.get('accessTokenUrl'),
          scopes: (settings.get('scope') ?? '')
            .split(/[\s,]+/)
            .filter((scope) => scope.length > 0)
            .map((name) => ({ name })),
        });
      }
      case 'awsv4': {
        const settings = this.authSettings(record.awsv4);
        return compact({
          id: 'aws',
          kind: 'awsSignature' as const,
          region: settings.get('region'),
          service: settings.get('service'),
        });
      }
      case 'digest':
      case 'ntlm':
      case 'hawk':
      case 'edgegrid':
        this.note(
          ParseWarningCode.UNKNOWN_AUTH,
          `Authentication type "${type}" has no first-class representation and was recorded as unknown`,
          pointer,
        );
        return { id: type, kind: 'unknown', rawDescription: `Postman auth type "${type}"` };
      default:
        this.note(
          ParseWarningCode.UNKNOWN_AUTH,
          `Unrecognized authentication type "${type}"`,
          pointer,
        );
        return { id: type, kind: 'unknown', rawDescription: `Postman auth type "${type}"` };
    }
  }

  /**
   * Read a Postman auth block. Only the non-secret settings are read; the value
   * fields holding tokens and passwords are deliberately never touched.
   */
  private authSettings(value: unknown): Map<string, string> {
    const settings = new Map<string, string>();
    for (const entry of asArray(value) ?? []) {
      const record = asRecord(entry);
      const key = asText(record?.key);
      const setting = asString(record?.value);
      if (key === undefined || setting === undefined) continue;
      if (looksSensitiveKey(key) || looksLikeCredential(setting)) continue;
      settings.set(key, this.resolveTemplate(setting));
    }
    return settings;
  }

  private registerScheme(scheme: AuthScheme): void {
    if (!this.authSchemes.some((existing) => existing.id === scheme.id)) {
      this.authSchemes.push(scheme);
    }
  }

  private parseBody(
    value: unknown,
    pointer: string,
  ): { required: boolean; content: MediaTypeBody[] } | undefined {
    const record = asRecord(value);
    const mode = asString(record?.mode);
    if (!record || mode === undefined) return undefined;

    switch (mode) {
      case 'raw': {
        const raw = asString(record.raw);
        if (raw === undefined || raw.trim().length === 0) return undefined;
        const language = asString(asRecord(asRecord(record.options)?.raw)?.language);
        return this.rawBody(this.resolveTemplate(raw), language, pointer);
      }

      case 'urlencoded':
      case 'formdata': {
        const fields = (asArray(record[mode]) ?? [])
          .map((entry) => asRecord(entry))
          .filter((entry): entry is JsonRecord => entry !== undefined)
          .filter((entry) => entry.disabled !== true);

        const properties: ObjectProperty[] = fields
          .map((entry): ObjectProperty | undefined => {
            const name = asText(entry.key);
            if (name === undefined) return undefined;
            const fieldValue = asString(entry.value);
            return {
              name,
              required: true,
              schema:
                looksSensitiveKey(name) || fieldValue === undefined
                  ? { kind: 'string' as const }
                  : inferSchemaFromSamples([this.resolveTemplate(fieldValue)]),
            };
          })
          .filter((property): property is ObjectProperty => property !== undefined);

        if (properties.length === 0) return undefined;

        return {
          required: true,
          content: [
            {
              mediaType:
                mode === 'urlencoded' ? 'application/x-www-form-urlencoded' : 'multipart/form-data',
              schema: { kind: 'object', properties },
            },
          ],
        };
      }

      case 'file':
        return {
          required: true,
          content: [
            {
              mediaType: 'application/octet-stream',
              schema: unknownSchema('body is a file upload'),
            },
          ],
        };

      case 'graphql': {
        const query = asString(asRecord(record.graphql)?.query);
        return {
          required: true,
          content: [
            {
              mediaType: 'application/json',
              schema: {
                kind: 'object',
                properties: [
                  compact({
                    name: 'query',
                    required: true,
                    schema: compact({ kind: 'string' as const, example: query }),
                  }),
                  {
                    name: 'variables',
                    required: false,
                    schema: unknownSchema('GraphQL variables'),
                  },
                ],
              },
            },
          ],
        };
      }

      default:
        this.note(
          ParseWarningCode.UNSUPPORTED_FEATURE,
          `Unrecognized body mode "${mode}"`,
          pointer,
        );
        return undefined;
    }
  }

  private rawBody(
    raw: string,
    language: string | undefined,
    pointer: string,
  ): { required: boolean; content: MediaTypeBody[] } {
    if (language === undefined || language === 'json') {
      try {
        const parsed: unknown = JSON.parse(raw);
        return {
          required: true,
          content: [{ mediaType: 'application/json', schema: inferSchemaFromSamples([parsed]) }],
        };
      } catch {
        if (language === 'json') {
          this.note(
            ParseWarningCode.MALFORMED_ENTRY,
            'Body is declared as JSON but does not parse; its structure is unknown',
            pointer,
          );
        }
      }
    }

    const mediaType = RAW_LANGUAGE_MEDIA_TYPES[language ?? ''] ?? 'text/plain';
    return {
      required: true,
      content: [{ mediaType, schema: unknownSchema(`body is opaque ${language ?? 'text'}`) }],
    };
  }

  // -------------------------------------------------------------------------
  // Saved responses
  // -------------------------------------------------------------------------

  private parseResponses(value: unknown, pointer: string): ApiResponse[] {
    const saved = asArray(value) ?? [];
    if (saved.length === 0) return [];

    // Several examples may be saved for one status; merging them yields a
    // shape supported by every sample rather than by whichever came first.
    const byStatus = new Map<
      ResponseStatus,
      { samples: unknown[]; description?: string; mediaType: string }
    >();

    for (const entry of saved) {
      const record = asRecord(entry);
      if (!record) continue;

      const code = record.code;
      const status = typeof code === 'number' ? toResponseStatus(String(code)) : undefined;
      if (status === undefined) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          `Saved response has no usable status code${record.name ? ` ("${String(record.name)}")` : ''}`,
          pointer,
        );
        continue;
      }

      const body = asString(record.body);
      const bucket = byStatus.get(status) ?? {
        samples: [],
        description: asText(record.status) ?? asText(record.name),
        mediaType: this.responseMediaType(record),
      };

      if (body !== undefined && body.trim().length > 0) {
        try {
          bucket.samples.push(JSON.parse(body));
        } catch {
          // A non-JSON example is still evidence that the endpoint responds;
          // the shape simply cannot be derived from it.
          bucket.samples.push(undefined);
        }
      }

      byStatus.set(status, bucket);
    }

    return [...byStatus].map(([status, bucket]): ApiResponse => {
      const usable = bucket.samples.filter((sample) => sample !== undefined);
      const schema: SchemaNode =
        usable.length > 0
          ? inferSchemaFromSamples(usable)
          : unknownSchema('the saved example response was not JSON');

      return compact({
        status,
        description: bucket.description,
        content: [{ mediaType: bucket.mediaType, schema }],
        headers: [],
      });
    });
  }

  private responseMediaType(record: JsonRecord): string {
    const headers = this.parseHeaders(record.header);
    const contentType = headers.find((header) => header.name.toLowerCase() === 'content-type');
    return (contentType?.value.split(';')[0] ?? 'application/json').trim().toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  /**
   * A collection has no single base URL, so it is derived from the origins the
   * requests actually use, most frequent first.
   */
  private deriveServers(endpoints: readonly Endpoint[]): Server[] {
    const counts = new Map<string, number>();
    for (const endpoint of endpoints) {
      for (const server of endpoint.servers) {
        counts.set(server.url, (counts.get(server.url) ?? 0) + 1);
      }
    }

    if (counts.size === 0) {
      const baseUrl = this.variables.get('baseUrl') ?? this.variables.get('base_url');
      return baseUrl ? [{ url: baseUrl, variables: [] }] : [];
    }

    return [...counts]
      .sort((left, right) => right[1] - left[1])
      .map(([url]) => ({ url, variables: [] }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const RAW_LANGUAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  javascript: 'application/javascript',
  html: 'text/html',
  xml: 'application/xml',
  text: 'text/plain',
};

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Names of `{{variable}}` templates the collection left unresolved. */
function unresolvedVariables(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => (match[1] as string).trim()),
    ),
  ];
}

/** Drop a scheme and host from a string that did not parse as a URL. */
function stripOrigin(value: string): string {
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = withoutScheme.indexOf('/');
  const path = slash === -1 ? '/' : withoutScheme.slice(slash);
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}

function toEnvName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}
