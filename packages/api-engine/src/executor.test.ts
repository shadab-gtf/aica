import type { ApiSpec, Endpoint } from '@aica/api-ir';
import { ApprovalGate, Redactor, SecretResolver, SsrfPolicy } from '@aica/security-engine';
import { ErrorCode, isErr, isOk, unwrap } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import { ApiExecutor, buildUrl } from './executor.js';
import type { FetchLike } from './executor.js';

const TOKEN = 'aB3xY9zQ7mN2pL5kR8wT1vC4nH6jF0dG';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'GET /orders',
    method: 'GET',
    path: '/orders',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    servers: [],
    source: { format: 'openapi3' },
    ...overrides,
  };
}

function spec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    id: 'orders',
    title: 'Orders',
    servers: [{ url: 'https://api.test/v1', variables: [] }],
    endpoints: [],
    authSchemes: [],
    security: [],
    components: {},
    source: { format: 'openapi3' },
    warnings: [],
    ...overrides,
  };
}

/** Records what was sent and replies with a canned response. */
function stubFetch(replies: (Response | ((url: string, init: RequestInit) => Response))[]): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) throw new Error('no reply configured');
    return typeof reply === 'function' ? reply(url, init) : reply;
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

/** A policy that permits the test host without touching real DNS. */
function policy(): SsrfPolicy {
  return new SsrfPolicy({
    allowedHosts: ['api.test', 'other.test', 'evil.test'],
    resolveHost: async () => ['93.184.216.34'],
  });
}

