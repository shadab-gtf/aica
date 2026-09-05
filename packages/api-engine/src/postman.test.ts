import { ParseWarningCode } from '@aica/api-ir';
import type { ApiSpec, Endpoint, ObjectSchema } from '@aica/api-ir';
import { ErrorCode, isErr, unwrap } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import { isPostmanCollection, parsePostman } from './postman.js';

const API_KEY = 'aB3xY9zQ7mN2pL5kR8wT1vC4nH6jF0dG';

const collection = {
  info: {
    name: 'Orders',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description: { content: 'Saved order requests', type: 'text/plain' },
  },
  variable: [{ key: 'baseUrl', value: 'https://api.test/v1' }],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  item: [
    {
      name: 'Orders',
      item: [
        {
          name: 'List orders',
          request: {
            method: 'GET',
            description: 'Page through orders',
            header: [
              { key: 'Accept', value: 'application/json' },
              { key: 'X-Api-Key', value: API_KEY },
              { key: 'X-Legacy', value: 'yes', disabled: true },
            ],
            url: {
              raw: '{{baseUrl}}/orders?status=pending',
              protocol: 'https',
              host: ['api', 'test'],
              path: ['v1', 'orders'],
              query: [
                { key: 'status', value: 'pending', description: 'Filter by status' },
                { key: 'debug', value: 'true', disabled: true },
              ],
            },
          },
          response: [
            {
              name: 'A page',
              code: 200,
              status: 'OK',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: '{"id":"1","total":1250,"coupon":"SAVE"}',
            },
            { name: 'Another page', code: 200, body: '{"id":"2","total":40}' },
            { name: 'Missing', code: 404, body: 'not found' },
          ],
        },
        {
          name: 'Get order',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/orders/:orderId',
              variable: [{ key: 'orderId', value: '42', description: 'Order identifier' }],
            },
          },
        },
      ],
    },
    {
      name: 'Create order',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        url: {
          raw: 'https://api.test/v1/orders',
          protocol: 'https',
          host: ['api', 'test'],
          path: ['v1', 'orders'],
        },
        body: {
          mode: 'raw',
          raw: '{"items":["A1"],"coupon":"SAVE"}',
          options: { raw: { language: 'json' } },
        },
      },
    },
  ],
};

function parse(document: unknown = collection): ApiSpec {
  return unwrap(parsePostman(document, { location: 'orders.postman.json' }));
}

function endpointOf(spec: ApiSpec, id: string): Endpoint {
  const endpoint = spec.endpoints.find((candidate) => candidate.id === id);
  if (!endpoint)
    throw new Error(`no endpoint ${id} in ${spec.endpoints.map((e) => e.id).join(', ')}`);
  return endpoint;
}

// ---------------------------------------------------------------------------

describe('detection', () => {
  it('recognizes a collection by its schema url', () => {
    expect(isPostmanCollection(collection)).toBe(true);
    expect(isPostmanCollection({ info: { name: 'x' }, item: [] })).toBe(true);
  });

  it.each([{}, { openapi: '3.0.0' }, null, 'text'])('rejects %j', (document) => {
    expect(isPostmanCollection(document)).toBe(false);
  });

  it('fails with an actionable message', () => {
    const result = parsePostman({ openapi: '3.0.0' });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
    expect(isErr(result) && result.error.message).toMatch(/info.*item/i);
  });
});

describe('collection structure', () => {
  const spec = parse();

  it('takes its identity and description from info', () => {
    expect(spec).toMatchObject({
      id: 'orders',
      title: 'Orders',
      description: 'Saved order requests',
    });
  });

  it('flattens folders and keeps the folder as a tag', () => {
    expect(spec.endpoints.map((endpoint) => endpoint.id)).toEqual([
      'GET /v1/orders',
      'GET /v1/orders/{orderId}',
      'POST /v1/orders',
    ]);
    expect(endpointOf(spec, 'GET /v1/orders').tags).toEqual(['Orders']);
    expect(endpointOf(spec, 'POST /v1/orders').tags).toEqual([]);
  });

  it('uses the request name as the summary', () => {
    expect(endpointOf(spec, 'GET /v1/orders')).toMatchObject({
      summary: 'List orders',
      description: 'Page through orders',
    });
  });

  it('derives servers from the origins the requests use', () => {
    expect(spec.servers).toEqual([{ url: 'https://api.test', variables: [] }]);
  });

  it('records provenance including the folder path', () => {
    expect(endpointOf(spec, 'GET /v1/orders').source).toEqual({
      format: 'postman',
      location: 'orders.postman.json',
      pointer: 'Orders/List orders',
    });
  });
});

