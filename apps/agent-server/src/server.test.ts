import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpcConnection, createTransportPair } from '@aica/rpc';
import { clientMethods, serverMethods } from '@aica/schemas';
import { ErrorCode, ok } from '@aica/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentServer } from './server.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/sample-app',
);

/**
 * The whole server, over the real framing and the real JSON-RPC layer, with
 * only the pipe simulated. Nothing here stubs a handler: a test that mocked the
 * gateway would prove the test harness works and nothing else.
 */
function connect(options: { secretStorage?: boolean; fetchImpl?: typeof fetch } = {}) {
  const [clientSide, serverSide] = createTransportPair();
  const client = new RpcConnection({ transport: clientSide, requestTimeoutMs: 30_000 });
  const server = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });

  const agent = new AgentServer({
    connection: server,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const call = async (method: string, params?: unknown) => client.request(method, params);

  const initialize = async () =>
    call(clientMethods.initialize.method, {
      clientName: 'test',
      clientVersion: '0.0.0',
      capabilities: { secretStorage: options.secretStorage ?? false, approvals: true },
    });

  const openFixture = async () => {
    const opened = await call(clientMethods.openProject.method, { root: FIXTURE_ROOT });
    if (!opened.ok) throw opened.error;
    return (opened.value as { projectId: string }).projectId;
  };

  return { client, server, agent, call, initialize, openFixture };
}

describe('handshake', () => {
  it('reports its version and the methods it answers', async () => {
    const { call, initialize, client } = connect();
    const result = await initialize();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const value = result.value as { protocolVersion: string; methods: string[] };
    expect(value.protocolVersion).toBe('1');
    // The advertised list is the registration list, not a hand-written one, so
    // it cannot fall out of date.
    expect(value.methods).toContain(clientMethods.openProject.method);
    expect(value.methods).toContain(clientMethods.runValidation.method);

    expect(await call('does/not/exist')).toMatchObject({ ok: false });
    client.dispose();
  });
});

describe('parameter validation', () => {
  it('rejects a call with a missing field and names the field', async () => {
    const { call, initialize, client } = connect();
    await initialize();

    const result = await call(clientMethods.openProject.method, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe(ErrorCode.INVALID_INPUT);
    // A caller must be able to fix the call from the message alone.
    expect(result.error.message).toContain('root');
    client.dispose();
  });

  it('rejects a value of the wrong type rather than coercing it', async () => {
    const { call, initialize, client } = connect();
    await initialize();

    const result = await call(clientMethods.searchCode.method, {
      projectId: 'proj_x',
      query: 'orders',
      limit: 'lots',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_INPUT);
    client.dispose();
  });

  it('applies schema defaults so a handler never sees an absent optional', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();
    await call(clientMethods.indexCode.method, { projectId });

    // `limit` is defaulted by the contract, not by the handler.
    const result = await call(clientMethods.searchCode.method, { projectId, query: 'order' });
    expect(result.ok).toBe(true);
    client.dispose();
  });
});

describe('project isolation', () => {
  it('refuses every project-scoped call for an unknown project', async () => {
    const { call, initialize, client } = connect();
    await initialize();

    for (const method of [
      clientMethods.projectStatus.method,
      clientMethods.indexCode.method,
      clientMethods.listApis.method,
    ]) {
      const result = await call(method, { projectId: 'proj_nonexistent' });
      expect(result.ok, method).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    }
    client.dispose();
  });

  it('gives each opened project its own identity and state', async () => {
    const { call, initialize, client } = connect();
    await initialize();

    const first = await call(clientMethods.openProject.method, { root: FIXTURE_ROOT });
    const second = await call(clientMethods.openProject.method, { root: FIXTURE_ROOT });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const a = (first.value as { projectId: string }).projectId;
    const b = (second.value as { projectId: string }).projectId;
    expect(a).not.toBe(b);

    // An API imported into one is not visible from the other.
    await call(clientMethods.importApi.method, {
      projectId: a,
      source: { kind: 'text', text: 'curl https://api.example.com/v1/orders' },
    });

    const listB = await call(clientMethods.listApis.method, { projectId: b });
    expect(listB.ok).toBe(true);
    if (listB.ok) expect((listB.value as { apis: unknown[] }).apis).toHaveLength(0);
    client.dispose();
  });
});

describe('indexing and search', () => {
  it('indexes the fixture and reports counted statistics', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();

    const result = await call(clientMethods.indexCode.method, { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stats = result.value as { files: number; symbols: number; resolutionRate: number };
    expect(stats.files).toBeGreaterThan(0);
    expect(stats.symbols).toBeGreaterThan(0);
    expect(stats.resolutionRate).toBeGreaterThan(0);
    client.dispose();
  });

  it('refuses to search before an index exists rather than returning nothing', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();

    // An empty result would read as "no matches", which is a different and
    // wrong answer to "the index has not been built".
    const result = await call(clientMethods.searchCode.method, { projectId, query: 'orders' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
    client.dispose();
  });

  it('finds the order service by intent words', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();
    await call(clientMethods.indexCode.method, { projectId });

    const result = await call(clientMethods.searchCode.method, {
      projectId,
      query: 'cancel an order',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const matches = (result.value as { matches: { file: string }[] }).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((match) => match.file.includes('orders'))).toBe(true);
    client.dispose();
  });
});

describe('API import', () => {
  it('imports a cURL command and lists it', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();

    const imported = await call(clientMethods.importApi.method, {
      projectId,
      name: 'orders',
      source: { kind: 'text', text: "curl -X POST https://api.example.com/v1/orders -d '{}'" },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value).toMatchObject({ endpointCount: 1 });

    const list = await call(clientMethods.listApis.method, { projectId });
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.value as { apis: unknown[] }).apis).toHaveLength(1);
    client.dispose();
  });

  it('reports a document it cannot parse instead of storing an empty API', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();

    const result = await call(clientMethods.importApi.method, {
      projectId,
      source: { kind: 'text', text: 'this is not a specification of anything' },
    });

    expect(result.ok).toBe(false);
    const list = await call(clientMethods.listApis.method, { projectId });
    if (list.ok) expect((list.value as { apis: unknown[] }).apis).toHaveLength(0);
    client.dispose();
  });

  it('keeps a file import inside the project root', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();

    const result = await call(clientMethods.importApi.method, {
      projectId,
      source: { kind: 'file', path: '../../package.json' },
    });

    expect(result.ok).toBe(false);
    client.dispose();
  });

  it('attaches existing call sites to endpoints it knows about', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();
    await call(clientMethods.indexCode.method, { projectId });

    await call(clientMethods.importApi.method, {
      projectId,
      source: { kind: 'text', text: 'curl https://api.example.com/v1/orders' },
    });

    const result = await call(clientMethods.listEndpoints.method, { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const endpoints = (result.value as { endpoints: { path: string; callSites: unknown[] }[] })
      .endpoints;
    // The cURL command's server is the origin, so the endpoint path carries
    // the `/v1` prefix that the fixture keeps in its BASE_URL constant.
    const orders = endpoints.find((endpoint) => endpoint.path === '/v1/orders');
    expect(orders).toBeDefined();
    expect(orders?.callSites.length).toBeGreaterThan(0);
    client.dispose();
  });
});

describe('planning', () => {
  it('will not plan before the project is indexed', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();

    const result = await call(clientMethods.createPlan.method, {
      projectId,
      message: 'integrate POST /orders',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
    client.dispose();
  });

  it('produces a plan and a brief rendered from it', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();
    await call(clientMethods.indexCode.method, { projectId });
    await call(clientMethods.importApi.method, {
      projectId,
      source: { kind: 'text', text: "curl -X POST https://api.example.com/v1/orders -d '{}'" },
    });

    const planned = await call(clientMethods.createPlan.method, {
      projectId,
      message: 'integrate POST /orders into the order service',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const plan = planned.value as { planId: string; steps: unknown[]; targetFiles: string[] };
    expect(plan.steps.length).toBeGreaterThan(0);
    // A plan that names most of the repository is not a plan.
    expect(plan.targetFiles.length).toBeLessThanOrEqual(3);

    const brief = await call(clientMethods.getPlanBrief.method, {
      projectId,
      planId: plan.planId,
    });
    expect(brief.ok).toBe(true);
    if (brief.ok) expect((brief.value as { brief: string }).brief.length).toBeGreaterThan(0);
    client.dispose();
  });

  it('reports an unknown plan id', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();

    const result = await call(clientMethods.getPlanBrief.method, {
      projectId,
      planId: 'plan_missing',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    client.dispose();
  });
});

describe('impact analysis', () => {
  it('finds what depends on a shared module', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();
    await call(clientMethods.indexCode.method, { projectId });

    const result = await call(clientMethods.analyzeImpact.method, {
      projectId,
      file: 'src/api/client.ts',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = result.value as { files: string[]; blindSpots: unknown[] };
    expect(report.files.length).toBeGreaterThan(0);
    // Blind spots travel with the report: "nothing else is affected" and
    // "nothing else I can prove" must not look the same.
    expect(Array.isArray(report.blindSpots)).toBe(true);
    client.dispose();
  });

  it('refuses an ambiguous or unknown target instead of guessing', async () => {
    const { call, initialize, openFixture, client } = connect();
    await initialize();
    const projectId = await openFixture();
    await call(clientMethods.indexCode.method, { projectId });

    const result = await call(clientMethods.analyzeImpact.method, {
      projectId,
      file: 'src/nowhere.ts',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    client.dispose();
  });
});

describe('secrets', () => {
  it('does not offer Postman when the client cannot store secrets', async () => {
    const { call, initialize, openFixture, client } = connect({ secretStorage: false });
    await initialize();
    const projectId = await openFixture();

    const result = await call(clientMethods.listPostmanWorkspaces.method, { projectId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
    client.dispose();
  });

  it('reports Postman as unconfigured when no key reference is set', async () => {
    const { call, initialize, openFixture, client } = connect({ secretStorage: true });
    await initialize();
    const projectId = await openFixture();

    const status = await call(clientMethods.projectStatus.method, { projectId });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value).toMatchObject({ postmanReady: false });

    const result = await call(clientMethods.listPostmanWorkspaces.method, { projectId });
    expect(result.ok).toBe(false);
    // "Not connected" is a thing the UI has to be able to say.
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.CONFIG_ERROR);
    client.dispose();
  });

  it('asks the editor for a secret rather than reading the environment', async () => {
    const readSecret = vi.fn(async () => ok({ found: true, value: 'pmak-test-value' }));
    const fetchImpl = vi.fn(async () =>
      Response.json({ workspaces: [{ id: 'w1', name: 'Team', type: 'team' }] }),
    ) as unknown as typeof fetch;

    const [clientSide, serverSide] = createTransportPair();
    const client = new RpcConnection({ transport: clientSide, requestTimeoutMs: 30_000 });
    const server = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });
    new AgentServer({ connection: server, fetchImpl });

    client.onRequest(serverMethods.readSecret.method, readSecret);

    await client.request(clientMethods.initialize.method, {
      clientName: 'test',
      clientVersion: '0.0.0',
      capabilities: { secretStorage: true, approvals: true },
    });

    const opened = await client.request(clientMethods.openProject.method, {
      root: POSTMAN_FIXTURE_ROOT,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const projectId = (opened.value as { projectId: string }).projectId;

    const result = await client.request(clientMethods.listPostmanWorkspaces.method, { projectId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { workspaces: { id: string }[] }).workspaces).toEqual([
        { id: 'w1', name: 'Team', type: 'team' },
      ]);
    }

    // The server asked the editor, and told it why.
    expect(readSecret).toHaveBeenCalledTimes(1);
    const [params] = readSecret.mock.calls[0] as unknown as [{ name: string; reason: string }];
    expect(params.name).toBe('postman');
    expect(params.reason).toBeTruthy();

    // And the key went to Postman in the documented header, not to the log.
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('X-API-Key')).toBe('pmak-test-value');

    client.dispose();
  });

  it('fails the call when the editor has no such secret', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const [clientSide, serverSide] = createTransportPair();
    const client = new RpcConnection({ transport: clientSide, requestTimeoutMs: 30_000 });
    const server = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });
    new AgentServer({ connection: server, fetchImpl });

    client.onRequest(serverMethods.readSecret.method, async () => ok({ found: false }));

    await client.request(clientMethods.initialize.method, {
      clientName: 'test',
      clientVersion: '0.0.0',
      capabilities: { secretStorage: true, approvals: true },
    });
    const opened = await client.request(clientMethods.openProject.method, {
      root: POSTMAN_FIXTURE_ROOT,
    });
    if (!opened.ok) throw opened.error;
    const projectId = (opened.value as { projectId: string }).projectId;

    const result = await client.request(clientMethods.listPostmanWorkspaces.method, { projectId });
    expect(result.ok).toBe(false);
    // No request was attempted with a missing credential.
    expect(fetchImpl).not.toHaveBeenCalled();
    client.dispose();
  });
});

/**
 * A project directory whose configuration points Postman at the editor's
 * keychain. Written per-test so the fixture repository stays a plain sample app
 * with no agent configuration of its own.
 */
let POSTMAN_FIXTURE_ROOT = '';

beforeEach(async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  POSTMAN_FIXTURE_ROOT = await mkdtemp(path.join(tmpdir(), 'aica-postman-'));
  await writeFile(
    path.join(POSTMAN_FIXTURE_ROOT, 'agent.config.json'),
    JSON.stringify({ postman: { apiKeyRef: 'keychain:postman' } }),
    'utf8',
  );
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  if (POSTMAN_FIXTURE_ROOT) await rm(POSTMAN_FIXTURE_ROOT, { recursive: true, force: true });
});
