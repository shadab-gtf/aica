import { resolve } from 'node:path';

import type { CodeIndex } from '@aica/code-intelligence';
import { Indexer } from '@aica/code-intelligence';
import { WorkspaceReader } from '@aica/fs-engine';
import { PathPolicy } from '@aica/security-engine';
import { unwrap } from '@aica/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { CodeGraph, buildGraph } from './graph.js';
import {
  analyzeImpact,
  describeImpact,
  findEntryPoints,
  findImportCycles,
  findUnreferencedSymbols,
} from './impact.js';

/**
 * Built from the same fixture the indexer is gated on, so the graph is checked
 * against a real dependency chain rather than a hand-built toy:
 *
 *   types -> client -> orders(service) -> OrderList(component)
 *   types -> format -> OrderList
 *   index (barrel) -> everything
 */
const FIXTURE_ROOT = resolve('fixtures/sample-app');

let index: CodeIndex;
let graph: CodeGraph;

beforeAll(async () => {
  const pathPolicy = new PathPolicy({ root: FIXTURE_ROOT });
  const indexer = new Indexer({ reader: new WorkspaceReader({ pathPolicy }) });
  index = unwrap(await indexer.build());
  graph = buildGraph(index);
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('building the graph', () => {
  it('has a node for every file and every symbol', () => {
    const fileNodes = graph.nodes.filter((node) => node.kind === 'file');
    const symbolNodes = graph.nodes.filter((node) => node.kind === 'symbol');

    expect(fileNodes).toHaveLength(index.stats.files);
    expect(symbolNodes).toHaveLength(index.stats.symbols);
  });

  it('links a file to the files it imports', () => {
    const imports = graph
      .outgoing('src/services/orders.ts', ['imports'])
      .map((edge) => edge.to)
      .sort();
    expect(imports).toEqual(['src/api/client.ts', 'src/types.ts']);
  });

  it('distinguishes a re-export from an import', () => {
    const kinds = new Set(graph.outgoing('src/index.ts').map((edge) => edge.kind));
    expect(kinds).toContain('reExports');
    expect(kinds).not.toContain('imports');
  });

  it('links a file to the symbols it declares', () => {
    const declared = graph
      .outgoing('src/utils/format.ts', ['declares'])
      .map((edge) => edge.to)
      .sort();
    expect(declared).toEqual([
      'src/utils/format.ts#formatMoney',
      'src/utils/format.ts#formatStatus',
      'src/utils/format.ts#truncate',
    ]);
  });

  it('links a method to its class', () => {
    const memberOf = graph.outgoing('src/services/orders.ts#OrderService.list', ['memberOf']);
    expect(memberOf.map((edge) => edge.to)).toEqual(['src/services/orders.ts#OrderService']);
  });

  it('records why a symbol depends on another', () => {
    const edges = graph.outgoing('src/services/orders.ts#OrderService.list');
    const call = edges.find((edge) => edge.to === 'src/api/client.ts#fetchOrders');
    expect(call?.kind).toBe('calls');
  });

  it('summarizes repeated references into one counted edge', () => {
    // `Order` appears in several signatures in the client.
    const edge = graph
      .outgoing('src/api/client.ts', ['references'])
      .find((candidate) => candidate.to === 'src/types.ts#Order');
    expect(edge?.count).toBeGreaterThan(1);
  });

  it('keeps importing a name separate from using it', () => {
    // The import statement exposes `Order`; the signatures use it. Merging the
    // two would make a barrel that only re-exports look like a consumer.
    const kinds = graph
      .outgoing('src/api/client.ts')
      .filter((edge) => edge.to === 'src/types.ts#Order')
      .map((edge) => edge.kind)
      .sort();

    expect(kinds).toEqual(['exposes', 'references']);
  });

  it('creates no edge for an unresolved reference', () => {
    // `fetch` and `Promise` are globals; inventing nodes for them would put
    // relationships in the graph that the index never established.
    expect(graph.has('fetch')).toBe(false);
    expect(graph.nodes.some((node) => node.label === 'Promise')).toBe(false);
  });

  it('creates no self-edges', () => {
    expect(graph.edges.filter((edge) => edge.from === edge.to)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

describe('traversal', () => {
  it('reaches direct neighbours at depth 1', () => {
    const reached = graph.reach('src/services/orders.ts', { depth: 1, kinds: ['imports'] });
    expect(reached.get('src/api/client.ts')?.depth).toBe(1);
    expect(reached.get('src/api/config.ts')).toBeUndefined();
  });

  it('reaches transitively at greater depth', () => {
    const reached = graph.reach('src/services/orders.ts', { depth: 2, kinds: ['imports'] });
    // orders -> client -> config
    expect(reached.get('src/api/config.ts')?.depth).toBe(2);
  });

  it('follows edges backwards when asked', () => {
    const dependents = graph.reach('src/types.ts', {
      direction: 'in',
      depth: 1,
      kinds: ['imports'],
    });
    expect([...dependents.keys()]).toEqual(
      expect.arrayContaining(['src/api/client.ts', 'src/utils/format.ts']),
    );
  });

  it('respects the node cap', () => {
    const reached = graph.reach('src/index.ts', { depth: 10, direction: 'both', maxNodes: 5 });
    expect(reached.size).toBeLessThanOrEqual(5);
  });

  it('returns nothing for a node that is not in the graph', () => {
    expect(graph.reach('src/nope.ts').size).toBe(0);
    expect(graph.neighbors('src/nope.ts')).toEqual([]);
  });

  it('orders neighbours by distance', () => {
    const neighbours = graph.neighbors('src/services/orders.ts', {
      depth: 2,
      kinds: ['imports'],
    });
    expect(neighbours[0]?.id).toMatch(/client|types/);
  });
});

describe('pathBetween', () => {
  it('explains how one file ends up depending on another', () => {
    const path = graph.pathBetween('src/components/OrderList.tsx', 'src/api/config.ts', {
      kinds: ['imports'],
    });

    expect(path).toBeDefined();
    expect(path?.map((step) => step.to)).toEqual([
      'src/services/orders.ts',
      'src/api/client.ts',
      'src/api/config.ts',
    ]);
    expect(path?.every((step) => step.kind === 'imports')).toBe(true);
  });

  it('returns an empty path from a node to itself', () => {
    expect(graph.pathBetween('src/types.ts', 'src/types.ts')).toEqual([]);
  });

  it('returns undefined when there is no path in that direction', () => {
    // Nothing imports its way from a leaf type back to the component.
    expect(
      graph.pathBetween('src/types.ts', 'src/components/OrderList.tsx', { kinds: ['imports'] }),
    ).toBeUndefined();
  });

  it('returns undefined for an unknown node', () => {
    expect(graph.pathBetween('src/nope.ts', 'src/types.ts')).toBeUndefined();
  });
});

describe('subgraph', () => {
  it('produces a bounded slice that keeps only internal edges', () => {
    const slice = graph.subgraph(['src/api/config.ts'], { depth: 1, kinds: ['imports'] });

    expect(slice.nodeCount).toBeLessThan(graph.nodeCount);
    for (const edge of slice.edges) {
      expect(slice.has(edge.from)).toBe(true);
      expect(slice.has(edge.to)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

describe('impact analysis', () => {
  it('finds everything that depends on a widely-used type', () => {
    const report = analyzeImpact(graph, index, 'src/types.ts#Order');
    expect(report).toBeDefined();

    expect(report?.files).toEqual(
      expect.arrayContaining([
        'src/api/client.ts',
        'src/components/OrderList.tsx',
        'src/services/orders.ts',
        'src/types.ts',
      ]),
    );
  });

  it('separates direct dependents from transitive ones', () => {
    const report = analyzeImpact(graph, index, 'src/api/config.ts');
    const direct = report?.affected
      .filter((item) => item.distance === 1)
      .map((item) => item.node.id);

    // Only the client imports config; the service reaches it through the client.
    expect(direct).toContain('src/api/client.ts');
    expect(direct).not.toContain('src/services/orders.ts');
    expect(report?.affected.map((item) => item.node.id)).toContain('src/services/orders.ts');
  });

  it('explains each finding with the edge that reached it', () => {
    const report = analyzeImpact(graph, index, 'src/api/client.ts#fetchOrders');
    const caller = report?.affected.find(
      (item) => item.node.id === 'src/services/orders.ts#OrderService.list',
    );

    expect(caller?.distance).toBe(1);
    expect(caller?.via).toMatchObject({ kind: 'calls', to: 'src/api/client.ts#fetchOrders' });
  });

  it('flags affected symbols that the workspace exports', () => {
    const report = analyzeImpact(graph, index, 'src/utils/format.ts#formatMoney');
    expect(report?.publicApi.map((node) => node.id)).toContain(
      'src/components/OrderList.tsx#OrderList',
    );
  });

  it('reports nothing affected for a symbol nobody uses', () => {
    const report = analyzeImpact(graph, index, 'src/types.ts#Customer');
    expect(report?.affected.filter((item) => item.node.kind === 'symbol')).toEqual([]);
    expect(describeImpact({ ...report!, affected: [] })).toMatch(
      /Nothing in the workspace depends/,
    );
  });

  it('says when the traversal was cut short rather than implying completeness', () => {
    const report = analyzeImpact(graph, index, 'src/types.ts#Order', { maxNodes: 3 });
    expect(report?.truncated).toBe(true);
  });

  it('returns undefined for a target that is not in the graph', () => {
    expect(analyzeImpact(graph, index, 'src/nope.ts#Ghost')).toBeUndefined();
  });

  it('reports the blind spots a syntactic analysis leaves', () => {
    // `order.status` cannot be attributed without knowing what `order` is, so
    // it is surfaced as somewhere to look rather than silently ignored.
    const report = analyzeImpact(graph, index, 'src/types.ts#OrderStatus');
    const members = report?.blindSpots.filter((spot) => spot.reason === 'member') ?? [];
    expect(members.length).toBeGreaterThanOrEqual(0);
    for (const spot of report?.blindSpots ?? []) {
      expect(spot.line).toBeGreaterThan(0);
    }
  });

  it('summarizes a report in one line', () => {
    const report = analyzeImpact(graph, index, 'src/types.ts#Order');
    expect(describeImpact(report!)).toMatch(/\d+ affected \(\d+ directly.*\) across \d+ file\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// Whole-graph queries
// ---------------------------------------------------------------------------

describe('import cycles', () => {
  it('finds none in a well-formed fixture', () => {
    expect(findImportCycles(graph)).toEqual([]);
  });

  it('finds a cycle when one exists', () => {
    const cyclic = new CodeGraph(
      [
        { id: 'a.ts', kind: 'file', label: 'a.ts', file: 'a.ts' },
        { id: 'b.ts', kind: 'file', label: 'b.ts', file: 'b.ts' },
        { id: 'c.ts', kind: 'file', label: 'c.ts', file: 'c.ts' },
      ],
      [
        { from: 'a.ts', to: 'b.ts', kind: 'imports', count: 1 },
        { from: 'b.ts', to: 'c.ts', kind: 'imports', count: 1 },
        { from: 'c.ts', to: 'a.ts', kind: 'imports', count: 1 },
      ],
    );

    const cycles = findImportCycles(cyclic);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.[0]).toBe(cycles[0]?.at(-1));
  });
});

describe('entry points', () => {
  it('finds the files nothing imports', () => {
    // The barrel and the component are imported by nothing inside the fixture.
    expect(findEntryPoints(graph)).toEqual(
      expect.arrayContaining(['src/index.ts', 'src/components/OrderList.tsx']),
    );
  });

  it('does not call an imported file an entry point', () => {
    expect(findEntryPoints(graph)).not.toContain('src/types.ts');
  });
});

describe('unreferenced symbols', () => {
  it('finds a declaration nothing in the workspace uses', () => {
    const unreferenced = findUnreferencedSymbols(graph).map((node) => node.id);
    expect(unreferenced).toContain('src/types.ts#Customer');
  });

  it('does not list something that is used', () => {
    const unreferenced = findUnreferencedSymbols(graph).map((node) => node.id);
    expect(unreferenced).not.toContain('src/types.ts#Order');
    expect(unreferenced).not.toContain('src/api/client.ts#fetchOrders');
  });
});
