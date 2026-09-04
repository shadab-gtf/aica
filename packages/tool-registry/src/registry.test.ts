import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ErrorCode, err, errors, isErr, isOk, newId, ok } from '@aica/shared';
import { ApprovalGate, ApprovalMode, Redactor, type PolicyContext } from '@aica/security-engine';

import { ToolRegistry } from './registry.js';
import { ToolDispatcher, type ToolCallRecord } from './dispatcher.js';
import { defineTool, toToolSpec, type ToolContext } from './tool.js';

const context = (): ToolContext => ({
  runId: newId('run'),
  projectId: newId('proj'),
  signal: new AbortController().signal,
  environment: 'local',
});

const policyContext = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  mode: ApprovalMode.auto,
  allowedEnvironments: ['local'],
  apiExecutionEnabled: true,
  ...overrides,
});

const readTool = defineTool({
  name: 'read_thing',
  title: 'Read a thing',
  description: 'Reads a thing by name. Use this to inspect a thing before changing it.',
  category: 'filesystem',
  inputSchema: z.object({ name: z.string().min(1) }),
  risk: 'READ_ONLY',
  actionKind: 'file_read',
  mutates: false,
  describeCall: (input) => `read ${input.name}`,
  handler: (input) => ok({ name: input.name, content: 'contents' }),
});

const writeTool = defineTool({
  name: 'write_thing',
  title: 'Write a thing',
  description: 'Writes a thing. Use this only after the change has been planned and reviewed.',
  category: 'filesystem',
  inputSchema: z.object({ name: z.string(), content: z.string() }),
  risk: 'LOW_RISK_WRITE',
  actionKind: 'file_write',
  mutates: true,
  handler: () => ok({ written: true }),
});

const deleteTool = defineTool({
  name: 'delete_thing',
  title: 'Delete a thing',
  description: 'Permanently removes a thing. This cannot be undone from within the agent.',
  category: 'filesystem',
  inputSchema: z.object({ name: z.string() }),
  risk: 'DESTRUCTIVE',
  actionKind: 'file_delete',
  mutates: true,
  handler: () => ok({ deleted: true }),
});

const buildRegistry = (): ToolRegistry => {
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(deleteTool);
  return registry;
};

const buildDispatcher = (
  options: {
    registry?: ToolRegistry;
    policy?: Partial<PolicyContext>;
    responder?: (request: { action: { subject: string } }) => Promise<{ granted: boolean }>;
    redactor?: Redactor;
    onComplete?: (record: ToolCallRecord) => void;
  } = {},
): { dispatcher: ToolDispatcher; registry: ToolRegistry } => {
  const registry = options.registry ?? buildRegistry();
  const gate = new ApprovalGate({
    context: policyContext(options.policy),
    responder: options.responder ?? (async () => ({ granted: true })),
  });
  return {
    registry,
    dispatcher: new ToolDispatcher({
      registry,
      approvals: gate,
      ...(options.redactor ? { redactor: options.redactor } : {}),
      ...(options.onComplete ? { onComplete: options.onComplete } : {}),
    }),
  };
};

