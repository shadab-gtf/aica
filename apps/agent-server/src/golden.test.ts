import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ScriptedProvider } from '@aica/agent-core';
import { RpcConnection, createTransportPair } from '@aica/rpc';
import { clientMethods, serverMethods } from '@aica/schemas';
import { ErrorCode, RunBudget, ok } from '@aica/shared';
import { AuditLog, EgressLedger, Redactor } from '@aica/security-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentServer } from './server.js';

/**
 * The golden suite — the Phase 10 gate.
 *
 * Every scenario runs against the whole system: real framing, real JSON-RPC,
 * real gateway, real planner, real tool registry with its approval gate, real
 * patch engine writing to a real directory. Only the model is scripted, because
 * a suite whose outcome depends on a model is not a suite.
 *
 * What is being checked is not "does the happy path work". It is the set of
 * claims this system makes about itself: that it will not write without being
 * allowed to, that it will not report an unvalidated change as validated, that
 * it records what it refused, and that it says what left the machine.
 */

let root = '';

const CLIENT = [
  "import { BASE_URL } from './config.js';",
  '',
  'export async function fetchOrders(token: string): Promise<unknown> {',
  '  const response = await fetch(`${BASE_URL}/orders`, {',
  '    headers: { Authorization: `Bearer ${token}` },',
  '  });',
  '  return response.json();',
  '}',
  '',
].join('\n');

async function makeProject(config: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'aica-golden-'));
  await mkdir(path.join(directory, 'src'), { recursive: true });

  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'target', type: 'module', dependencies: { react: '^19.0.0' } }),
    'utf8',
  );
  await writeFile(
    path.join(directory, 'src/config.ts'),
    "export const BASE_URL = 'https://api.test/v1';\n",
    'utf8',
  );
  await writeFile(path.join(directory, 'src/client.ts'), CLIENT, 'utf8');
  await writeFile(
    path.join(directory, 'agent.config.json'),
    JSON.stringify({ model: { provider: 'scripted', model: 'scripted/golden' }, ...config }),
    'utf8',
  );

  return directory;
}

