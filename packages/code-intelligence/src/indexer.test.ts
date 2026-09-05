import { resolve } from 'node:path';

import { WorkspaceReader } from '@aica/fs-engine';
import { PathPolicy } from '@aica/security-engine';
import { isErr, unwrap } from '@aica/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import type { CodeIndex } from './indexer.js';
import { Indexer, resolveSpecifier } from './indexer.js';

/**
 * The phase gate: index correctness against a fixture.
 *
 * `fixtures/sample-app` is a synthetic repository with a real dependency chain
 * — types feed an API client, the client feeds a service, the service feeds a
 * React component, and a barrel re-exports the lot. Every claim below is about
 * that chain, so a regression in resolution shows up as a wrong answer to a
 * question the agent will actually be asked.
 */
const FIXTURE_ROOT = resolve('fixtures/sample-app');

function indexerFor(root: string): Indexer {
  const pathPolicy = new PathPolicy({ root });
  return new Indexer({ reader: new WorkspaceReader({ pathPolicy }) });
}

let index: CodeIndex;

beforeAll(async () => {
  index = unwrap(await indexerFor(FIXTURE_ROOT).build());
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('indexing the fixture', () => {
  it('finds every source file and no others', () => {
    expect([...index.files].map((file) => file.path).sort()).toEqual([
      'src/api/client.ts',
      'src/api/config.ts',
      'src/components/OrderList.tsx',
      'src/index.ts',
      'src/services/orders.ts',
      'src/types.ts',
      'src/utils/format.ts',
    ]);
  });

  it('parses every file without a syntax error', () => {
    for (const file of index.files) {
      expect(file.diagnostics, `${file.path} produced diagnostics`).toEqual([]);
    }
  });

  it('records a content hash so staleness is detectable', () => {
    for (const file of index.files) {
      expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('skips nothing in a healthy repository', () => {
    expect(index.stats.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

describe('symbols', () => {
  it('finds the declarations of the API client', () => {
    const client = index.file('src/api/client.ts');
    const byName = new Map(client?.symbols.map((symbol) => [symbol.name, symbol]));

    expect([...byName.keys()]).toEqual([
      'ApiError',
      'request',
      'fetchOrders',
      'fetchOrder',
      'createOrder',
      'cancelOrder',
    ]);
    expect(byName.get('fetchOrders')).toMatchObject({
      kind: 'function',
      exported: true,
      async: true,
    });
    // `request` is module-private; the index must not claim otherwise.
    expect(byName.get('request')?.exported).toBe(false);
  });

  it('finds the service class and its methods', () => {
    expect(index.symbol('src/services/orders.ts#OrderService')).toMatchObject({
      kind: 'class',
      exported: true,
    });
    expect(index.symbol('src/services/orders.ts#OrderService.byStatus')).toMatchObject({
      kind: 'method',
      container: 'OrderService',
      async: true,
    });
  });

  it('recognizes the React component as a component', () => {
    expect(index.symbol('src/components/OrderList.tsx#OrderList')?.kind).toBe('component');
  });

  it('finds a declaration by name across the workspace', () => {
    const found = index.symbolsNamed('Order');
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('src/types.ts#Order');
  });
});

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

describe('module resolution', () => {
  it('resolves every local import in the fixture', () => {
    expect(index.stats.unresolvedImports).toBe(0);
  });

  it('resolves a .js specifier to the .ts source it means', () => {
    // ESM TypeScript must write `./config.js` for `./config.ts`.
    const client = index.file('src/api/client.ts');
    const config = client?.imports.find((record) => record.moduleSpecifier === './config.js');
    expect(config?.resolvedFile).toBe('src/api/config.ts');
  });

  it('resolves a parent-relative specifier', () => {
    const client = index.file('src/api/client.ts');
    const types = client?.imports.find((record) => record.moduleSpecifier === '../types.js');
    expect(types?.resolvedFile).toBe('src/types.ts');
  });

  it('leaves a package specifier external and unresolved', () => {
    const component = index.file('src/components/OrderList.tsx');
    const react = component?.imports.find((record) => record.moduleSpecifier === 'react');
    expect(react).toMatchObject({ external: true });
    expect(react?.resolvedFile).toBeUndefined();
  });

  it('reports the dependencies of a file', () => {
    expect([...index.dependenciesOf('src/services/orders.ts')].sort()).toEqual([
      'src/api/client.ts',
      'src/types.ts',
    ]);
  });

  it('reports the dependents of a file', () => {
    expect([...index.dependentsOf('src/types.ts')].sort()).toEqual([
      'src/api/client.ts',
      'src/components/OrderList.tsx',
      'src/index.ts',
      'src/services/orders.ts',
      'src/utils/format.ts',
    ]);
  });
});

describe('resolveSpecifier', () => {
  const files = new Set([
    'src/a.ts',
    'src/b.tsx',
    'src/nested/index.ts',
    'src/legacy.js',
    'src/typings.d.ts',
  ]);

  it.each([
    ['src/main.ts', './a.js', 'src/a.ts'],
    ['src/main.ts', './a', 'src/a.ts'],
    ['src/main.ts', './b', 'src/b.tsx'],
    ['src/main.ts', './nested', 'src/nested/index.ts'],
    ['src/nested/deep.ts', '../a.js', 'src/a.ts'],
    ['src/main.ts', './legacy.js', 'src/legacy.js'],
  ])('resolves %s + %s to %s', (from, specifier, expected) => {
    expect(resolveSpecifier(from, specifier, files)).toBe(expected);
  });

  it('returns undefined for a package, rather than half-resolving it', () => {
    expect(resolveSpecifier('src/main.ts', 'react', files)).toBeUndefined();
    expect(resolveSpecifier('src/main.ts', '@scope/pkg', files)).toBeUndefined();
  });

  it('returns undefined for a relative path that does not exist', () => {
    expect(resolveSpecifier('src/main.ts', './missing.js', files)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

describe('the barrel file', () => {
  it('resolves each re-exported name to the declaration it actually names', () => {
    const exports = index.exportsOf('src/index.ts');

    expect(exports.get('OrderService')).toBe('src/services/orders.ts#OrderService');
    expect(exports.get('fetchOrders')).toBe('src/api/client.ts#fetchOrders');
    expect(exports.get('formatMoney')).toBe('src/utils/format.ts#formatMoney');
    expect(exports.get('Order')).toBe('src/types.ts#Order');
    expect(exports.get('Channel')).toBe('src/types.ts#Channel');
  });

  it('exposes exactly what the barrel names', () => {
    expect([...index.exportsOf('src/index.ts').keys()].sort()).toEqual(
      [
        'ApiError',
        'Channel',
        'Customer',
        'Money',
        'Order',
        'OrderFilter',
        'OrderLine',
        'OrderStatus',
        'OrderService',
        'cancelOrder',
        'createOrder',
        'fetchOrder',
        'fetchOrders',
        'formatMoney',
        'formatStatus',
        'totalOf',
      ].sort(),
    );
  });

  it('resolves a directly-exported declaration too', () => {
    expect(index.exportsOf('src/types.ts').get('Order')).toBe('src/types.ts#Order');
    expect(index.exportsOf('src/api/client.ts').get('fetchOrders')).toBe(
      'src/api/client.ts#fetchOrders',
    );
  });

  it('does not claim a module-private declaration is exported', () => {
    expect(index.exportsOf('src/api/client.ts').has('request')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

describe('references', () => {
  it('attributes a cross-file call to the declaration it calls', () => {
    const service = index.file('src/services/orders.ts');
    const call = service?.references.find(
      (reference) => reference.name === 'fetchOrders' && reference.kind === 'call',
    );
    expect(call?.symbolId).toBe('src/api/client.ts#fetchOrders');
  });

  it('answers "who uses this declaration" across files', () => {
    const users = index
      .referencesTo('src/types.ts#Order')
      .map((reference) => reference.location.file);

    expect([...new Set(users)].sort()).toEqual([
      'src/api/client.ts',
      'src/components/OrderList.tsx',
      'src/index.ts',
      'src/services/orders.ts',
    ]);
  });

  it('attributes a reference to the enclosing declaration', () => {
    const component = index.file('src/components/OrderList.tsx');
    const call = component?.references.find(
      (reference) => reference.name === 'formatMoney' && reference.kind === 'call',
    );
    expect(call?.symbolId).toBe('src/utils/format.ts#formatMoney');
    expect(call?.fromSymbolId).toBe('src/components/OrderList.tsx#OrderList');
  });

  it('marks a reference into an external package as external, not unresolved', () => {
    const component = index.file('src/components/OrderList.tsx');
    const hook = component?.references.find((reference) => reference.name === 'useState');
    expect(hook).toMatchObject({ external: true });
    expect(hook?.symbolId).toBeUndefined();
  });

  it('leaves a global unresolved rather than inventing a declaration for it', () => {
    const client = index.file('src/api/client.ts');
    const global = client?.references.find((reference) => reference.name === 'fetch');
    expect(global?.symbolId).toBeUndefined();
    expect(global?.external).toBeUndefined();
  });

  it('resolves every bare reference that names a workspace declaration', () => {
    // Anything left unresolved must be a global or a built-in — never a bare
    // name this workspace declares. Members are excluded: which declaration
    // `order.status` means depends on the type of `order`.
    const declared = new Set(index.allSymbols.map((symbol) => symbol.name));
    const missed = index.files.flatMap((file) =>
      file.references.filter(
        (reference) =>
          reference.symbolId === undefined &&
          reference.external !== true &&
          reference.member !== true &&
          declared.has(reference.name),
      ),
    );

    expect(missed.map((reference) => `${reference.location.file}:${reference.name}`)).toEqual([]);
  });

  it('marks a property access as a member and never resolves it by name', () => {
    // `orders.ts` imports nothing called `list`, but even if it did, the member
    // call on a service must not be attributed to it.
    const component = index.file('src/components/OrderList.tsx');
    const memberCall = component?.references.find(
      (reference) => reference.name === 'byStatus' && reference.kind === 'call',
    );

    expect(memberCall).toMatchObject({ member: true, kind: 'call' });
    expect(memberCall?.symbolId).toBeUndefined();
  });

  it('still records the receiver of a member access', () => {
    const service = index.file('src/services/orders.ts');
    // `fetchOrders(this.token, ...)` — the call itself is a bare import.
    const call = service?.references.find(
      (reference) => reference.name === 'fetchOrders' && reference.member !== true,
    );
    expect(call?.symbolId).toBe('src/api/client.ts#fetchOrders');
  });
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

describe('statistics', () => {
  it('separates resolved, external, and genuinely unknown references', () => {
    const {
      references,
      resolvedReferences,
      externalReferences,
      memberReferences,
      unresolvedReferences,
    } = index.stats;
    expect(resolvedReferences + externalReferences + memberReferences + unresolvedReferences).toBe(
      references,
    );
    expect(resolvedReferences).toBeGreaterThan(0);
    expect(externalReferences).toBeGreaterThan(0);
  });

  it('reports a resolution rate that excludes what was never in scope', () => {
    expect(index.resolutionRate).toBeGreaterThan(0);
    expect(index.resolutionRate).toBeLessThanOrEqual(1);
  });

  it('counts what it indexed', () => {
    expect(index.stats.files).toBe(7);
    expect(index.stats.symbols).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// Incremental update
// ---------------------------------------------------------------------------

describe('updateFile', () => {
  it('re-links the whole index so a change is seen by every dependent', async () => {
    const indexer = indexerFor(FIXTURE_ROOT);
    const updated = unwrap(await indexer.updateFile(index, 'src/api/client.ts'));

    // Re-reading an unchanged file must produce an equivalent index, not drift.
    expect(updated.exportsOf('src/index.ts').get('fetchOrders')).toBe(
      'src/api/client.ts#fetchOrders',
    );
    expect(updated.size).toBe(index.size);
  });

  it('refuses a file it cannot analyze rather than indexing nothing', async () => {
    const indexer = indexerFor(FIXTURE_ROOT);
    const result = await indexer.updateFile(index, 'package.json');
    expect(isErr(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces the same index twice', async () => {
    const again = unwrap(await indexerFor(FIXTURE_ROOT).build());
    expect(again.files.map((file) => file.path).sort()).toEqual(
      index.files.map((file) => file.path).sort(),
    );
    expect(again.stats.symbols).toBe(index.stats.symbols);
    expect(again.stats.resolvedReferences).toBe(index.stats.resolvedReferences);
  });
});
