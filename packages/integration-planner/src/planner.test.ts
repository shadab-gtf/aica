import { resolve } from 'node:path';

import { parseApiSource } from '@aica/api-engine';
import { buildGraph } from '@aica/code-graph';
import type { CodeGraph } from '@aica/code-graph';
import type { CodeIndex } from '@aica/code-intelligence';
import { Indexer } from '@aica/code-intelligence';
import { WorkspaceReader } from '@aica/fs-engine';
import { PathPolicy } from '@aica/security-engine';
import { unwrap } from '@aica/shared';
import type { ApiSpec } from '@aica/api-ir';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseIntent } from './intent.js';
import { findClientConventions, literalSignature, matchEndpoints } from './matching.js';
import { buildPlan, renderBrief } from './planner.js';

/**
 * Golden scenarios 1 and 2 — the Phase 4 gate.
 *
 * Both run against the same fixture the indexer is gated on, plus a
 * specification of the API that fixture already talks to. That pairing is the
 * point: the planner's job is to notice what the repository already does, and
 * it can only be tested by giving it a repository that genuinely does it.
 */
const FIXTURE_ROOT = resolve('fixtures/sample-app');

/** The API `fixtures/sample-app` is written against. */
const ORDERS_SPEC = `
openapi: 3.0.3
info:
  title: Orders API
  version: "1.0"
servers:
  - url: https://api.example.com/v1
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    Order:
      type: object
      required: [id, status, total]
      properties:
        id: { type: string }
        status: { type: string, enum: [pending, shipped, cancelled] }
        total:
          type: object
          required: [amount, currency]
          properties:
            amount: { type: integer }
            currency: { type: string }
security:
  - bearerAuth: []
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List orders
      parameters:
        - name: status
          in: query
          schema: { type: string, enum: [pending, shipped, cancelled] }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Order' }
    post:
      operationId: createOrder
      summary: Create an order
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Order' }
      responses:
        "201":
          description: created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
  /orders/{orderId}:
    get:
      operationId: getOrder
      summary: Get one order
      parameters:
        - name: orderId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
  /refunds:
    post:
      operationId: createRefund
      summary: Issue a refund for an order
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [orderId, amount]
              properties:
                orderId: { type: string }
                amount: { type: integer }
      responses:
        "201":
          description: created
          content:
            application/json:
              schema:
                type: object
                properties:
                  refundId: { type: string }
`;

let code: CodeIndex;
let graph: CodeGraph;
let spec: ApiSpec;

beforeAll(async () => {
  const pathPolicy = new PathPolicy({ root: FIXTURE_ROOT });
  code = unwrap(await new Indexer({ reader: new WorkspaceReader({ pathPolicy }) }).build());
  graph = buildGraph(code);
  spec = unwrap(parseApiSource(ORDERS_SPEC, { location: 'orders.yaml' }));
});

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