describe('urls and variables', () => {
  const spec = parse();

  it('resolves a collection variable', () => {
    // `{{baseUrl}}` is defined, so the path behind it is recovered.
    expect(endpointOf(spec, 'GET /v1/orders/{orderId}').path).toBe('/v1/orders/{orderId}');
  });

  it('normalizes a :param placeholder and keeps its documentation', () => {
    const parameter = endpointOf(spec, 'GET /v1/orders/{orderId}').parameters[0];
    expect(parameter).toMatchObject({
      name: 'orderId',
      in: 'path',
      required: true,
      description: 'Order identifier',
    });
    expect(parameter?.schema).toMatchObject({ kind: 'string', example: '42' });
  });

  it('reports an undefined variable rather than silently assuming it is a host', () => {
    const spec2 = parse({
      ...collection,
      variable: [],
      item: [{ name: 'X', request: { method: 'GET', url: { raw: '{{baseUrl}}/things' } } }],
    });

    // `{{baseUrl}}` commonly holds a path prefix such as `/v1`, so the recovered
    // path may be incomplete — which is stated rather than glossed over.
    expect(spec2.endpoints[0]?.path).toBe('/things');
    expect(spec2.endpoints[0]?.servers).toEqual([]);
    const warning = spec2.warnings.find((entry) => entry.code === ParseWarningCode.UNRESOLVED_REF);
    expect(warning?.message).toMatch(/does not define "\{\{baseUrl\}\}"/);
  });

  it('skips disabled query parameters, which were not sent', () => {
    const names = endpointOf(spec, 'GET /v1/orders')
      .parameters.filter((parameter) => parameter.in === 'query')
      .map((parameter) => parameter.name);
    expect(names).toEqual(['status']);
  });

  it('keeps declared query parameter descriptions', () => {
    const status = endpointOf(spec, 'GET /v1/orders').parameters.find((p) => p.name === 'status');
    expect(status).toMatchObject({ in: 'query', required: false, description: 'Filter by status' });
  });
});

describe('headers and credentials', () => {
  const spec = parse();

  it('keeps ordinary headers and drops disabled and structural ones', () => {
    const names = endpointOf(spec, 'GET /v1/orders')
      .parameters.filter((parameter) => parameter.in === 'header')
      .map((parameter) => parameter.name);
    expect(names).toEqual(['Accept']);
  });

  it('turns a credential header into a scheme and discards the value', () => {
    expect(spec.authSchemes).toEqual(
      expect.arrayContaining([
        { id: 'x-api-key', kind: 'apiKey', in: 'header', name: 'X-Api-Key' },
      ]),
    );
    expect(JSON.stringify(spec)).not.toContain(API_KEY);
    expect(spec.warnings.some((warning) => warning.message.includes('env:X_API_KEY'))).toBe(true);
    expect(spec.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.LITERAL_CREDENTIAL,
    );
  });

  it('reads the collection-level auth block', () => {
    expect(spec.security).toEqual([[{ schemeId: 'bearer', scopes: [] }]]);
    expect(spec.authSchemes).toEqual(
      expect.arrayContaining([{ id: 'bearer', kind: 'bearer', headerName: 'Authorization' }]),
    );
  });

  it('reads an apikey auth block without touching the value', () => {
    const spec2 = parse({
      ...collection,
      auth: {
        type: 'apikey',
        apikey: [
          { key: 'key', value: 'X-Custom-Key' },
          { key: 'in', value: 'query' },
          { key: 'value', value: API_KEY },
        ],
      },
    });
    expect(spec2.authSchemes).toEqual(
      expect.arrayContaining([
        { id: 'apikey-x-custom-key', kind: 'apiKey', in: 'query', name: 'X-Custom-Key' },
      ]),
    );
    expect(JSON.stringify(spec2)).not.toContain(API_KEY);
  });

  it('records an unsupported auth type as unknown rather than guessing', () => {
    const spec2 = parse({ ...collection, auth: { type: 'ntlm' } });
    expect(spec2.authSchemes).toEqual(
      expect.arrayContaining([
        { id: 'ntlm', kind: 'unknown', rawDescription: 'Postman auth type "ntlm"' },
      ]),
    );
    expect(spec2.warnings.map((warning) => warning.code)).toContain(ParseWarningCode.UNKNOWN_AUTH);
  });

  it('treats noauth as no requirement', () => {
    expect(parse({ ...collection, auth: { type: 'noauth' } }).security).toEqual([]);
  });
});

