/**
 * Conflict detection between two descriptions of the same API.
 *
 * The system routinely holds more than one account of an endpoint: a
 * specification the team published, a Postman collection someone exported, a
 * cURL command that demonstrably worked. When they disagree, the disagreement
 * is the most valuable thing in the input — it is usually the reason an
 * integration is broken — and the architecture forbids resolving it silently.
 * So this module reports differences and never merges them away.
 *
 * Comparison is directional. The first argument is the account being checked
 * *against* (typically the specification) and the second is what was actually
 * seen. "Undocumented" therefore means present in reality but absent from the
 * spec, which is a different problem from a field the spec promises and reality
 * omits — and the severities differ accordingly.
 *
 * Nothing here consults a model. Every finding is a structural fact about two
 * documents, which is what makes it usable as evidence later.
 */

import type { ApiSpec, Endpoint, SchemaNode, Server } from '@aica/api-ir';
import {
  effectiveSecurity,
  normalizePath,
  pathSignature,
  preferredBody,
  referencedSchemeIds,
  successResponse,
} from '@aica/api-ir';

export const ConflictCode = {
  /** An endpoint one side documents and the other does not. */
  ENDPOINT_UNDOCUMENTED: 'ENDPOINT_UNDOCUMENTED',
  ENDPOINT_MISSING: 'ENDPOINT_MISSING',
  /** Same endpoint reached under a differently-named path parameter. */
  PATH_PARAMETER_RENAMED: 'PATH_PARAMETER_RENAMED',
  PARAMETER_MISSING: 'PARAMETER_MISSING',
  PARAMETER_UNDOCUMENTED: 'PARAMETER_UNDOCUMENTED',
  PARAMETER_REQUIREDNESS: 'PARAMETER_REQUIREDNESS',
  MEDIA_TYPE_MISMATCH: 'MEDIA_TYPE_MISMATCH',
  FIELD_MISSING: 'FIELD_MISSING',
  FIELD_UNDOCUMENTED: 'FIELD_UNDOCUMENTED',
  FIELD_TYPE: 'FIELD_TYPE',
  FIELD_REQUIREDNESS: 'FIELD_REQUIREDNESS',
  FIELD_NULLABILITY: 'FIELD_NULLABILITY',
  ENUM_MISMATCH: 'ENUM_MISMATCH',
  STATUS_UNDOCUMENTED: 'STATUS_UNDOCUMENTED',
  AUTH_MISMATCH: 'AUTH_MISMATCH',
  SERVER_MISMATCH: 'SERVER_MISMATCH',
} as const;

export type ConflictCode = (typeof ConflictCode)[keyof typeof ConflictCode];

/**
 * `error` means code written against one account will fail against the other.
 * `warning` means it may fail depending on data. `info` records a difference
 * that is safe but worth knowing, such as an extra field in a response.
 */
export type ConflictSeverity = 'error' | 'warning' | 'info';