describe('registration', () => {
  it('registers and looks up a tool', () => {
    const registry = new ToolRegistry();
    expect(isOk(registry.register(readTool))).toBe(true);
    expect(registry.has('read_thing')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('refuses a duplicate name', () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    const result = registry.register(readTool);
    expect(isErr(result) && result.error.code).toBe(ErrorCode.ALREADY_EXISTS);
  });

  it('refuses a name providers would reject', () => {
    const registry = new ToolRegistry();
    for (const name of ['ReadThing', 'read-thing', '1read', 'read thing']) {
      const result = registry.register({ ...readTool, name });
      expect(isErr(result), name).toBe(true);
    }
  });

  it('refuses a tool whose description would cause wrong selection', () => {
    const registry = new ToolRegistry();
    const result = registry.register({ ...readTool, description: 'reads' });
    expect(isErr(result) && result.error.message).toMatch(/states what it does/i);
  });

  it('filters specs by category, so an analysis run is not shown execution tools', () => {
    const registry = buildRegistry();
    registry.register({
      ...readTool,
      name: 'call_api',
      category: 'api',
      actionKind: 'api_request',
    });

    const filesystemOnly = registry.specs({ categories: ['filesystem'] });
    expect(filesystemOnly.map((spec) => spec.name)).not.toContain('call_api');
    expect(filesystemOnly).toHaveLength(3);
  });

  it('unregisters a tool', () => {
    const registry = buildRegistry();
    expect(registry.unregister('read_thing')).toBe(true);
    expect(registry.has('read_thing')).toBe(false);
  });
});

describe('provider spec derivation', () => {
  it('derives JSON Schema from the same Zod schema that guards execution', () => {
    const spec = toToolSpec(readTool);
    expect(spec.name).toBe('read_thing');
    expect(spec.parameters).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });

  it('strips keys that providers reject', () => {
    const spec = toToolSpec(readTool);
    expect(spec.parameters.$schema).toBeUndefined();
    expect(spec.parameters.title).toBeUndefined();
  });
});

describe('dispatch: validation', () => {
  it('runs a valid call and returns the result', async () => {
    const { dispatcher } = buildDispatcher();
    const outcome = await dispatcher.dispatch(
      { id: 'call_1', name: 'read_thing', arguments: { name: 'alpha' } },
      context(),
    );
    expect(outcome.record.ok).toBe(true);
    expect(outcome.value).toEqual({ name: 'alpha', content: 'contents' });
    expect(outcome.record.subject).toBe('read alpha');
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const handler = vi.fn(() => ok({}));
    const registry = new ToolRegistry();
    registry.register({ ...readTool, handler });
    const { dispatcher } = buildDispatcher({ registry });

    const outcome = await dispatcher.dispatch(
      { id: 'call_1', name: 'read_thing', arguments: { name: 123 } },
      context(),
    );

    expect(outcome.record.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(outcome.modelVisibleText).toContain('INVALID_INPUT');
    expect(outcome.modelVisibleText).toContain('name');
  });

  it('names the available tools when the model invents one', async () => {
    const { dispatcher } = buildDispatcher();
    const outcome = await dispatcher.dispatch(
      { id: 'call_1', name: 'imaginary_tool', arguments: {} },
      context(),
    );
    expect(outcome.record.ok).toBe(false);
    expect(outcome.modelVisibleText).toContain('read_thing');
  });
});

describe('dispatch: policy and approval', () => {
  it('does not ask for a read-only tool', async () => {
    const responder = vi.fn(async () => ({ granted: true }));
    const { dispatcher } = buildDispatcher({
      policy: { mode: ApprovalMode.askAlways },
      responder,
    });
    await dispatcher.dispatch({ id: 'c', name: 'read_thing', arguments: { name: 'a' } }, context());
    expect(responder).not.toHaveBeenCalled();
  });

  it('asks before a write when the mode requires it', async () => {
    const responder = vi.fn(async () => ({ granted: true }));
    const { dispatcher } = buildDispatcher({
      policy: { mode: ApprovalMode.askAlways },
      responder,
    });
    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'write_thing', arguments: { name: 'a', content: 'x' } },
      context(),
    );
    expect(responder).toHaveBeenCalledTimes(1);
    expect(outcome.record.ok).toBe(true);
  });

  it('does not execute when the user declines, and tells the model not to retry', async () => {
    const handler = vi.fn(() => ok({ written: true }));
    const registry = new ToolRegistry();
    registry.register({ ...writeTool, handler });
    const { dispatcher } = buildDispatcher({
      registry,
      policy: { mode: ApprovalMode.askAlways },
      responder: async () => ({ granted: false }),
    });

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'write_thing', arguments: { name: 'a', content: 'x' } },
      context(),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(outcome.record.ok).toBe(false);
    expect(outcome.modelVisibleText).toMatch(/declined/i);
    expect(outcome.modelVisibleText).toMatch(/Do not retry/i);
  });

  it('confirms a destructive tool even in auto mode', async () => {
    const responder = vi.fn(async () => ({ granted: true }));
    const { dispatcher } = buildDispatcher({ policy: { mode: ApprovalMode.auto }, responder });
    await dispatcher.dispatch(
      { id: 'c', name: 'delete_thing', arguments: { name: 'a' } },
      context(),
    );
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('tells the model that a policy denial will not change on retry', async () => {
    const { dispatcher } = buildDispatcher({ policy: { mode: ApprovalMode.readOnly } });
    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'write_thing', arguments: { name: 'a', content: 'x' } },
      context(),
    );
    expect(outcome.modelVisibleText).toMatch(/forbidden by project policy/i);
  });
});

