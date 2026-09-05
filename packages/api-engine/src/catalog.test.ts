import type { ApiSpec, Endpoint } from '@aica/api-ir';
import { describe, expect, it } from 'vitest';

import { EndpointIndex, tokenize } from './catalog.js';

function endpoint(
  overrides: Partial<Endpoint> & Pick<Endpoint, 'id' | 'method' | 'path'>,
): Endpoint {
  return {
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    servers: [],
    source: { format: 'openapi3' },
    ...overrides,
  };
}

const orders: ApiSpec = {
  id: 'orders',
  title: 'Orders API',
  servers: [],
  authSchemes: [],
  security: [],
  components: {},
  source: { format: 'openapi3' },
  warnings: [],
  endpoints: [
    endpoint({
      id: 'GET /orders',
      method: 'GET',
      path: '/orders',
      operationId: 'listOrders',
      summary: 'List orders',
      tags: ['orders'],
    }),
    endpoint({
      id: 'POST /orders',
      method: 'POST',
      path: '/orders',
      operationId: 'createOrder',
      summary: 'Create an order',
      tags: ['orders'],
    }),
    endpoint({
      id: 'GET /orders/{id}',
      method: 'GET',
      path: '/orders/{id}',
      operationId: 'getOrder',
      tags: ['orders'],
    }),
    endpoint({
      id: 'GET /orders/me',
      method: 'GET',
      path: '/orders/me',
      operationId: 'getMyOrders',
      tags: ['orders'],
    }),
    endpoint({
      id: 'POST /refunds',
      method: 'POST',
      path: '/refunds',
      operationId: 'createRefund',
      summary: 'Issue a refund for an order',
      description: 'Refunds a captured payment back to the customer',
      tags: ['payments'],
    }),
  ],
};

const billing: ApiSpec = {
  ...orders,
  id: 'billing',
  title: 'Billing API',
  endpoints: [
    // The same endpoint under a differently-named path parameter.
    endpoint({
      id: 'GET /orders/{orderId}',
      method: 'GET',
      path: '/orders/{orderId}',
      operationId: 'fetchOrder',
    }),
    endpoint({ id: 'GET /invoices', method: 'GET', path: '/invoices', summary: 'List invoices' }),
  ],
};

describe('tokenize', () => {
  it('breaks camelCase and path punctuation apart', () => {
    expect(tokenize('/paymentIntents/{id}')).toEqual(['payment', 'intents', 'id']);
    expect(tokenize('createRefund')).toEqual(['create', 'refund']);
  });

  it('drops single characters and low-signal words', () => {
    expect(tokenize('the API endpoint for a user')).toEqual(['user']);
  });
});

describe('EndpointIndex', () => {
  const index = new EndpointIndex([orders, billing]);

  it('indexes every endpoint of every specification', () => {
    expect(index.size).toBe(7);
    expect(index.all().filter((record) => record.specId === 'orders')).toHaveLength(5);
  });

  it('finds an endpoint by id, optionally within one specification', () => {
    expect(index.find('GET /invoices')?.specTitle).toBe('Billing API');
    expect(index.find('GET /invoices', 'orders')).toBeUndefined();
  });

  it('filters by tag', () => {
    expect(index.byTag('payments').map((record) => record.endpoint.id)).toEqual(['POST /refunds']);
    expect(index.byTag('PAYMENTS')).toHaveLength(1);
  });
});

describe('matching a concrete request', () => {
  const index = new EndpointIndex([orders]);

  it('attributes a concrete path to its template and captures the values', () => {
    const matches = index.match('GET', '/orders/42');
    expect(matches.map((match) => match.record.endpoint.id)).toEqual(['GET /orders/{id}']);
    expect(matches[0]?.parameters).toEqual({ id: '42' });
  });

  it('returns every candidate when a path is genuinely ambiguous, most specific first', () => {
    // `/orders/me` is both a literal endpoint and a valid `{id}`.
    const matches = index.match('GET', '/orders/me');
    expect(matches.map((match) => match.record.endpoint.id)).toEqual([
      'GET /orders/me',
      'GET /orders/{id}',
    ]);
  });

  it('respects the method', () => {
    expect(index.match('DELETE', '/orders/42')).toEqual([]);
  });

  it('returns nothing for a path no template covers', () => {
    expect(index.match('GET', '/unknown/42')).toEqual([]);
  });
});

describe('search', () => {
  const index = new EndpointIndex([orders, billing]);

  it('ranks by term overlap and reports which fields matched', () => {
    const results = index.search('refund a payment');
    expect(results[0]?.record.endpoint.id).toBe('POST /refunds');
    expect(results[0]?.matchedOn).toEqual(expect.arrayContaining(['path', 'summary']));
  });

  it('matches an operationId written in camelCase', () => {
    expect(index.search('create order')[0]?.record.endpoint.id).toBe('POST /orders');
  });

  it('matches a plural against a singular term', () => {
    expect(index.search('invoice')[0]?.record.endpoint.id).toBe('GET /invoices');
  });

  it('filters by an explicitly named method', () => {
    const results = index.search('POST orders');
    expect(results.every((result) => result.record.endpoint.method === 'POST')).toBe(true);
  });

  it('does not treat a lowercase verb in prose as a method filter', () => {
    const results = index.search('get the order list');
    expect(results.some((result) => result.record.endpoint.method !== 'GET')).toBe(true);
  });

  it('honours explicit filters', () => {
    expect(
      index.search('orders', { method: 'POST' }).every((r) => r.record.endpoint.method === 'POST'),
    ).toBe(true);
    expect(
      index.search('orders', { specId: 'billing' }).every((r) => r.record.specId === 'billing'),
    ).toBe(true);
    expect(
      index
        .search('orders', { tag: 'payments' })
        .every((r) => r.record.endpoint.tags.includes('payments')),
    ).toBe(true);
  });

  it('respects the result limit', () => {
    expect(index.search('orders', { limit: 2 })).toHaveLength(2);
  });

  it('returns nothing for a query with no usable terms', () => {
    expect(index.search('')).toEqual([]);
    expect(index.search('the a')).toEqual([]);
  });

  it('returns nothing when no endpoint is related to the query', () => {
    expect(index.search('kubernetes cluster autoscaler')).toEqual([]);
  });

  it('is deterministic, including the tiebreak between equal scores', () => {
    expect(index.search('orders')).toEqual(index.search('orders'));
  });
});

describe('duplicates', () => {
  it('groups endpoints two specifications describe the same way', () => {
    const groups = new EndpointIndex([orders, billing]).duplicates();
    // `/orders/{id}` and `/orders/{orderId}` are one endpoint named two ways.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((record) => record.specId).sort()).toEqual(['billing', 'orders']);
  });

  it('finds none in a single coherent specification', () => {
    expect(new EndpointIndex([orders]).duplicates()).toEqual([]);
  });
});