describe('bodies', () => {
  it('infers a schema from a raw JSON body', () => {
    const body = endpointOf(parse(), 'POST /v1/orders').requestBody;
    expect(body?.content[0]?.mediaType).toBe('application/json');
    expect((body?.content[0]?.schema as ObjectSchema).properties.map((p) => p.name)).toEqual([
      'items',
      'coupon',
    ]);
  });

  it('reports a body declared as JSON that does not parse', () => {
    const spec = parse(
      withRequest({
        body: { mode: 'raw', raw: '{not json', options: { raw: { language: 'json' } } },
      }),
    );
    expect(spec.warnings.some((warning) => warning.message.includes('does not parse'))).toBe(true);
  });

  it('maps urlencoded and formdata bodies', () => {
    const urlencoded = parse(
      withRequest({
        body: {
          mode: 'urlencoded',
          urlencoded: [
            { key: 'a', value: '1' },
            { key: 'b', value: '2', disabled: true },
          ],
        },
      }),
    );
    const content = urlencoded.endpoints[0]?.requestBody?.content[0];
    expect(content?.mediaType).toBe('application/x-www-form-urlencoded');
    expect((content?.schema as ObjectSchema).properties.map((p) => p.name)).toEqual(['a']);

    const formdata = parse(
      withRequest({ body: { mode: 'formdata', formdata: [{ key: 'f', value: 'x' }] } }),
    );
    expect(formdata.endpoints[0]?.requestBody?.content[0]?.mediaType).toBe('multipart/form-data');
  });

  it('describes a GraphQL body without pretending to know the variables', () => {
    const spec = parse(
      withRequest({ body: { mode: 'graphql', graphql: { query: '{ orders { id } }' } } }),
    );
    const schema = spec.endpoints[0]?.requestBody?.content[0]?.schema as ObjectSchema;
    expect(schema.properties.map((property) => property.name)).toEqual(['query', 'variables']);
    expect(schema.properties[1]?.schema).toMatchObject({ kind: 'unknown' });
  });

  it('ignores an empty raw body', () => {
    expect(
      parse(withRequest({ body: { mode: 'raw', raw: '   ' } })).endpoints[0]?.requestBody,
    ).toBeUndefined();
  });
});

describe('saved responses', () => {
  const spec = parse();
  const list = endpointOf(spec, 'GET /v1/orders');

  it('merges several examples of one status into one shape', () => {
    const ok = list.responses.find((response) => response.status === 200);
    const schema = ok?.content[0]?.schema as ObjectSchema;

    expect(schema.properties.find((property) => property.name === 'id')?.required).toBe(true);
    // `coupon` appeared in only one of the two saved examples.
    expect(schema.properties.find((property) => property.name === 'coupon')?.required).toBe(false);
  });

  it('records a non-JSON example as an unknown shape', () => {
    const missing = list.responses.find((response) => response.status === 404);
    expect(missing?.content[0]?.schema).toMatchObject({ kind: 'unknown' });
  });

  it('takes the media type from the saved response headers', () => {
    expect(list.responses.find((response) => response.status === 200)?.content[0]?.mediaType).toBe(
      'application/json',
    );
  });

  it('describes the response from its saved status text', () => {
    expect(list.responses.find((response) => response.status === 200)?.description).toBe('OK');
  });
});

describe('robustness', () => {
  it('skips a malformed item and keeps the rest', () => {
    const spec = parse({
      ...collection,
      item: [
        'not an object',
        { name: 'No url', request: { method: 'GET' } },
        { name: 'Fine', request: { method: 'GET', url: { raw: 'https://api.test/ok' } } },
      ],
    });
    expect(spec.endpoints.map((endpoint) => endpoint.id)).toEqual(['GET /ok']);
    expect(spec.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.MALFORMED_ENTRY,
    );
  });

  it('rejects an unrecognized HTTP method rather than assuming one', () => {
    const spec = parse(withRequest({ method: 'FETCH' }));
    expect(spec.endpoints).toEqual([]);
    expect(spec.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.UNSUPPORTED_FEATURE,
    );
  });

  it('accepts the shorthand where request is just a URL string', () => {
    const spec = parse({
      ...collection,
      item: [{ name: 'Ping', request: 'https://api.test/ping' }],
    });
    expect(spec.endpoints[0]).toMatchObject({ id: 'GET /ping', method: 'GET' });
  });

  it('is deterministic', () => {
    expect(parse()).toEqual(parse());
  });
});

function withRequest(request: Record<string, unknown>): unknown {
  return {
    ...collection,
    item: [
      {
        name: 'Probe',
        request: {
          method: 'POST',
          url: {
            raw: 'https://api.test/probe',
            protocol: 'https',
            host: ['api', 'test'],
            path: ['probe'],
          },
          ...request,
        },
      },
    ],
  };
}
