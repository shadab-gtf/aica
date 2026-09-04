import { describe, expect, it, vi } from 'vitest';

import { ErrorCode, isErr, isOk } from '@aica/shared';

import {
  ApprovalMode,
  DEFAULT_APPROVAL_MODE,
  classifyHttpRisk,
  evaluatePolicy,
  isReadOnlyMethod,
  maxRisk,
  riskAtLeast,
  type ActionDescriptor,
  type PolicyContext,
} from './risk.js';
import { ApprovalGate, denyAllResponder } from './approvals.js';

const localContext = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  mode: ApprovalMode.askOnDestructive,
  allowedEnvironments: ['local'],
  apiExecutionEnabled: true,
  ...overrides,
});

const action = (overrides: Partial<ActionDescriptor> = {}): ActionDescriptor => ({
  kind: 'file_write',
  risk: 'LOW_RISK_WRITE',
  subject: 'src/app.ts',
  detail: 'write a file',
  ...overrides,
});

describe('risk ordering', () => {
  it('orders the four levels', () => {
    expect(riskAtLeast('DESTRUCTIVE', 'HIGH_RISK_WRITE')).toBe(true);
    expect(riskAtLeast('READ_ONLY', 'LOW_RISK_WRITE')).toBe(false);
    expect(maxRisk('READ_ONLY', 'HIGH_RISK_WRITE')).toBe('HIGH_RISK_WRITE');
  });
});

describe('classifyHttpRisk', () => {
  it('treats reads as READ_ONLY', () => {
    expect(classifyHttpRisk('GET', 'production')).toBe('READ_ONLY');
    expect(classifyHttpRisk('head', 'production')).toBe('READ_ONLY');
    expect(isReadOnlyMethod('OPTIONS')).toBe(true);
  });

  it('escalates the same mutation when it targets production', () => {
    expect(classifyHttpRisk('POST', 'local')).toBe('LOW_RISK_WRITE');
    expect(classifyHttpRisk('POST', 'production')).toBe('HIGH_RISK_WRITE');
    expect(classifyHttpRisk('PATCH', 'staging')).toBe('LOW_RISK_WRITE');
  });

  it('always treats DELETE as destructive', () => {
    expect(classifyHttpRisk('DELETE', 'local')).toBe('DESTRUCTIVE');
    expect(classifyHttpRisk('DELETE', 'production')).toBe('DESTRUCTIVE');
  });

  it('refuses UPDATE and explains how to resolve it', () => {
    const verdict = classifyHttpRisk('UPDATE', 'local');
    expect(typeof verdict).toBe('object');
    expect((verdict as { invalid: string }).invalid).toMatch(/not an HTTP method/i);
    expect((verdict as { invalid: string }).invalid).toMatch(/PUT|PATCH/);
  });
});

describe('evaluatePolicy', () => {
  it('defaults to asking before any side effect', () => {
    expect(DEFAULT_APPROVAL_MODE).toBe(ApprovalMode.askAlways);
    const decision = evaluatePolicy(action(), localContext({ mode: ApprovalMode.askAlways }));
    expect(decision.outcome).toBe('require_approval');
  });

  it('denies an environment the project has not allowed', () => {
    const decision = evaluatePolicy(
      action({ kind: 'api_request', environment: 'production', method: 'GET', risk: 'READ_ONLY' }),
      localContext({ allowedEnvironments: ['local', 'staging'] }),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reason).toMatch(/production/);
  });

  it('denies API execution outright when the project only permits code changes', () => {
    const decision = evaluatePolicy(
      action({ kind: 'api_request', method: 'GET', risk: 'READ_ONLY', environment: 'local' }),
      localContext({ apiExecutionEnabled: false }),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reason).toMatch(/only modify code/i);
  });

  it('requires approval for a destructive production request even in auto mode', () => {
    const decision = evaluatePolicy(
      action({
        kind: 'api_request',
        method: 'DELETE',
        risk: 'DESTRUCTIVE',
        environment: 'production',
        subject: 'DELETE /customers/{id}',
      }),
      localContext({ mode: ApprovalMode.auto, allowedEnvironments: ['local', 'production'] }),
    );
    expect(decision.outcome).toBe('require_approval');
  });

  it('never lets auto mode delete without confirmation', () => {
    const decision = evaluatePolicy(
      action({ kind: 'file_delete', risk: 'DESTRUCTIVE', subject: 'src/legacy.ts' }),
      localContext({ mode: ApprovalMode.auto }),
    );
    expect(decision.outcome).toBe('require_approval');
  });

  it('allows a low-risk write in auto mode', () => {
    const decision = evaluatePolicy(action(), localContext({ mode: ApprovalMode.auto }));
    expect(decision.outcome).toBe('allow');
  });

  it('allows read-only work in read-only mode and denies everything else', () => {
    const context = localContext({ mode: ApprovalMode.readOnly });
    expect(evaluatePolicy(action({ kind: 'file_read', risk: 'READ_ONLY' }), context).outcome).toBe(
      'allow',
    );
    expect(evaluatePolicy(action(), context).outcome).toBe('deny');
  });

  it('routes reads through freely but confirms mutations in askOnApiAndDestructive', () => {
    const context = localContext({ mode: ApprovalMode.askOnApiAndDestructive });
    expect(
      evaluatePolicy(
        action({ kind: 'api_request', method: 'GET', risk: 'READ_ONLY', environment: 'local' }),
        context,
      ).outcome,
    ).toBe('allow');
    expect(
      evaluatePolicy(
        action({
          kind: 'api_request',
          method: 'POST',
          risk: 'LOW_RISK_WRITE',
          environment: 'local',
        }),
        context,
      ).outcome,
    ).toBe('require_approval');
  });

  it('surfaces every patch for review in reviewEveryPatch mode', () => {
    const context = localContext({ mode: ApprovalMode.reviewEveryPatch });
    expect(evaluatePolicy(action({ kind: 'patch_apply' }), context).outcome).toBe(
      'require_approval',
    );
  });

  it('honours a tool that always demands confirmation', () => {
    const decision = evaluatePolicy(
      action({ risk: 'READ_ONLY', kind: 'mcp_tool', requiresApproval: true }),
      localContext({ mode: ApprovalMode.auto }),
    );
    expect(decision.outcome).toBe('require_approval');
  });

  it('denies a mutation method the project has not permitted', () => {
    const decision = evaluatePolicy(
      action({ kind: 'api_request', method: 'DELETE', risk: 'DESTRUCTIVE', environment: 'local' }),
      localContext({ allowedMutationMethods: ['POST', 'PUT', 'PATCH'] }),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reason).toMatch(/DELETE/);
  });
});

