/**
 * The canonical endpoint intermediate representation (specification section 6).
 *
 * Every source format — OpenAPI 3.x, Swagger 2.0, a Postman collection, a
 * pasted cURL command — is lowered into these types. Nothing downstream
 * (endpoint search, code matching, client generation, contract validation)
 * knows which format an API came from.
 *
 * Two properties matter more than completeness:
 *
 * - **Provenance is preserved.** Every endpoint and every specification carries
 *   a `SourceRef` naming the format, the location, and the pointer it came
 *   from, so any claim the agent makes about an API can be traced back to the
 *   bytes that produced it.
 * - **Gaps are recorded, not filled.** A source that omits a response schema
 *   produces an `unknown` schema with a reason, never an invented shape.
 */

import type { AuthScheme, SecurityOption } from './auth.js';
import { referencedSchemeIds } from './auth.js';
import type { SchemaNode } from './schema.js';

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value.toUpperCase());
}

/** Methods that must not carry a request body, per RFC 9110. */
const BODYLESS_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'GET',
  'HEAD',
  'DELETE',
  'OPTIONS',
  'TRACE',
]);

/** Methods that are safe: they are not expected to change server state. */
const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'GET',
  'HEAD',
  'OPTIONS',
  'TRACE',
]);

export function isSafeMethod(method: HttpMethod): boolean {
  return SAFE_METHODS.has(method);
}

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/**
 * How a parameter is serialized into the request. Kept because a query
 * parameter serialized as `?tag=a&tag=b` and one serialized as `?tag=a,b` are
 * different wire formats, and generating the wrong one produces a bug that
 * only shows up against the live API.
 */
export type ParameterStyle =
  'simple' | 'form' | 'label' | 'matrix' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';

export interface Parameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly schema: SchemaNode;
  readonly required: boolean;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly style?: ParameterStyle;
  readonly explode?: boolean;
  /** Example drawn from the source, never invented. */
  readonly example?: unknown;
}

/** One representation of a body: a media type and the shape sent under it. */
export interface MediaTypeBody {
  /** Lower-cased media type without parameters, e.g. `application/json`. */
  readonly mediaType: string;
  readonly schema: SchemaNode;
  readonly example?: unknown;
}

export interface RequestBody {
  readonly required: boolean;
  readonly content: readonly MediaTypeBody[];
  readonly description?: string;
}

export interface ResponseHeader {
  readonly name: string;
  readonly schema: SchemaNode;
  readonly description?: string;
}

/**
 * What a response is documented under: a concrete code, a class of codes
 * (`'2XX'`), or `'default'` for the source's catch-all. Ranges are kept as
 * ranges rather than resolved to a representative code, because "some 2xx" and
 * "exactly 200" lead to different client code.
 */
export type ResponseStatus = number | 'default' | '1XX' | '2XX' | '3XX' | '4XX' | '5XX';

export interface ApiResponse {
  readonly status: ResponseStatus;
  readonly description?: string;
  readonly content: readonly MediaTypeBody[];
  readonly headers: readonly ResponseHeader[];
}

/** Parse a response key from a specification into a status, if it is one. */
export function toResponseStatus(key: string): ResponseStatus | undefined {
  if (key === 'default') return 'default';

  const range = /^([1-5])XX$/i.exec(key);
  if (range) return `${range[1] as string}XX` as ResponseStatus;

  const code = Number(key);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
}

/** The hundreds digit of a status, so ranges and codes compare uniformly. */
export function statusClass(status: ResponseStatus): number | undefined {
  if (typeof status === 'number') return Math.floor(status / 100);
  if (status === 'default') return undefined;
  return Number(status[0]);
}

