import { ErrorCode, isErr, unwrap } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import {
  ParseWarningCode,
  isPublic,
  listEnums,
  resolvePath,
  successSchema,
  toTypeScript,
} from '@aica/api-ir';
import type { ApiSpec, Endpoint, ObjectSchema } from '@aica/api-ir';

import { isOpenApiDocument, parseOpenApi } from './openapi.js';

// ---------------------------------------------------------------------------
// A specification exercising the features that actually appear in the wild.
// ---------------------------------------------------------------------------

const petstore = {
  openapi: '3.1.0',
  info: { title: 'Orders API', version: '2.1.0', description: 'Order management' },
  servers: [
    {
      url: 'https://{tenant}.api.example.com/v2',
      description: 'Production',
      variables: { tenant: { default: 'acme', enum: ['acme', 'globex'] } },
    },
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    '/orders': {
      parameters: [
        { name: 'X-Request-Id', in: 'header', schema: { type: 'string', format: 'uuid' } },
      ],
      get: {
        operationId: 'listOrders',
        summary: 'List orders',
        tags: ['orders'],
        parameters: [
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/OrderStatus' } },
          {
            name: 'limit',
            in: 'query',
            required: true,
            schema: { type: 'integer', minimum: 1, maximum: 100 },
          },
          // Overrides the path-level declaration of the same header.
          { name: 'X-Request-Id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'A page of orders',
            headers: { 'X-Total-Count': { schema: { type: 'integer' } } },
            content: {
              'application/json; charset=utf-8': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
              },
            },
          },
          '4XX': { description: 'Client error' },
          default: { description: 'Unexpected' },
        },
      },
      post: {
        operationId: 'createOrder',
        security: [{ apiKey: [] }, { bearerAuth: ['orders:write'] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderInput' } } },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
    '/orders/{orderId}': {
      get: {
        operationId: 'getOrder',
        deprecated: true,
        parameters: [{ name: 'orderId', in: 'path', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'One order',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      oauth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/authorize',
            tokenUrl: 'https://example.com/token',
            scopes: { 'orders:read': 'Read orders', 'orders:write': 'Write orders' },
          },
        },
      },
    },
    schemas: {
      OrderStatus: { type: 'string', enum: ['pending', 'shipped', 'cancelled'] },
      Money: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: { type: 'integer' },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
        },
      },
      Order: {
        type: 'object',
        required: ['id', 'status', 'total'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { $ref: '#/components/schemas/OrderStatus' },
          total: { $ref: '#/components/schemas/Money' },
          // 3.1 spells nullability as a type union with "null".
          note: { type: ['string', 'null'] },
          parent: { $ref: '#/components/schemas/Order' },
        },
      },
      OrderInput: {
        allOf: [
          {
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', items: { type: 'string' } } },
          },
          { type: 'object', properties: { coupon: { type: 'string' } } },
        ],
      },
    },
  },
};

function parse(document: unknown = petstore): ApiSpec {
  return unwrap(parseOpenApi(document, { location: 'orders.yaml' }));
}

function endpointOf(spec: ApiSpec, id: string): Endpoint {
  const endpoint = spec.endpoints.find((candidate) => candidate.id === id);
  if (!endpoint)
    throw new Error(`no endpoint ${id} in ${spec.endpoints.map((e) => e.id).join(', ')}`);
  return endpoint;
}

// ---------------------------------------------------------------------------

describe('detection', () => {
  it('recognizes OpenAPI 3 and Swagger 2', () => {
    expect(isOpenApiDocument({ openapi: '3.0.3' })).toBe(true);
    expect(isOpenApiDocument({ swagger: '2.0' })).toBe(true);
  });

  it.each([{}, { openapi: '2.0' }, { info: {} }, null, 'text', []])('rejects %j', (document) => {
    expect(isOpenApiDocument(document)).toBe(false);
  });

  it('fails with an actionable message rather than an empty spec', () => {
    const result = parseOpenApi({ info: { title: 'x' } });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
    expect(isErr(result) && result.error.message).toMatch(/openapi.*3\.x.*swagger/i);
  });
});

describe('specification metadata', () => {
  it('carries title, version, and a slug identity', () => {
    const spec = parse();
    expect(spec).toMatchObject({ id: 'orders-api', title: 'Orders API', version: '2.1.0' });
  });

  it('records provenance on the spec and on every endpoint', () => {
    const spec = parse();
    expect(spec.source).toEqual({ format: 'openapi3', location: 'orders.yaml' });
    expect(endpointOf(spec, 'GET /orders').source).toEqual({
      format: 'openapi3',
      location: 'orders.yaml',
      pointer: '#/paths/~1orders/get',
    });
  });

  it('keeps server variables', () => {
    expect(parse().servers).toEqual([
      {
        url: 'https://{tenant}.api.example.com/v2',
        description: 'Production',
        variables: [{ name: 'tenant', default: 'acme', enum: ['acme', 'globex'] }],
      },
    ]);
  });

  it('defaults an absent server list to the document root', () => {
    const spec = parse({ ...petstore, servers: undefined });
    expect(spec.servers).toEqual([{ url: '/', variables: [] }]);
  });
});

describe('operations', () => {
  it('finds every operation under every path', () => {
    expect(parse().endpoints.map((endpoint) => endpoint.id)).toEqual([
      'GET /orders',
      'POST /orders',
      'GET /orders/{orderId}',
    ]);
  });

  it('preserves summary, tags, operationId, and deprecation', () => {
    const list = endpointOf(parse(), 'GET /orders');
    expect(list).toMatchObject({
      operationId: 'listOrders',
      summary: 'List orders',
      tags: ['orders'],
    });
    expect(endpointOf(parse(), 'GET /orders/{orderId}').deprecated).toBe(true);
    expect(list.deprecated).toBeUndefined();
  });
});

describe('parameters', () => {
  const list = endpointOf(parse(), 'GET /orders');

  it('merges path-level parameters, letting the operation win', () => {
    const header = list.parameters.filter((parameter) => parameter.name === 'X-Request-Id');
    expect(header).toHaveLength(1);
    // The operation declared it required; the path-level copy did not.
    expect(header[0]).toMatchObject({ in: 'header', required: true });
    expect(header[0]?.schema).toEqual({ kind: 'string' });
  });

  it('keeps declared constraints', () => {
    const limit = list.parameters.find((parameter) => parameter.name === 'limit');
    expect(limit).toMatchObject({ in: 'query', required: true });
    expect(limit?.schema).toEqual({ kind: 'integer', minimum: 1, maximum: 100 });
  });

  it('inlines a referenced parameter schema', () => {
    const status = list.parameters.find((parameter) => parameter.name === 'status');
    expect(status?.schema).toMatchObject({
      kind: 'enum',
      values: ['pending', 'shipped', 'cancelled'],
    });
  });

  it('forces a path parameter to be required even when the source omits it', () => {
    // The document declares orderId without `required: true`, which is invalid
    // but common; a path parameter is required by definition.
    const detail = endpointOf(parse(), 'GET /orders/{orderId}');
    expect(detail.parameters[0]).toMatchObject({ name: 'orderId', in: 'path', required: true });
  });

  it('reports a parameter with no schema instead of inventing one', () => {
    const spec = parse(
      withOperation({
        parameters: [{ name: 'q', in: 'query' }],
        responses: { '200': { description: 'ok' } },
      }),
    );
    const parameter = endpointOf(spec, 'GET /probe').parameters[0];
    expect(parameter?.schema).toMatchObject({ kind: 'unknown' });
    expect(spec.warnings.map((warning) => warning.code)).toContain(ParseWarningCode.MISSING_SCHEMA);
  });

  it('drops a parameter with an unsupported location and says so', () => {
    const spec = parse(
      withOperation({
        parameters: [{ name: 'x', in: 'body', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      }),
    );
    expect(endpointOf(spec, 'GET /probe').parameters).toEqual([]);
  });
});

describe('schemas', () => {
  const spec = parse();

  it('inlines references so consumers see one complete shape', () => {
    const order = successSchema(endpointOf(spec, 'GET /orders/{orderId}'));
    expect(resolvePath(order as never, 'total.currency')).toMatchObject({
      kind: 'string',
      minLength: 3,
    });
  });

  it('preserves enumerations exactly', () => {
    const order = successSchema(endpointOf(spec, 'GET /orders/{orderId}'));
    expect(listEnums(order as never)).toEqual([
      { path: 'status', values: ['pending', 'shipped', 'cancelled'] },
    ]);
  });

  it('reads 3.1 nullability from a type array', () => {
    const order = successSchema(endpointOf(spec, 'GET /orders/{orderId}')) as ObjectSchema;
    const note = order.properties.find((property) => property.name === 'note');
    expect(note?.schema).toMatchObject({ kind: 'string', nullable: true });
    expect(note?.required).toBe(false);
  });

  it('breaks a recursive reference into a named node rather than recursing forever', () => {
    const order = successSchema(endpointOf(spec, 'GET /orders/{orderId}')) as ObjectSchema;
    const parent = order.properties.find((property) => property.name === 'parent');
    expect(parent?.schema).toMatchObject({ kind: 'ref', name: 'Order', circular: true });
    expect(spec.warnings.map((warning) => warning.code)).toContain(ParseWarningCode.CIRCULAR_REF);
  });

  it('renders the inlined shape as TypeScript', () => {
    const rendered = toTypeScript(
      successSchema(endpointOf(spec, 'GET /orders/{orderId}')) as never,
    );
    expect(rendered).toContain('id: string;');
    expect(rendered).toContain("status: 'pending' | 'shipped' | 'cancelled';");
    expect(rendered).toContain('note?: string | null;');
    expect(rendered).toContain('parent?: Order;');
  });

  it('turns allOf into an intersection and flattens a single-element one', () => {
    const body = endpointOf(spec, 'POST /orders').requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content[0]?.schema).toMatchObject({ kind: 'intersection' });

    const collapsed = parse(
      withSchema({ allOf: [{ type: 'string' }], description: 'a wrapped string' }),
    );
    expect(collapsed.components.Probe).toEqual({ kind: 'string', description: 'a wrapped string' });
  });

  it('turns oneOf into a union and keeps the discriminator', () => {
    const spec2 = parse(
      withSchema({
        oneOf: [{ type: 'string' }, { type: 'integer' }],
        discriminator: { propertyName: 'kind' },
      }),
    );
    expect(spec2.components.Probe).toMatchObject({
      kind: 'union',
      discriminator: 'kind',
      options: [{ kind: 'string' }, { kind: 'integer' }],
    });
  });

  it('treats const as a one-value enumeration', () => {
    expect(parse(withSchema({ const: 'fixed' })).components.Probe).toMatchObject({
      kind: 'enum',
      values: ['fixed'],
    });
  });

  it('normalizes media types', () => {
    const response = endpointOf(spec, 'GET /orders').responses[0];
    expect(response?.content[0]?.mediaType).toBe('application/json');
  });

  it('records an array with no item type as a gap', () => {
    const parsed = parse(withSchema({ type: 'array' }));
    expect(parsed.components.Probe).toMatchObject({ kind: 'array', items: { kind: 'unknown' } });
    expect(parsed.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.MISSING_SCHEMA,
    );
  });

  it('reports an unresolvable reference instead of dropping the field', () => {
    const parsed = parse(withSchema({ $ref: '#/components/schemas/Missing' }));
    expect(parsed.components.Probe).toMatchObject({ kind: 'ref', name: 'Missing' });
    expect(parsed.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.UNRESOLVED_REF,
    );
  });

  it('does not fetch an external reference', () => {
    const parsed = parse(withSchema({ $ref: 'https://example.com/schema.json#/Thing' }));
    expect(parsed.components.Probe).toMatchObject({ kind: 'ref', name: 'Thing' });
    expect(
      parsed.warnings.find((warning) => warning.code === ParseWarningCode.UNRESOLVED_REF)?.message,
    ).toMatch(/not fetched/);
  });

  it('records a required property that is never declared', () => {
    const parsed = parse(withSchema({ type: 'object', required: ['ghost'], properties: {} }));
    expect(parsed.warnings.some((warning) => warning.message.includes('"ghost" is required'))).toBe(
      true,
    );
  });
});

describe('responses', () => {
  const list = endpointOf(parse(), 'GET /orders');

  it('keeps concrete codes, ranges, and the catch-all', () => {
    expect(list.responses.map((response) => response.status)).toEqual([200, '4XX', 'default']);
  });

  it('keeps response headers', () => {
    expect(list.responses[0]?.headers).toEqual([
      { name: 'X-Total-Count', schema: { kind: 'integer' } },
    ]);
  });

  it('rejects a response key that is not a status', () => {
    const spec = parse(
      withOperation({ responses: { ok: { description: 'ok' }, '200': { description: 'ok' } } }),
    );
    expect(spec.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.MALFORMED_ENTRY,
    );
    expect(endpointOf(spec, 'GET /probe').responses.map((response) => response.status)).toEqual([
      200,
    ]);
  });

  it('reports an operation that documents no response at all', () => {
    const spec = parse(withOperation({ summary: 'no responses' }));
    expect(spec.warnings.map((warning) => warning.code)).toContain(ParseWarningCode.MISSING_SCHEMA);
  });
});

describe('security', () => {
  const spec = parse();

  it('separates an absent security list from an explicitly empty one', () => {
    // OpenAPI gives the empty list meaning: it is an override saying "this one
    // needs nothing", not a silence. Collapsing the two made an endpoint the
    // author had marked public inherit the global bearer requirement — a lock
    // in the catalog, and a token attached to a request that must not carry
    // one.
    const parsed = unwrap(
      parseOpenApi({
        openapi: '3.0.3',
        info: { title: 'Mixed', version: '1' },
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
        security: [{ bearerAuth: [] }],
        paths: {
          '/inherits': { get: { responses: { '200': { description: 'ok' } } } },
          '/public': { get: { security: [], responses: { '200': { description: 'ok' } } } },
        },
      }),
    );

    const byPath = new Map(parsed.endpoints.map((endpoint) => [endpoint.path, endpoint]));

    expect(byPath.get('/inherits')?.security).toEqual([]);
    expect(byPath.get('/public')?.security).toEqual([[]]);
    expect(isPublic(byPath.get('/public')?.security ?? [])).toBe(true);
  });

  it('maps every scheme kind', () => {
    expect(spec.authSchemes).toEqual([
      { id: 'bearerAuth', kind: 'jwt', bearerFormat: 'JWT' },
      { id: 'apiKey', kind: 'apiKey', in: 'header', name: 'X-Api-Key' },
      {
        id: 'oauth',
        kind: 'oauth2',
        flow: 'authorizationCode',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        scopes: [
          { name: 'orders:read', description: 'Read orders' },
          { name: 'orders:write', description: 'Write orders' },
        ],
      },
    ]);
  });

  it('never stores a credential, only a scheme', () => {
    for (const scheme of spec.authSchemes) {
      expect(scheme).not.toHaveProperty('secretRef');
    }
  });

  it('keeps alternatives separate from conjunctions', () => {
    // `[{apiKey: []}, {bearerAuth: [...]}]` is "either", not "both".
    expect(endpointOf(spec, 'POST /orders').security).toEqual([
      [{ schemeId: 'apiKey', scopes: [] }],
      [{ schemeId: 'bearerAuth', scopes: ['orders:write'] }],
    ]);
  });

  it('represents a conjunction as one option with two requirements', () => {
    const parsed = parse(
      withOperation({
        security: [{ apiKey: [], bearerAuth: [] }],
        responses: { '200': { description: 'ok' } },
      }),
    );
    expect(endpointOf(parsed, 'GET /probe').security).toEqual([
      [
        { schemeId: 'apiKey', scopes: [] },
        { schemeId: 'bearerAuth', scopes: [] },
      ],
    ]);
  });

  it('inherits the specification default when an operation declares none', () => {
    expect(spec.security).toEqual([[{ schemeId: 'bearerAuth', scopes: [] }]]);
    expect(endpointOf(spec, 'GET /orders').security).toEqual([]);
  });

  it('records an unrecognized scheme type as unknown rather than guessing', () => {
    const parsed = parse(withSecurityScheme({ type: 'magic' }));
    expect(parsed.authSchemes[0]).toMatchObject({ id: 'probe', kind: 'unknown' });
    expect(parsed.warnings.map((warning) => warning.code)).toContain(ParseWarningCode.UNKNOWN_AUTH);
  });

  it('notes that OpenID Connect endpoints are not discovered during parsing', () => {
    const parsed = parse(
      withSecurityScheme({
        type: 'openIdConnect',
        openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      }),
    );
    expect(parsed.authSchemes[0]).toMatchObject({ kind: 'oauth2', pkce: true });
    expect(
      parsed.warnings.some((warning) => warning.message.includes('not fetched during parsing')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Swagger 2.0
// ---------------------------------------------------------------------------

const swagger = {
  swagger: '2.0',
  info: { title: 'Legacy API', version: '1.0' },
  host: 'api.legacy.test',
  basePath: '/v1',
  schemes: ['https'],
  consumes: ['application/json'],
  produces: ['application/json'],
  securityDefinitions: {
    basicAuth: { type: 'basic' },
    apiKey: { type: 'apiKey', in: 'query', name: 'api_key' },
    oauth: {
      type: 'oauth2',
      flow: 'accessCode',
      authorizationUrl: 'https://legacy.test/authorize',
      tokenUrl: 'https://legacy.test/token',
      scopes: { read: 'Read' },
    },
  },
  paths: {
    '/widgets': {
      get: {
        operationId: 'listWidgets',
        parameters: [
          {
            name: 'tags',
            in: 'query',
            type: 'array',
            items: { type: 'string' },
            collectionFormat: 'pipes',
          },
          { name: 'x-nullable-header', in: 'header', type: 'string', 'x-nullable': true },
        ],
        responses: {
          '200': {
            description: 'ok',
            schema: { type: 'array', items: { $ref: '#/definitions/Widget' } },
          },
        },
      },
      post: {
        operationId: 'createWidget',
        parameters: [
          { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Widget' } },
        ],
        responses: { '201': { description: 'created' } },
      },
    },
    '/widgets/{id}/image': {
      post: {
        operationId: 'uploadImage',
        consumes: ['multipart/form-data'],
        parameters: [
          { name: 'id', in: 'path', required: true, type: 'string' },
          { name: 'file', in: 'formData', required: true, type: 'file' },
          { name: 'caption', in: 'formData', type: 'string' },
        ],
        responses: { '204': { description: 'no content' } },
      },
    },
  },
  definitions: {
    Widget: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, size: { type: 'integer', format: 'int32' } },
    },
  },
};

describe('Swagger 2.0', () => {
  const spec = unwrap(parseOpenApi(swagger));

  it('is recorded as swagger2, not as OpenAPI 3', () => {
    expect(spec.source.format).toBe('swagger2');
  });

  it('builds servers from scheme, host, and basePath', () => {
    expect(spec.servers).toEqual([{ url: 'https://api.legacy.test/v1', variables: [] }]);
  });

  it('falls back to the base path when the host is unknown', () => {
    const hostless = unwrap(parseOpenApi({ ...swagger, host: undefined }));
    expect(hostless.servers).toEqual([{ url: '/v1', variables: [] }]);
  });

  it('reads type keywords inlined on the parameter', () => {
    const tags = endpointOf(spec, 'GET /widgets').parameters.find((p) => p.name === 'tags');
    expect(tags).toMatchObject({ in: 'query', required: false, style: 'pipeDelimited' });
    expect(tags?.schema).toMatchObject({ kind: 'array', items: { kind: 'string' } });
  });

  it('honours the x-nullable extension', () => {
    const header = endpointOf(spec, 'GET /widgets').parameters.find(
      (p) => p.name === 'x-nullable-header',
    );
    expect(header?.schema).toMatchObject({ kind: 'string', nullable: true });
  });

  it('lifts a body parameter into a request body using consumes', () => {
    const body = endpointOf(spec, 'POST /widgets').requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content[0]?.mediaType).toBe('application/json');
    expect(body?.content[0]?.schema).toMatchObject({ kind: 'object' });
    // The lifted parameter must not also appear as a parameter.
    expect(endpointOf(spec, 'POST /widgets').parameters).toEqual([]);
  });

  it('collects formData parameters into one object body', () => {
    const upload = endpointOf(spec, 'POST /widgets/{id}/image');
    expect(upload.requestBody?.content[0]?.mediaType).toBe('multipart/form-data');
    expect(upload.requestBody?.content[0]?.schema).toMatchObject({
      kind: 'object',
      properties: [
        { name: 'file', required: true },
        { name: 'caption', required: false },
      ],
    });
    // The path parameter survives; the form fields do not linger as parameters.
    expect(upload.parameters.map((parameter) => parameter.name)).toEqual(['id']);
  });

  it('uses produces for the response media type', () => {
    expect(endpointOf(spec, 'GET /widgets').responses[0]?.content[0]?.mediaType).toBe(
      'application/json',
    );
  });

  it('maps Swagger flow names onto the OAuth2 flows', () => {
    expect(spec.authSchemes).toEqual([
      { id: 'basicAuth', kind: 'basic' },
      { id: 'apiKey', kind: 'apiKey', in: 'query', name: 'api_key' },
      {
        id: 'oauth',
        kind: 'oauth2',
        flow: 'authorizationCode',
        authorizationUrl: 'https://legacy.test/authorize',
        tokenUrl: 'https://legacy.test/token',
        scopes: [{ name: 'read', description: 'Read' }],
      },
    ]);
  });

  it('resolves definitions references', () => {
    expect(spec.components.Widget).toMatchObject({ kind: 'object' });
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('malformed documents', () => {
  it('parses what it can and reports the rest', () => {
    const spec = unwrap(
      parseOpenApi({
        openapi: '3.0.0',
        info: {},
        paths: {
          '/good': { get: { responses: { '200': { description: 'ok' } } } },
          '/bad': 'not an object',
          'x-vendor': { get: {} },
        },
      }),
    );

    expect(spec.title).toBe('Untitled API');
    expect(spec.endpoints.map((endpoint) => endpoint.id)).toEqual(['GET /good']);
    expect(spec.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.MALFORMED_ENTRY,
    );
  });

  it('reports a document with no paths without throwing', () => {
    const spec = unwrap(parseOpenApi({ openapi: '3.0.0', info: { title: 'Empty' } }));
    expect(spec.endpoints).toEqual([]);
    expect(spec.warnings[0]?.message).toMatch(/no paths/);
  });

  it('appends invariant violations found after parsing', () => {
    const spec = unwrap(
      parseOpenApi({
        openapi: '3.0.0',
        info: { title: 'Inconsistent' },
        paths: { '/items/{id}': { get: { responses: { '200': { description: 'ok' } } } } },
      }),
    );
    expect(spec.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.UNDECLARED_PATH_PARAMETER,
    );
  });

  it('is deterministic: parsing twice yields the same IR', () => {
    expect(parse()).toEqual(parse());
  });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function withOperation(operation: Record<string, unknown>): unknown {
  return {
    openapi: '3.0.3',
    info: { title: 'Probe' },
    paths: { '/probe': { get: operation } },
  };
}

function withSchema(schema: Record<string, unknown>): unknown {
  return {
    openapi: '3.0.3',
    info: { title: 'Probe' },
    paths: {},
    components: { schemas: { Probe: schema } },
  };
}

function withSecurityScheme(scheme: Record<string, unknown>): unknown {
  return {
    openapi: '3.0.3',
    info: { title: 'Probe' },
    paths: {},
    components: { securitySchemes: { probe: scheme } },
  };
}
