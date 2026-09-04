import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ErrorCode,
  EventBus,
  RunEmitter,
  err,
  errors,
  isErr,
  newId,
  ok,
  unwrap,
  type AgentEvent,
} from '@aica/shared';
import { ApprovalGate, ApprovalMode, Redactor } from '@aica/security-engine';
import { ToolDispatcher, ToolRegistry, defineTool } from '@aica/tool-registry';

import { ScriptedProvider, type ScriptedTurn } from './providers/scripted.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { AgentRuntime } from './runtime.js';
import { assess, evidence, shouldAskUser, weakest } from './confidence.js';
import { TaskRouter } from './router.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const readFile = defineTool({
  name: 'read_file',
  title: 'Read file',
  description: 'Reads a file from the workspace. Use this before editing anything.',
  category: 'filesystem',
  inputSchema: z.object({ path: z.string().min(1) }),
  risk: 'READ_ONLY',
  actionKind: 'file_read',
  mutates: false,
  handler: (input) => ok({ path: input.path, content: `contents of ${input.path}` }),
});

const applyPatch = defineTool({
  name: 'apply_patch',
  title: 'Apply patch',
  description: 'Applies an anchored edit to a file. Use only after the change has been planned.',
  category: 'filesystem',
  inputSchema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
  risk: 'LOW_RISK_WRITE',
  actionKind: 'patch_apply',
  mutates: true,
  handler: () => ok({ applied: true }),
});

const failing = defineTool({
  name: 'always_fails',
  title: 'Always fails',
  description: 'A tool that always fails, used to exercise the failure paths of the loop.',
  category: 'filesystem',
  inputSchema: z.object({}),
  risk: 'READ_ONLY',
  actionKind: 'file_read',
  mutates: false,
  handler: () => err(errors.notFound('nothing here')),
});

interface Harness {
  runtime: AgentRuntime;
  provider: ScriptedProvider;
  events: AgentEvent[];
  bus: EventBus;
  emitter: RunEmitter;
  runId: ReturnType<typeof newId<'run'>>;
  projectId: ReturnType<typeof newId<'proj'>>;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
}

function harness(
  turns: readonly ScriptedTurn[],
  options: {
    mode?: ApprovalMode;
    granted?: boolean;
    tools?: ReturnType<typeof defineTool>[];
    maxConsecutiveFailures?: number;
    redactor?: Redactor;
  } = {},
): Harness {
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? [readFile, applyPatch, failing]) {
    registry.register(tool as never);
  }

  const dispatcher = new ToolDispatcher({
    registry,
    approvals: new ApprovalGate({
      context: {
        mode: options.mode ?? ApprovalMode.auto,
        allowedEnvironments: ['local'],
        apiExecutionEnabled: true,
      },
      responder: async () => ({ granted: options.granted ?? true }),
    }),
    ...(options.redactor ? { redactor: options.redactor } : {}),
  });

  const provider = new ScriptedProvider({ turns, onExhausted: 'end' });
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const runId = newId('run');
  const projectId = newId('proj');

  return {
    runtime: new AgentRuntime({
      provider,
      registry,
      dispatcher,
      ...(options.maxConsecutiveFailures !== undefined
        ? { maxConsecutiveFailures: options.maxConsecutiveFailures }
        : {}),
    }),
    provider,
    events,
    bus,
    emitter: new RunEmitter({ bus, runId, projectId }),
    runId,
    projectId,
    registry,
    dispatcher,
  };
}

const runOptions = (h: Harness, overrides: Record<string, unknown> = {}) => ({
  runId: h.runId,
  projectId: h.projectId,
  systemPrompt: 'You are a senior engineer.',
  task: 'Integrate the payment API into checkout.',
  emitter: h.emitter,
  environment: 'local' as const,
  ...overrides,
});

const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

