import { describe, expect, it } from 'vitest';

import {
  describeAuth,
  isConfigured,
  isPublic,
  referencedSchemeIds,
  requiredSecretRefs,
  satisfiableOption,
} from './auth.js';
import type { AuthScheme, SecurityOption } from './auth.js';
import {
  checkSpecInvariants,
  effectiveSecurity,
  endpointId,
  endpointSignature,
  errorResponses,
  fillPath,
  matchPath,
  normalizePath,
  pathParameterNames,
  pathSignature,
  slugify,
  statusClass,
  successResponse,
  toResponseStatus,
} from './endpoint.js';
import type { ApiSpec, Endpoint } from './endpoint.js';
import { ParseWarningCode } from './endpoint.js';
import {
  describeSchema,
  listEnums,
  listPaths,
  resolvePath,
  toTypeScript,
  unknownSchema,
} from './schema.js';
import type { SchemaNode } from './schema.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  it.each([
    ['/users/{id}', '/users/{id}'],
    ['/users/:id', '/users/{id}'],
    ['/users/<id>', '/users/{id}'],
    ['/users/[id]', '/users/{id}'],
    ['users/:id', '/users/{id}'],
    ['/users/', '/users'],
    ['/users//{id}', '/users/{id}'],
    ['/users/{id}?expand=true', '/users/{id}'],
    ['/users/{id}#section', '/users/{id}'],
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it('leaves the root path alone', () => {
    expect(normalizePath('/')).toBe('/');
  });
});

describe('path identity', () => {
  it('treats differently-named parameters as the same endpoint shape', () => {
    expect(pathSignature('/users/{id}/orders/{orderId}')).toBe(
      pathSignature('/users/{userId}/orders/{oid}'),
    );
  });

  it('does not confuse different shapes', () => {
    expect(pathSignature('/users/{id}')).not.toBe(pathSignature('/users/{id}/orders'));
  });

  it('builds a stable id from method and path', () => {
    expect(endpointId('GET', '/users/:id')).toBe('GET /users/{id}');
    expect(endpointSignature({ method: 'GET', path: '/users/{userId}' })).toBe('GET /users/{}');
  });

  it('lists parameter names in order', () => {
    expect(pathParameterNames('/users/{userId}/orders/{orderId}')).toEqual(['userId', 'orderId']);
  });
});

describe('matchPath', () => {
  it('captures parameters from a concrete path', () => {
    expect(matchPath('/users/{id}', '/users/42')).toEqual({ id: '42' });
  });

  it('distinguishes no-match from match-with-no-parameters', () => {
    expect(matchPath('/users', '/users')).toEqual({});
    expect(matchPath('/users', '/orders')).toBeUndefined();
  });

  it('rejects a path with a different number of segments', () => {
    expect(matchPath('/users/{id}', '/users/42/orders')).toBeUndefined();
    expect(matchPath('/users/{id}/orders', '/users/42')).toBeUndefined();
  });

  it('matches a parameter embedded in a segment', () => {
    expect(matchPath('/files/{name}.json', '/files/report.json')).toEqual({ name: 'report' });
    expect(matchPath('/files/{name}.json', '/files/report.csv')).toBeUndefined();
  });

  it('decodes percent-encoded values', () => {
    expect(matchPath('/users/{email}', '/users/a%40b.com')).toEqual({ email: 'a@b.com' });
  });

  it('keeps a malformed escape verbatim rather than failing', () => {
    expect(matchPath('/users/{id}', '/users/100%')).toEqual({ id: '100%' });
  });

  it('does not match an empty segment against a parameter', () => {
    expect(matchPath('/users/{id}', '/users/')).toBeUndefined();
  });

  it('round-trips through fillPath', () => {
    const filled = fillPath('/users/{id}/orders/{orderId}', { id: '42', orderId: 'a b' });
    expect(filled).toBe('/users/42/orders/a%20b');
    expect(matchPath('/users/{id}/orders/{orderId}', filled)).toEqual({ id: '42', orderId: 'a b' });
  });
});

// ---------------------------------------------------------------------------
// Response status
// ---------------------------------------------------------------------------