export interface Conflict {
  readonly code: ConflictCode;
  readonly severity: ConflictSeverity;
  readonly message: string;
  /** Endpoint the conflict concerns, when it is endpoint-specific. */
  readonly endpointId?: string;
  /** Dotted location inside a schema, such as `data.items.status`. */
  readonly path?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface CompareOptions {
  /** Label for the first document in messages. */
  readonly expectedLabel?: string;
  /** Label for the second document in messages. */
  readonly actualLabel?: string;
  /** How deep to compare nested schemas. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 10;

// ---------------------------------------------------------------------------
// Specification comparison
// ---------------------------------------------------------------------------

/**
 * Compare two specifications describing the same API.
 *
 * Endpoints are paired by signature rather than by exact path, so `/users/{id}`
 * and `/users/{userId}` are recognized as the same endpoint named two ways —
 * itself a reportable difference, but not a missing endpoint.
 */
export function compareSpecs(
  expected: ApiSpec,
  actual: ApiSpec,
  options: CompareOptions = {},
): Conflict[] {
  const expectedLabel = options.expectedLabel ?? expected.title;
  const actualLabel = options.actualLabel ?? actual.title;

  const conflicts: Conflict[] = [];

  // A specification writes paths relative to its server's base path, while an
  // observed request carries the whole thing: `/orders` under a server of
  // `https://api.test/v1` is the same endpoint as an observed `/v1/orders`.
  // Pairing on the bare path would report both as missing.
  const bySignature = new Map<string, Aligned>();
  for (const endpoint of actual.endpoints) {
    for (const aligned of align(actual, endpoint)) {
      if (!bySignature.has(aligned.key)) bySignature.set(aligned.key, aligned);
    }
  }

  const matched = new Set<Endpoint>();

  for (const endpoint of expected.endpoints) {
    const candidates = align(expected, endpoint);
    const found = candidates
      .map((candidate) => ({ candidate, aligned: bySignature.get(candidate.key) }))
      .find((entry) => entry.aligned !== undefined);

    const counterpart = found?.aligned?.endpoint;

    if (!counterpart) {
      conflicts.push({
        code: ConflictCode.ENDPOINT_MISSING,
        severity: 'warning',
        message: `${endpoint.id} is documented in ${expectedLabel} but absent from ${actualLabel}`,
        endpointId: endpoint.id,
      });
      continue;
    }

    matched.add(counterpart);

    // Compare the aligned paths, so a differing base path is not mistaken for
    // a renamed parameter.
    const expectedPath = found?.candidate.path ?? endpoint.path;
    const actualPath = found?.aligned?.path ?? counterpart.path;

    if (expectedPath !== actualPath) {
      conflicts.push({
        code: ConflictCode.PATH_PARAMETER_RENAMED,
        severity: 'info',
        message: `${endpoint.id} is written as ${counterpart.path} in ${actualLabel}; the path parameters are named differently`,
        endpointId: endpoint.id,
        expected: endpoint.path,
        actual: counterpart.path,
      });
    }

    conflicts.push(
      ...compareEndpoints(endpoint, counterpart, {
        expectedLabel,
        actualLabel,
        maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
        expectedSpec: expected,
        actualSpec: actual,
      }),
    );
  }

  for (const endpoint of actual.endpoints) {
    if (matched.has(endpoint)) continue;
    conflicts.push({
      code: ConflictCode.ENDPOINT_UNDOCUMENTED,
      severity: 'warning',
      message: `${endpoint.id} appears in ${actualLabel} but is not documented in ${expectedLabel}`,
      endpointId: endpoint.id,
    });
  }

  conflicts.push(...compareServers(expected, actual, expectedLabel, actualLabel));

  return conflicts;
}

/** One way an endpoint's path can be written once its server base is applied. */
interface Aligned {
  readonly endpoint: Endpoint;
  /** The full path including the server's base path. */
  readonly path: string;
  /** `METHOD /v1/orders/{}` — identity ignoring parameter names. */
  readonly key: string;
}

/**
 * Every path this endpoint could be reached at, given its specification's
 * servers.
 *
 * The endpoint's own path is always included: a Postman collection or a cURL
 * command already carries the base path in the path itself, while an OpenAPI
 * document keeps it in the server URL. Producing both forms lets the two pair
 * up without either side having to be normalized first.
 */
function align(spec: ApiSpec, endpoint: Endpoint): Aligned[] {
  const servers = endpoint.servers.length > 0 ? endpoint.servers : spec.servers;
  const paths = new Set<string>([endpoint.path]);

  for (const base of basePaths(servers)) {
    paths.add(normalizePath(`${base}${endpoint.path}`));
  }

  return [...paths].map((path) => ({
    endpoint,
    path,
    key: `${endpoint.method} ${pathSignature(path)}`,
  }));
}

/** The path portion of each server URL, e.g. `https://api.test/v1` -> `/v1`. */
function basePaths(servers: readonly Server[]): string[] {
  const bases = new Set<string>();

  for (const server of servers) {
    // A server URL may be absolute, relative, or carry `{variable}` segments
    // that cannot be resolved here; only a usable path prefix is taken.
    const withoutScheme = server.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    const base = withoutScheme.replace(/\/+$/, '');
    if (base.length > 0 && base.startsWith('/') && !base.includes('{')) bases.add(base);
  }

  return [...bases];
}

function compareServers(
  expected: ApiSpec,
  actual: ApiSpec,
  expectedLabel: string,
  actualLabel: string,
): Conflict[] {
  const expectedOrigins = new Set(expected.servers.map((server) => originOf(server.url)));
  const actualOrigins = [...new Set(actual.servers.map((server) => originOf(server.url)))];

  // A relative server URL says nothing about the host, so it cannot conflict.
  const comparable = actualOrigins.filter((origin) => origin.length > 0);
  if (expectedOrigins.size === 0 || comparable.length === 0) return [];

  const unknown = comparable.filter((origin) => !expectedOrigins.has(origin));
  if (unknown.length === 0) return [];

  return [
    {
      code: ConflictCode.SERVER_MISMATCH,
      severity: 'warning',
      message: `${actualLabel} calls ${unknown.join(', ')}, which ${expectedLabel} does not list as a server`,
      expected: [...expectedOrigins].join(', '),
      actual: unknown.join(', '),
    },
  ];
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Endpoint comparison
// ---------------------------------------------------------------------------

interface EndpointCompareContext {
  readonly expectedLabel: string;
  readonly actualLabel: string;
  readonly maxDepth: number;
  readonly expectedSpec?: ApiSpec;
  readonly actualSpec?: ApiSpec;
}

/** Compare two accounts of one endpoint: parameters, bodies, responses, auth. */
export function compareEndpoints(
  expected: Endpoint,
  actual: Endpoint,
  context: EndpointCompareContext,
): Conflict[] {
  return [
    ...compareParameters(expected, actual, context),
    ...compareRequestBodies(expected, actual, context),
    ...compareResponses(expected, actual, context),
    ...compareAuth(expected, actual, context),
  ];
}

function compareParameters(
  expected: Endpoint,
  actual: Endpoint,
  context: EndpointCompareContext,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const key = (parameter: { in: string; name: string }): string =>
    `${parameter.in}:${parameter.name}`;

  const actualByKey = new Map(actual.parameters.map((parameter) => [key(parameter), parameter]));
  const expectedByKey = new Map(
    expected.parameters.map((parameter) => [key(parameter), parameter]),
  );

  for (const parameter of expected.parameters) {
    const counterpart = actualByKey.get(key(parameter));

    if (!counterpart) {
      // Only a required parameter's absence is an error: an optional one simply
      // was not used in the observed request.
      if (parameter.required) {
        conflicts.push({
          code: ConflictCode.PARAMETER_MISSING,
          severity: 'error',
          message: `${expected.id} requires the ${parameter.in} parameter "${parameter.name}", which ${context.actualLabel} does not send`,
          endpointId: expected.id,
          path: parameter.name,
        });
      }
      continue;
    }

    if (parameter.required && !counterpart.required) {
      conflicts.push({
        code: ConflictCode.PARAMETER_REQUIREDNESS,
        severity: 'warning',
        message: `${expected.id}: ${context.expectedLabel} requires "${parameter.name}" but ${context.actualLabel} treats it as optional`,
        endpointId: expected.id,
        path: parameter.name,
      });
    }

    conflicts.push(
      ...decorate(
        compareParameterSchemas(
          parameter.schema,
          counterpart.schema,
          parameter.name,
          context.maxDepth,
        ),
        expected.id,
      ),
    );
  }

  for (const parameter of actual.parameters) {
    if (expectedByKey.has(key(parameter))) continue;
    // A header the client adds that the spec does not mention is usually
    // harmless; an undocumented query parameter often is not.
    conflicts.push({
      code: ConflictCode.PARAMETER_UNDOCUMENTED,
      severity: parameter.in === 'header' ? 'info' : 'warning',
      message: `${expected.id}: ${context.actualLabel} sends the ${parameter.in} parameter "${parameter.name}", which ${context.expectedLabel} does not document`,
      endpointId: expected.id,
      path: parameter.name,
    });
  }

  return conflicts;
}

/**
 * Compare a declared parameter against one recovered from an observed request.
 *
 * Path, query, header and cookie values are strings on the wire: `?limit=10`
 * carries the two characters `1` and `0`, whatever the specification calls the
 * field. So a string observation cannot contradict a scalar declaration, and
 * reporting it as a type conflict would flag every numeric parameter of every
 * spec compared against a real call.
 *
 * The observed *value* is still checked against a declared enumeration, which
 * is where genuine mismatches in this position actually occur.
 */
function compareParameterSchemas(
  expected: SchemaNode,
  actual: SchemaNode,
  path: string,
  maxDepth: number,
): Conflict[] {
  if (actual.kind === 'string' && SCALAR_KINDS.has(expected.kind)) {
    return expected.kind === 'enum' ? compareObservedValueAgainstEnum(expected, actual, path) : [];
  }

  return compareSchemas(expected, actual, { path, maxDepth });
}

const SCALAR_KINDS: ReadonlySet<SchemaNode['kind']> = new Set<SchemaNode['kind']>([
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
]);

function compareObservedValueAgainstEnum(
  expected: SchemaNode & { kind: 'enum' },
  actual: SchemaNode,
  path: string,
): Conflict[] {
  const observed = actual.example;
  if (typeof observed !== 'string') return [];

  // Enumerated values travel as strings, so the comparison is on the text.
  const documented = expected.values.map((value) => String(value));
  if (documented.includes(observed)) return [];

  return [
    {
      code: ConflictCode.ENUM_MISMATCH,
      severity: 'error',
      message: `${describePath(path)} was sent as ${JSON.stringify(observed)}, which is not among the documented values ${format(expected.values)}`,
      path,
      expected: format(expected.values),
      actual: JSON.stringify(observed),
    },
  ];
}

function compareRequestBodies(
  expected: Endpoint,
  actual: Endpoint,
  context: EndpointCompareContext,
): Conflict[] {
  const expectedBody = expected.requestBody;
  const actualBody = actual.requestBody;

  if (!expectedBody || !actualBody) return [];

  const expectedMedia = preferredBody(expectedBody.content);
  const actualMedia = preferredBody(actualBody.content);
  if (!expectedMedia || !actualMedia) return [];

  const conflicts: Conflict[] = [];

  if (expectedMedia.mediaType !== actualMedia.mediaType) {
    conflicts.push({
      code: ConflictCode.MEDIA_TYPE_MISMATCH,
      severity: 'error',
      message: `${expected.id}: ${context.expectedLabel} expects a ${expectedMedia.mediaType} body but ${context.actualLabel} sends ${actualMedia.mediaType}`,
      endpointId: expected.id,
      expected: expectedMedia.mediaType,
      actual: actualMedia.mediaType,
    });
    // Different media types describe different shapes; comparing their schemas
    // would produce noise rather than findings.
    return conflicts;
  }

  return [
    ...conflicts,
    ...decorate(
      compareSchemas(expectedMedia.schema, actualMedia.schema, {
        path: 'body',
        maxDepth: context.maxDepth,
      }),
      expected.id,
    ),
  ];
}

function compareResponses(
  expected: Endpoint,
  actual: Endpoint,
  context: EndpointCompareContext,
): Conflict[] {
  const conflicts: Conflict[] = [];

  const documented = new Set(expected.responses.map((response) => String(response.status)));
  for (const response of actual.responses) {
    if (!documented.has(String(response.status)) && documented.size > 0) {
      conflicts.push({
        code: ConflictCode.STATUS_UNDOCUMENTED,
        severity: 'warning',
        message: `${expected.id} returned ${response.status} in ${context.actualLabel}, which ${context.expectedLabel} does not document`,
        endpointId: expected.id,
        actual: String(response.status),
      });
    }
  }

  const expectedSuccess = successResponse(expected);
  const actualSuccess = successResponse(actual);
  if (!expectedSuccess || !actualSuccess) return conflicts;

  const expectedMedia = preferredBody(expectedSuccess.content);
  const actualMedia = preferredBody(actualSuccess.content);
  if (!expectedMedia || !actualMedia) return conflicts;

  return [
    ...conflicts,
    ...decorate(
      compareSchemas(expectedMedia.schema, actualMedia.schema, {
        path: 'response',
        maxDepth: context.maxDepth,
      }),
      expected.id,
    ),
  ];
}

function compareAuth(
  expected: Endpoint,
  actual: Endpoint,
  context: EndpointCompareContext,
): Conflict[] {
  const expectedSpec = context.expectedSpec;
  const actualSpec = context.actualSpec;
  if (!expectedSpec || !actualSpec) return [];

  const expectedSchemes = referencedSchemeIds(effectiveSecurity(expectedSpec, expected));
  const actualSchemes = referencedSchemeIds(effectiveSecurity(actualSpec, actual));

  if (expectedSchemes.length === 0 || actualSchemes.length === 0) return [];

  const kindOf = (spec: ApiSpec, ids: readonly string[]): string[] =>
    [
      ...new Set(
        ids.map((id) =>
          credentialFamily(spec.authSchemes.find((scheme) => scheme.id === id)?.kind ?? 'unknown'),
        ),
      ),
    ].sort();

  const expectedKinds = kindOf(expectedSpec, expectedSchemes);
  const actualKinds = kindOf(actualSpec, actualSchemes);

  // Scheme *names* differ freely between documents; the kind of credential is
  // what a caller has to get right.
  if (actualKinds.some((kind) => expectedKinds.includes(kind))) return [];

  return [
    {
      code: ConflictCode.AUTH_MISMATCH,
      severity: 'error',
      message: `${expected.id}: ${context.expectedLabel} expects ${expectedKinds.join(' or ')} authentication but ${context.actualLabel} uses ${actualKinds.join(' or ')}`,
      endpointId: expected.id,
      expected: expectedKinds.join(', '),
      actual: actualKinds.join(', '),
    },
  ];
}

/**
 * Collapse scheme kinds that a caller satisfies the same way.
 *
 * A JWT is a bearer token: a specification declaring `bearer` and a request
 * observed carrying a JWT agree about what the caller must supply, and only the
 * format of the token differs. Reporting that as a mismatch would fire on
 * almost every real comparison, drowning out the cases where the caller really
 * would send the wrong kind of credential.
 */
function credentialFamily(kind: string): string {
  return kind === 'jwt' ? 'bearer' : kind;
}

function decorate(conflicts: readonly Conflict[], endpointId: string): Conflict[] {
  return conflicts.map((conflict) => ({ ...conflict, endpointId }));
}

// ---------------------------------------------------------------------------
// Schema comparison
// ---------------------------------------------------------------------------

export interface SchemaCompareOptions {
  readonly path?: string;
  readonly maxDepth?: number;
}

/**
 * Structural comparison of two schemas.
 *
 * This is the primitive contract validation is built on: given what an API
 * declares and what it actually returns — or what the frontend actually reads —
 * it says exactly which field diverges and how.
 *
 * `unknown` on either side yields no finding. An unspecified shape cannot
 * contradict anything, and reporting it as a mismatch would bury the real
 * conflicts under noise from under-documented specs.
 */
export function compareSchemas(
  expected: SchemaNode,
  actual: SchemaNode,
  options: SchemaCompareOptions = {},
): Conflict[] {
  return diff(expected, actual, options.path ?? '', options.maxDepth ?? DEFAULT_MAX_DEPTH, 0);
}

function diff(
  expected: SchemaNode,
  actual: SchemaNode,
  path: string,
  maxDepth: number,
  depth: number,
): Conflict[] {
  if (depth > maxDepth) return [];

  // Nothing can be concluded about a shape the source never described.
  if (expected.kind === 'unknown' || actual.kind === 'unknown') return [];

  // A reference that was left symbolic (external or recursive) stops the walk;
  // the two sides are compared by name instead of by structure.
  if (expected.kind === 'ref' || actual.kind === 'ref') {
    return expected.kind === 'ref' && actual.kind === 'ref' && expected.name !== actual.name
      ? [
          {
            code: ConflictCode.FIELD_TYPE,
            severity: 'warning',
            message: `${describePath(path)} refers to "${expected.name}" in one account and "${actual.name}" in the other`,
            path,
            expected: expected.name,
            actual: actual.name,
          },
        ]
      : [];
  }

  const conflicts: Conflict[] = [];

  if (expected.nullable !== true && actual.nullable === true) {
    conflicts.push({
      code: ConflictCode.FIELD_NULLABILITY,
      severity: 'error',
      message: `${describePath(path)} can be null in practice but is not documented as nullable`,
      path,
    });
  }

  if (expected.kind === 'union' || actual.kind === 'union') {
    return [...conflicts, ...diffUnion(expected, actual, path, maxDepth, depth)];
  }

  if (expected.kind === 'enum' || actual.kind === 'enum') {
    return [...conflicts, ...diffEnum(expected, actual, path)];
  }

  if (!kindsCompatible(expected.kind, actual.kind)) {
    return [
      ...conflicts,
      {
        code: ConflictCode.FIELD_TYPE,
        severity: 'error',
        message: `${describePath(path)} is documented as ${expected.kind} but is ${actual.kind}`,
        path,
        expected: expected.kind,
        actual: actual.kind,
      },
    ];
  }

  if (expected.kind === 'object' && actual.kind === 'object') {
    return [...conflicts, ...diffObject(expected, actual, path, maxDepth, depth)];
  }

  if (expected.kind === 'array' && actual.kind === 'array') {
    return [
      ...conflicts,
      ...diff(expected.items, actual.items, joinPath(path, '[]'), maxDepth, depth + 1),
    ];
  }

  return conflicts;
}

function diffUnion(
  expected: SchemaNode,
  actual: SchemaNode,
  path: string,
  maxDepth: number,
  depth: number,
): Conflict[] {
  const expectedOptions = expected.kind === 'union' ? expected.options : [expected];
  const actualOptions = actual.kind === 'union' ? actual.options : [actual];

  // Every observed variant must be covered by some documented variant; a
  // documented variant that never appeared is not a conflict.
  const uncovered = actualOptions.filter(
    (option) =>
      !expectedOptions.some(
        (candidate) => diff(candidate, option, path, maxDepth, depth + 1).length === 0,
      ),
  );

  if (uncovered.length === 0) return [];

  return [
    {
      code: ConflictCode.FIELD_TYPE,
      severity: 'error',
      message: `${describePath(path)} can be ${uncovered.map((option) => option.kind).join(' or ')}, which is not among the documented variants`,
      path,
      expected: expectedOptions.map((option) => option.kind).join(' | '),
      actual: actualOptions.map((option) => option.kind).join(' | '),
    },
  ];
}

function diffEnum(expected: SchemaNode, actual: SchemaNode, path: string): Conflict[] {
  if (expected.kind !== 'enum') {
    // Reality is narrower than the documentation, which is not a conflict.
    return [];
  }

  if (actual.kind !== 'enum') {
    return [
      {
        code: ConflictCode.ENUM_MISMATCH,
        severity: 'warning',
        message: `${describePath(path)} is documented as one of ${format(expected.values)} but the other account allows any ${actual.kind}`,
        path,
        expected: format(expected.values),
        actual: actual.kind,
      },
    ];
  }

  const documented = new Set(expected.values.map((value) => JSON.stringify(value)));
  const unexpected = actual.values.filter((value) => !documented.has(JSON.stringify(value)));

  if (unexpected.length === 0) return [];

  // This is the single most common cause of a silently broken integration: a
  // UI comparing against a value the API never returns, or the reverse.
  return [
    {
      code: ConflictCode.ENUM_MISMATCH,
      severity: 'error',
      message: `${describePath(path)} takes the value ${format(unexpected)}, which is not among the documented values ${format(expected.values)}`,
      path,
      expected: format(expected.values),
      actual: format(unexpected),
    },
  ];
}

function diffObject(
  expected: SchemaNode & { kind: 'object' },
  actual: SchemaNode & { kind: 'object' },
  path: string,
  maxDepth: number,
  depth: number,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const actualByName = new Map(actual.properties.map((property) => [property.name, property]));

  for (const property of expected.properties) {
    const counterpart = actualByName.get(property.name);
    const childPath = joinPath(path, property.name);

    if (!counterpart) {
      if (property.required) {
        conflicts.push({
          code: ConflictCode.FIELD_MISSING,
          severity: 'error',
          message: `${describePath(childPath)} is documented as required but is absent`,
          path: childPath,
        });
      }
      continue;
    }

    if (property.required && !counterpart.required) {
      conflicts.push({
        code: ConflictCode.FIELD_REQUIREDNESS,
        severity: 'warning',
        message: `${describePath(childPath)} is documented as required but is not always present`,
        path: childPath,
      });
    }

    conflicts.push(...diff(property.schema, counterpart.schema, childPath, maxDepth, depth + 1));
  }

  const expectedNames = new Set(expected.properties.map((property) => property.name));
  for (const property of actual.properties) {
    if (expectedNames.has(property.name)) continue;
    // An extra field breaks nothing at runtime, but it is exactly what the user
    // needs to see when the documentation is stale.
    conflicts.push({
      code: ConflictCode.FIELD_UNDOCUMENTED,
      severity: 'info',
      message: `${describePath(joinPath(path, property.name))} is present but not documented`,
      path: joinPath(path, property.name),
    });
  }

  return conflicts;
}

/** An integer is a number; a number is not necessarily an integer. */
function kindsCompatible(expected: SchemaNode['kind'], actual: SchemaNode['kind']): boolean {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  // Intersections are structural refinements the comparison does not unfold.
  return expected === 'intersection' || actual === 'intersection';
}

function joinPath(path: string, segment: string): string {
  if (path.length === 0) return segment;
  return segment === '[]' ? `${path}[]` : `${path}.${segment}`;
}

function describePath(path: string): string {
  return path.length > 0 ? `"${path}"` : 'the value';
}

function format(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}