describe('ScriptedProvider', () => {
  it('reassembles chunked text into one turn', async () => {
    const provider = new ScriptedProvider({ turns: [{ text: 'A fairly long assistant reply.' }] });
    const turn = unwrap(await provider.chat({ messages: [] }));
    expect(turn.message.content).toBe('A fairly long assistant reply.');
    expect(turn.stopReason).toBe('end_turn');
  });

  it('emits tool calls and reports tool_use', async () => {
    const provider = new ScriptedProvider({
      turns: [{ toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"a.ts"}' }] }],
    });
    const turn = unwrap(await provider.chat({ messages: [] }));
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.message.toolCalls?.[0]?.name).toBe('read_file');
  });

  it('surfaces a scripted provider error as a structured failure', async () => {
    const provider = new ScriptedProvider({
      turns: [{ error: { message: 'provider exploded', retryable: true } }],
    });
    const result = await provider.chat({ messages: [] });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.MODEL_FAILURE);
    expect(isErr(result) && result.error.retryable).toBe(true);
  });

  it('treats a truncated stream as a failure rather than a complete turn', async () => {
    const provider = new ScriptedProvider({ turns: [{ text: 'partial', truncate: true }] });
    const result = await provider.chat({ messages: [] });
    expect(isErr(result) && result.error.message).toMatch(/without completing/i);
  });

  it('respects an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedProvider({ turns: [{ text: 'never sent' }] });
    const result = await provider.chat({ messages: [], signal: controller.signal });
    expect(isErr(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

describe('AgentRuntime', () => {
  it('completes immediately when the model asks for no tools', async () => {
    const h = harness([{ text: 'Nothing to do here.' }]);
    const outcome = unwrap(await h.runtime.run(runOptions(h)));

    expect(outcome.stoppedBecause).toBe('completed');
    expect(outcome.summary).toBe('Nothing to do here.');
    expect(outcome.iterations).toBe(1);
    expect(outcome.toolCalls).toBe(0);
    expect(types(h.events)).toEqual([
      'AGENT_STARTED',
      'USAGE_RECORDED',
      'ASSISTANT_MESSAGE',
      'AGENT_COMPLETED',
    ]);
  });

  it('runs a tool, feeds the result back, and finishes', async () => {
    const h = harness([
      { toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"src/checkout.tsx"}' }] },
      { text: 'I read the file and it uses the existing client.' },
    ]);

    const outcome = unwrap(await h.runtime.run(runOptions(h)));

    expect(outcome.toolCalls).toBe(1);
    expect(outcome.iterations).toBe(2);
    expect(types(h.events)).toContain('TOOL_CALLED');
    expect(types(h.events)).toContain('TOOL_COMPLETED');

    // The tool result was appended to the conversation the model saw next.
    const secondRequest = h.provider.requests[1];
    const toolMessage = secondRequest?.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(JSON.stringify(toolMessage)).toContain('contents of src/checkout.tsx');
  });

  it('advertises the registered tools to the provider', async () => {
    const h = harness([{ text: 'done' }]);
    await h.runtime.run(runOptions(h));
    const names = h.provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('read_file');
    expect(names).toContain('apply_patch');
  });

  it('sends the system prompt and task as the opening messages', async () => {
    const h = harness([{ text: 'done' }]);
    await h.runtime.run(runOptions(h));
    const messages = h.provider.requests[0]?.messages ?? [];
    expect(messages[0]).toMatchObject({ role: 'system', content: 'You are a senior engineer.' });
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user' });
  });

  it('continues a prior conversation when history is supplied', async () => {
    const h = harness([{ text: 'follow-up done' }]);
    await h.runtime.run(
      runOptions(h, {
        history: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      }),
    );
    const contents = (h.provider.requests[0]?.messages ?? []).map((m) =>
      'content' in m ? m.content : '',
    );
    expect(contents).toContain('earlier answer');
  });

  it('handles several tool calls in one turn', async () => {
    const h = harness([
      {
        toolCalls: [
          { name: 'read_file', argumentsJson: '{"path":"a.ts"}' },
          { name: 'read_file', argumentsJson: '{"path":"b.ts"}' },
        ],
      },
      { text: 'read both' },
    ]);
    const outcome = unwrap(await h.runtime.run(runOptions(h)));
    expect(outcome.toolCalls).toBe(2);
  });

  it('tells the model when its tool arguments were not valid JSON', async () => {
    const h = harness([
      { toolCalls: [{ name: 'read_file', argumentsJson: '{"path": broken' }] },
      { text: 'recovered' },
    ]);

    const outcome = unwrap(await h.runtime.run(runOptions(h)));
    expect(outcome.stoppedBecause).toBe('completed');

    const toolMessage = h.provider.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMessage)).toMatch(/not valid JSON/i);
  });

  it('keeps going after a tool failure, so one bad call does not end the run', async () => {
    const h = harness([
      { toolCalls: [{ name: 'always_fails', argumentsJson: '{}' }] },
      { toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"a.ts"}' }] },
      { text: 'recovered after the failure' },
    ]);

    const outcome = unwrap(await h.runtime.run(runOptions(h)));
    expect(outcome.stoppedBecause).toBe('completed');
    expect(outcome.summary).toBe('recovered after the failure');
    expect(h.dispatcher.calls.filter((call) => !call.ok)).toHaveLength(1);
  });

  it('stops after repeated iterations in which every tool call fails', async () => {
    const h = harness(
      Array.from({ length: 10 }, () => ({
        toolCalls: [{ name: 'always_fails', argumentsJson: '{}' }],
      })),
      { maxConsecutiveFailures: 3 },
    );

    const outcome = unwrap(await h.runtime.run(runOptions(h)));
    expect(outcome.stoppedBecause).toBe('repeated_failures');
    expect(outcome.iterations).toBe(3);
    // The report names the actual cause rather than claiming success.
    expect(outcome.summary).toMatch(/nothing here/);
  });

  it('stops at the iteration limit and says the task needs breaking down', async () => {
    const h = harness(
      Array.from({ length: 20 }, () => ({
        toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
      })),
    );

    const outcome = unwrap(await h.runtime.run(runOptions(h, { maxIterations: 4 })));
    expect(outcome.stoppedBecause).toBe('max_iterations');
    expect(outcome.iterations).toBe(4);
    expect(outcome.summary).toMatch(/smaller steps/i);
  });

  it('ends the run when the provider itself fails', async () => {
    const h = harness([{ error: { message: 'provider outage', retryable: true } }]);
    const result = await h.runtime.run(runOptions(h));

    expect(isErr(result) && result.error.code).toBe(ErrorCode.MODEL_FAILURE);
    expect(types(h.events)).toContain('AGENT_FAILED');
  });

  it('reports cancellation rather than a completed run', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([{ text: 'unreachable' }]);

    const result = await h.runtime.run(runOptions(h, { signal: controller.signal }));
    expect(isErr(result) && result.error.code).toBe(ErrorCode.ABORTED);
  });

  it('does not execute a write the user declined, and continues the run', async () => {
    const h = harness(
      [
        {
          toolCalls: [
            { name: 'apply_patch', argumentsJson: '{"path":"a.ts","oldText":"x","newText":"y"}' },
          ],
        },
        { text: 'The user declined the edit, so nothing was changed.' },
      ],
      { mode: ApprovalMode.askAlways, granted: false },
    );

    const outcome = unwrap(await h.runtime.run(runOptions(h)));
    const failed = h.dispatcher.calls.find((call) => !call.ok);
    expect(failed?.error?.code).toBe(ErrorCode.APPROVAL_DENIED);
    expect(outcome.stoppedBecause).toBe('completed');
  });

  it('accumulates usage across turns', async () => {
    const h = harness([
      { toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"a.ts"}' }] },
      { text: 'done' },
    ]);
    const outcome = unwrap(await h.runtime.run(runOptions(h)));
    expect(outcome.usage.inputTokens).toBe(200);
    expect(outcome.usage.outputTokens).toBe(100);
  });

  it('emits events with monotonic sequence numbers for the run timeline', async () => {
    const h = harness([
      { toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"a.ts"}' }] },
      { text: 'done' },
    ]);
    await h.runtime.run(runOptions(h));
    const seqs = h.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('never emits a secret in an event payload', async () => {
    const redactor = new Redactor();
    redactor.registerValue('supersecrettoken');

    const leaky = defineTool({
      name: 'leak_tool',
      title: 'Leak',
      description: 'Returns something containing a credential, to prove redaction is applied.',
      category: 'filesystem',
      inputSchema: z.object({}),
      risk: 'READ_ONLY',
      actionKind: 'file_read',
      mutates: false,
      handler: () => ok({ config: 'token=supersecrettoken' }),
    });

    const h = harness(
      [{ toolCalls: [{ name: 'leak_tool', argumentsJson: '{}' }] }, { text: 'done' }],
      { tools: [leaky], redactor },
    );

    await h.runtime.run(runOptions(h));
    expect(JSON.stringify(h.events)).not.toContain('supersecrettoken');
  });
});

// ---------------------------------------------------------------------------
// OpenRouter adapter, against a stubbed transport
// ---------------------------------------------------------------------------

function sseResponse(chunks: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const openRouter = (fetchImpl: typeof fetch): OpenRouterProvider =>
  new OpenRouterProvider({
    apiKey: 'test-key-not-real',
    model: 'anthropic/claude-sonnet-4.5',
    fetchImpl,
  });

describe('OpenRouterProvider', () => {
  it('assembles streamed text deltas', async () => {
    const provider = openRouter(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const turn = unwrap(await provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(turn.message.content).toBe('Hello world');
    expect(turn.stopReason).toBe('end_turn');
  });

  it('reassembles a tool call split across deltas', async () => {
    const provider = openRouter(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const turn = unwrap(await provider.chat({ messages: [] }));
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.message.toolCalls?.[0]).toMatchObject({
      id: 'call_abc',
      name: 'read_file',
      argumentsJson: '{"path":"a.ts"}',
    });
  });

  it('reports usage when the provider includes it', async () => {
    const provider = openRouter(async () =>
      sseResponse([
        'data: {"usage":{"prompt_tokens":11,"completion_tokens":7,"total_cost":0.0012}}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      ]),
    );
    const turn = unwrap(await provider.chat({ messages: [] }));
    expect(turn.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, costUsd: 0.0012 });
  });

  it('explains a rejected credential and marks it not retryable', async () => {
    const provider = openRouter(
      async () =>
        new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), {
          status: 401,
        }),
    );
    const result = await provider.chat({ messages: [] });
    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.message).toMatch(/rejected the credentials/i);
    expect(isErr(result) && result.error.retryable).toBe(false);
  });

  it('marks a rate limit retryable', async () => {
    const provider = openRouter(async () => new Response('{}', { status: 429 }));
    const result = await provider.chat({ messages: [] });
    expect(isErr(result) && result.error.retryable).toBe(true);
  });

  it('marks a server error retryable', async () => {
    const provider = openRouter(async () => new Response('{}', { status: 503 }));
    const result = await provider.chat({ messages: [] });
    expect(isErr(result) && result.error.retryable).toBe(true);
  });

  it('never puts the API key in an error message', async () => {
    const provider = openRouter(async () => {
      throw new Error('socket hang up');
    });
    const result = await provider.chat({ messages: [] });
    expect(isErr(result) && result.error.message).not.toContain('test-key-not-real');
  });

  it('sends the key as a bearer header and the tools as function specs', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n']),
    );
    const provider = openRouter(fetchImpl as unknown as typeof fetch);

    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', description: 'reads a file', parameters: { type: 'object' } }],
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key-not-real');
    const body = JSON.parse(String(init.body)) as { tools: unknown[]; stream: boolean };
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
  });

  it('tolerates a malformed SSE line without failing the turn', async () => {
    const provider = openRouter(async () =>
      sseResponse([
        ': keepalive comment\n\n',
        'data: not json at all\n\n',
        'data: {"choices":[{"delta":{"content":"survived"},"finish_reason":"stop"}]}\n\n',
      ]),
    );
    const turn = unwrap(await provider.chat({ messages: [] }));
    expect(turn.message.content).toBe('survived');
  });

  it('treats a stream with no finish reason as a failure', async () => {
    const provider = openRouter(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"half"}}]}\n\n']),
    );
    const result = await provider.chat({ messages: [] });
    expect(isErr(result) && result.error.message).toMatch(/without a finish reason/i);
  });

  it('surfaces an error object embedded in the stream', async () => {
    const provider = openRouter(async () =>
      sseResponse(['data: {"error":{"message":"model overloaded"}}\n\n']),
    );
    const result = await provider.chat({ messages: [] });
    expect(isErr(result) && result.error.message).toBe('model overloaded');
  });
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