describe('intent understanding', () => {
  it('reads action, endpoint, and target straight out of an explicit request', () => {
    const intent = parseIntent(
      'Integrate POST /refunds into src/components/OrderList.tsx using the existing client',
    );

    expect(intent).toMatchObject({
      action: 'integrate',
      method: 'POST',
      path: '/refunds',
      files: ['src/components/OrderList.tsx'],
    });
    expect(intent.ambiguities).toEqual([]);
  });

  it.each([
    ['Fix the broken order total', 'fix'],
    ['Refactor the order service', 'refactor'],
    ['Add tests for formatMoney', 'test'],
    ['What does OrderService do?', 'explain'],
    ['Wire up the payments endpoint', 'integrate'],
  ])('classifies %s as %s', (text, action) => {
    expect(parseIntent(text).action).toBe(action);
  });

  it('treats a bare endpoint mention as an integration', () => {
    expect(parseIntent('POST /payments').action).toBe('integrate');
  });

  it('does not guess a method the user did not give', () => {
    const intent = parseIntent('Integrate the /refunds endpoint into the order list');
    expect(intent.method).toBeUndefined();
    expect(intent.ambiguities.join(' ')).toMatch(/No HTTP method/);
  });

  it('says what it could not determine instead of assuming', () => {
    const intent = parseIntent('make it better');
    expect(intent.action).toBe('unknown');
    expect(intent.ambiguities.length).toBeGreaterThan(0);
  });

  it('picks out backticked identifiers', () => {
    expect(parseIntent('Update `OrderService` to retry').symbols).toContain('OrderService');
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe('literalSignature', () => {
  it.each([
    ['/orders', '/orders'],
    ['/orders/{}', '/orders/{}'],
    // A trailing interpolation appended to a path is a query string.
    ['/orders{}', '/orders'],
    ['https://api.example.com/v1/orders', '/v1/orders'],
    ['/orders?status=open', '/orders'],
  ])('reduces %s to %s', (value, expected) => {
    expect(literalSignature(value)).toBe(expected);
  });
});

describe('matching endpoints to code', () => {
  it('finds the existing call site for each implemented endpoint', () => {
    const matches = matchEndpoints(spec, code);
    const byId = new Map(matches.map((match) => [match.endpoint.id, match]));

    expect(byId.get('GET /orders')?.implemented).toBe(true);
    expect(byId.get('POST /orders')?.implemented).toBe(true);
    expect(byId.get('GET /orders/{orderId}')?.implemented).toBe(true);
  });

  it('attributes the call site to the function that makes the call', () => {
    const matches = matchEndpoints(spec, code);
    const detail = matches.find((match) => match.endpoint.id === 'GET /orders/{orderId}');
    const names = detail?.callSites.map((site) => site.symbol?.name);

    expect(names).toContain('fetchOrder');
    expect(detail?.callSites[0]?.file).toBe('src/api/client.ts');
  });

  it('reports an endpoint the codebase does not call yet', () => {
    const matches = matchEndpoints(spec, code);
    const refunds = matches.find((match) => match.endpoint.id === 'POST /refunds');

    expect(refunds?.implemented).toBe(false);
    expect(refunds?.callSites).toEqual([]);
  });

  it('explains why a call site matched', () => {
    const matches = matchEndpoints(spec, code);
    const list = matches.find((match) => match.endpoint.id === 'GET /orders');
    expect(list?.callSites[0]?.reasons.join(' ')).toMatch(/matches \/orders/);
  });

  it('matches when the base path is in the spec path and the code holds it separately', () => {
    // What every cURL-derived spec looks like: the server is the bare origin
    // and the version prefix is part of the path. The fixture keeps that prefix
    // in its BASE_URL constant and writes only `/orders`, so a matcher that
    // compares the two literally finds nothing and reports an endpoint the
    // codebase already calls as unimplemented.
    const derived = unwrap(parseApiSource('curl https://api.example.com/v1/orders'));
    const matches = matchEndpoints(derived, code);

    expect(matches[0]?.endpoint.path).toBe('/v1/orders');
    expect(matches[0]?.implemented).toBe(true);
    expect(matches[0]?.callSites.map((site) => site.file)).toContain('src/api/client.ts');
    expect(matches[0]?.callSites[0]?.reasons.join(' ')).toMatch(/base path held separately/);
  });

  it('does not match a path that merely shares a prefix', () => {
    const derived = unwrap(parseApiSource('curl https://api.example.com/v1/invoices'));
    const matches = matchEndpoints(derived, code);

    expect(matches[0]?.implemented).toBe(false);
    expect(matches[0]?.callSites).toEqual([]);
  });
});

describe('observing the repository conventions', () => {
  it('identifies the API client layer', () => {
    expect(findClientConventions(code).clientFiles).toContain('src/api/client.ts');
  });

  it('names the HTTP mechanism already in use', () => {
    expect(findClientConventions(code).httpMechanisms).toEqual(['fetch']);
  });

  it('finds the existing authentication helper', () => {
    const names = findClientConventions(code).authHelpers.map((symbol) => symbol.name);
    expect(names).toContain('authHeaders');
  });

  it('finds the configured base URL rather than a hard-coded host', () => {
    const base = findClientConventions(code).baseUrls[0];
    expect(base?.symbol?.name).toBe('BASE_URL');
    expect(base?.file).toBe('src/api/config.ts');
  });

  it('does not mistake a component with one URL for the client layer', () => {
    expect(findClientConventions(code).clientFiles).not.toContain('src/components/OrderList.tsx');
  });
});

// ---------------------------------------------------------------------------
// Golden scenario 1: integrate an endpoint that is not implemented yet
// ---------------------------------------------------------------------------

describe('golden scenario 1: integrating a new endpoint', () => {
  const request = 'Integrate POST /refunds into the order list so a user can refund an order';

  it('identifies the endpoint the user named', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    expect(plan.endpoint?.id).toBe('POST /refunds');
  });

  it('knows the endpoint is not implemented yet', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    expect(plan.existingCallSites).toEqual([]);
  });

  it('routes the work to the existing client rather than a new one', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    const first = plan.steps[0];

    expect(first?.file).toBe('src/api/client.ts');
    expect(first?.description).toMatch(/existing API client/i);
  });

  it('constrains the change to the conventions the repository already has', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    const constraints = plan.constraints.join('\n');

    expect(constraints).toMatch(/fetch.*do not add another HTTP client/i);
    expect(constraints).toMatch(/authHeaders/);
    expect(constraints).toMatch(/BASE_URL/);
    expect(constraints).toMatch(/never hard-code a credential/i);
  });

  it('requires tests and a full validation pass before it is done', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    expect(plan.expectedTests.length).toBeGreaterThan(0);
    expect(plan.validation).toEqual(
      expect.arrayContaining(['The project typechecks.', 'The test suite passes.']),
    );
  });

  it('traces every claim back to evidence', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    expect(plan.evidence.join('\n')).toMatch(/API client layer identified/);
    expect(plan.evidence.join('\n')).toMatch(/HTTP mechanism in use: fetch/);
  });

  it('is confident, because every part was determined from evidence', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    expect(plan.confidence).not.toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Golden scenario 2: change an endpoint that is already integrated
// ---------------------------------------------------------------------------

describe('golden scenario 2: changing an endpoint already in use', () => {
  const request = 'Add a status filter to GET /orders in src/services/orders.ts';

  it('finds where the endpoint is already called', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });

    expect(plan.endpoint?.id).toBe('GET /orders');
    expect(plan.existingCallSites.map((site) => site.file)).toContain('src/api/client.ts');
  });

  it('tells the executor to extend the existing call, not add a second one', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    expect(plan.steps[0]?.description).toMatch(/extend the existing call/i);
  });

  it('puts the file the user named among the targets', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    expect(plan.targetFiles).toContain('src/services/orders.ts');
  });

  it('marks widely-depended-on files as ones to leave alone', () => {
    const plan = buildPlan({ intent: parseIntent(request), code, graph, specs: [spec] });
    // Five files import the shared types module.
    expect(plan.protectedFiles).toContain('src/types.ts');
  });
});