export interface ServerVariable {
  readonly name: string;
  readonly default: string;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export interface Server {
  /** May contain `{variable}` placeholders. */
  readonly url: string;
  readonly description?: string;
  readonly variables: readonly ServerVariable[];
}

export type ApiSourceFormat = 'openapi3' | 'swagger2' | 'postman' | 'curl' | 'manual';

/** Where a piece of the IR came from, so every fact stays traceable. */
export interface SourceRef {
  readonly format: ApiSourceFormat;
  /** File path, URL, or a short label such as `pasted cURL`. */
  readonly location?: string;
  /** JSON pointer (`#/paths/~1users/get`) or a Postman item path. */
  readonly pointer?: string;
}

export interface Endpoint {
  /** Stable identity: `GET /users/{id}` with the path canonicalized. */
  readonly id: string;
  readonly method: HttpMethod;
  /** Canonical template form: leading slash, `{param}` placeholders. */
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly parameters: readonly Parameter[];
  readonly requestBody?: RequestBody;
  readonly responses: readonly ApiResponse[];
  /**
   * Ways to authenticate a call here; satisfying any one suffices. An empty
   * array means the specification-level default applies, which is different
   * from an array holding one empty option — that is the endpoint declaring
   * itself explicitly public.
   */
  readonly security: readonly SecurityOption[];
  readonly deprecated?: boolean;
  /** Operation-level server override; empty means inherit from the spec. */
  readonly servers: readonly Server[];
  readonly source: SourceRef;
}

/**
 * Something the parser could not represent faithfully. Warnings are part of the
 * output rather than log noise, because the agent must be able to tell the user
 * "this specification does not say what this endpoint returns" instead of
 * quietly proceeding on a guess.
 */
export interface ParseWarning {
  readonly code: ParseWarningCode;
  readonly message: string;
  readonly pointer?: string;
}

export const ParseWarningCode = {
  UNRESOLVED_REF: 'UNRESOLVED_REF',
  CIRCULAR_REF: 'CIRCULAR_REF',
  MISSING_SCHEMA: 'MISSING_SCHEMA',
  UNSUPPORTED_FEATURE: 'UNSUPPORTED_FEATURE',
  UNKNOWN_AUTH: 'UNKNOWN_AUTH',
  DUPLICATE_ENDPOINT: 'DUPLICATE_ENDPOINT',
  UNDECLARED_PATH_PARAMETER: 'UNDECLARED_PATH_PARAMETER',
  UNUSED_PATH_PARAMETER: 'UNUSED_PATH_PARAMETER',
  UNKNOWN_SECURITY_SCHEME: 'UNKNOWN_SECURITY_SCHEME',
  LITERAL_CREDENTIAL: 'LITERAL_CREDENTIAL',
  MALFORMED_ENTRY: 'MALFORMED_ENTRY',
} as const;

export type ParseWarningCode = (typeof ParseWarningCode)[keyof typeof ParseWarningCode];

export function warn(code: ParseWarningCode, message: string, pointer?: string): ParseWarning {
  return pointer ? { code, message, pointer } : { code, message };
}

export interface ApiSpec {
  /** Slug derived from the title; unique within a project. */
  readonly id: string;
  readonly title: string;
  readonly version?: string;
  readonly description?: string;
  readonly servers: readonly Server[];
  readonly endpoints: readonly Endpoint[];
  readonly authSchemes: readonly AuthScheme[];
  /** Specification-level default applied to endpoints declaring none. */
  readonly security: readonly SecurityOption[];
  /** Named schemas kept for reference rendering and type generation. */
  readonly components: Readonly<Record<string, SchemaNode>>;
  readonly source: SourceRef;
  readonly warnings: readonly ParseWarning[];
}

// ---------------------------------------------------------------------------
// Path canonicalization
// ---------------------------------------------------------------------------

/**
 * Bring a path template into the canonical `{param}` form.
 *
 * Sources disagree: OpenAPI writes `/users/{id}`, Express and Postman write
 * `/users/:id`, some documentation writes `/users/<id>` or `/users/[id]`. They
 * are the same endpoint, and endpoint identity has to agree or the same API
 * imported twice looks like two APIs.
 *
 * Query strings and fragments are dropped — they are parameters, not identity.
 */
export function normalizePath(rawPath: string): string {
  let path = rawPath.trim();

  const queryStart = path.search(/[?#]/);
  if (queryStart >= 0) path = path.slice(0, queryStart);

  path = path
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
    .replace(/<([^<>/]+)>/g, '{$1}')
    .replace(/\[([^[\]/]+)\]/g, '{$1}')
    // Collapse repeated separators introduced by joining base URLs to paths.
    .replace(/\/{2,}/g, '/');

  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  return path;
}

/** Names of the `{param}` placeholders in a canonical path, in order. */
export function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string);
}

/**
 * Identity of a path ignoring what its parameters are called. `/users/{id}` and
 * `/users/{userId}` are the same endpoint named two ways; without this, merging
 * an OpenAPI spec with a Postman collection of the same API yields duplicates.
 */
export function pathSignature(path: string): string {
  return normalizePath(path).replace(/\{[^{}]+\}/g, '{}');
}

export function endpointId(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/** Identity ignoring parameter names, for cross-source endpoint matching. */
export function endpointSignature(endpoint: Pick<Endpoint, 'method' | 'path'>): string {
  return `${endpoint.method} ${pathSignature(endpoint.path)}`;
}

/**
 * Match a concrete request path against a template, returning the captured
 * parameters. Used to attribute an observed request — a cURL command, a call
 * found in the codebase — to a documented endpoint.
 *
 * Returns `undefined` when the path does not match, which is different from
 * matching with no parameters (an empty object).
 */
export function matchPath(
  template: string,
  concretePath: string,
): Record<string, string> | undefined {
  const templateSegments = splitSegments(normalizePath(template));
  const concreteSegments = splitSegments(normalizePath(concretePath));

  if (templateSegments.length !== concreteSegments.length) return undefined;

  const captured: Record<string, string> = {};

  for (const [index, templateSegment] of templateSegments.entries()) {
    const concreteSegment = concreteSegments[index] as string;
    const whole = /^\{([^{}]+)\}$/.exec(templateSegment);

    if (whole) {
      if (concreteSegment.length === 0) return undefined;
      captured[whole[1] as string] = decodeSegment(concreteSegment);
      continue;
    }

    if (!templateSegment.includes('{')) {
      if (templateSegment !== concreteSegment) return undefined;
      continue;
    }

    // Mixed segment such as `{id}.json` or `file-{name}`.
    const mixed = matchMixedSegment(templateSegment, concreteSegment);
    if (!mixed) return undefined;
    Object.assign(captured, mixed);
  }

  return captured;
}

function splitSegments(path: string): string[] {
  return path.split('/').slice(1);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is data, not an error: keep it verbatim.
    return segment;
  }
}

function matchMixedSegment(
  templateSegment: string,
  concreteSegment: string,
): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = templateSegment.replace(/\{([^{}]+)\}|([^{}]+)/g, (_all, name, literal) => {
    if (typeof name === 'string') {
      names.push(name);
      return '([^/]+?)';
    }
    return escapeRegExp(literal as string);
  });