function makeExecutor(
  fetch: FetchLike,
  options: { env?: Record<string, string>; approvals?: ApprovalGate; redactor?: Redactor } = {},
): { executor: ApiExecutor; redactor: Redactor } {
  const redactor = options.redactor ?? new Redactor();
  const executor = new ApiExecutor({
    ssrf: policy(),
    redactor,
    secrets: new SecretResolver({ env: options.env ?? {}, redactor }),
    approvals: options.approvals,
    fetch,
  });
  return { executor, redactor };
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe('buildUrl', () => {
  it('joins the server base path to the endpoint path', () => {
    expect(unwrap(buildUrl(spec(), endpoint()))).toBe('https://api.test/v1/orders');
  });

  it('fills path parameters and encodes them', () => {
    const url = buildUrl(spec(), endpoint({ id: 'GET /orders/{id}', path: '/orders/{id}' }), {
      pathParameters: { id: 'a b' },
    });
    expect(unwrap(url)).toBe('https://api.test/v1/orders/a%20b');
  });

  it('refuses to build a URL with a path parameter missing', () => {
    const result = buildUrl(spec(), endpoint({ path: '/orders/{id}' }), {});
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
    expect(isErr(result) && result.error.message).toMatch(/needs path parameter\(s\) id/);
  });

  it('appends query values, repeating a key for an array', () => {
    const url = buildUrl(spec(), endpoint(), {
      query: { status: 'open', tag: ['a', 'b'], limit: 5 },
    });
    expect(unwrap(url)).toBe('https://api.test/v1/orders?status=open&tag=a&tag=b&limit=5');
  });

  it('substitutes server variables and honours their defaults', () => {
    const withVariables = spec({
      servers: [
        {
          url: 'https://{tenant}.api.test/v1',
          variables: [{ name: 'tenant', default: 'acme', enum: ['acme', 'globex'] }],
        },
      ],
    });
    expect(unwrap(buildUrl(withVariables, endpoint()))).toBe('https://acme.api.test/v1/orders');
    expect(
      unwrap(buildUrl(withVariables, endpoint(), { serverVariables: { tenant: 'globex' } })),
    ).toBe('https://globex.api.test/v1/orders');
  });

  it('rejects a server variable outside its documented values', () => {
    const withVariables = spec({
      servers: [
        {
          url: 'https://{tenant}.api.test',
          variables: [{ name: 'tenant', default: 'acme', enum: ['acme'] }],
        },
      ],
    });
    const result = buildUrl(withVariables, endpoint(), { serverVariables: { tenant: 'evil' } });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.CONFIG_ERROR);
  });

  it('reports when no server is known rather than inventing one', () => {
    const result = buildUrl(spec({ servers: [] }), endpoint());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.CONFIG_ERROR);
  });

  it('lets the caller override the server', () => {
    expect(unwrap(buildUrl(spec(), endpoint(), { serverUrl: 'https://staging.api.test/v1' }))).toBe(
      'https://staging.api.test/v1/orders',
    );
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe('execute', () => {
  it('sends the request and returns the parsed body with its inferred shape', async () => {
    const { fetch, calls } = stubFetch([json({ id: '1', total: 1250 })]);
    const { executor } = makeExecutor(fetch);

    const result = await executor.execute(spec(), endpoint());
    const exchange = unwrap(result);

    expect(calls[0]?.url).toBe('https://api.test/v1/orders');
    expect(calls[0]?.init.method).toBe('GET');
    expect(exchange.status).toBe(200);
    expect(exchange.json).toEqual({ id: '1', total: 1250 });
    expect(exchange.schema).toMatchObject({ kind: 'object' });
    expect(exchange.request.url).toBe('https://api.test/v1/orders');
  });

  it('treats a non-2xx response as an answer, not a failure', async () => {
    const { fetch } = stubFetch([
      json({ error: 'not found' }, { status: 404, statusText: 'Not Found' }),
    ]);
    const { executor } = makeExecutor(fetch);

    const exchange = unwrap(await executor.execute(spec(), endpoint()));
    expect(exchange.status).toBe(404);
    expect(exchange.json).toEqual({ error: 'not found' });
  });

  it('serializes a JSON body and sets the content type', async () => {
    const { fetch, calls } = stubFetch([json({ ok: true }, { status: 201 })]);
    const { executor } = makeExecutor(fetch);

    await executor.execute(spec(), endpoint({ method: 'POST', id: 'POST /orders' }), {
      body: { items: ['A1'] },
    });

    expect(calls[0]?.init.body).toBe('{"items":["A1"]}');
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('serializes a form body when that is the endpoint media type', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch);

    await executor.execute(spec(), endpoint({ method: 'POST' }), {
      body: { user: 'alice', remember: true },
      mediaType: 'application/x-www-form-urlencoded',
    });

    expect(calls[0]?.init.body).toBe('user=alice&remember=true');
  });

  it('refuses a method that is not an HTTP method rather than guessing', async () => {
    const { fetch } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch);

    const result = await executor.execute(
      spec(),
      endpoint({ method: 'UPDATE' as unknown as Endpoint['method'] }),
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
    expect(isErr(result) && result.error.message).toMatch(/PUT.*PATCH/);
  });

  it('caps an oversized response and says it was truncated', async () => {
    const big = 'x'.repeat(5000);
    const { fetch } = stubFetch([new Response(big, { status: 200 })]);
    const redactor = new Redactor();
    const executor = new ApiExecutor({
      ssrf: policy(),
      redactor,
      fetch,
      maxResponseBytes: 1000,
    });

    const exchange = unwrap(await executor.execute(spec(), endpoint()));
    expect(exchange.truncated).toBe(true);
    expect(exchange.body.length).toBe(1000);
  });

  it('reports a network failure as a retryable error', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { executor } = makeExecutor(fetch);

    const result = await executor.execute(spec(), endpoint());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(isErr(result) && result.error.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

describe('SSRF protection', () => {
  it('refuses a host outside the allowlist before any request is made', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch);

    const result = await executor.execute(
      spec({ servers: [{ url: 'https://blocked.test', variables: [] }] }),
      endpoint(),
    );

    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(calls).toHaveLength(0);
  });

  it('re-validates each redirect hop instead of trusting the first check', async () => {
    const { fetch, calls } = stubFetch([
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
      json({ secret: 'cloud credentials' }),
    ]);
    const { executor } = makeExecutor(fetch);

    const result = await executor.execute(spec(), endpoint());

    // The first hop was allowed; the redirect target was not.
    expect(calls).toHaveLength(1);
    expect(isErr(result)).toBe(true);
  });

  it('stops after the redirect limit rather than looping', async () => {
    const { fetch } = stubFetch([
      (url) => new Response(null, { status: 302, headers: { location: `${url}/again` } }),
    ]);
    const redactor = new Redactor();
    const executor = new ApiExecutor({ ssrf: policy(), redactor, fetch, maxRedirects: 2 });

    const result = await executor.execute(spec(), endpoint());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.LIMIT_EXCEEDED);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const bearerSpec = spec({
  authSchemes: [{ id: 'bearerAuth', kind: 'bearer', secretRef: 'env:API_TOKEN' }],
  security: [[{ schemeId: 'bearerAuth', scopes: [] }]],
});

describe('credentials', () => {
  it('resolves a secret reference at the point of use and sends it', async () => {
    const { fetch, calls } = stubFetch([json({ ok: true })]);
    const { executor } = makeExecutor(fetch, { env: { API_TOKEN: TOKEN } });

    const exchange = unwrap(await executor.execute(bearerSpec, endpoint()));

    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    // The returned summary must not carry it.
    expect(exchange.request.headers.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(exchange)).not.toContain(TOKEN);
  });

  it('scrubs a credential that the API echoes back in its response', async () => {
    const { fetch } = stubFetch([json({ echoed: `Bearer ${TOKEN}` })]);
    const { executor } = makeExecutor(fetch, { env: { API_TOKEN: TOKEN } });

    const exchange = unwrap(await executor.execute(bearerSpec, endpoint()));
    expect(exchange.body).not.toContain(TOKEN);
    expect(exchange.body).toContain('[REDACTED]');
  });

  it('drops credentials when a redirect crosses origins', async () => {
    const { fetch, calls } = stubFetch([
      new Response(null, { status: 307, headers: { location: 'https://evil.test/collect' } }),
      json({ ok: true }),
    ]);
    const { executor } = makeExecutor(fetch, { env: { API_TOKEN: TOKEN } });

    unwrap(await executor.execute(bearerSpec, endpoint()));

    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    // Following a redirect to another host must not hand it the token.
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('keeps credentials on a same-origin redirect', async () => {
    const { fetch, calls } = stubFetch([
      new Response(null, { status: 307, headers: { location: 'https://api.test/v1/orders/' } }),
      json({ ok: true }),
    ]);
    const { executor } = makeExecutor(fetch, { env: { API_TOKEN: TOKEN } });

    unwrap(await executor.execute(bearerSpec, endpoint()));
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('fails before sending when the credential is not configured, naming what to set', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch, { env: {} });

    const result = await executor.execute(bearerSpec, endpoint());

    expect(isErr(result) && result.error.code).toBe(ErrorCode.CONFIG_ERROR);
    expect(calls).toHaveLength(0);
  });

  it('reports an endpoint whose scheme has no reference at all', async () => {
    const unconfigured = spec({
      authSchemes: [{ id: 'apiKey', kind: 'apiKey', in: 'header', name: 'X-Api-Key' }],
      security: [[{ schemeId: 'apiKey', scopes: [] }]],
    });
    const { fetch } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch);

    const result = await executor.execute(unconfigured, endpoint());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.AUTH_FAILURE);
    expect(isErr(result) && result.error.message).toMatch(/not configured/);
  });

  it('sends an API key in the header the scheme names', async () => {
    const keySpec = spec({
      authSchemes: [
        { id: 'apiKey', kind: 'apiKey', in: 'header', name: 'X-Api-Key', secretRef: 'env:KEY' },
      ],
      security: [[{ schemeId: 'apiKey', scopes: [] }]],
    });
    const { fetch, calls } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch, { env: { KEY: TOKEN } });

    unwrap(await executor.execute(keySpec, endpoint()));
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe(TOKEN);
  });

  it('encodes basic credentials and registers the encoded pair for redaction', async () => {
    const basicSpec = spec({
      authSchemes: [
        { id: 'basic', kind: 'basic', usernameRef: 'env:USER', passwordRef: 'env:PASS' },
      ],
      security: [[{ schemeId: 'basic', scopes: [] }]],
    });
    const { fetch, calls } = stubFetch([json({})]);
    const { executor, redactor } = makeExecutor(fetch, {
      env: { USER: 'alice', PASS: 'hunter2hunter2' },
    });

    unwrap(await executor.execute(basicSpec, endpoint()));

    const encoded = Buffer.from('alice:hunter2hunter2').toString('base64');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${encoded}`,
    );
    expect(redactor.text(encoded)).not.toContain(encoded);
  });

  it('sends nothing extra for a public endpoint', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch);

    unwrap(await executor.execute(spec(), endpoint({ security: [[]] })));
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('refuses to place a key in the query string, where it would be recorded', async () => {
    const querySpec = spec({
      authSchemes: [
        { id: 'apiKey', kind: 'apiKey', in: 'query', name: 'api_key', secretRef: 'env:KEY' },
      ],
      security: [[{ schemeId: 'apiKey', scopes: [] }]],
    });
    const { fetch } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch, { env: { KEY: TOKEN } });

    const result = await executor.execute(querySpec, endpoint());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.UNSUPPORTED);
  });
});

// ---------------------------------------------------------------------------
// Policy and approvals
// ---------------------------------------------------------------------------

describe('policy enforcement', () => {
  const context = {
    mode: 'askAlways' as const,
    allowedEnvironments: ['local' as const, 'production' as const],
    apiExecutionEnabled: true,
  };

  it('asks before any real request under askAlways, a GET included', async () => {
    // Sending a request at all is a side effect on someone else's system, so
    // "askAlways" covers reads too, not only writes.
    const { fetch, calls } = stubFetch([json({})]);
    let asked = 0;
    const gate = new ApprovalGate({
      context,
      responder: async () => {
        asked += 1;
        return { granted: true };
      },
    });
    const { executor } = makeExecutor(fetch, { approvals: gate });

    unwrap(await executor.execute(spec(), endpoint()));
    expect(asked).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('sends a read-only request without asking once the mode permits it', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    let asked = 0;
    const gate = new ApprovalGate({
      context: { ...context, mode: 'askOnDestructive' },
      responder: async () => {
        asked += 1;
        return { granted: true };
      },
    });
    const { executor } = makeExecutor(fetch, { approvals: gate });

    unwrap(await executor.execute(spec(), endpoint()));
    expect(asked).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('asks before a mutating request and sends it when granted', async () => {
    const { fetch, calls } = stubFetch([json({}, { status: 201 })]);
    const subjects: string[] = [];
    const gate = new ApprovalGate({
      context,
      responder: async (request) => {
        subjects.push(request.action.subject);
        return { granted: true };
      },
    });
    const { executor } = makeExecutor(fetch, { approvals: gate });

    unwrap(await executor.execute(spec(), endpoint({ method: 'POST' }), { body: { a: 1 } }));
    expect(subjects).toEqual(['POST /orders']);
    expect(calls).toHaveLength(1);
  });

  it('does not send when the user declines', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const gate = new ApprovalGate({ context, responder: async () => ({ granted: false }) });
    const { executor } = makeExecutor(fetch, { approvals: gate });

    const result = await executor.execute(spec(), endpoint({ method: 'DELETE' }));
    expect(isErr(result)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('denies outright when API execution is disabled for the project', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const gate = new ApprovalGate({
      context: { ...context, apiExecutionEnabled: false },
      responder: async () => ({ granted: true }),
    });
    const { executor } = makeExecutor(fetch, { approvals: gate });

    const result = await executor.execute(spec(), endpoint());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(calls).toHaveLength(0);
  });

  it('records every decision for the audit trail', async () => {
    const { fetch } = stubFetch([json({})]);
    const gate = new ApprovalGate({ context, responder: async () => ({ granted: true }) });
    const { executor } = makeExecutor(fetch, { approvals: gate });

    await executor.execute(spec(), endpoint({ method: 'POST' }));
    expect(gate.auditTrail).toHaveLength(1);
    expect(gate.auditTrail[0]?.action.kind).toBe('api_request');
  });

  it('proceeds without a gate only when one was not configured', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const { executor } = makeExecutor(fetch);
    expect(isOk(await executor.execute(spec(), endpoint({ method: 'DELETE' })))).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
