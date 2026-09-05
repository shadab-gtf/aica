import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpcConnection, createTransportPair } from '@aica/rpc';
import { clientMethods } from '@aica/schemas';
import { EventBus, newId } from '@aica/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpGateway } from './http.js';
import { AgentServer } from './server.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/sample-app',
);

/**
 * The dashboard's transport.
 *
 * A local HTTP server that can index a codebase and run commands is a
 * capability sitting on a port, so most of this file is about who is allowed to
 * reach it — and localhost is not a boundary against the browser the user is
 * already running.
 */

const TOKEN = 'test-token-value';

let gateway: HttpGateway;
let server: AgentServer;
let base: string;
let client: RpcConnection;

beforeEach(async () => {
  const [clientSide, serverSide] = createTransportPair();
  client = new RpcConnection({ transport: clientSide, requestTimeoutMs: 30_000 });
  const connection = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });
  server = new AgentServer({ connection });

  gateway = new HttpGateway({
    gateway: server.methodTable,
    bus: server.eventBus,
    token: TOKEN,
  });

  base = (await gateway.listen()).url;
});

afterEach(async () => {
  client.dispose();
  await gateway.close();
});

/**
 * A request sent with Node's HTTP client rather than `fetch`.
 *
 * `fetch` refuses to set forbidden headers, `Host` among them, so anything
 * testing what the server does with a hostile `Host` has to go lower.
 */
function rawStatus(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port: gateway.listening?.port, path, method: 'GET', headers },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function call(method: string, params?: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify({ method, params }),
    ...init,
  });
}