  const matched = new RegExp(`^${pattern}$`).exec(concreteSegment);
  if (!matched) return undefined;

  const captured: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    captured[name] = decodeSegment(matched[index + 1] as string);
  }
  return captured;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Substitute captured values back into a template, for request building. */
export function fillPath(template: string, values: Readonly<Record<string, string>>): string {
  return normalizePath(template).replace(/\{([^{}]+)\}/g, (all, name: string) => {
    const value = values[name];
    return value === undefined ? all : encodeURIComponent(value);
  });
}

// ---------------------------------------------------------------------------
// Endpoint accessors
// ---------------------------------------------------------------------------

export function parametersIn(endpoint: Endpoint, location: ParameterLocation): Parameter[] {
  return endpoint.parameters.filter((parameter) => parameter.in === location);
}

export function requiredParameters(endpoint: Endpoint): Parameter[] {
  return endpoint.parameters.filter((parameter) => parameter.required);
}

/**
 * The response the caller normally gets: the lowest documented 2xx, falling
 * back to a `2XX` range and then to the catch-all.
 */
export function successResponse(endpoint: Endpoint): ApiResponse | undefined {
  const concrete = endpoint.responses
    .filter(
      (response): response is ApiResponse & { status: number } =>
        statusClass(response.status) === 2,
    )
    .filter((response) => typeof response.status === 'number')
    .sort((left, right) => left.status - right.status);

  return (
    concrete[0] ??
    endpoint.responses.find((response) => response.status === '2XX') ??
    endpoint.responses.find((response) => response.status === 'default')
  );
}

/** Documented failures: any 4xx or 5xx, range entries included. */
export function errorResponses(endpoint: Endpoint): ApiResponse[] {
  return endpoint.responses.filter((response) => {
    const group = statusClass(response.status);
    return group === 4 || group === 5;
  });
}

/** Prefer JSON when present; otherwise the first documented representation. */
export function preferredBody(content: readonly MediaTypeBody[]): MediaTypeBody | undefined {
  return content.find((body) => body.mediaType.includes('json')) ?? content[0];
}

