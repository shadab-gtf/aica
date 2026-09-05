import type { ApiSpec, SchemaNode } from '@aica/api-ir';
import { unwrap } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import { ConflictCode, compareSchemas, compareSpecs } from './conflicts.js';
import type { Conflict } from './conflicts.js';
import { parseCurl } from './curl.js';
import { parseOpenApi } from './openapi.js';
import { parsePostman } from './postman.js';

function codes(conflicts: readonly Conflict[]): string[] {
  return conflicts.map((conflict) => conflict.code);
}

function errors(conflicts: readonly Conflict[]): Conflict[] {
  return conflicts.filter((conflict) => conflict.severity === 'error');
}

// ---------------------------------------------------------------------------
// Schema comparison
// ---------------------------------------------------------------------------

describe('compareSchemas', () => {
  it('finds nothing between identical schemas', () => {
    const schema: SchemaNode = {
      kind: 'object',
      properties: [{ name: 'id', required: true, schema: { kind: 'string' } }],
    };
    expect(compareSchemas(schema, schema)).toEqual([]);
  });

  it('reports a documented field that is absent in practice', () => {
    const conflicts = compareSchemas(
      { kind: 'object', properties: [{ name: 'id', required: true, schema: { kind: 'string' } }] },
      { kind: 'object', properties: [] },
    );
    expect(codes(conflicts)).toEqual([ConflictCode.FIELD_MISSING]);
    expect(conflicts[0]?.severity).toBe('error');
    expect(conflicts[0]?.path).toBe('id');
  });

  it('does not complain when an optional documented field is absent', () => {
    expect(
      compareSchemas(
        {
          kind: 'object',
          properties: [{ name: 'note', required: false, schema: { kind: 'string' } }],
        },
        { kind: 'object', properties: [] },
      ),
    ).toEqual([]);
  });

  it('reports an undocumented field as information, not as a failure', () => {
    const conflicts = compareSchemas(
      { kind: 'object', properties: [] },
      {
        kind: 'object',
        properties: [{ name: 'extra', required: true, schema: { kind: 'string' } }],
      },
    );
    expect(conflicts[0]).toMatchObject({ code: ConflictCode.FIELD_UNDOCUMENTED, severity: 'info' });
  });

  it('reports a type mismatch with both sides named', () => {
    const conflicts = compareSchemas({ kind: 'string' }, { kind: 'integer' });
    expect(conflicts[0]).toMatchObject({
      code: ConflictCode.FIELD_TYPE,
      severity: 'error',
      expected: 'string',
      actual: 'integer',
    });
  });

  it('accepts an integer where a number is documented, but not the reverse', () => {
    expect(compareSchemas({ kind: 'number' }, { kind: 'integer' })).toEqual([]);
    expect(codes(compareSchemas({ kind: 'integer' }, { kind: 'number' }))).toEqual([
      ConflictCode.FIELD_TYPE,
    ]);
  });

  it('reports a value that is null in practice but not documented as nullable', () => {
    const conflicts = compareSchemas({ kind: 'string' }, { kind: 'string', nullable: true });
    expect(conflicts[0]).toMatchObject({ code: ConflictCode.FIELD_NULLABILITY, severity: 'error' });
  });

  it('concludes nothing from an unspecified shape', () => {
    expect(compareSchemas({ kind: 'unknown' }, { kind: 'integer' })).toEqual([]);
    expect(compareSchemas({ kind: 'string' }, { kind: 'unknown' })).toEqual([]);
  });

  it('catches the enumeration mismatch that silently breaks integrations', () => {
    const conflicts = compareSchemas(
      { kind: 'enum', values: ['pending', 'shipped'] },
      { kind: 'enum', values: ['pending', 'completed'] },
    );
    expect(conflicts[0]).toMatchObject({ code: ConflictCode.ENUM_MISMATCH, severity: 'error' });
    expect(conflicts[0]?.message).toContain('"completed"');
  });

  it('does not report an enumeration that is a subset of the documented one', () => {
    expect(
      compareSchemas({ kind: 'enum', values: ['a', 'b'] }, { kind: 'enum', values: ['a'] }),
    ).toEqual([]);
  });

  it('warns when reality is wider than a documented enumeration', () => {
    const conflicts = compareSchemas({ kind: 'enum', values: ['a'] }, { kind: 'string' });
    expect(conflicts[0]).toMatchObject({ code: ConflictCode.ENUM_MISMATCH, severity: 'warning' });
  });

  it('descends into arrays and nested objects, naming the full path', () => {
    const conflicts = compareSchemas(
      {
        kind: 'object',
        properties: [
          {
            name: 'items',
            required: true,
            schema: {
              kind: 'array',
              items: {
                kind: 'object',
                properties: [{ name: 'sku', required: true, schema: { kind: 'string' } }],
              },
            },
          },
        ],
      },
      {
        kind: 'object',
        properties: [
          {
            name: 'items',
            required: true,
            schema: {
              kind: 'array',
              items: {
                kind: 'object',
                properties: [{ name: 'sku', required: true, schema: { kind: 'integer' } }],
              },
            },
          },
        ],
      },
    );
    expect(conflicts[0]).toMatchObject({ code: ConflictCode.FIELD_TYPE, path: 'items[].sku' });
  });

  it('accepts an observed variant covered by a documented union', () => {
    const union: SchemaNode = { kind: 'union', options: [{ kind: 'string' }, { kind: 'integer' }] };
    expect(compareSchemas(union, { kind: 'string' })).toEqual([]);
    expect(codes(compareSchemas(union, { kind: 'boolean' }))).toEqual([ConflictCode.FIELD_TYPE]);
  });

  it('compares unresolved references by name', () => {
    const left: SchemaNode = { kind: 'ref', ref: '#/a', name: 'Order' };
    expect(compareSchemas(left, { kind: 'ref', ref: '#/b', name: 'Order' })).toEqual([]);
    expect(codes(compareSchemas(left, { kind: 'ref', ref: '#/b', name: 'Invoice' }))).toEqual([
      ConflictCode.FIELD_TYPE,
    ]);
  });

  it('terminates on deeply nested structures', () => {
    let deep: SchemaNode = { kind: 'string' };
    for (let level = 0; level < 40; level += 1) {
      deep = { kind: 'object', properties: [{ name: 'next', required: true, schema: deep }] };
    }
    expect(() => compareSchemas(deep, deep)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cross-format agreement: the phase gate
// ---------------------------------------------------------------------------

const openApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Orders API', version: '1.0.0' },
  servers: [{ url: 'https://api.test/v1' }],
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'shipped'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'total'],
                  properties: {
                    id: { type: 'string' },
                    total: { type: 'integer' },
                    note: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ bearerAuth: [] }],
};

const declared = unwrap(parseOpenApi(openApiDocument, { location: 'orders.yaml' }));

describe('an observed request agreeing with the specification', () => {
  const observed = unwrap(
    parseCurl(
      `curl 'https://api.test/v1/orders?status=pending&limit=10' -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'`,
      { fallbackTitle: 'Orders API' },
    ),
  );

  const conflicts = compareSpecs(declared, observed, {
    expectedLabel: 'the specification',
    actualLabel: 'the observed request',
  });

  it('reports no errors when the request matches what is documented', () => {
    expect(errors(conflicts)).toEqual([]);
  });

  it('does not mistake a wire-format string for a type mismatch', () => {
    // `limit` is documented as an integer and arrived as the string "10".
    expect(codes(conflicts)).not.toContain(ConflictCode.FIELD_TYPE);
  });

  it('still notices that the observed request documents no response', () => {
    // The specification documents a 200; the command saw nothing, which is a
    // gap in the observation rather than a contradiction.
    expect(codes(conflicts)).not.toContain(ConflictCode.STATUS_UNDOCUMENTED);
  });
});

describe('an observed request contradicting the specification', () => {
  const observed = unwrap(
    parseCurl(
      `curl 'https://api.other.test/v1/orders?status=completed&expand=customer' -H 'X-Api-Key: aB3xY9zQ7mN2pL5kR8wT1vC4nH6jF0dG'`,
      { fallbackTitle: 'Orders API' },
    ),
  );

  const conflicts = compareSpecs(declared, observed, {
    expectedLabel: 'the specification',
    actualLabel: 'the observed request',
  });

  it('catches the value that is not in the documented enumeration', () => {
    const enumConflict = conflicts.find((conflict) => conflict.code === ConflictCode.ENUM_MISMATCH);
    expect(enumConflict).toMatchObject({ severity: 'error', path: 'status' });
    expect(enumConflict?.message).toContain('"completed"');
  });

  it('catches the undocumented query parameter', () => {
    expect(
      conflicts.find((conflict) => conflict.code === ConflictCode.PARAMETER_UNDOCUMENTED),
    ).toMatchObject({ severity: 'warning', path: 'expand' });
  });

  it('catches the wrong kind of credential', () => {
    const auth = conflicts.find((conflict) => conflict.code === ConflictCode.AUTH_MISMATCH);
    expect(auth).toMatchObject({ severity: 'error' });
    expect(auth?.message).toMatch(/bearer.*apiKey|apiKey.*bearer/);
  });

  it('catches the call to a host the specification does not list', () => {
    expect(
      conflicts.find((conflict) => conflict.code === ConflictCode.SERVER_MISMATCH),
    ).toMatchObject({
      actual: 'https://api.other.test',
    });
  });
});

describe('two specifications of the same API', () => {
  const postmanCollection = {
    info: {
      name: 'Orders API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'List orders',
        request: {
          method: 'GET',
          url: {
            raw: 'https://api.test/v1/orders',
            protocol: 'https',
            host: ['api', 'test'],
            path: ['v1', 'orders'],
            query: [{ key: 'status', value: 'pending' }],
          },
        },
        response: [{ name: 'ok', code: 200, body: '{"id":"1","total":1250}' }],
      },
      {
        name: 'Cancel order',
        request: {
          method: 'DELETE',
          url: {
            raw: 'https://api.test/v1/orders/7',
            protocol: 'https',
            host: ['api', 'test'],
            path: ['v1', 'orders', '7'],
          },
        },
      },
    ],
  };

  const collection = unwrap(parsePostman(postmanCollection));
  const conflicts = compareSpecs(declared, collection, {
    expectedLabel: 'the specification',
    actualLabel: 'the collection',
  });

  it('agrees on the endpoint both describe', () => {
    const onListOrders = conflicts.filter((conflict) => conflict.endpointId === 'GET /v1/orders');
    expect(errors(onListOrders)).toEqual([]);
  });

  it('reports the endpoint only the collection knows about', () => {
    expect(
      conflicts.find((conflict) => conflict.code === ConflictCode.ENDPOINT_UNDOCUMENTED),
    ).toMatchObject({ endpointId: 'DELETE /v1/orders/7' });
  });

  it('recognizes a response field the specification does not promise', () => {
    // The collection's saved response has no `note`, which the spec marks
    // optional, so that is not a finding; nothing is invented either way.
    expect(codes(conflicts)).not.toContain(ConflictCode.FIELD_MISSING);
  });
});

describe('endpoints matched across differing parameter names', () => {
  const renamed = unwrap(
    parseOpenApi({
      openapi: '3.0.3',
      info: { title: 'Orders API' },
      servers: [{ url: 'https://api.test/v1' }],
      paths: {
        '/orders/{orderId}': {
          get: {
            parameters: [
              { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }),
  );

  const original = unwrap(
    parseOpenApi({
      openapi: '3.0.3',
      info: { title: 'Orders API' },
      servers: [{ url: 'https://api.test/v1' }],
      paths: {
        '/orders/{id}': {
          get: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }),
  );

  const conflicts = compareSpecs(original, renamed);

  it('pairs them rather than reporting one missing and one extra', () => {
    expect(codes(conflicts)).not.toContain(ConflictCode.ENDPOINT_MISSING);
    expect(codes(conflicts)).not.toContain(ConflictCode.ENDPOINT_UNDOCUMENTED);
  });

  it('records the rename as information', () => {
    expect(
      conflicts.find((conflict) => conflict.code === ConflictCode.PATH_PARAMETER_RENAMED),
    ).toMatchObject({
      severity: 'info',
      expected: '/orders/{id}',
      actual: '/orders/{orderId}',
    });
  });

  it('reports the differently-named path parameter itself', () => {
    expect(codes(conflicts)).toContain(ConflictCode.PARAMETER_MISSING);
  });
});

describe('a specification compared with itself', () => {
  it('finds no conflicts at all', () => {
    expect(compareSpecs(declared, declared)).toEqual([]);
  });

  it('is deterministic', () => {
    const other = unwrap(parseOpenApi(openApiDocument));
    expect(compareSpecs(declared, other)).toEqual(compareSpecs(declared, other));
  });
});

// A spec with no endpoints in common should not throw or produce nonsense.
describe('unrelated specifications', () => {
  it('reports every endpoint on both sides without failing', () => {
    const other = unwrap(
      parseOpenApi({
        openapi: '3.0.3',
        info: { title: 'Other' },
        paths: { '/widgets': { get: { responses: { '200': { description: 'ok' } } } } },
      }),
    ) as ApiSpec;

    const conflicts = compareSpecs(declared, other);
    expect(codes(conflicts)).toContain(ConflictCode.ENDPOINT_MISSING);
    expect(codes(conflicts)).toContain(ConflictCode.ENDPOINT_UNDOCUMENTED);
  });
});
