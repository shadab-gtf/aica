import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseApiSource } from '@aica/api-engine';
import { buildGraph } from '@aica/code-graph';
import { Indexer } from '@aica/code-intelligence';
import { WorkspaceReader } from '@aica/fs-engine';
import { PathPolicy } from '@aica/security-engine';
import { unwrap } from '@aica/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { FORBIDDEN_COLUMN_NAMES } from './contract.js';
import { MemoryStore } from './memory.js';
import { toApiSnapshot, toIndexSnapshot } from './project-rows.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'fixtures/sample-app');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/20260905120000_init.sql');

/**
 * The rule the user chose — metadata only, never file contents — held to by the
 * schema, by the mappers, and by the store. Each is checked separately, because
 * a rule enforced in one place is a rule that leaks the first time someone adds
 * a column.
 */
describe('the schema never gains a column for file contents', () => {
  let sql = '';

  beforeAll(async () => {
    sql = (await readFile(MIGRATION, 'utf8')).toLowerCase();
  });

  it('declares no forbidden column', () => {
    // Column declarations only: the file's own prose names these words in the
    // course of explaining why they are absent.
    const declarations = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((word): word is string => word !== undefined);

    for (const forbidden of FORBIDDEN_COLUMN_NAMES) {
      expect(declarations, `column "${forbidden}" must not exist`).not.toContain(forbidden);
    }
  });

  it('scopes every project-owned table by project_id', () => {
    // §48: isolation should not depend on remembering to add a filter.
    for (const table of ['files', 'symbols', 'refs', 'graph_edges', 'apis', 'endpoints', 'runs']) {
      const start = sql.indexOf(`create table if not exists ${table} (`);
      expect(start, `table ${table} is missing`).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf(');', start));
      expect(body, `${table} must carry project_id`).toContain('project_id');
    }
  });

  it('enables row-level security so a non-service key reads nothing', () => {
    expect(sql).toContain('enable row level security');
    // No policy is granted anywhere: the service role bypasses RLS, everything
    // else is denied by default.
    expect(sql).not.toContain('create policy');
  });
});

describe('mapping an index to rows', () => {
  let snapshot: ReturnType<typeof toIndexSnapshot>;

  beforeAll(async () => {
    const pathPolicy = new PathPolicy({ root: FIXTURE_ROOT });
    const reader = new WorkspaceReader({ pathPolicy });
    const index = unwrap(await new Indexer({ reader, pathPolicy }).build());
    snapshot = toIndexSnapshot(index, buildGraph(index));
  });

  it('keeps signatures, which say what a declaration is', () => {
    const fetchOrders = snapshot.symbols.find((symbol) => symbol.name === 'fetchOrders');
    expect(fetchOrders?.signature).toContain('fetchOrders');
  });

  it('drops doc comments, which are prose from the file', () => {
    // The distinction the user asked for: a signature is metadata, a doc
    // comment is content.
    for (const symbol of snapshot.symbols) {
      expect(Object.keys(symbol)).not.toContain('doc');
    }
  });

  it('carries no field holding file text', () => {
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('response.json()');
    expect(serialized).not.toContain('const query = new URLSearchParams');
  });

  it('preserves which references could not be attributed', () => {
    // These are the blind spots an impact report has to admit to; losing them
    // would turn "nothing else I can prove" into "nothing else".
    const unattributed = snapshot.references.filter(
      (reference) => reference.symbolId === undefined,
    );
    expect(unattributed.length).toBeGreaterThan(0);
  });

  it('counts what it stored', () => {
    expect(snapshot.stats.files).toBe(snapshot.files.length);
    expect(snapshot.stats.symbols).toBe(snapshot.symbols.length);
    expect(snapshot.edges.length).toBeGreaterThan(0);
  });
});

describe('mapping an API to rows', () => {
  it('keeps the specification in full, including component schemas', () => {
    const spec = unwrap(
      parseApiSource(
        [
          'openapi: 3.0.3',
          'info: { title: Orders, version: "1" }',
          'components:',
          '  schemas:',
          '    Order: { type: object, properties: { id: { type: string } } }',
          'paths:',
          '  /orders:',
          '    get: { operationId: listOrders, summary: List orders, responses: { "200": { description: ok } } }',
        ].join('\n'),
      ),
    );

    const snapshot = toApiSnapshot(spec, 'openapi3');
    expect(snapshot.api.title).toBe('Orders');
    expect(snapshot.endpoints).toHaveLength(1);
    expect(snapshot.endpoints[0]?.operationId).toBe('listOrders');
    // An API document is the user's own documentation, not their source: it is
    // durable state and is kept whole.
    expect(snapshot.schemas.map((schema) => schema.name)).toContain('Order');
  });

  it('records whether an endpoint needs authentication', () => {
    const spec = unwrap(
      parseApiSource(
        [
          'openapi: 3.0.3',
          'info: { title: Secure, version: "1" }',
          'components: { securitySchemes: { bearerAuth: { type: http, scheme: bearer } } }',
          'security: [{ bearerAuth: [] }]',
          'paths:',
          '  /private:',
          '    get: { responses: { "200": { description: ok } } }',
          '  /public:',
          '    get: { security: [], responses: { "200": { description: ok } } }',
        ].join('\n'),
      ),
    );

    const snapshot = toApiSnapshot(spec, 'openapi3');
    const byPath = new Map(snapshot.endpoints.map((endpoint) => [endpoint.path, endpoint]));

    expect(byPath.get('/private')?.requiresAuth).toBe(true);
    // An endpoint declaring `security: []` is explicitly public, which is not
    // the same as one that declares nothing.
    expect(byPath.get('/public')?.requiresAuth).toBe(false);
  });

  it('stores scheme names, never a credential', () => {
    const spec = unwrap(
      parseApiSource(
        [
          'openapi: 3.0.3',
          'info: { title: Keyed, version: "1" }',
          'components: { securitySchemes: { apiKey: { type: apiKey, in: header, name: X-API-Key } } }',
          'paths: { /x: { get: { responses: { "200": { description: ok } } } } }',
        ].join('\n'),
      ),
    );

    const serialized = JSON.stringify(toApiSnapshot(spec, 'openapi3'));
    expect(serialized).toContain('apiKey');
    expect(serialized).not.toMatch(/sk-|Bearer\s+[A-Za-z0-9]/);
  });
});