// ---------------------------------------------------------------------------
// Under-determined requests
// ---------------------------------------------------------------------------

describe('when the evidence does not support a plan', () => {
  it('asks rather than nominating a plausible endpoint', () => {
    const plan = buildPlan({
      intent: parseIntent('integrate the thing with the other thing'),
      code,
      graph,
      specs: [spec],
    });

    expect(plan.endpoint).toBeUndefined();
    expect(plan.confidence).toBe('low');
    expect(plan.openQuestions.length).toBeGreaterThan(0);
  });

  it('says when no specification is loaded at all', () => {
    const plan = buildPlan({ intent: parseIntent('Integrate POST /refunds'), code, specs: [] });
    expect(plan.openQuestions.join(' ')).toMatch(/No API specification/);
  });

  it('says when a named endpoint is in no specification', () => {
    const plan = buildPlan({
      intent: parseIntent('Integrate DELETE /nonexistent into the app'),
      code,
      specs: [spec],
    });
    expect(plan.openQuestions.join(' ')).toMatch(/not in any loaded specification/);
  });

  it('infers an endpoint from a vague request but does not claim certainty', () => {
    // "integrate orders" is answerable by matching, and the planner does match
    // it — but it records that the endpoint was inferred rather than stated,
    // and the confidence reflects that rather than reading as a decision.
    const plan = buildPlan({ intent: parseIntent('integrate orders'), code, graph, specs: [spec] });

    expect(plan.endpoint).toBeDefined();
    expect(plan.confidence).not.toBe('high');
    expect(plan.openQuestions.join(' ')).toMatch(/must be identified by matching/);
  });
});

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

describe('the executor brief', () => {
  const plan = () =>
    buildPlan({
      intent: parseIntent('Integrate POST /refunds into src/components/OrderList.tsx'),
      code,
      graph,
      specs: [spec],
    });

  it('states the objective, the endpoint, and the conventions', () => {
    const brief = renderBrief(plan());

    expect(brief).toContain('# Objective');
    expect(brief).toContain('POST /refunds');
    expect(brief).toContain('src/api/client.ts');
    expect(brief).toContain('# Constraints');
    expect(brief).toContain('# Definition of done');
  });

  it('includes the request and response shapes from the specification', () => {
    const brief = renderBrief(plan());
    expect(brief).toContain('orderId: string;');
    expect(brief).toContain('refundId?: string;');
  });

  it('describes authentication as a scheme and never as a value', () => {
    const brief = renderBrief(plan());
    expect(brief).toMatch(/Authentication: Bearer token/);
    expect(brief).toMatch(/do not embed a key/i);
  });

  it('names the files to change and the files to leave alone', () => {
    const brief = renderBrief(plan());
    expect(brief).toContain('# Files to change');
    expect(brief).toContain('# Files to leave alone');
  });

  it('respects a size cap so a brief cannot grow without bound', () => {
    const brief = renderBrief(plan(), { maxChars: 500 });
    expect(brief.length).toBeLessThanOrEqual(520);
    expect(brief).toContain('[brief truncated]');
  });

  it('never contains a secret value, only the mechanism', () => {
    const brief = renderBrief(plan());
    expect(brief).not.toMatch(/sk-[a-z0-9-]{10,}/i);
    expect(brief).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
  });

  it('is deterministic', () => {
    expect(renderBrief(plan())).toBe(renderBrief(plan()));
  });
});
