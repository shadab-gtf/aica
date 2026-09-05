import { Redactor, SecretResolver } from '@aica/security-engine';
import { ErrorCode, isErr, isOk, unwrap } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import type { FetchLike } from './executor.js';
import { PostmanApiClient } from './postman-api.js';

/**
 * Every request is mocked. Nothing here reaches api.getpostman.com, so the
 * suite runs offline and a real key cannot make it pass by accident.
 */

const API_KEY = 'postman-test-key-0000000000000000';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function stub(replies: readonly (Response | ((call: Call) => Response))[]): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;

  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) throw new Error('no reply configured');
    return typeof reply === 'function' ? reply(call) : reply.clone();
  };

  return { fetch, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeClient(
  fetch: FetchLike,
  options: { env?: Record<string, string>; cacheTtlMs?: number; maxRetries?: number } = {},
): { client: PostmanApiClient; redactor: Redactor; clock: { value: number } } {
  const redactor = new Redactor();
  const clock = { value: 1_000_000 };

  const client = new PostmanApiClient({
    apiKeyRef: 'env:POSTMAN_API_KEY',
    secrets: new SecretResolver({ env: options.env ?? { POSTMAN_API_KEY: API_KEY }, redactor }),
    redactor,
    fetch,
    baseUrl: 'https://postman.test',
    maxRetries: options.maxRetries ?? 0,
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    now: () => clock.value,
  });

  return { client, redactor, clock };
}

/** A minimal but realistic collection, exercising the v2.1 shapes. */
const COLLECTION = {
  collection: {
    info: {
      name: 'Orders API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: 'Order endpoints',
    },
    variable: [{ key: 'baseUrl', value: 'https://api.example.com/v1' }],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    item: [
      {
        name: 'List orders',
        request: {
          method: 'GET',
          header: [{ key: 'Accept', value: 'application/json' }],
          url: {
            raw: '{{baseUrl}}/orders?status=pending',
            protocol: 'https',
            host: ['api', 'example', 'com'],
            path: ['v1', 'orders'],
            query: [{ key: 'status', value: 'pending' }],
          },
        },
        response: [{ name: 'ok', code: 200, status: 'OK', body: '{"id":"1","total":1250}' }],
      },
      {
        name: 'Create order',
        request: {
          method: 'POST',
          url: {
            raw: 'https://api.example.com/v1/orders',
            protocol: 'https',
            host: ['api', 'example', 'com'],
            path: ['v1', 'orders'],
          },
          body: { mode: 'raw', raw: '{"items":["A1"]}', options: { raw: { language: 'json' } } },
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('sends the key in the documented header and never in the URL', async () => {
    const { fetch, calls } = stub([json({ user: { id: 1 } })]);
    const { client } = makeClient(fetch);

    unwrap(await client.healthCheck());

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe(API_KEY);
    expect(headers.authorization).toBeUndefined();
    expect(calls[0]?.url).not.toContain(API_KEY);
  });

  it('reports a missing key as configuration, before any request', async () => {
    const { fetch, calls } = stub([json({})]);
    const { client } = makeClient(fetch, { env: {} });

    const result = await client.healthCheck();

    expect(isErr(result) && result.error.code).toBe(ErrorCode.CONFIG_ERROR);
    expect(calls).toHaveLength(0);
  });

  it('never puts the key in an error', async () => {
    const { fetch } = stub([json({ error: { message: 'Invalid API Key' } }, { status: 401 })]);
    const { client } = makeClient(fetch);

    const result = await client.listWorkspaces();

    expect(isErr(result) && result.error.code).toBe(ErrorCode.AUTH_FAILURE);
    expect(JSON.stringify(isErr(result) ? result.error.toJSON() : {})).not.toContain(API_KEY);
  });

  it('registers the key with the redactor so it is scrubbed everywhere after', async () => {
    const { fetch } = stub([json({ workspaces: [] })]);
    const { client, redactor } = makeClient(fetch);

    await client.listWorkspaces();

    expect(redactor.text(`key=${API_KEY}`)).not.toContain(API_KEY);
  });

  it('treats 403 the same as 401, since the fix is the same', async () => {
    const { fetch } = stub([json({ error: { message: 'Forbidden' } }, { status: 403 })]);
    const { client } = makeClient(fetch);

    expect(isErr(await client.listWorkspaces())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workspaces and collections
// ---------------------------------------------------------------------------

describe('listing workspaces', () => {
  it('returns what a picker needs', async () => {
    const { fetch, calls } = stub([
      json({
        workspaces: [
          { id: 'ws-1', name: 'Team', type: 'team' },
          { id: 'ws-2', name: 'Personal', type: 'personal' },
        ],
      }),
    ]);
    const { client } = makeClient(fetch);

    const workspaces = unwrap(await client.listWorkspaces());

    expect(calls[0]?.url).toBe('https://postman.test/workspaces');
    expect(workspaces).toEqual([
      { id: 'ws-1', name: 'Team', type: 'team' },
      { id: 'ws-2', name: 'Personal', type: 'personal' },
    ]);
  });

  it('skips a workspace with no id rather than showing a broken row', async () => {
    const { fetch } = stub([
      json({ workspaces: [{ name: 'Nameless' }, { id: 'ok', name: 'Fine' }] }),
    ]);
    const { client } = makeClient(fetch);

    expect(unwrap(await client.listWorkspaces())).toEqual([{ id: 'ok', name: 'Fine' }]);
  });

  it('returns an empty list rather than failing when there are none', async () => {
    const { fetch } = stub([json({ workspaces: [] })]);
    const { client } = makeClient(fetch);

    expect(unwrap(await client.listWorkspaces())).toEqual([]);
  });
});

describe('listing collections in a workspace', () => {
  it('reads them from the workspace detail response', async () => {
    const { fetch, calls } = stub([
      json({
        workspace: {
          id: 'ws-1',
          name: 'Team',
          collections: [
            { id: 'c-1', uid: '12345-c-1', name: 'Orders API' },
            { id: 'c-2', uid: '12345-c-2', name: 'Billing API' },
          ],
        },
      }),
    ]);
    const { client } = makeClient(fetch);

    const collections = unwrap(await client.listCollections('ws-1'));

    expect(calls[0]?.url).toBe('https://postman.test/workspaces/ws-1');
    expect(collections.map((entry) => entry.uid)).toEqual(['12345-c-1', '12345-c-2']);
  });

  it('skips an entry with no uid, since fetching needs one', async () => {
    const { fetch } = stub([
      json({
        workspace: {
          collections: [
            { id: 'c-1', name: 'No uid' },
            { uid: 'u', name: 'Fine' },
          ],
        },
      }),
    ]);
    const { client } = makeClient(fetch);

    expect(unwrap(await client.listCollections('ws-1'))).toHaveLength(1);
  });

  it('reports a response with no workspace object', async () => {
    const { fetch } = stub([json({ nothing: true })]);
    const { client } = makeClient(fetch);

    const result = await client.listCollections('ws-1');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.MALFORMED_RESPONSE);
  });

  it.each(['../../users', 'ws 1', '', 'ws?x=1', 'a'.repeat(200)])(
    'refuses the workspace id %s before it reaches a URL',
    async (id) => {
      const { fetch, calls } = stub([json({})]);
      const { client } = makeClient(fetch);

      const result = await client.listCollections(id);
      expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
      expect(calls).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Fetching and normalizing
// ---------------------------------------------------------------------------

describe('fetching a collection', () => {
  it('unwraps the collection envelope', async () => {
    const { fetch, calls } = stub([json(COLLECTION)]);
    const { client } = makeClient(fetch);

    const document = unwrap(await client.fetchCollection('12345-c-1'));

    expect(calls[0]?.url).toBe('https://postman.test/collections/12345-c-1');
    expect((document as { info: { name: string } }).info.name).toBe('Orders API');
  });

  it('reports a response with no collection body', async () => {
    const { fetch } = stub([json({ collection: null })]);
    const { client } = makeClient(fetch);

    const result = await client.fetchCollection('12345-c-1');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.MALFORMED_RESPONSE);
  });

  it('refuses a malformed collection uid', async () => {
    const { fetch, calls } = stub([json(COLLECTION)]);
    const { client } = makeClient(fetch);

    expect(isErr(await client.fetchCollection('../secrets'))).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('normalizing into the canonical IR', () => {
  it('produces the same ApiSpec any other source would', async () => {
    const { fetch } = stub([json(COLLECTION)]);
    const { client } = makeClient(fetch);

    const spec = unwrap(await client.fetchCollectionSpec('12345-c-1'));

    // Reuses the existing Postman parser, so endpoints, methods and paths come
    // out exactly as they do for a collection loaded from a file.
    expect(spec.title).toBe('Orders API');
    expect(spec.endpoints.map((endpoint) => endpoint.id)).toEqual([
      'GET /v1/orders',
      'POST /v1/orders',
    ]);
    expect(spec.source.format).toBe('postman');
    expect(spec.source.location).toBe('postman:12345-c-1');
  });

  it('carries through parameters, headers, bodies, and response examples', async () => {
    const { fetch } = stub([json(COLLECTION)]);
    const { client } = makeClient(fetch);

    const spec = unwrap(await client.fetchCollectionSpec('12345-c-1'));
    const list = spec.endpoints.find((endpoint) => endpoint.id === 'GET /v1/orders');
    const create = spec.endpoints.find((endpoint) => endpoint.id === 'POST /v1/orders');

    expect(list?.parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['status', 'Accept']),
    );
    expect(list?.responses[0]?.status).toBe(200);
    expect(create?.requestBody?.content[0]?.mediaType).toBe('application/json');
  });

  it('carries through the authentication scheme without its value', async () => {
    const { fetch } = stub([json(COLLECTION)]);
    const { client } = makeClient(fetch);

    const spec = unwrap(await client.fetchCollectionSpec('12345-c-1'));

    expect(spec.authSchemes.map((scheme) => scheme.kind)).toContain('bearer');
    for (const scheme of spec.authSchemes) {
      expect(scheme).not.toHaveProperty('secretRef');
    }
  });

  it('resolves collection variables', async () => {
    const { fetch } = stub([json(COLLECTION)]);
    const { client } = makeClient(fetch);

    const spec = unwrap(await client.fetchCollectionSpec('12345-c-1'));
    expect(spec.servers.map((server) => server.url)).toContain('https://api.example.com');
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('caching', () => {
  it('serves a repeat request from cache', async () => {
    const { fetch, calls } = stub([json({ workspaces: [{ id: 'ws-1', name: 'Team' }] })]);
    const { client } = makeClient(fetch, { cacheTtlMs: 60_000 });

    await client.listWorkspaces();
    await client.listWorkspaces();

    expect(calls).toHaveLength(1);
  });

  it('refetches once the entry is stale', async () => {
    const { fetch, calls } = stub([json({ workspaces: [] })]);
    const { client, clock } = makeClient(fetch, { cacheTtlMs: 1_000 });

    await client.listWorkspaces();
    clock.value += 2_000;
    await client.listWorkspaces();

    expect(calls).toHaveLength(2);
  });

  it('can be cleared, so a picker can offer a refresh', async () => {
    const { fetch, calls } = stub([json({ workspaces: [] })]);
    const { client } = makeClient(fetch, { cacheTtlMs: 60_000 });

    await client.listWorkspaces();
    client.clearCache();
    await client.listWorkspaces();

    expect(calls).toHaveLength(2);
  });

  it('does not cache the health check, which must reflect the key right now', async () => {
    const { fetch, calls } = stub([json({ user: {} })]);
    const { client } = makeClient(fetch, { cacheTtlMs: 60_000 });

    await client.healthCheck();
    await client.healthCheck();

    expect(calls).toHaveLength(2);
  });

  it('caches per path, so one resource does not mask another', async () => {
    const { fetch, calls } = stub([
      (call) =>
        call.url.endsWith('/workspaces') ? json({ workspaces: [] }) : json({ collections: [] }),
    ]);
    const { client } = makeClient(fetch, { cacheTtlMs: 60_000 });

    await client.listWorkspaces();
    await client.listAllCollections();

    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('failures', () => {
  it.each([
    [400, ErrorCode.INVALID_INPUT],
    [401, ErrorCode.AUTH_FAILURE],
    [404, ErrorCode.NOT_FOUND],
    [429, ErrorCode.RATE_LIMITED],
    [500, ErrorCode.API_ERROR],
  ])('maps HTTP %s onto the error taxonomy', async (status, code) => {
    const { fetch } = stub([json({ error: { message: 'nope' } }, { status })]);
    const { client } = makeClient(fetch);

    const result = await client.listWorkspaces();
    expect(isErr(result) && result.error.code).toBe(code);
  });

  it('reports a non-JSON body as malformed', async () => {
    const { fetch } = stub([new Response('<html>gateway</html>', { status: 200 })]);
    const { client } = makeClient(fetch);

    const result = await client.listWorkspaces();
    expect(isErr(result) && result.error.code).toBe(ErrorCode.MALFORMED_RESPONSE);
  });

  it('returns a controlled error when Postman is unreachable', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ENOTFOUND api.getpostman.com');
    };
    const { client } = makeClient(fetch);

    const result = await client.listWorkspaces();
    expect(isErr(result) && result.error.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(isErr(result) && result.error.retryable).toBe(true);
  });

  it('times out rather than hanging', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const redactor = new Redactor();
    const client = new PostmanApiClient({
      apiKeyRef: 'env:POSTMAN_API_KEY',
      secrets: new SecretResolver({ env: { POSTMAN_API_KEY: API_KEY }, redactor }),
      redactor,
      fetch,
      baseUrl: 'https://postman.test',
      timeoutMs: 20,
    });

    const result = await client.listWorkspaces();
    expect(isErr(result) && result.error.code).toBe(ErrorCode.TIMEOUT);
  });

  it('retries a rate limit and succeeds', async () => {
    let attempts = 0;
    const fetch: FetchLike = async () => {
      attempts += 1;
      return attempts < 3 ? json({}, { status: 429 }) : json({ workspaces: [] });
    };
    const { client } = makeClient(fetch, { maxRetries: 3 });

    expect(isOk(await client.listWorkspaces())).toBe(true);
    expect(attempts).toBe(3);
  });

  it('does not retry a client error', async () => {
    let attempts = 0;
    const fetch: FetchLike = async () => {
      attempts += 1;
      return json({}, { status: 404 });
    };
    const { client } = makeClient(fetch, { maxRetries: 3 });

    await client.listWorkspaces();
    expect(attempts).toBe(1);
  });

  it('does not cache a failure', async () => {
    let attempts = 0;
    const fetch: FetchLike = async () => {
      attempts += 1;
      return attempts === 1 ? json({}, { status: 500 }) : json({ workspaces: [] });
    };
    const { client } = makeClient(fetch, { cacheTtlMs: 60_000 });

    await client.listWorkspaces();
    expect(isOk(await client.listWorkspaces())).toBe(true);
    expect(attempts).toBe(2);
  });
});