describe('the in-memory store', () => {
  function project(id = 'proj_1') {
    return {
      id,
      name: 'sample',
      root: '/tmp/sample',
      fileCount: 0,
      symbolCount: 0,
      referenceCount: 0,
      resolutionRate: 0,
    };
  }

  it('records a project and updates its counts when an index arrives', async () => {
    const store = new MemoryStore();
    await store.saveProject(project());

    await store.replaceIndex('proj_1', {
      files: [{ path: 'a.ts', bytes: 10, lines: 1 }],
      symbols: [],
      references: [],
      edges: [],
      stats: { files: 1, symbols: 0, references: 0, resolutionRate: 0.5 },
    });

    const stored = await store.getProject('proj_1');
    expect(stored.ok && stored.value?.fileCount).toBe(1);
    expect(stored.ok && stored.value?.resolutionRate).toBe(0.5);
  });

  it('replaces an index rather than merging into it', async () => {
    const store = new MemoryStore();
    await store.saveProject(project());

    const symbol = (id: string) => ({
      id,
      path: 'a.ts',
      name: id,
      kind: 'function',
      exported: true,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
      isAsync: false,
      deprecated: false,
    });

    await store.replaceIndex('proj_1', {
      files: [],
      symbols: [symbol('gone'), symbol('kept')],
      references: [],
      edges: [],
      stats: { files: 0, symbols: 2, references: 0, resolutionRate: 1 },
    });

    await store.replaceIndex('proj_1', {
      files: [],
      symbols: [symbol('kept')],
      references: [],
      edges: [],
      stats: { files: 0, symbols: 1, references: 0, resolutionRate: 1 },
    });

    // A symbol that was deleted from the source must disappear, or a later
    // search reports a declaration that no longer exists.
    const found = await store.searchSymbols('proj_1', 'gone');
    expect(found.ok && found.value).toHaveLength(0);
  });

  it('keeps projects apart', async () => {
    const store = new MemoryStore();
    await store.saveProject(project('proj_a'));
    await store.saveProject(project('proj_b'));

    await store.saveApi('proj_a', {
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

    const forB = await store.listApis('proj_b');
    expect(forB.ok && forB.value).toHaveLength(0);
  });

  it('drops a run patch for a run that was never started', async () => {
    const store = new MemoryStore();
    await store.finishRun('run_ghost', { status: 'completed' });

    const runs = await store.listRuns('proj_1');
    // Inventing a row from a partial would produce a run record with no task.
    expect(runs.ok && runs.value).toHaveLength(0);
  });

  it('returns events in sequence order and honours a cursor', async () => {
    const store = new MemoryStore();
    for (const seq of [3, 1, 2]) {
      await store.appendEvent({
        id: `evt_${seq}`,
        runId: 'run_1',
        projectId: 'proj_1',
        seq,
        type: 'STATUS',
        at: new Date().toISOString(),
        payload: {},
      });
    }

    const all = await store.listEvents('run_1');
    expect(all.ok && all.value.map((event) => event.seq)).toEqual([1, 2, 3]);

    const since = await store.listEvents('run_1', 1);
    expect(since.ok && since.value.map((event) => event.seq)).toEqual([2, 3]);
  });

  it('ranks exported symbols above local ones', async () => {
    const store = new MemoryStore();
    const base = {
      path: 'a.ts',
      kind: 'function',
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
      isAsync: false,
      deprecated: false,
    };

    await store.replaceIndex('proj_1', {
      files: [],
      symbols: [
        { ...base, id: 'a#localOrder', name: 'localOrder', exported: false },
        { ...base, id: 'a#publicOrder', name: 'publicOrder', exported: true },
      ],
      references: [],
      edges: [],
      stats: { files: 0, symbols: 2, references: 0, resolutionRate: 1 },
    });

    const found = await store.searchSymbols('proj_1', 'order');
    expect(found.ok && found.value[0]?.name).toBe('publicOrder');
  });
});