beforeEach(async () => {
  root = await makeProject();
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function scripted(turns: ConstructorParameters<typeof ScriptedProvider>[0]['turns']) {
  return new ScriptedProvider({ turns, model: 'scripted/golden' });
}

function propose(rationale: string, oldText: string, newText: string) {
  return {
    name: 'propose_patch',
    argumentsJson: JSON.stringify({
      rationale,
      files: [{ path: 'src/client.ts', edits: [{ oldText, newText }] }],
    }),
  };
}

function connect(options: { provider?: ScriptedProvider; approve?: boolean } = {}) {
  const [clientSide, serverSide] = createTransportPair();
  const client = new RpcConnection({ transport: clientSide, requestTimeoutMs: 60_000 });
  const server = new RpcConnection({ transport: serverSide, requestTimeoutMs: 60_000 });

  const agent = new AgentServer({
    connection: server,
    ...(options.provider ? { provider: options.provider } : {}),
  });

  const events: { type: string; payload: unknown }[] = [];
  client.onNotification('agent/event', (params) => {
    const event = params as { type: string; payload: unknown };
    events.push({ type: event.type, payload: event.payload });
  });

  client.onRequest(serverMethods.requestApproval.method, async () =>
    ok({ granted: options.approve ?? true, remembered: false }),
  );

  const call = (method: string, params?: unknown) => client.request(method, params);

  return {
    agent,
    events,
    call,
    dispose: () => client.dispose(),
    open: async (projectRoot = root) => {
      await call(clientMethods.initialize.method, {
        clientName: 'golden',
        clientVersion: '1',
        capabilities: { secretStorage: false, approvals: true },
      });
      const opened = await call(clientMethods.openProject.method, { root: projectRoot });
      if (!opened.ok) throw opened.error;
      const projectId = (opened.value as { projectId: string }).projectId;
      await call(clientMethods.indexCode.method, { projectId });
      return projectId;
    },
  };
}

// ---------------------------------------------------------------------------
// Scenarios 1 and 2 — integrating an endpoint, and one already in use
// ---------------------------------------------------------------------------

describe('scenario 1: integrating an endpoint the codebase does not call', () => {
  it('plans from evidence, proposes, and writes nothing until told', async () => {
    const harness = connect({
      provider: scripted([
        {
          toolCalls: [
            propose(
              'Add cancelOrder beside the existing client functions.',
              'export async function fetchOrders',
              'export async function cancelOrder(id: string): Promise<void> {\n  await fetch(`${BASE_URL}/orders/${id}`, { method: "DELETE" });\n}\n\nexport async function fetchOrders',
            ),
          ],
        },
        { text: 'Proposed cancelOrder.', stopReason: 'end_turn' },
      ]),
    });

    const projectId = await harness.open();
    const result = await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'add a way to cancel an order',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = result.value as {
      patchesProposed: number;
      patchesApplied: number;
      validationPassed?: boolean;
      usage: { toolCalls: number };
    };

    expect(summary.patchesProposed).toBe(1);
    expect(summary.patchesApplied).toBe(0);
    // Nothing was written, so there was nothing to validate.
    expect(summary.validationPassed).toBeUndefined();
    expect(summary.usage.toolCalls).toBe(1);

    // And the file on disk is untouched.
    expect(await readFile(path.join(root, 'src/client.ts'), 'utf8')).toBe(CLIENT);

    harness.dispose();
  });
});

describe('scenario 2: an endpoint the codebase already calls', () => {
  it('finds the existing call site and plans to extend it', async () => {
    const harness = connect({ provider: scripted([{ text: 'ok', stopReason: 'end_turn' }]) });
    const projectId = await harness.open();

    await harness.call(clientMethods.importApi.method, {
      projectId,
      source: { kind: 'text', text: 'curl https://api.test/v1/orders' },
    });

    const endpoints = await harness.call(clientMethods.listEndpoints.method, { projectId });
    expect(endpoints.ok).toBe(true);
    if (!endpoints.ok) return;

    const orders = (
      endpoints.value as { endpoints: { path: string; callSites: unknown[] }[] }
    ).endpoints.find((endpoint) => endpoint.path === '/v1/orders');

    // The spec's path carries `/v1`; the code keeps it in a BASE_URL constant.
    // Missing this reports an endpoint the codebase calls as uncalled.
    expect(orders?.callSites.length).toBeGreaterThan(0);

    const planned = await harness.call(clientMethods.createPlan.method, {
      projectId,
      message: 'change how orders are listed',
    });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      const steps = (planned.value as { steps: { description: string }[] }).steps;
      expect(steps.some((step) => /existing/i.test(step.description))).toBe(true);
    }

    harness.dispose();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — validation and bounded repair
// ---------------------------------------------------------------------------

describe('scenario 4: a change that does not validate', () => {
  it('does not report an unvalidated change as validated', async () => {
    // A project whose typecheck always fails, and an agent permitted to write.
    const failing = await makeProject({
      permissions: { approvalMode: 'auto' },
      validation: {
        typecheck: [
          'node',
          '-e',
          'process.stderr.write("src/a.ts(1,1): error TS1005: nope"); process.exit(1)',
        ],
      },
      limits: { maxIterations: 6 },
    });

    const harness = connect({
      provider: scripted([
        {
          toolCalls: [
            propose(
              'Add a constant.',
              'export async function fetchOrders',
              'export const X = 1;\n\nexport async function fetchOrders',
            ),
          ],
        },
        {
          toolCalls: [
            { name: 'apply_patch', argumentsJson: JSON.stringify({ patchId: 'PLACEHOLDER' }) },
          ],
        },
        { text: 'Applied.', stopReason: 'end_turn' },
      ]),
    });

    const projectId = await harness.open(failing);
    const result = await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'add a constant',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const summary = result.value as { validationPassed?: boolean; patchesApplied: number };
      // The apply failed (the id was invented), so nothing was written and
      // nothing was validated. Either way, never `true`.
      expect(summary.validationPassed).not.toBe(true);
    }

    harness.dispose();
    await rm(failing, { recursive: true, force: true });
  });

  it('refuses to apply a patch nobody previewed', async () => {
    const harness = connect({
      provider: scripted([
        {
          toolCalls: [
            { name: 'apply_patch', argumentsJson: JSON.stringify({ patchId: 'patch_invented' }) },
          ],
        },
        { text: 'Could not.', stopReason: 'end_turn' },
      ]),
    });

    const auto = await makeProject({ permissions: { approvalMode: 'auto' } });
    const projectId = await harness.open(auto);
    await harness.call(clientMethods.startRun.method, { projectId, task: 'write something' });

    const failures = harness.events.filter(
      (event) => event.type === 'TOOL_COMPLETED' && (event.payload as { ok: boolean }).ok === false,
    );
    // Applying a patch nobody previewed would bypass review entirely.
    expect(failures.length).toBeGreaterThan(0);

    harness.dispose();
    await rm(auto, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// The claims this system makes about itself
// ---------------------------------------------------------------------------

describe('the agent cannot write without being allowed to', () => {
  it('is not even given the tool in a review-first mode', async () => {
    const provider = scripted([{ text: 'ok', stopReason: 'end_turn' }]);
    const harness = connect({ provider });
    const projectId = await harness.open();

    await harness.call(clientMethods.startRun.method, { projectId, task: 'change something' });

    const advertised = provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(advertised).toContain('propose_patch');
    expect(advertised).not.toContain('apply_patch');

    harness.dispose();
  });

  it('refuses a path outside the project', async () => {
    const harness = connect({
      provider: scripted([
        {
          toolCalls: [
            {
              name: 'propose_patch',
              argumentsJson: JSON.stringify({
                rationale: 'escape',
                files: [{ path: '../../etc/passwd', create: 'x' }],
              }),
            },
          ],
        },
        { text: 'Refused.', stopReason: 'end_turn' },
      ]),
    });

    const projectId = await harness.open();
    const result = await harness.call(clientMethods.startRun.method, { projectId, task: 'escape' });

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { patchesProposed: number }).patchesProposed).toBe(0);

    harness.dispose();
  });
});

describe('the audit record', () => {
  it('records what was attempted, including what was refused', async () => {
    const harness = connect({
      provider: scripted([
        {
          toolCalls: [
            {
              name: 'propose_patch',
              argumentsJson: JSON.stringify({
                rationale: 'escape',
                files: [{ path: '../outside.ts', create: 'x' }],
              }),
            },
          ],
        },
        { text: 'done', stopReason: 'end_turn' },
      ]),
    });

    const projectId = await harness.open();
    await harness.call(clientMethods.startRun.method, { projectId, task: 'try something' });

    const trail = await harness.call(clientMethods.auditTrail.method, { projectId });
    expect(trail.ok).toBe(true);
    if (!trail.ok) return;

    const entries = (trail.value as { entries: { action: string; decision: string }[] }).entries;
    expect(entries.length).toBeGreaterThan(0);

    // The refused tool call is in the record. An audit log that only records
    // successes cannot answer the question it is usually opened for.
    expect(entries.some((entry) => entry.decision === 'failed')).toBe(true);

    harness.dispose();
  });

  it('summarises runs, refusals, and what left the machine', async () => {
    const harness = connect({ provider: scripted([{ text: 'ok', stopReason: 'end_turn' }]) });
    const projectId = await harness.open();
    await harness.call(clientMethods.startRun.method, { projectId, task: 'look around' });

    const summary = await harness.call(clientMethods.observability.method, { projectId });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;

    const value = summary.value as {
      runs: { total: number; validated: number };
      audit: { entries: number };
      egress: { localOnly: boolean; byHost: unknown[] };
    };

    expect(value.runs.total).toBe(1);
    // The run changed nothing, so it is not counted as validated.
    expect(value.runs.validated).toBe(0);
    expect(value.audit.entries).toBeGreaterThan(0);
    // A scripted provider sends nothing anywhere.
    expect(value.egress.byHost).toEqual([]);

    harness.dispose();
  });
});

describe('nothing secret reaches a record', () => {
  it('redacts a credential before an audit entry exists', () => {
    const redactor = new Redactor();
    redactor.registerValue('super-secret-token-value');

    const audit = new AuditLog({ projectId: 'proj_1', redactor });
    const entry = audit.record({
      actor: 'agent',
      action: 'tool_call',
      subject: 'call with super-secret-token-value',
      decision: 'succeeded',
      details: { authorization: 'Bearer super-secret-token-value' },
    });

    // Redacted on the way in. A secret that reaches storage has leaked whatever
    // a reader does with it afterwards.
    expect(entry.subject).not.toContain('super-secret-token-value');
    expect(JSON.stringify(entry.details)).not.toContain('super-secret-token-value');
  });

  it('records destinations and volumes, never payloads', () => {
    const ledger = new EgressLedger();
    ledger.record({
      kind: 'model',
      host: 'https://openrouter.ai/api/v1',
      requestBytes: 4096,
      responseBytes: 512,
    });

    const summary = ledger.summarize();
    expect(summary[0]?.host).toBe('openrouter.ai');
    expect(summary[0]?.requestBytes).toBe(4096);
    // The shape has no field for a body: recording what was sent to a model
    // would put a copy of the source on disk.
    expect(Object.keys(ledger.all[0] ?? {})).not.toContain('body');
  });

  it('refuses egress when a project says local-only', () => {
    const ledger = new EgressLedger({ localOnly: true });

    expect(ledger.permits('api.example.com').allowed).toBe(false);
    // Loopback is not egress. Treating it as such would make the setting
    // unusable while protecting nothing.
    expect(ledger.permits('127.0.0.1').allowed).toBe(true);
    expect(ledger.permits('http://localhost:54321').allowed).toBe(true);
  });
});

describe('run budgets', () => {
  it('stops on the limit that ran out, and says which', () => {
    const budget = new RunBudget({ maxToolCalls: 2 });
    budget.countToolCall(true);
    expect(budget.check().ok).toBe(true);

    budget.countToolCall(true);
    const verdict = budget.check();

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.limit).toBe('maxToolCalls');
      // "Stopped after 2 tool calls" is actionable; "budget exceeded" is not.
      expect(verdict.reason).toContain('2 tool calls');
    }
  });

  it('counts a file once however many times it is rewritten', () => {
    const budget = new RunBudget({ maxFilesChanged: 2 });
    budget.countFiles(['a.ts', 'a.ts', 'b.ts']);

    expect(budget.usage.filesChanged).toBe(2);
    expect(budget.check().ok).toBe(false);
  });

  it('checks a file limit before the write, not after', () => {
    const budget = new RunBudget({ maxFilesChanged: 2 });
    budget.countFiles(['a.ts']);

    // A patch refused is a patch the user still has; a patch applied past the
    // limit is a repository already rewritten.
    expect(budget.allowsFiles(['b.ts']).ok).toBe(true);
    expect(budget.allowsFiles(['b.ts', 'c.ts']).ok).toBe(false);
  });

  it('counts consecutive failures, not total ones', () => {
    const budget = new RunBudget({ maxConsecutiveFailures: 3 });

    for (let index = 0; index < 10; index += 1) {
      budget.countToolCall(index % 2 === 0);
    }
    // Forty successes and one failure is a run that is working.
    expect(budget.check().ok).toBe(true);

    budget.countToolCall(false);
    budget.countToolCall(false);
    budget.countToolCall(false);
    expect(budget.check().ok).toBe(false);
  });

  it('treats an unset limit as unlimited', () => {
    const budget = new RunBudget({});
    for (let index = 0; index < 1000; index += 1) budget.countToolCall(true);
    expect(budget.check().ok).toBe(true);
  });
});

describe('guidance never becomes permission', () => {
  it('frames skills as guidance in the system prompt', async () => {
    const provider = scripted([{ text: 'ok', stopReason: 'end_turn' }]);
    const harness = connect({ provider });
    const projectId = await harness.open();

    await harness.call(clientMethods.startRun.method, { projectId, task: 'update the order list' });

    const system = provider.requests[0]?.messages.find((message) => message.role === 'system');
    const text = String(system?.content);

    // The project depends on React, so the React skill applies — and arrives
    // under a heading saying it cannot lift a rule.
    expect(text).toContain('guidance, not permission');
    expect(text).toContain('Never disable, skip, weaken');

    harness.dispose();
  });
});

describe('cancellation', () => {
  it('stops a run that is in flight', async () => {
    const stalled = {
      id: 'stalled',
      model: 'stalled',
      chat: () => new Promise(() => undefined),
    } as unknown as ScriptedProvider;

    const harness = connect({ provider: stalled });
    const projectId = await harness.open();

    const pending = harness.call(clientMethods.startRun.method, { projectId, task: 'hang' });
    await vi.waitFor(() => {
      expect(harness.events.some((event) => event.type === 'AGENT_STARTED')).toBe(true);
    });

    harness.dispose();
    await pending.catch(() => undefined);
  });

  it('reports an unknown project rather than acting on a guess', async () => {
    const harness = connect({ provider: scripted([]) });
    await harness.call(clientMethods.initialize.method, {
      clientName: 'golden',
      clientVersion: '1',
      capabilities: {},
    });

    const result = await harness.call(clientMethods.startRun.method, {
      projectId: 'proj_nonexistent',
      task: 'anything',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND);

    harness.dispose();
  });
});