describe('ApprovalGate', () => {
  it('fails closed when no responder is wired', async () => {
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.askAlways }),
      responder: denyAllResponder,
    });
    const result = await gate.authorize(action());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.APPROVAL_DENIED);
  });

  it('distinguishes a policy denial from a declined approval', async () => {
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.readOnly }),
      responder: async () => ({ granted: true }),
    });
    const result = await gate.authorize(action());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('does not ask at all for an allowed action', async () => {
    const responder = vi.fn(async () => ({ granted: true }));
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.auto }),
      responder,
    });
    expect(isOk(await gate.authorize(action()))).toBe(true);
    expect(responder).not.toHaveBeenCalled();
  });

  it('remembers a grant for the same subject within the run', async () => {
    const responder = vi.fn(async () => ({ granted: true, remember: true }));
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.askAlways }),
      responder,
    });
    expect(isOk(await gate.authorize(action()))).toBe(true);
    expect(isOk(await gate.authorize(action()))).toBe(true);
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('refuses to remember a destructive grant, so each one is confirmed', async () => {
    const responder = vi.fn(async () => ({ granted: true, remember: true }));
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.askOnDestructive }),
      responder,
    });
    const destructive = action({ kind: 'file_delete', risk: 'DESTRUCTIVE' });
    await gate.authorize(destructive);
    await gate.authorize(destructive);
    expect(responder).toHaveBeenCalledTimes(2);
  });

  it('treats a throwing responder as a denial rather than an allow', async () => {
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.askAlways }),
      responder: async () => {
        throw new Error('UI disconnected');
      },
    });
    const result = await gate.authorize(action());
    expect(isErr(result) && result.error.code).toBe(ErrorCode.APPROVAL_DENIED);
  });

  it('records every decision in the audit trail', async () => {
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.askAlways }),
      responder: async () => ({ granted: true }),
    });
    await gate.authorize(action({ subject: 'a.ts' }));
    await gate.authorize(action({ subject: 'b.ts' }));
    expect(gate.auditTrail).toHaveLength(2);
    expect(gate.auditTrail.every((record) => record.granted)).toBe(true);
    expect(gate.auditTrail[0]?.approvalId).toMatch(/^appr_/);
  });

  it('emits request and resolution callbacks for the run timeline', async () => {
    const requested: string[] = [];
    const resolved: boolean[] = [];
    const gate = new ApprovalGate({
      context: localContext({ mode: ApprovalMode.askAlways }),
      responder: async () => ({ granted: false }),
      onRequest: (request) => requested.push(request.action.subject),
      onResolved: (_request, response) => resolved.push(response.granted),
    });
    await gate.authorize(action({ subject: 'src/checkout.tsx' }));
    expect(requested).toEqual(['src/checkout.tsx']);
    expect(resolved).toEqual([false]);
  });
});
