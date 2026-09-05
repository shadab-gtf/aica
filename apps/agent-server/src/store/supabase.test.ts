import { describe, expect, it } from 'vitest';

import { SUPABASE_DEFAULT_URL, SupabaseStore } from './supabase.js';
import { MemoryStore } from './memory.js';
import type { Store } from './contract.js';

/**
 * The Postgres store.
 *
 * Split in two on purpose.
 *
 * The behaviour tests run against a **fake client** — an in-process stand-in
 * for the PostgREST surface. They are what CI runs: they check the decisions
 * this class makes (delete-then-insert rather than upsert, batching, service
 * role, error shape) without requiring Docker on a build machine.
 *
 * The contract tests run against a **real local stack** when one is up, and
 * skip otherwise, with the same assertions the in-memory store has to satisfy.
 * A store that passes one and fails the other is a bug in one of them, and
 * without this pairing it would be a bug nobody notices until someone turns the
 * database on.
 */

// ---------------------------------------------------------------------------
// A fake PostgREST surface
// ---------------------------------------------------------------------------

interface Recorded {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  rows?: unknown[];
  filters: [string, unknown][];
}

function fakeClient(options: { rows?: Record<string, unknown[]>; failOn?: string } = {}) {
  const calls: Recorded[] = [];
  const data = options.rows ?? {};

  const builder = (table: string, op: Recorded['op'], rows?: unknown[]) => {
    const record: Recorded = { table, op, filters: [] };
    if (rows) record.rows = rows;
    calls.push(record);

    const result =
      options.failOn === table
        ? { data: null, error: { message: 'boom', code: '42P01' } }
        : { data: data[table] ?? [], error: null };

    // Every builder method returns the same thenable, which is how the real
    // client chains. `await` on it resolves to the result.
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };

    for (const method of [
      'select',
      'eq',
      'gt',
      'order',
      'limit',
      'textSearch',
      'maybeSingle',
      'single',
    ]) {
      chain[method] = (...args: unknown[]) => {
        if (method === 'eq' || method === 'gt') {
          record.filters.push([String(args[0]), args[1]]);
        }
        if (method === 'maybeSingle' || method === 'single') {
          return Promise.resolve({
            data: (data[table] ?? [])[0] ?? null,
            error: options.failOn === table ? { message: 'boom' } : null,
          });
        }
        return chain;
      };
    }

    return chain;
  };

  return {
    calls,
    client: {
      from: (table: string) => ({
        select: (...args: unknown[]) => {
          const chain = builder(table, 'select');
          void args;
          return chain;
        },
        insert: (rows: unknown[]) => builder(table, 'insert', rows),
        upsert: (row: unknown) => builder(table, 'upsert', [row]),
        update: (row: unknown) => builder(table, 'update', [row]),
        delete: () => builder(table, 'delete'),
      }),
    } as never,
  };
}

function store(fake: ReturnType<typeof fakeClient>, batchSize = 500): SupabaseStore {
  return new SupabaseStore({
    url: SUPABASE_DEFAULT_URL,
    serviceKey: 'service-role-key',
    client: fake.client,
    batchSize,
  });
}

const emptySnapshot = {
  files: [],
  symbols: [],
  references: [],
  edges: [],
  stats: { files: 0, symbols: 0, references: 0, resolutionRate: 0 },
};

