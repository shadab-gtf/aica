import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ScriptedProvider } from '@aica/agent-core';
import { RpcConnection, createTransportPair } from '@aica/rpc';
import { clientMethods } from '@aica/schemas';
import { SupabaseStore } from './store/supabase.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentServer } from './server.js';

/**
 * Persistence, end to end, against a real Postgres.
 *
 * The store's own suite proves the class does the right thing against a fake
 * PostgREST. This proves the *server* is wired to it: that opening a project
 * writes a row, that indexing writes a projection, and that a run and its
 * events survive somewhere other than memory.
 *
 * Skipped when no stack is configured, rather than failed. A build machine
 * without Docker should report "not run", never a red test it cannot fix:
 *
 *   pnpm db:start
 *   AICA_TEST_SUPABASE_URL=http://127.0.0.1:54321 \
 *   AICA_TEST_SUPABASE_SERVICE_KEY=<the secret key> \
 *   pnpm vitest run apps/agent-server/src/persistence.test.ts
 */

const URL = process.env['AICA_TEST_SUPABASE_URL'];
const KEY = process.env['AICA_TEST_SUPABASE_SERVICE_KEY'];
const live = URL !== undefined && KEY !== undefined;

let root = '';
let client: RpcConnection;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aica-persist-'));
  await mkdir(path.join(root, 'src'), { recursive: true });

  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'target', type: 'module' }),
    'utf8',
  );
  await writeFile(
    path.join(root, 'src/client.ts'),
    'export async function fetchOrders(): Promise<unknown> {\n  return fetch("/orders");\n}\n',
    'utf8',
  );

  // The reference is `env:`, and the resolver reads it from the environment —
  // so the key travels the same path a real project's would, rather than being
  // handed to the store directly.
  await writeFile(
    path.join(root, 'agent.config.json'),
    JSON.stringify({
      model: { provider: 'scripted', model: 'scripted/persist' },
      database: {
        enabled: true,
        url: URL ?? 'http://127.0.0.1:54321',
        serviceKeyRef: 'env:AICA_TEST_SUPABASE_SERVICE_KEY',
      },
    }),
    'utf8',
  );
});

afterEach(async () => {
  client?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

function connect() {
  const [clientSide, serverSide] = createTransportPair();
  client = new RpcConnection({ transport: clientSide, requestTimeoutMs: 60_000 });
  const server = new RpcConnection({ transport: serverSide, requestTimeoutMs: 60_000 });

  new AgentServer({
    connection: server,
    provider: new ScriptedProvider({
      turns: [{ text: 'Looked around.', stopReason: 'end_turn' }],
      model: 'scripted/persist',
    }),
  });

  return (method: string, params?: unknown) => client.request(method, params);
}

describe.skipIf(!live)('a run against a real database', () => {
  it('writes the project, the index, the run, and its events', async () => {
    const call = connect();

    await call(clientMethods.initialize.method, {
      clientName: 'persistence',
      clientVersion: '1',
      capabilities: {},
    });

    const opened = await call(clientMethods.openProject.method, { root });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const projectId = (opened.value as { projectId: string; configIssues: unknown[] }).projectId;
    // A configuration problem here would mean the store silently fell back to
    // memory, and every assertion below would pass against nothing.
    expect((opened.value as { configIssues: unknown[] }).configIssues).toEqual([]);

    await call(clientMethods.indexCode.method, { projectId });
    const started = await call(clientMethods.startRun.method, { projectId, task: 'look around' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const runId = (started.value as { runId: string }).runId;

    // Read back through a *separate* store instance. Reading through the
    // server's own would prove only that it remembers what it just did.
    const store = new SupabaseStore({ url: URL as string, serviceKey: KEY as string });

    const project = await store.getProject(projectId);
    expect(project.ok && project.value?.root).toBe(root);
    // The index projection was written, not just the project row.
    expect(project.ok && (project.value?.fileCount ?? 0)).toBeGreaterThan(0);

    const runs = await store.listRuns(projectId);
    expect(runs.ok && runs.value.map((run) => run.id)).toContain(runId);
    expect(runs.ok && runs.value[0]?.status).toBe('completed');

    const events = await store.listEvents(runId);
    expect(events.ok && events.value.length).toBeGreaterThan(0);
    // Dense and ordered, which is what lets a UI detect a gap.
    if (events.ok) {
      const sequence = events.value.map((event) => event.seq);
      expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
    }

    const symbols = await store.searchSymbols(projectId, 'fetchOrders');
    expect(symbols.ok && symbols.value.map((row) => row.name)).toContain('fetchOrders');
  });

  it('stores no source text, only metadata', async () => {
    const call = connect();

    await call(clientMethods.initialize.method, {
      clientName: 'persistence',
      clientVersion: '1',
      capabilities: {},
    });
    const opened = await call(clientMethods.openProject.method, { root });
    if (!opened.ok) return;

    const projectId = (opened.value as { projectId: string }).projectId;
    await call(clientMethods.indexCode.method, { projectId });

    const store = new SupabaseStore({ url: URL as string, serviceKey: KEY as string });
    const symbols = await store.searchSymbols(projectId, 'fetchOrders');
    expect(symbols.ok).toBe(true);
    if (!symbols.ok) return;

    const serialized = JSON.stringify(symbols.value);
    // The signature is metadata and is kept; the body is content and is not.
    expect(serialized).toContain('fetchOrders');
    expect(serialized).not.toContain('return fetch');
  });
});