describe('response status', () => {
  it.each([
    ['200', 200],
    ['404', 404],
    ['default', 'default'],
    ['2XX', '2XX'],
    ['5xx', '5XX'],
  ])('parses %s', (key, expected) => {
    expect(toResponseStatus(key)).toBe(expected);
  });

  it.each(['', 'ok', '99', '600', 'x'])('rejects %s', (key) => {
    expect(toResponseStatus(key)).toBeUndefined();
  });

  it('groups codes and ranges the same way', () => {
    expect(statusClass(201)).toBe(2);
    expect(statusClass('2XX')).toBe(2);
    expect(statusClass('default')).toBeUndefined();
  });
});

describe('response selection', () => {
  const endpoint = makeEndpoint({
    responses: [
      { status: 500, content: [], headers: [] },
      { status: 201, content: [], headers: [] },
      { status: 200, content: [], headers: [] },
      { status: 404, content: [], headers: [] },
    ],
  });

  it('picks the lowest documented success', () => {
    expect(successResponse(endpoint)?.status).toBe(200);
  });

  it('falls back to a range, then to default', () => {
    const ranged = makeEndpoint({ responses: [{ status: '2XX', content: [], headers: [] }] });
    expect(successResponse(ranged)?.status).toBe('2XX');

    const fallback = makeEndpoint({ responses: [{ status: 'default', content: [], headers: [] }] });
    expect(successResponse(fallback)?.status).toBe('default');

    expect(successResponse(makeEndpoint({ responses: [] }))).toBeUndefined();
  });

  it('collects failures including ranges', () => {
    expect(errorResponses(endpoint).map((response) => response.status)).toEqual([500, 404]);
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const order: SchemaNode = {
  kind: 'object',
  properties: [
    { name: 'id', required: true, schema: { kind: 'string', format: 'uuid' } },
    {
      name: 'status',
      required: true,
      schema: { kind: 'enum', values: ['pending', 'shipped'], base: 'string' },
    },
    {
      name: 'items',
      required: true,
      schema: {
        kind: 'array',
        items: {
          kind: 'object',
          properties: [
            { name: 'sku', required: true, schema: { kind: 'string' } },
            { name: 'quantity', required: false, schema: { kind: 'integer' } },
          ],
        },
      },
    },
    { name: 'note', required: false, schema: { kind: 'string', nullable: true } },
  ],
};

describe('resolvePath', () => {
  it('walks object properties', () => {
    expect(resolvePath(order, 'id')?.kind).toBe('string');
  });

  it('steps through arrays implicitly', () => {
    expect(resolvePath(order, 'items.sku')?.kind).toBe('string');
  });

  it('returns undefined for a path the schema does not have', () => {
    expect(resolvePath(order, 'items.price')).toBeUndefined();
    expect(resolvePath(order, 'id.nested')).toBeUndefined();
  });

  it('resolves through a union only when every variant carries the path', () => {
    const union: SchemaNode = {
      kind: 'union',
      options: [
        {
          kind: 'object',
          properties: [{ name: 'id', required: true, schema: { kind: 'string' } }],
        },
        {
          kind: 'object',
          properties: [{ name: 'id', required: true, schema: { kind: 'string' } }],
        },
      ],
    };
    expect(resolvePath(union, 'id')?.kind).toBe('string');

    const partial: SchemaNode = {
      kind: 'union',
      options: [
        {
          kind: 'object',
          properties: [{ name: 'id', required: true, schema: { kind: 'string' } }],
        },
        {
          kind: 'object',
          properties: [{ name: 'other', required: true, schema: { kind: 'string' } }],
        },
      ],
    };
    expect(resolvePath(partial, 'id')).toBeUndefined();
  });

  it('returns the schema itself for an empty path', () => {
    expect(resolvePath(order, '')).toBe(order);
  });
});

describe('listPaths and listEnums', () => {
  it('enumerates every leaf path, flattening arrays', () => {
    expect(listPaths(order)).toEqual([
      'id',
      'status',
      'items',
      'items.sku',
      'items.quantity',
      'note',
    ]);
  });

  it('finds enumerations with their location', () => {
    expect(listEnums(order)).toEqual([{ path: 'status', values: ['pending', 'shipped'] }]);
  });
});

describe('toTypeScript', () => {
  it('renders an object with optionality and nullability', () => {
    const rendered = toTypeScript(order);
    expect(rendered).toContain('id: string;');
    expect(rendered).toContain("status: 'pending' | 'shipped';");
    expect(rendered).toContain('quantity?: number;');
    expect(rendered).toContain('note?: string | null;');
    expect(rendered).toContain('items: Array<{');
  });

  it('renders an unspecified shape as unknown, never any', () => {
    expect(toTypeScript(unknownSchema('the spec says nothing'))).toBe('unknown');
  });

  it('distinguishes a closed empty object from an open one', () => {
    expect(toTypeScript({ kind: 'object', properties: [], additionalProperties: false })).toBe(
      'Record<string, never>',
    );
    expect(toTypeScript({ kind: 'object', properties: [] })).toBe('Record<string, unknown>');
    expect(
      toTypeScript({ kind: 'object', properties: [], additionalProperties: { kind: 'string' } }),
    ).toBe('Record<string, string>');
  });

  it('quotes keys that are not identifiers', () => {
    const rendered = toTypeScript({
      kind: 'object',
      properties: [{ name: 'content-type', required: true, schema: { kind: 'string' } }],
    });
    expect(rendered).toContain("'content-type': string;");
  });

  it('terminates on a recursive type', () => {
    const recursive: SchemaNode = {
      kind: 'object',
      properties: [
        {
          name: 'next',
          required: false,
          schema: { kind: 'ref', ref: '#/x', name: 'Node', circular: true },
        },
      ],
    };
    expect(toTypeScript(recursive)).toContain('next?: Node;');
  });
});

describe('describeSchema', () => {
  it('says when a shape is unspecified and why', () => {
    expect(describeSchema(unknownSchema('no schema declared'))).toBe(
      'unspecified (no schema declared)',
    );
    expect(describeSchema(unknownSchema())).toBe('unspecified');
  });

  it('describes composites', () => {
    expect(describeSchema(order)).toBe('object with 4 field(s)');
    expect(describeSchema({ kind: 'array', items: { kind: 'string' } })).toBe('array of string');
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth schemes', () => {
  it('reports which references a scheme still needs', () => {
    const oauth: AuthScheme = {
      id: 'oauth',
      kind: 'oauth2',
      flow: 'clientCredentials',
      scopes: [],
      clientIdRef: 'env:CLIENT_ID',
      clientSecretRef: 'env:CLIENT_SECRET',
    };
    expect(requiredSecretRefs(oauth)).toEqual(['env:CLIENT_ID', 'env:CLIENT_SECRET']);
    expect(isConfigured(oauth)).toBe(true);
  });

  it('treats an unconfigured scheme as unusable rather than failing later', () => {
    expect(isConfigured({ id: 'k', kind: 'apiKey', in: 'header', name: 'X-Api-Key' })).toBe(false);
    expect(
      isConfigured({
        id: 'k',
        kind: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
        secretRef: 'env:K',
      }),
    ).toBe(true);
    expect(isConfigured({ id: 'u', kind: 'unknown' })).toBe(false);
    expect(isConfigured({ id: 'n', kind: 'none' })).toBe(true);
  });

  it('describes a scheme without revealing anything secret', () => {
    expect(
      describeAuth({
        id: 'k',
        kind: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
        secretRef: 'env:K',
      }),
    ).toBe('API key in header "X-Api-Key"');
    expect(describeAuth({ id: 'u', kind: 'unknown' })).toMatch(/could not be determined/);
  });
});

describe('security options', () => {
  const apiKey: AuthScheme = {
    id: 'apiKey',
    kind: 'apiKey',
    in: 'header',
    name: 'X-Api-Key',
    secretRef: 'env:K',
  };
  const signature: AuthScheme = { id: 'sig', kind: 'hmac', headerName: 'X-Signature' };
  const bearer: AuthScheme = { id: 'bearer', kind: 'bearer', secretRef: 'env:TOKEN' };

  it('keeps "and" separate from "or"', () => {
    const bothRequired: SecurityOption[] = [
      [
        { schemeId: 'apiKey', scopes: [] },
        { schemeId: 'sig', scopes: [] },
      ],
    ];

    // The signature scheme has no reference, so the conjunction is unusable
    // even though the API key alone is configured.
    expect(satisfiableOption(bothRequired, [apiKey, signature])).toBeUndefined();

    const eitherWorks: SecurityOption[] = [
      [{ schemeId: 'sig', scopes: [] }],
      [{ schemeId: 'apiKey', scopes: [] }],
    ];
    expect(satisfiableOption(eitherWorks, [apiKey, signature])).toEqual([
      { schemeId: 'apiKey', scopes: [] },
    ]);
  });

  it('recognizes a public endpoint', () => {
    expect(isPublic([])).toBe(true);
    expect(isPublic([[], [{ schemeId: 'bearer', scopes: [] }]])).toBe(true);
    expect(isPublic([[{ schemeId: 'bearer', scopes: [] }]])).toBe(false);
  });

  it('collects every scheme mentioned across options', () => {
    expect(
      referencedSchemeIds([
        [
          { schemeId: 'apiKey', scopes: [] },
          { schemeId: 'sig', scopes: [] },
        ],
        [{ schemeId: 'apiKey', scopes: [] }],
      ]),
    ).toEqual(['apiKey', 'sig']);
  });

  it('falls back to the specification default only when the endpoint declares none', () => {
    const spec = makeSpec({
      security: [[{ schemeId: 'bearer', scopes: [] }]],
      authSchemes: [bearer],
    });
    const inherits = makeEndpoint({ security: [] });
    const overrides = makeEndpoint({ security: [[]] });

    expect(effectiveSecurity(spec, inherits)).toEqual([[{ schemeId: 'bearer', scopes: [] }]]);
    // An explicitly empty option is the endpoint opting out, not an absence.
    expect(effectiveSecurity(spec, overrides)).toEqual([[]]);
    expect(isPublic(effectiveSecurity(spec, overrides))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('checkSpecInvariants', () => {
  it('accepts a coherent specification', () => {
    const spec = makeSpec({
      endpoints: [
        makeEndpoint({
          id: 'GET /users/{id}',
          path: '/users/{id}',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { kind: 'string' } }],
          responses: [{ status: 200, content: [], headers: [] }],
        }),
      ],
    });
    expect(checkSpecInvariants(spec)).toEqual([]);
  });

  it('flags a path parameter that is used but never declared', () => {
    const spec = makeSpec({
      endpoints: [
        makeEndpoint({
          id: 'GET /users/{id}',
          path: '/users/{id}',
          responses: [{ status: 200, content: [], headers: [] }],
        }),
      ],
    });
    expect(checkSpecInvariants(spec).map((w) => w.code)).toContain(
      ParseWarningCode.UNDECLARED_PATH_PARAMETER,
    );
  });

  it('flags a declared path parameter that the path does not use', () => {
    const spec = makeSpec({
      endpoints: [
        makeEndpoint({
          parameters: [{ name: 'id', in: 'path', required: true, schema: { kind: 'string' } }],
          responses: [{ status: 200, content: [], headers: [] }],
        }),
      ],
    });
    expect(checkSpecInvariants(spec).map((w) => w.code)).toContain(
      ParseWarningCode.UNUSED_PATH_PARAMETER,
    );
  });

  it('flags duplicates, unknown schemes, bodies on bodyless methods, and missing responses', () => {
    const spec = makeSpec({
      security: [[{ schemeId: 'ghost', scopes: [] }]],
      endpoints: [
        makeEndpoint({ security: [[{ schemeId: 'absent', scopes: [] }]] }),
        makeEndpoint({
          requestBody: {
            required: true,
            content: [{ mediaType: 'application/json', schema: { kind: 'string' } }],
          },
        }),
      ],
    });

    const codes = checkSpecInvariants(spec).map((w) => w.code);
    expect(codes).toContain(ParseWarningCode.DUPLICATE_ENDPOINT);
    expect(codes).toContain(ParseWarningCode.UNKNOWN_SECURITY_SCHEME);
    expect(codes).toContain(ParseWarningCode.UNSUPPORTED_FEATURE);
    expect(codes).toContain(ParseWarningCode.MISSING_SCHEMA);
  });

  it('does not flag an explicitly public endpoint as referencing an unknown scheme', () => {
    const spec = makeSpec({
      endpoints: [
        makeEndpoint({ security: [[]], responses: [{ status: 200, content: [], headers: [] }] }),
      ],
    });
    expect(checkSpecInvariants(spec)).toEqual([]);
  });
});

describe('slugify', () => {
  it.each([
    ['Payments API', 'payments-api'],
    ['  Orders  ', 'orders'],
    ['v2 / Billing', 'v2-billing'],
    ['!!!', 'api'],
  ])('turns %s into %s', (title, expected) => {
    expect(slugify(title)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEndpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'GET /users',
    method: 'GET',
    path: '/users',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    servers: [],
    source: { format: 'openapi3' },
    ...overrides,
  };
}

function makeSpec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    id: 'test',
    title: 'Test',
    servers: [],
    endpoints: [],
    authSchemes: [],
    security: [],
    components: {},
    source: { format: 'openapi3' },
    warnings: [],
    ...overrides,
  };
}