describe('the Postgres store', () => {
  it('checks the schema exists, not merely that the port answers', async () => {
    const fake = fakeClient();
    expect(await store(fake).health()).toMatchObject({ ok: true });

    // A select against a table the migration creates proves reachability, key
    // acceptance and migration state in one call.
    expect(fake.calls[0]).toMatchObject({ table: 'projects', op: 'select' });
  });

  it('reports an unmigrated database as a configuration problem, with the fix', async () => {
    const fake = fakeClient({ failOn: 'projects' });
    const result = await store(fake).health();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('db:start');
      expect(result.error.message).toContain('db:push');
    }
  });

  it('replaces an index rather than merging into it', async () => {
    const fake = fakeClient();
    await store(fake).replaceIndex('proj_1', {
      ...emptySnapshot,
      files: [{ path: 'a.ts', bytes: 1, lines: 1 }],
      stats: { files: 1, symbols: 0, references: 0, resolutionRate: 1 },
    });

    const deletes = fake.calls.filter((call) => call.op === 'delete').map((call) => call.table);
    // A symbol removed from the source must disappear. An upsert would leave it
    // to be found by a later search that confidently reports a declaration
    // which no longer exists.
    expect(deletes).toEqual(['refs', 'graph_edges', 'symbols', 'files']);
    expect(deletes.every((table) => table !== 'apis')).toBe(true);
  });

  it('deletes children before parents and inserts them the other way round', async () => {
    const fake = fakeClient();
    await store(fake).replaceIndex('proj_1', {
      ...emptySnapshot,
      files: [{ path: 'a.ts', bytes: 1, lines: 1 }],
      symbols: [
        {
          id: 'a.ts#x',
          path: 'a.ts',
          name: 'x',
          kind: 'function',
          exported: true,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
          isAsync: false,
          deprecated: false,
        },
      ],
      references: [{ path: 'a.ts', name: 'x', kind: 'call', line: 2, column: 1, isMember: false }],
    });

    const inserts = fake.calls.filter((call) => call.op === 'insert').map((call) => call.table);
    expect(inserts.indexOf('symbols')).toBeLessThan(inserts.indexOf('refs'));
  });

  it('batches large inserts instead of sending one enormous statement', async () => {
    const fake = fakeClient();
    const references = Array.from({ length: 250 }, (_, index) => ({
      path: 'a.ts',
      name: `ref${index}`,
      kind: 'read',
      line: index,
      column: 1,
      isMember: false,
    }));

    await store(fake, 100).replaceIndex('proj_1', { ...emptySnapshot, references });

    const refInserts = fake.calls.filter((call) => call.op === 'insert' && call.table === 'refs');
    // Postgres would take all 250; the request body is what times out.
    expect(refInserts).toHaveLength(3);
    expect(refInserts[0]?.rows).toHaveLength(100);
    expect(refInserts[2]?.rows).toHaveLength(50);
  });

  it('sends nothing when there is nothing to send', async () => {
    const fake = fakeClient();
    await store(fake).recordFindings([]);
    expect(fake.calls.filter((call) => call.op === 'insert')).toHaveLength(0);
  });

  it('scopes every read by project', async () => {
    const fake = fakeClient();
    await store(fake).searchSymbols('proj_1', 'order');

    const search = fake.calls.find((call) => call.table === 'symbols');
    expect(search?.filters).toContainEqual(['project_id', 'proj_1']);
  });

  it('does not query on an empty search string', async () => {
    const fake = fakeClient();
    const result = await store(fake).searchSymbols('proj_1', '   ');

    expect(result).toMatchObject({ ok: true, value: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it('replaces an API specification when it is re-imported', async () => {
    const fake = fakeClient();
    await store(fake).saveApi('proj_1', {
      api: {
        id: 'orders',
        title: 'Orders',
        format: 'openapi3',
        servers: [],
        authSchemes: [],
        warnings: [],
      },
      endpoints: [],
      schemas: [],
    });

    const deletes = fake.calls.filter((call) => call.op === 'delete').map((call) => call.table);
    // An endpoint removed upstream must not linger in the catalog as something
    // still callable.
    expect(deletes).toEqual(['endpoints', 'api_schemas']);
  });

  it('sends nothing for a run patch with no fields', async () => {
    const fake = fakeClient();
    await store(fake).finishRun('run_1', {});
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a write failure as retryable, naming the table', async () => {
    const fake = fakeClient({ failOn: 'runs' });
    const result = await store(fake).finishRun('run_1', { status: 'completed' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The usual cause is the local stack still coming up.
      expect(result.error.retryable).toBe(true);
      expect(result.error.details['table']).toBe('runs');
    }
  });

  it('upserts an event by id so a replay does not double it', async () => {
    const fake = fakeClient();
    await store(fake).appendEvent({
      id: 'evt_1',
      runId: 'run_1',
      projectId: 'proj_1',
      seq: 1,
      type: 'STATUS',
      at: new Date().toISOString(),
      payload: { message: 'hello' },
    });

    // Sequence numbers are what a late-joining UI uses to detect gaps; a
    // duplicated event would look like a missing one somewhere else.
    expect(fake.calls[0]).toMatchObject({ table: 'run_events', op: 'upsert' });
  });
});

// ---------------------------------------------------------------------------
// The same contract, against a real stack
// ---------------------------------------------------------------------------

const LIVE_URL = process.env['AICA_TEST_SUPABASE_URL'];
const LIVE_KEY = process.env['AICA_TEST_SUPABASE_SERVICE_KEY'];
const live = LIVE_URL !== undefined && LIVE_KEY !== undefined;

describe.skipIf(!live)('against a running local stack', () => {
  /**
   * Run with a stack up:
   *
   *   pnpm db:start && pnpm db:push
   *   AICA_TEST_SUPABASE_URL=http://127.0.0.1:54321 \
   *   AICA_TEST_SUPABASE_SERVICE_KEY=$(supabase status -o json | jq -r .SERVICE_ROLE_KEY) \
   *   pnpm vitest run apps/agent-server/src/store
   *
   * Skipped otherwise rather than failed: a build machine without Docker should
   * report "not run", never a red test it cannot fix.
   */
  const stores: Store[] = [];

  function connect(): Store {
    const created = new SupabaseStore({ url: LIVE_URL as string, serviceKey: LIVE_KEY as string });
    stores.push(created);
    return created;
  }

  it('is reachable and migrated', async () => {
    expect(await connect().health()).toMatchObject({ ok: true });
  });

  it('round-trips a project through Postgres', async () => {
    const db = connect();
    const id = `proj_test_${Date.now()}`;

    await db.saveProject({
      id,
      name: 'test',
      root: '/tmp/test',
      fileCount: 0,
      symbolCount: 0,
      referenceCount: 0,
      resolutionRate: 0,
    });

    const stored = await db.getProject(id);
    expect(stored.ok && stored.value?.name).toBe('test');
  });

  it('answers a symbol search the same way the in-memory store does', async () => {
    const db = connect();
    const memory = new MemoryStore();
    const id = `proj_search_${Date.now()}`;

    const project = {
      id,
      name: 'test',
      root: '/tmp/test',
      fileCount: 0,
      symbolCount: 0,
      referenceCount: 0,
      resolutionRate: 0,
    };
    await db.saveProject(project);
    await memory.saveProject(project);

    const snapshot = {
      files: [{ path: 'a.ts', bytes: 1, lines: 1 }],
      symbols: [
        {
          id: 'a.ts#createOrder',
          path: 'a.ts',
          name: 'createOrder',
          kind: 'function',
          exported: true,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
          isAsync: false,
          deprecated: false,
        },
      ],
      references: [],
      edges: [],
      stats: { files: 1, symbols: 1, references: 0, resolutionRate: 1 },
    };

    await db.replaceIndex(id, snapshot);
    await memory.replaceIndex(id, snapshot);

    const fromDb = await db.searchSymbols(id, 'createOrder');
    const fromMemory = await memory.searchSymbols(id, 'createOrder');

    expect(fromDb.ok && fromDb.value.map((row) => row.name)).toEqual(
      fromMemory.ok ? fromMemory.value.map((row) => row.name) : [],
    );
  });
});
