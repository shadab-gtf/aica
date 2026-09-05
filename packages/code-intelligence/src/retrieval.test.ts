import { resolve } from 'node:path';

import { WorkspaceReader } from '@aica/fs-engine';
import { PathPolicy } from '@aica/security-engine';
import { unwrap } from '@aica/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import type { CodeIndex } from './indexer.js';
import { Indexer } from './indexer.js';
import { retrieve, tokenize } from './retrieval.js';

const FIXTURE_ROOT = resolve('fixtures/sample-app');

let index: CodeIndex;

beforeAll(async () => {
  const pathPolicy = new PathPolicy({ root: FIXTURE_ROOT });
  index = unwrap(await new Indexer({ reader: new WorkspaceReader({ pathPolicy }) }).build());
});

function ids(result: ReturnType<typeof retrieve>): string[] {
  return result.items.map((item) => item.symbol?.id ?? item.file);
}

describe('tokenize', () => {
  it('breaks camelCase and punctuation into comparable terms', () => {
    expect(tokenize('fetchOrders')).toEqual(['fetch', 'orders']);
    expect(tokenize('src/api/client.ts')).toEqual(['api', 'client', 'ts']);
    expect(tokenize('How does this cancel an order?')).toEqual(['cancel', 'an', 'order']);
  });

  it('drops single characters', () => {
    expect(tokenize('a b cd')).toEqual(['cd']);
  });
});

describe('retrieving by intent', () => {
  it('finds the function that matches the words used', () => {
    const result = retrieve(index, { text: 'cancel an order' });
    expect(ids(result)[0]).toBe('src/api/client.ts#cancelOrder');
  });

  it('matches a phrase against a camelCase name', () => {
    const result = retrieve(index, { text: 'format money' });
    expect(ids(result)[0]).toBe('src/utils/format.ts#formatMoney');
  });

  it('returns nothing for a query unrelated to the codebase', () => {
    expect(retrieve(index, { text: 'kubernetes ingress controller' }).items).toEqual([]);
  });

  it('returns nothing when there is nothing to go on', () => {
    expect(retrieve(index, {}).items).toEqual([]);
  });

  it('prefers an exported declaration over a private one', () => {
    // `request` is private and `fetchOrders` exported; both are about requests.
    const result = retrieve(index, { text: 'fetch orders request' });
    const order = ids(result);
    expect(order.indexOf('src/api/client.ts#fetchOrders')).toBeLessThan(
      order.indexOf('src/api/client.ts#request'),
    );
  });

  it('explains why each item was chosen', () => {
    const result = retrieve(index, { text: 'cancel order' });
    expect(result.items[0]?.reasons.join(' ')).toMatch(/matches .*cancel/);
  });
});

describe('retrieving from seeds', () => {
  it('always includes a symbol the caller named', () => {
    const result = retrieve(index, { symbols: ['src/types.ts#Money'] });
    expect(ids(result)).toContain('src/types.ts#Money');
    expect(result.items[0]?.reasons).toContain('named in the request');
  });

  it('pulls in what references a seeded symbol', () => {
    const result = retrieve(index, { symbols: ['src/api/client.ts#fetchOrders'] });
    // The service method that calls it is what a change would break.
    expect(ids(result)).toContain('src/services/orders.ts#OrderService.list');
  });

  it('includes the declarations of a seeded file', () => {
    const result = retrieve(index, { files: ['src/utils/format.ts'], expandDepth: 0 });
    expect(ids(result)).toEqual(
      expect.arrayContaining([
        'src/utils/format.ts#formatMoney',
        'src/utils/format.ts#formatStatus',
        'src/utils/format.ts#truncate',
      ]),
    );
  });

  it('expands to the exported surface of neighbouring modules', () => {
    const result = retrieve(index, { files: ['src/services/orders.ts'], expandDepth: 1 });
    // `orders.ts` imports the client, so the client's exports come along.
    expect(ids(result)).toContain('src/api/client.ts#fetchOrders');
  });

  it('does not pull in a neighbour’s private internals', () => {
    const result = retrieve(index, { files: ['src/services/orders.ts'], expandDepth: 1 });
    expect(ids(result)).not.toContain('src/api/client.ts#request');
  });

  it('ranks a seed above a mere text match', () => {
    const result = retrieve(index, {
      text: 'format',
      symbols: ['src/types.ts#Money'],
    });
    expect(ids(result)[0]).toBe('src/types.ts#Money');
  });

  it('ignores a seed that is not in the index', () => {
    const result = retrieve(index, { symbols: ['src/nope.ts#Ghost'] });
    expect(result.items).toEqual([]);
  });
});

describe('budget', () => {
  it('never exceeds the byte budget', () => {
    const result = retrieve(index, { text: 'order', maxBytes: 300 });
    expect(result.bytes).toBeLessThanOrEqual(300);
    expect(result.truncated).toBe(true);
    expect(result.omitted).toBeGreaterThan(0);
  });

  it('never exceeds the item cap', () => {
    const result = retrieve(index, { text: 'order', maxItems: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('reports its own size honestly', () => {
    const result = retrieve(index, { text: 'order' });
    const summed = result.items.reduce((total, item) => total + item.bytes, 0);
    expect(result.bytes).toBe(summed);
  });

  it('keeps the highest-ranked items when it has to cut', () => {
    const full = retrieve(index, { text: 'cancel order' });
    const cut = retrieve(index, { text: 'cancel order', maxItems: 1 });
    expect(ids(cut)).toEqual([ids(full)[0]]);
  });
});

describe('snippets', () => {
  it('carries the location, the doc, and the signature as written', () => {
    const result = retrieve(index, { symbols: ['src/api/client.ts#fetchOrders'] });
    const snippet = result.items.find((item) => item.symbol?.name === 'fetchOrders')?.snippet ?? '';

    expect(snippet).toContain('src/api/client.ts:');
    expect(snippet).toContain('function fetchOrders');
    // The signature is quoted from the file, so it can be checked against it.
    expect(snippet).toContain('token: string');
  });

  it('returns declarations rather than whole files', () => {
    const result = retrieve(index, { text: 'order' });
    for (const item of result.items) {
      expect(item.bytes).toBeLessThan(1000);
    }
  });
});

describe('determinism', () => {
  it('returns the same context for the same question', () => {
    const first = retrieve(index, { text: 'cancel an order', files: ['src/services/orders.ts'] });
    const second = retrieve(index, { text: 'cancel an order', files: ['src/services/orders.ts'] });
    expect(ids(first)).toEqual(ids(second));
    expect(first.bytes).toBe(second.bytes);
  });
});
