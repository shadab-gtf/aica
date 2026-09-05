import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentServer } from '@aica/agent-server';
import { RpcConnection, createTransportPair } from '@aica/rpc';
import { clientMethods } from '@aica/schemas';
import type { ValidationFindingSummary, ValidationSummary } from '@aica/schemas';
import { ErrorCode, newId } from '@aica/shared';
import type { AgentEvent } from '@aica/shared';
import { describe, expect, it, vi } from 'vitest';

import { AgentClient } from './client.js';
import { summarizeValidation, toDiagnostics } from './model/diagnostics.js';
import { demandsAttention, statusBarText, toTimelineEntry } from './model/status.js';
import { apiCatalogTree, flatten, planTree, validationTree } from './model/tree.js';
import { RestartPolicy, resolveServerEntry } from './serverProcess.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/sample-app',
);

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function finding(overrides: Partial<ValidationFindingSummary> = {}): ValidationFindingSummary {
  return {
    check: 'typecheck',
    severity: 'error',
    message: "Property 'total' is missing",
    ...overrides,
  };
}

describe('findings as diagnostics', () => {
  it('converts a one-based tool position to a zero-based editor position once', () => {
    const { byFile } = toDiagnostics([finding({ file: 'src/a.ts', line: 12, column: 5 })]);

    const descriptor = byFile.get('src/a.ts')?.[0];
    expect(descriptor?.startLine).toBe(11);
    expect(descriptor?.startColumn).toBe(4);
  });

  it('covers the whole line when the tool reported no column', () => {
    const { byFile } = toDiagnostics([finding({ file: 'src/a.ts', line: 3 })]);
    const descriptor = byFile.get('src/a.ts')?.[0];

    // A squiggle under column 1 claims a precision the tool did not report.
    expect(descriptor?.wholeLine).toBe(true);
    expect(descriptor?.startColumn).toBe(0);
    expect(descriptor?.endColumn).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('keeps an unlocated finding instead of anchoring it to line one', () => {
    const { byFile, unlocated } = toDiagnostics([
      finding({ code: 'TS18003', message: 'No inputs were found in config file' }),
    ]);

    expect(byFile.size).toBe(0);
    // Losing it would make the problems view disagree with the terminal.
    expect(unlocated).toHaveLength(1);
  });

  it('clamps a zero line rather than producing a negative one', () => {
    const { byFile } = toDiagnostics([finding({ file: 'src/a.ts', line: 0 })]);
    expect(byFile.get('src/a.ts')?.[0]?.startLine).toBe(0);
  });

  it('puts the test name in front of an assertion message', () => {
    const { byFile } = toDiagnostics([
      finding({
        check: 'test',
        file: 'src/a.test.ts',
        line: 40,
        testName: 'cancels an order',
        message: 'expected 2 to be 3',
      }),
    ]);

    // "expected 2 to be 3" on line 40 of a twenty-test file is not actionable.
    expect(byFile.get('src/a.test.ts')?.[0]?.message).toBe('cancels an order: expected 2 to be 3');
  });

  it('groups findings by file and names the producing check', () => {
    const { byFile } = toDiagnostics([
      finding({ file: 'src/a.ts', line: 1 }),
      finding({ file: 'src/a.ts', line: 2 }),
      finding({ check: 'lint', file: 'src/b.ts', line: 1, severity: 'warning' }),
    ]);

    expect(byFile.get('src/a.ts')).toHaveLength(2);
    expect(byFile.get('src/b.ts')?.[0]?.source).toBe('aica/lint');
  });
});

describe('validation summary text', () => {
  const summary = (overrides: Partial<ValidationSummary>): ValidationSummary => ({
    passed: false,
    durationMs: 100,
    results: [],
    findings: [],
    ...overrides,
  });

  it('never reports a pass without saying how many checks ran', () => {
    const text = summarizeValidation(
      summary({
        passed: true,
        results: [
          { check: 'typecheck', passed: true, durationMs: 1, timedOut: false, findingCount: 0 },
          { check: 'test', passed: true, durationMs: 1, timedOut: false, findingCount: 0 },
        ],
      }),
    );
    expect(text).toBe('Validation passed (2 checks)');
  });

  it('says so when a pass had nothing to run', () => {
    // "Validation passed" with zero checks configured is the exact false
    // reassurance the whole validation layer exists to prevent.
    const text = summarizeValidation(
      summary({
        passed: true,
        results: [
          {
            check: 'typecheck',
            passed: true,
            durationMs: 0,
            timedOut: false,
            findingCount: 0,
            skippedReason: 'No command is configured for this check.',
          },
        ],
      }),
    );
    expect(text).toBe('No checks are configured');
  });

  it('distinguishes a failing check from one that could not run', () => {
    expect(
      summarizeValidation(
        summary({
          results: [
            { check: 'test', passed: false, durationMs: 1, timedOut: false, findingCount: 2 },
          ],
          findings: [finding({ check: 'test' }), finding({ check: 'test' })],
        }),
      ),
    ).toBe('test failed — 2 errors');

    expect(
      summarizeValidation(
        summary({
          results: [
            {
              check: 'test',
              passed: false,
              durationMs: 1,
              timedOut: false,
              findingCount: 0,
              skippedReason: 'vitest is not installed',
            },
          ],
        }),
      ),
    ).toBe('test could not run');
  });
});

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

describe('the API catalog tree', () => {
  it('says what is missing instead of rendering blank space', () => {
    const nodes = apiCatalogTree([], new Map());
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe('placeholder');
    expect(nodes[0]?.label).toMatch(/No API imported/);
  });

  it('shows how many call sites an endpoint already has', () => {
    const nodes = apiCatalogTree(
      [
        {
          apiId: 'orders',
          name: 'Orders',
          format: 'openapi3',
          endpointCount: 1,
          servers: [],
          securitySchemes: ['bearerAuth'],
        },
      ],
      new Map([
        [
          'orders',
          [
            {
              id: 'GET /orders',
              apiId: 'orders',
              method: 'GET',
              path: '/orders',
              tags: [],
              requiresAuth: true,
              callSites: [{ file: 'src/api/client.ts', line: 34 }],
            },
          ],
        ],
      ]),
    );

    const endpoint = flatten(nodes).find((node) => node.kind === 'endpoint');
    // The difference between "integrate this" and "already wired up".
    expect(endpoint?.description).toBe('1 call site');
    expect(endpoint?.location).toEqual({ file: 'src/api/client.ts', line: 34 });
  });

  it('names security schemes and never a credential', () => {
    const nodes = apiCatalogTree(
      [
        {
          apiId: 'orders',
          name: 'Orders',
          format: 'openapi3',
          endpointCount: 0,
          servers: ['https://api.example.com/v1'],
          securitySchemes: ['bearerAuth'],
        },
      ],
      new Map(),
    );

    expect(nodes[0]?.tooltip).toContain('bearerAuth');
    expect(nodes[0]?.tooltip).not.toMatch(/token|secret|key\s*[:=]/i);
  });
});

describe('the plan tree', () => {
  const plan = {
    planId: 'plan_1',
    intent: { action: 'integrate', description: 'integrate POST /refunds' },
    confidence: 'low' as const,
    steps: [{ order: 1, description: 'Add a refunds client function', file: 'src/api/client.ts' }],
    targetFiles: ['src/api/client.ts'],
    protectedFiles: ['src/types.ts'],
    constraints: ['Do not add a second HTTP client'],
    validation: ['pnpm test'],
    expectedTests: [],
    openQuestions: ['Which endpoint does "refund" mean?'],
    evidence: ['1 endpoint matched the request'],
  };

  it('puts open questions above the steps', () => {
    const nodes = planTree(plan);
    const questions = nodes.findIndex((node) => node.id === 'plan:questions');
    const steps = nodes.findIndex((node) => node.id === 'plan:steps');

    // A plan with unanswered questions should not be executed, and a reader
    // scrolling past the steps first will start executing.
    expect(questions).toBeGreaterThanOrEqual(0);
    expect(questions).toBeLessThan(steps);
  });

  it('keeps protected files visible as their own section', () => {
    const nodes = planTree(plan);
    const protectedSection = nodes.find((node) => node.id === 'plan:protected');
    expect(protectedSection?.label).toBe('Do not modify');
    expect(protectedSection?.children?.[0]?.label).toBe('src/types.ts');
  });

  it('carries the evidence so a user can disagree with a specific claim', () => {
    const nodes = planTree(plan);
    expect(nodes.find((node) => node.id === 'plan:evidence')?.children).toHaveLength(1);
  });

  it('shows a placeholder before any plan exists', () => {
    expect(planTree(undefined)[0]?.kind).toBe('placeholder');
  });
});

describe('the validation tree', () => {
  it('labels a skipped check skipped, never passed', () => {
    const nodes = validationTree({
      passed: false,
      durationMs: 10,
      results: [
        {
          check: 'lint',
          passed: true,
          durationMs: 0,
          timedOut: false,
          findingCount: 0,
          skippedReason: 'No command is configured for this check.',
        },
      ],
      findings: [],
    });

    const lint = nodes.find((node) => node.label === 'lint');
    expect(lint?.description).toBe('skipped');
    expect(lint?.icon).toBe('circle-slash');
  });

  it('leads with the diagnosis and says whether it is repairable', () => {
    const nodes = validationTree({
      passed: false,
      durationMs: 10,
      results: [
        { check: 'typecheck', passed: false, durationMs: 5, timedOut: false, findingCount: 1 },
      ],
      findings: [finding({ file: 'src/a.ts', line: 2 })],
      diagnosis: {
        category: 'typeError',
        summary: 'typecheck: TS2741 in src/a.ts',
        repairable: true,
        rationale: '1 finding shares a cause',
        groups: [
          { category: 'typeError', summary: 'TS2741', files: ['src/a.ts'], count: 1, weight: 1 },
        ],
      },
    });

    expect(nodes[0]?.id).toBe('validation:diagnosis');
    expect(nodes[0]?.description).toBe('repairable');
  });

  it('marks a timeout as a timeout rather than a failure', () => {
    const nodes = validationTree({
      passed: false,
      durationMs: 10,
      results: [
        { check: 'test', passed: false, durationMs: 60_000, timedOut: true, findingCount: 0 },
      ],
      findings: [],
    });

    expect(nodes.find((node) => node.label === 'test')?.description).toBe('timed out');
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function event<T extends AgentEvent['type']>(
  type: T,
  payload: Extract<AgentEvent, { type: T }>['payload'],
): AgentEvent {
  return {
    id: newId('evt'),
    runId: newId('run'),
    projectId: newId('proj'),
    seq: 1,
    at: new Date().toISOString(),
    type,
    payload,
  } as AgentEvent;
}

describe('events as timeline entries', () => {
  it('shows the redacted preview for a tool call, not its arguments', () => {
    const entry = toTimelineEntry(
      event('TOOL_CALLED', {
        callId: newId('call'),
        tool: 'fs.read',
        risk: 'READ_ONLY',
        argsPreview: 'path=src/a.ts',
      }),
    );

    expect(entry.label).toBe('fs.read');
    expect(entry.detail).toBe('path=src/a.ts');
  });

  it('renders an event type it does not know rather than dropping it', () => {
    // A dropped event is a gap in the run timeline, which is the audit record.
    const entry = toTimelineEntry({
      id: newId('evt'),
      runId: newId('run'),
      projectId: newId('proj'),
      seq: 9,
      at: new Date().toISOString(),
      type: 'SOMETHING_NEW',
      payload: {},
    } as unknown as AgentEvent);

    expect(entry.seq).toBe(9);
    expect(entry.label).toBe('Something new');
  });

  it('marks a failed tool call as an error', () => {
    const entry = toTimelineEntry(
      event('TOOL_COMPLETED', {
        callId: newId('call'),
        tool: 'exec.run',
        ok: false,
        durationMs: 5,
        error: { code: ErrorCode.TOOL_FAILURE, message: 'exit 1', retryable: false },
      }),
    );

    expect(entry.severity).toBe('error');
    expect(entry.detail).toBe('exit 1');
  });

  it('updates the status bar only for state changes', () => {
    expect(statusBarText(event('VALIDATION_STARTED', { steps: ['typecheck'] }))).toBe(
      'Validating…',
    );
    // A status bar flickering through forty tool names says nothing.
    expect(
      statusBarText(
        event('TOOL_CALLED', {
          callId: newId('call'),
          tool: 'fs.read',
          risk: 'READ_ONLY',
          argsPreview: '',
        }),
      ),
    ).toBeUndefined();
  });

  it('knows which events are waiting on the user', () => {
    expect(
      demandsAttention(
        event('APPROVAL_REQUESTED', {
          approvalId: newId('appr'),
          subject: 'write a file',
          risk: 'LOW_RISK_WRITE',
          detail: '',
        }),
      ),
    ).toBe(true);

    expect(demandsAttention(event('STATUS', { message: 'working' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

describe('server supervision', () => {
  it('prefers a configured server path and resolves a relative one', () => {
    expect(
      resolveServerEntry({ configured: '/opt/aica/main.js', extensionPath: '/ext' }),
    ).toContain('main.js');

    expect(resolveServerEntry({ configured: '', extensionPath: '/ext' })).toBe(
      path.join('/ext', 'dist', 'server', 'main.cjs'),
    );
  });

  it('gives up on a server that never starts properly', () => {
    const policy = new RestartPolicy(3, 10_000);

    expect(policy.shouldRestart(200)).toBe(true);
    expect(policy.shouldRestart(200)).toBe(true);
    expect(policy.shouldRestart(200)).toBe(true);
    // A process that dies on every start is misconfigured; restarting it
    // forever is a spin loop.
    expect(policy.shouldRestart(200)).toBe(false);
  });

  it('does not spend the budget on a server that ran and then died', () => {
    const policy = new RestartPolicy(3, 10_000);

    policy.shouldRestart(200);
    policy.shouldRestart(200);
    expect(policy.shouldRestart(60_000)).toBe(true);
    // The long run proves it can start, so the failure budget is restored.
    expect(policy.consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End to end, over the real protocol
// ---------------------------------------------------------------------------

describe('the client against a real server', () => {
  function connect(options: { secrets?: AgentClient['capabilities'] } = {}) {
    const [clientSide, serverSide] = createTransportPair();
    const serverConnection = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });
    new AgentServer({ connection: serverConnection });
    void options;
    return { clientSide, serverConnection };
  }

  it('completes the handshake and opens the workspace', async () => {
    const { clientSide } = connect();
    const client = new AgentClient({ transport: clientSide, requestTimeoutMs: 30_000 });

    const handshake = await client.call(clientMethods.initialize, {
      clientName: 'vscode',
      clientVersion: '0.1.0',
      capabilities: { secretStorage: false, approvals: false },
    });
    expect(handshake.ok).toBe(true);

    const opened = await client.call(clientMethods.openProject, { root: FIXTURE_ROOT });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.name).toBe('sample-app');
    client.dispose();
  });

  it('advertises no capability it cannot answer', async () => {
    const { clientSide } = connect();
    const withSecrets = new AgentClient({
      transport: clientSide,
      secrets: async () => 'value',
    });

    expect(withSecrets.capabilities).toEqual({ secretStorage: true, approvals: false });
    withSecrets.dispose();
  });

  it('surfaces a server error as a typed failure, not an exception', async () => {
    const { clientSide } = connect();
    const client = new AgentClient({ transport: clientSide, requestTimeoutMs: 30_000 });

    await client.call(clientMethods.initialize, {
      clientName: 'vscode',
      clientVersion: '0.1.0',
      capabilities: { secretStorage: false, approvals: false },
    });

    const result = await client.call(clientMethods.projectStatus, { projectId: 'proj_missing' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    client.dispose();
  });

  it('lets the caller omit a defaulted parameter', async () => {
    const { clientSide } = connect();
    const client = new AgentClient({ transport: clientSide, requestTimeoutMs: 30_000 });

    await client.call(clientMethods.initialize, {
      clientName: 'vscode',
      clientVersion: '0.1.0',
      capabilities: {},
    });
    const opened = await client.call(clientMethods.openProject, { root: FIXTURE_ROOT });
    if (!opened.ok) throw opened.error;

    await client.call(clientMethods.indexCode, { projectId: opened.value.projectId });
    // `limit` has a default in the contract; a caller must not have to restate it.
    const result = await client.call(clientMethods.searchCode, {
      projectId: opened.value.projectId,
      query: 'orders',
    });

    expect(result.ok).toBe(true);
    client.dispose();
  });

  it('answers the server request for a secret from its own store', async () => {
    const [clientSide, serverSide] = createTransportPair();
    const serverConnection = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });
    new AgentServer({ connection: serverConnection });

    const store = new Map([['postman', 'stored-value']]);
    const secrets = vi.fn(async (name: string) => store.get(name));

    const client = new AgentClient({ transport: clientSide, secrets, requestTimeoutMs: 30_000 });
    await client.call(clientMethods.initialize, {
      clientName: 'vscode',
      clientVersion: '0.1.0',
      capabilities: client.capabilities,
    });

    // Driven from the server side, which is the only direction this matters in.
    const response = await serverConnection.request('client/readSecret', {
      name: 'postman',
      reason: 'test',
    });

    expect(response).toMatchObject({ ok: true, value: { found: true, value: 'stored-value' } });
    expect(secrets).toHaveBeenCalledWith('postman', 'test');
    client.dispose();
  });

  it('reports a missing secret as not found rather than as an error', async () => {
    const [clientSide, serverSide] = createTransportPair();
    const serverConnection = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });
    new AgentServer({ connection: serverConnection });

    const client = new AgentClient({
      transport: clientSide,
      secrets: async () => undefined,
      requestTimeoutMs: 30_000,
    });

    const response = await serverConnection.request('client/readSecret', {
      name: 'absent',
      reason: 'test',
    });

    // An error would carry the name of the missing secret into a log; `found:
    // false` carries nothing.
    expect(response).toMatchObject({ ok: true, value: { found: false } });
    client.dispose();
  });

  it('denies an approval the user did not answer', async () => {
    const [clientSide, serverSide] = createTransportPair();
    const serverConnection = new RpcConnection({ transport: serverSide, requestTimeoutMs: 30_000 });
    new AgentServer({ connection: serverConnection });

    const client = new AgentClient({
      transport: clientSide,
      // A dismissed dialog, modelled honestly.
      approvals: async () => ({ granted: false, remembered: false }),
      requestTimeoutMs: 30_000,
    });

    const response = await serverConnection.request('client/requestApproval', {
      approvalId: 'appr_1',
      subject: 'delete a file',
      risk: 'DESTRUCTIVE',
      detail: '',
    });

    expect(response).toMatchObject({ ok: true, value: { granted: false } });
    client.dispose();
  });

  it('does not answer a capability it never advertised', async () => {
    const [clientSide, serverSide] = createTransportPair();
    const serverConnection = new RpcConnection({ transport: serverSide, requestTimeoutMs: 200 });
    new AgentServer({ connection: serverConnection });

    const client = new AgentClient({ transport: clientSide, requestTimeoutMs: 200 });

    const response = await serverConnection.request('client/readSecret', {
      name: 'postman',
      reason: 'test',
    });

    // A clean refusal, not a timeout.
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe(ErrorCode.UNSUPPORTED);
    client.dispose();
  });
});