describe('confidence engine', () => {
  it('is HIGH only when several independent facts agree', () => {
    const result = assess({
      subject: 'endpoint selection',
      evidence: [
        evidence('endpoint-match', 'exactly one endpoint matches POST /payments', true),
        evidence('client-found', 'an existing API client was found at lib/api/client.ts', true),
        evidence('types-align', 'PaymentRequest matches the request schema', true),
      ],
    });
    expect(result.confidence).toBe('HIGH');
    expect(result.supporting).toBe(3);
    expect(shouldAskUser(result)).toBe(false);
  });

  it('is MEDIUM on a single uncorroborated fact', () => {
    const result = assess({
      subject: 'integration point',
      evidence: [evidence('name-match', 'a component named CheckoutForm exists', true)],
    });
    expect(result.confidence).toBe('MEDIUM');
    expect(result.rationale).toMatch(/Nothing corroborates it/i);
  });

  it('caps at MEDIUM when anything contradicts, rather than averaging it away', () => {
    const result = assess({
      subject: 'endpoint selection',
      evidence: [
        evidence('endpoint-match', 'POST /payments matches', true),
        evidence('endpoint-match', 'POST /charges also matches', true),
        evidence('ambiguity', 'two endpoints match equally well', false),
      ],
    });
    expect(result.confidence).toBe('MEDIUM');
    expect(result.opposing).toBe(1);
  });

  it('is LOW with no evidence, however plausible the conclusion', () => {
    const result = assess({ subject: 'auth method', evidence: [] });
    expect(result.confidence).toBe('LOW');
    expect(shouldAskUser(result)).toBe(true);
  });

  it('takes the weakest part of a compound decision', () => {
    const high = assess({
      subject: 'a',
      evidence: [evidence('k', 'one', true), evidence('k', 'two', true)],
    });
    const low = assess({ subject: 'b', evidence: [] });
    expect(weakest([high, high])).toBe('HIGH');
    expect(weakest([high, low])).toBe('LOW');
    expect(weakest([])).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// Task router
// ---------------------------------------------------------------------------

describe('TaskRouter', () => {
  const router = new TaskRouter();

  it('never reinterprets an explicit command', () => {
    const result = router.classify({
      text: 'something that sounds like a security review',
      command: 'find-frontend-issues',
    });
    expect(result.kind).toBe('FRONTEND_REVIEW');
    expect(result.decidedBy).toBe('explicit');
    expect(result.confidence).toBe('HIGH');
  });

  it.each([
    ['Integrate the payment API into checkout.', 'API_INTEGRATION'],
    ['Connect this API to this page.', 'API_INTEGRATION'],
    ['API changed. Find what broke.', 'API_CHANGE_IMPACT'],
    ['Which endpoint should I use for refunds?', 'API_ANALYSIS'],
    ['Find why this frontend is failing.', 'BUG_FIX'],
    ['Review this component for production issues.', 'FRONTEND_REVIEW'],
    ['Run a security review of the auth module.', 'SECURITY_REVIEW'],
    ['This page is too slow, find performance problems.', 'PERFORMANCE_REVIEW'],
    ['Write tests for the payment service.', 'TEST_GENERATION'],
    ['Refactor this into a shared hook.', 'REFACTOR'],
    ['Find every place this endpoint is used.', 'API_CHANGE_IMPACT'],
    ['Document this module.', 'DOCUMENTATION'],
    ['Connect the GitHub MCP server.', 'MCP_TASK'],
  ])('classifies %j as %s', (text, expected) => {
    expect(router.classify({ text }).kind).toBe(expected);
  });

  it('falls back to general development with low confidence', () => {
    const result = router.classify({ text: 'hello there' });
    expect(result.kind).toBe('GENERAL_DEVELOPMENT');
    expect(result.confidence).toBe('LOW');
    expect(router.needsModelClassification(result)).toBe(true);
  });

  it('handles empty input without guessing', () => {
    expect(router.classify({ text: '   ' }).confidence).toBe('LOW');
  });

  it('does not consult the model when the deterministic rules were decisive', () => {
    const result = router.classify({ text: 'Integrate the payment API into the checkout page.' });
    expect(result.confidence).toBe('HIGH');
    expect(router.needsModelClassification(result)).toBe(false);
  });

  it('declines to be confident when two kinds are genuinely close', () => {
    // "fix" points at a bug, "slow" points at performance, and neither
    // dominates. The correct behaviour is to offer both rather than pick one
    // silently (specification section 69, scenario 10).
    const result = router.classify({ text: 'fix the slow checkout page' });
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.confidence).not.toBe('HIGH');
    expect([result.kind, ...result.alternatives]).toContain('PERFORMANCE_REVIEW');
    expect([result.kind, ...result.alternatives]).toContain('BUG_FIX');
  });

  it('discounts integration when there is no API catalog to integrate', () => {
    const withCatalog = router.classify({ text: 'wire up the api', hasApiCatalog: true });
    const without = router.classify({ text: 'wire up the api', hasApiCatalog: false });
    expect(withCatalog.kind).toBe('API_INTEGRATION');
    expect(without.confidence === 'LOW' || without.kind !== 'API_INTEGRATION').toBe(true);
  });
});