/** Schema of the success response body, when the source documented one. */
export function successSchema(endpoint: Endpoint): SchemaNode | undefined {
  const response = successResponse(endpoint);
  return response ? preferredBody(response.content)?.schema : undefined;
}

export function requestSchema(endpoint: Endpoint): SchemaNode | undefined {
  return endpoint.requestBody ? preferredBody(endpoint.requestBody.content)?.schema : undefined;
}

/**
 * The authentication a call to this endpoint must satisfy, resolving the
 * endpoint's own declaration against the specification default.
 */
export function effectiveSecurity(spec: ApiSpec, endpoint: Endpoint): readonly SecurityOption[] {
  return endpoint.security.length > 0 ? endpoint.security : spec.security;
}

export function findEndpoint(
  spec: ApiSpec,
  method: HttpMethod,
  path: string,
): Endpoint | undefined {
  const id = endpointId(method, path);
  return spec.endpoints.find((endpoint) => endpoint.id === id);
}

export function findAuthScheme(spec: ApiSpec, schemeId: string): AuthScheme | undefined {
  return spec.authSchemes.find((scheme) => scheme.id === schemeId);
}

/** One-line description for search results, prompts, and the UI. */
export function describeEndpoint(endpoint: Endpoint): string {
  const summary = endpoint.summary ?? endpoint.operationId;
  return summary
    ? `${endpoint.method} ${endpoint.path} — ${summary}`
    : `${endpoint.method} ${endpoint.path}`;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Check the invariants the rest of the system relies on. Violations are
 * returned as warnings rather than thrown: a real-world specification is often
 * internally inconsistent, and the agent's job is to report that clearly, not
 * to refuse to load the file.
 */
export function checkSpecInvariants(spec: ApiSpec): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  const seen = new Set<string>();
  const schemeIds = new Set(spec.authSchemes.map((scheme) => scheme.id));

  for (const schemeId of referencedSchemeIds(spec.security)) {
    if (!schemeIds.has(schemeId)) {
      warnings.push(
        warn(
          ParseWarningCode.UNKNOWN_SECURITY_SCHEME,
          `Specification-level security references undefined scheme "${schemeId}"`,
        ),
      );
    }
  }

  for (const endpoint of spec.endpoints) {
    if (seen.has(endpoint.id)) {
      warnings.push(
        warn(
          ParseWarningCode.DUPLICATE_ENDPOINT,
          `Duplicate endpoint ${endpoint.id}`,
          endpoint.source.pointer,
        ),
      );
    }
    seen.add(endpoint.id);

    warnings.push(...checkEndpointInvariants(endpoint, schemeIds));
  }

  return warnings;
}

function checkEndpointInvariants(
  endpoint: Endpoint,
  schemeIds: ReadonlySet<string>,
): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  const pointer = endpoint.source.pointer;

  const inPath = new Set(pathParameterNames(endpoint.path));
  const declared = new Set(parametersIn(endpoint, 'path').map((parameter) => parameter.name));

  for (const name of inPath) {
    if (!declared.has(name)) {
      warnings.push(
        warn(
          ParseWarningCode.UNDECLARED_PATH_PARAMETER,
          `${endpoint.id} uses {${name}} but does not declare it as a path parameter`,
          pointer,
        ),
      );
    }
  }

  for (const name of declared) {
    if (!inPath.has(name)) {
      warnings.push(
        warn(
          ParseWarningCode.UNUSED_PATH_PARAMETER,
          `${endpoint.id} declares path parameter "${name}" that does not appear in the path`,
          pointer,
        ),
      );
    }
  }

  for (const schemeId of referencedSchemeIds(endpoint.security)) {
    if (!schemeIds.has(schemeId)) {
      warnings.push(
        warn(
          ParseWarningCode.UNKNOWN_SECURITY_SCHEME,
          `${endpoint.id} references undefined security scheme "${schemeId}"`,
          pointer,
        ),
      );
    }
  }

  if (endpoint.requestBody && BODYLESS_METHODS.has(endpoint.method)) {
    warnings.push(
      warn(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        `${endpoint.id} documents a request body, which ${endpoint.method} requests do not carry`,
        pointer,
      ),
    );
  }

  if (endpoint.responses.length === 0) {
    warnings.push(
      warn(ParseWarningCode.MISSING_SCHEMA, `${endpoint.id} documents no response`, pointer),
    );
  }

  return warnings;
}

/** Stable slug for an API title, used as the specification identifier. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'api';
}