describe('dispatch: failure containment', () => {
  it('converts a handler that returns an error into a reportable outcome', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...readTool,
      handler: () => err(errors.notFound('thing does not exist', { name: 'ghost' })),
    });
    const { dispatcher } = buildDispatcher({ registry });

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'read_thing', arguments: { name: 'ghost' } },
      context(),
    );
    expect(outcome.record.ok).toBe(false);
    expect(outcome.record.error?.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('catches a handler that throws instead of returning a Result', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...readTool,
      handler: () => {
        throw new Error('handler defect');
      },
    });
    const { dispatcher } = buildDispatcher({ registry });

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'read_thing', arguments: { name: 'a' } },
      context(),
    );
    expect(outcome.record.ok).toBe(false);
    expect(outcome.record.error?.code).toBe(ErrorCode.TOOL_FAILURE);
    expect(outcome.modelVisibleText).toContain('handler defect');
  });

  it('times out a handler that never settles', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...readTool,
      timeoutMs: 100,
      handler: async (_input, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(ok({ aborted: true })), {
            once: true,
          });
        }),
    });
    const { dispatcher } = buildDispatcher({ registry });

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'read_thing', arguments: { name: 'a' } },
      context(),
    );
    expect(outcome.record.error?.code).toBe(ErrorCode.TIMEOUT);
  });

  it('reports an outer abort as cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const { dispatcher } = buildDispatcher();

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'read_thing', arguments: { name: 'a' } },
      { ...context(), signal: controller.signal },
    );
    expect(outcome.record.error?.code).toBe(ErrorCode.ABORTED);
  });

  it('flags a retryable failure as such, and a permanent one as not', async () => {
    const registry = new ToolRegistry();
    registry.register({ ...readTool, handler: () => err(errors.rateLimited('slow down')) });
    const { dispatcher } = buildDispatcher({ registry });

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'read_thing', arguments: { name: 'a' } },
      context(),
    );
    expect(outcome.modelVisibleText).toMatch(/may be transient/i);
  });
});

describe('dispatch: redaction and observability', () => {
  it('redacts secrets out of a tool result before it reaches the model', async () => {
    const redactor = new Redactor();
    redactor.registerValue('leakedsecretvalue');

    const registry = new ToolRegistry();
    registry.register({
      ...readTool,
      handler: () => ok({ config: 'token=leakedsecretvalue', authorization: 'Bearer abcdefghijk' }),
    });
    const { dispatcher } = buildDispatcher({ registry, redactor });

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'read_thing', arguments: { name: 'a' } },
      context(),
    );

    expect(outcome.modelVisibleText).not.toContain('leakedsecretvalue');
    expect(outcome.modelVisibleText).not.toContain('abcdefghijk');
    expect(outcome.record.resultPreview).not.toContain('leakedsecretvalue');
  });

  it('records every call with timing, for the run timeline', async () => {
    const records: ToolCallRecord[] = [];
    const { dispatcher } = buildDispatcher({ onComplete: (record) => records.push(record) });

    await dispatcher.dispatch(
      { id: 'c1', name: 'read_thing', arguments: { name: 'a' } },
      context(),
    );
    await dispatcher.dispatch({ id: 'c2', name: 'nope', arguments: {} }, context());

    expect(records).toHaveLength(2);
    expect(dispatcher.calls).toHaveLength(2);
    expect(records[0]?.callId).toMatch(/^call_/);
    expect(records[0]?.providerCallId).toBe('c1');
    expect(records[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(records[1]?.ok).toBe(false);
  });

  it('survives a describeCall that throws on unvalidated input', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...readTool,
      describeCall: (input) => (input as { name: string }).name.toUpperCase(),
    });
    const { dispatcher } = buildDispatcher({ registry });

    const outcome = await dispatcher.dispatch(
      { id: 'c', name: 'read_thing', arguments: { name: null } },
      context(),
    );
    expect(outcome.record.ok).toBe(false);
    expect(outcome.record.subject).toBe('read_thing');
  });
});