describe('who can reach the server', () => {
  it('binds to loopback and nowhere else', async () => {
    const address = gateway.listening;
    expect(address?.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('answers health without a token', async () => {
    // A dashboard has to be able to tell "the server is not running" from "my
    // token is wrong", and this answers the first without revealing anything.
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('refuses a call with no token', async () => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'initialize' }),
    });

    expect(response.status).toBe(401);
  });

  it('refuses a call with the wrong token', async () => {
    const response = await call('initialize', {}, { headers: { authorization: 'Bearer wrong' } });
    expect(response.status).toBe(401);
  });

  it('refuses a request whose Host is not loopback', async () => {
    // An attacker's domain can resolve to 127.0.0.1, which makes their page
    // same-origin with this server. The Host header is what catches it.
    //
    // Sent with a raw client because `fetch` forbids setting `Host` — which
    // means a test written with `fetch` cannot exercise this guard at all, and
    // would have passed against a server that did not have one.
    const status = await rawStatus('/health', { host: 'evil.example.com' });
    expect(status).toBe(421);
  });

  it('accepts a Host that names loopback with a port', async () => {
    expect(await rawStatus('/health', { host: `127.0.0.1:${gateway.listening?.port}` })).toBe(200);
    expect(await rawStatus('/health', { host: 'localhost:3000' })).toBe(200);
  });

  it('refuses an origin that is not allowlisted', async () => {
    // The token is not enough on its own: a browser sends a request to
    // localhost from any origin, so `*` would make the token the only thing
    // standing between a random page and this server.
    const response = await call('initialize', {}, { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
  });

  it('echoes an allowlisted origin rather than a wildcard', async () => {
    const response = await call(
      clientMethods.initialize.method,
      { clientName: 'web', clientVersion: '1', capabilities: {} },
      { headers: { origin: 'http://localhost:3000' } },
    );

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('answers a preflight', async () => {
    const response = await fetch(`${base}/rpc`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('calling a method', () => {
  it('reaches the same handlers the editor reaches', async () => {
    const response = await call(clientMethods.initialize.method, {
      clientName: 'web',
      clientVersion: '1',
      capabilities: {},
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; value: { protocolVersion: string } };
    expect(body.ok).toBe(true);
    expect(body.value.protocolVersion).toBe('1');
  });

  it('validates parameters exactly as the pipe does', async () => {
    const response = await call(clientMethods.openProject.method, {});
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { message: string } };
    // The same message a user would get over the pipe: it names the field.
    expect(body.error.message).toContain('root');
  });

  it('carries the structured error, with the status as a summary', async () => {
    await call(clientMethods.initialize.method, {
      clientName: 'web',
      clientVersion: '1',
      capabilities: {},
    });

    const response = await call(clientMethods.projectStatus.method, { projectId: 'proj_missing' });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('reports an unknown method rather than a generic failure', async () => {
    const response = await call('no/such/method', {});
    expect(response.status).toBe(501);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('sets headers that stop a response being sniffed or cached', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('opens a project and indexes it over HTTP', async () => {
    await call(clientMethods.initialize.method, {
      clientName: 'web',
      clientVersion: '1',
      capabilities: {},
    });

    const opened = await call(clientMethods.openProject.method, { root: FIXTURE_ROOT });
    const project = (await opened.json()) as { value: { projectId: string } };

    const indexed = await call(clientMethods.indexCode.method, {
      projectId: project.value.projectId,
    });
    const stats = (await indexed.json()) as { value: { files: number } };

    expect(stats.value.files).toBeGreaterThan(0);
  });
});

describe('the event stream', () => {
  function emit(projectId: string, seq: number): void {
    server.eventBus.emit({
      id: newId('evt'),
      runId: newId('run'),
      projectId: projectId as never,
      seq,
      at: new Date().toISOString(),
      type: 'STATUS',
      payload: { message: `event ${seq}` },
    } as never);
  }

  async function readFirstEvents(url: string, count: number): Promise<string> {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');

    let text = '';
    const decoder = new TextDecoder();

    while ((text.match(/\ndata: /g)?.length ?? 0) < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }

    await reader.cancel();
    return text;
  }

  it('refuses a stream with no token', async () => {
    const response = await fetch(`${base}/events`);
    expect(response.status).toBe(401);
  });

  it('accepts a token in the query string, which EventSource needs', async () => {
    const pending = readFirstEvents(`${base}/events?token=${TOKEN}`, 1);
    // Give the subscription a moment to attach before emitting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    emit('proj_a', 1);

    expect(await pending).toContain('event 1');
  });

  it('sends only the project the dashboard asked for', async () => {
    const pending = readFirstEvents(`${base}/events?token=${TOKEN}&projectId=proj_a`, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // §48's isolation applies to a stream exactly as it applies to a query.
    emit('proj_b', 1);
    emit('proj_a', 2);

    const text = await pending;
    expect(text).toContain('event 2');
    expect(text).not.toContain('event 1');
  });

  it('carries the sequence number, which is what detects a gap', async () => {
    const pending = readFirstEvents(`${base}/events?token=${TOKEN}`, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    emit('proj_a', 7);

    const text = await pending;
    expect(text).toContain('id: 7');
    expect(text).toContain('event: STATUS');
  });

  it('stops subscribing when the client goes away', async () => {
    const before = server.eventBus.listenerCount;

    const connection = httpRequest({
      host: '127.0.0.1',
      port: gateway.listening?.port,
      path: `/events?token=${TOKEN}`,
      method: 'GET',
    });
    // Destroying an open stream resets the socket, which Node reports as an
    // error on the client. Expected here, and swallowed so it does not surface
    // as an unhandled exception.
    connection.on('error', () => undefined);
    connection.end();

    await vi.waitFor(() => {
      expect(server.eventBus.listenerCount).toBeGreaterThan(before);
    });

    connection.destroy();

    // A stream that leaks a subscription per reload leaks memory for the life
    // of the process.
    await vi.waitFor(() => {
      expect(server.eventBus.listenerCount).toBe(before);
    });
  });
});

describe('the token itself', () => {
  it('is generated per process rather than fixed', async () => {
    const bus = new EventBus();
    const first = new HttpGateway({ gateway: server.methodTable, bus });
    const second = new HttpGateway({ gateway: server.methodTable, bus });

    const a = await first.listen();
    const b = await second.listen();

    // A token in configuration is a token in a repository.
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThan(32);

    await first.close();
    await second.close();
  });
});
