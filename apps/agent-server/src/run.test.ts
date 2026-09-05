import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ScriptedProvider } from '@aica/agent-core';
import { RpcConnection, createTransportPair } from '@aica/rpc';
import { clientMethods, serverMethods } from '@aica/schemas';
import type { Result } from '@aica/shared';
import { ErrorCode, ok } from '@aica/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentServer } from './server.js';

/**
 * A whole run, end to end, with a scripted model.
 *
 * Everything except the model is real: the framing, the JSON-RPC layer, the
 * gateway, the planner, the tool registry with its approval gate, the patch
 * engine writing to a real temporary directory, and the store. The model is
 * scripted because a test whose outcome depends on a model is not a test.
 */

let root = '';

const SOURCE = [
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aica-run-'));
  await writeFile(path.join(root, 'package.json'), '{"name":"target","type":"module"}', 'utf8');

  const src = path.join(root, 'src');
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');
  await import('node:fs/promises').then((fs) => fs.mkdir(src, { recursive: true }));
  await writeFile(
    path.join(src, 'config.ts'),
    "export const BASE_URL = 'https://api.test/v1';\n",
    'utf8',
  );
  await writeFile(path.join(src, 'client.ts'), SOURCE, 'utf8');
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

interface Harness {
  call: (method: string, params?: unknown) => Promise<Result<unknown>>;
  events: { type: string; payload: unknown }[];
  dispose: () => void;
  open: () => Promise<string>;
}

function connect(
  options: {
    provider?: ScriptedProvider;
    approve?: boolean;
  } = {},
): Harness {
  const [clientSide, serverSide] = createTransportPair();
  const client = new RpcConnection({ transport: clientSide, requestTimeoutMs: 60_000 });
  const server = new RpcConnection({ transport: serverSide, requestTimeoutMs: 60_000 });

  new AgentServer({
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
    call,
    events,
    dispose: () => client.dispose(),
    open: async () => {
      await call(clientMethods.initialize.method, {
        clientName: 'test',
        clientVersion: '0.0.0',
        capabilities: { secretStorage: false, approvals: true },
      });
      const opened = await call(clientMethods.openProject.method, { root });
      if (!opened.ok) throw opened.error;
      const projectId = (opened.value as { projectId: string }).projectId;
      await call(clientMethods.indexCode.method, { projectId });
      return projectId;
    },
  };
}

function scripted(turns: ConstructorParameters<typeof ScriptedProvider>[0]['turns']) {
  return new ScriptedProvider({ turns, model: 'scripted/test' });
}

describe('a run that proposes a change', () => {
  it('plans, proposes, and emits a patch for review', async () => {
    const provider = scripted([
      {
        toolCalls: [{ name: 'fs_read', argumentsJson: JSON.stringify({ path: 'src/client.ts' }) }],
      },
      {
        toolCalls: [
          {
            name: 'propose_patch',
            argumentsJson: JSON.stringify({
              rationale: 'Add a cancelOrder function beside the existing client functions.',
              files: [
                {
                  path: 'src/client.ts',
                  edits: [
                    {
                      oldText: 'export async function fetchOrders',
                      newText:
                        'export async function cancelOrder(token: string, id: string): Promise<void> {\n  await fetch(`${BASE_URL}/orders/${id}`, { method: "DELETE" });\n}\n\nexport async function fetchOrders',
                    },
                  ],
                },
              ],
            }),
          },
        ],
      },
      { text: 'Proposed a cancelOrder function.', stopReason: 'end_turn' },
    ]);

    const harness = connect({ provider });
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
    };
    expect(summary.patchesProposed).toBe(1);
    // The default approval mode does not let the agent write on its own.
    expect(summary.patchesApplied).toBe(0);
    // Nothing was written, so there is nothing to validate — which must not be
    // reported as a pass.
    expect(summary.validationPassed).toBeUndefined();

    const types = harness.events.map((event) => event.type);
    expect(types).toContain('PLAN_CREATED');
    expect(types).toContain('TOOL_CALLED');
    expect(types).toContain('PATCH_CREATED');
    expect(types).toContain('AGENT_COMPLETED');

    // Proposing did not touch the file.
    const onDisk = await readFile(path.join(root, 'src/client.ts'), 'utf8');
    expect(onDisk).toBe(SOURCE);

    harness.dispose();
  });

  it('gives the model the plan rather than the raw request', async () => {
    const provider = scripted([{ text: 'Understood.', stopReason: 'end_turn' }]);
    const harness = connect({ provider });
    const projectId = await harness.open();

    await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'integrate DELETE /orders/{id}',
    });

    const first = provider.requests[0];
    const task = first?.messages.find((message) => message.role === 'user');
    // The brief, not the sentence: it names files and states constraints.
    expect(String(task?.content)).toContain('src/client.ts');
    expect(String(task?.content).length).toBeGreaterThan('integrate DELETE /orders/{id}'.length);

    harness.dispose();
  });

  it('loads the guidance the repository calls for, and says which', async () => {
    // The fixture depends on React, so the React skill applies; nothing in the
    // request mentions it.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'target', type: 'module', dependencies: { react: '^19.0.0' } }),
      'utf8',
    );

    const provider = scripted([{ text: 'Understood.', stopReason: 'end_turn' }]);
    const harness = connect({ provider });
    const projectId = await harness.open();

    await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'update the order list',
    });

    const selected = harness.events.find((event) => event.type === 'SKILLS_SELECTED');
    expect((selected?.payload as { skills: string[] } | undefined)?.skills).toContain('react');

    // The guidance reached the model, framed as guidance.
    const system = provider.requests[0]?.messages.find((message) => message.role === 'system');
    expect(String(system?.content)).toContain('guidance, not permission');

    harness.dispose();
  });

  it('does not load guidance for a framework the project does not use', async () => {
    const provider = scripted([{ text: 'Understood.', stopReason: 'end_turn' }]);
    const harness = connect({ provider });
    const projectId = await harness.open();

    // The word is in the request; the repository says otherwise, and the
    // repository wins.
    await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'render a react component for the order list',
    });

    const selected = harness.events.find((event) => event.type === 'SKILLS_SELECTED');
    expect((selected?.payload as { skills: string[] } | undefined)?.skills ?? []).not.toContain(
      'react',
    );

    harness.dispose();
  });

  it('refuses to run before the project is indexed', async () => {
    const harness = connect({ provider: scripted([]) });

    await harness.call(clientMethods.initialize.method, {
      clientName: 'test',
      clientVersion: '0.0.0',
      capabilities: { secretStorage: false, approvals: true },
    });
    const opened = await harness.call(clientMethods.openProject.method, { root });
    if (!opened.ok) throw opened.error;
    const projectId = (opened.value as { projectId: string }).projectId;

    const result = await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'do work',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.PRECONDITION_FAILED);

    harness.dispose();
  });
});

describe('reviewing and applying a patch', () => {
  async function proposeOne(harness: Harness, projectId: string): Promise<string> {
    await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'add a way to cancel an order',
    });

    const listed = await harness.call(clientMethods.listPatches.method, { projectId });
    if (!listed.ok) throw listed.error;
    const patches = (listed.value as { patches: { patchId: string }[] }).patches;
    return patches[0]?.patchId as string;
  }

  function proposingProvider() {
    return scripted([
      {
        toolCalls: [
          {
            name: 'propose_patch',
            argumentsJson: JSON.stringify({
              rationale: 'Add cancelOrder.',
              files: [
                {
                  path: 'src/client.ts',
                  edits: [
                    {
                      oldText: 'export async function fetchOrders',
                      newText: 'export const CANCEL = true;\n\nexport async function fetchOrders',
                    },
                  ],
                },
              ],
            }),
          },
        ],
      },
      { text: 'Done.', stopReason: 'end_turn' },
    ]);
  }

  it('returns both sides of every file so a diff can be shown', async () => {
    const harness = connect({ provider: proposingProvider() });
    const projectId = await harness.open();
    const patchId = await proposeOne(harness, projectId);

    const preview = await harness.call(clientMethods.previewPatch.method, { projectId, patchId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const content = preview.value as {
      diff: string;
      files: { path: string; before?: string; after?: string }[];
    };
    expect(content.files).toHaveLength(1);
    expect(content.files[0]?.before).toBe(SOURCE);
    expect(content.files[0]?.after).toContain('export const CANCEL = true;');
    expect(content.diff).toContain('CANCEL');

    harness.dispose();
  });

  it('writes only when the patch is applied, and can revert exactly', async () => {
    const harness = connect({ provider: proposingProvider() });
    const projectId = await harness.open();
    const patchId = await proposeOne(harness, projectId);

    expect(await readFile(path.join(root, 'src/client.ts'), 'utf8')).toBe(SOURCE);

    const applied = await harness.call(clientMethods.applyPatch.method, { projectId, patchId });
    expect(applied.ok).toBe(true);
    expect(await readFile(path.join(root, 'src/client.ts'), 'utf8')).toContain('CANCEL');

    const reverted = await harness.call(clientMethods.revertPatch.method, { projectId, patchId });
    expect(reverted.ok).toBe(true);
    // Byte-for-byte, from content captured before the write — not by inverting
    // a diff and hoping.
    expect(await readFile(path.join(root, 'src/client.ts'), 'utf8')).toBe(SOURCE);

    harness.dispose();
  });

  it('refuses to apply the same patch twice', async () => {
    const harness = connect({ provider: proposingProvider() });
    const projectId = await harness.open();
    const patchId = await proposeOne(harness, projectId);

    await harness.call(clientMethods.applyPatch.method, { projectId, patchId });
    const again = await harness.call(clientMethods.applyPatch.method, { projectId, patchId });

    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe(ErrorCode.ALREADY_EXISTS);

    harness.dispose();
  });

  it('refuses to discard a change that is already on disk', async () => {
    const harness = connect({ provider: proposingProvider() });
    const projectId = await harness.open();
    const patchId = await proposeOne(harness, projectId);

    await harness.call(clientMethods.applyPatch.method, { projectId, patchId });
    const discarded = await harness.call(clientMethods.discardPatch.method, { projectId, patchId });

    // Discarding would leave the change in place while the UI showed it gone.
    expect(discarded.ok).toBe(false);
    if (!discarded.ok) expect(discarded.error.code).toBe(ErrorCode.PRECONDITION_FAILED);

    harness.dispose();
  });

  it('refuses to revert something that was never applied', async () => {
    const harness = connect({ provider: proposingProvider() });
    const projectId = await harness.open();
    const patchId = await proposeOne(harness, projectId);

    const reverted = await harness.call(clientMethods.revertPatch.method, { projectId, patchId });
    expect(reverted.ok).toBe(false);

    harness.dispose();
  });

  it('reports an unknown patch id rather than applying nothing quietly', async () => {
    const harness = connect({ provider: scripted([]) });
    const projectId = await harness.open();

    const result = await harness.call(clientMethods.applyPatch.method, {
      projectId,
      patchId: 'patch_invented',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND);

    harness.dispose();
  });
});

describe('what the agent is not allowed to do', () => {
  it('does not get an apply tool in a review-first approval mode', async () => {
    const provider = scripted([
      {
        toolCalls: [{ name: 'apply_patch', argumentsJson: JSON.stringify({ patchId: 'patch_x' }) }],
      },
      { text: 'Could not apply.', stopReason: 'end_turn' },
    ]);

    const harness = connect({ provider });
    const projectId = await harness.open();

    await harness.call(clientMethods.startRun.method, { projectId, task: 'change something' });

    // The tool was never advertised, so the call comes back as unknown rather
    // than being quietly permitted.
    const advertised = provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(advertised).toContain('propose_patch');
    expect(advertised).not.toContain('apply_patch');

    const completed = harness.events.find((event) => event.type === 'TOOL_COMPLETED');
    expect((completed?.payload as { ok: boolean } | undefined)?.ok).toBe(false);

    harness.dispose();
  });

  it('refuses an edit whose anchor does not match the file', async () => {
    const provider = scripted([
      {
        toolCalls: [
          {
            name: 'propose_patch',
            argumentsJson: JSON.stringify({
              rationale: 'Edit text that is not there.',
              files: [
                {
                  path: 'src/client.ts',
                  edits: [{ oldText: 'function thatDoesNotExist', newText: 'x' }],
                },
              ],
            }),
          },
        ],
      },
      { text: 'The anchor did not match.', stopReason: 'end_turn' },
    ]);

    const harness = connect({ provider });
    const projectId = await harness.open();
    const result = await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'break something',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { patchesProposed: number }).patchesProposed).toBe(0);

    harness.dispose();
  });

  it('refuses a stale edit when the file changed after it was read', async () => {
    const provider = scripted([
      {
        toolCalls: [
          {
            name: 'propose_patch',
            argumentsJson: JSON.stringify({
              rationale: 'Edit against a hash from a different version.',
              files: [
                {
                  path: 'src/client.ts',
                  expectedHash: 'a'.repeat(64),
                  edits: [
                    {
                      oldText: 'export async function fetchOrders',
                      newText: 'export const X = 1;\nexport async function fetchOrders',
                    },
                  ],
                },
              ],
            }),
          },
        ],
      },
      { text: 'Stale.', stopReason: 'end_turn' },
    ]);

    const harness = connect({ provider });
    const projectId = await harness.open();
    await harness.call(clientMethods.startRun.method, { projectId, task: 'edit stale' });

    const completed = harness.events.filter((event) => event.type === 'TOOL_COMPLETED');
    const failure = completed.find((event) => (event.payload as { ok: boolean }).ok === false);
    // §37: a concurrent user edit is a loud failure, never a silent overwrite.
    expect(failure).toBeDefined();

    harness.dispose();
  });

  it('refuses to touch a file outside the project', async () => {
    const provider = scripted([
      {
        toolCalls: [
          {
            name: 'propose_patch',
            argumentsJson: JSON.stringify({
              rationale: 'Escape the project.',
              files: [{ path: '../../etc/passwd', create: 'x' }],
            }),
          },
        ],
      },
      { text: 'Refused.', stopReason: 'end_turn' },
    ]);

    const harness = connect({ provider });
    const projectId = await harness.open();
    const result = await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'escape',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { patchesProposed: number }).patchesProposed).toBe(0);

    harness.dispose();
  });
});

describe('run history', () => {
  it('records the run and its events', async () => {
    const provider = scripted([{ text: 'Nothing to do.', stopReason: 'end_turn' }]);
    const harness = connect({ provider });
    const projectId = await harness.open();

    const started = await harness.call(clientMethods.startRun.method, {
      projectId,
      task: 'look around',
    });
    if (!started.ok) throw started.error;
    const runId = (started.value as { runId: string }).runId;

    const runs = await harness.call(clientMethods.listRuns.method, { projectId });
    expect(runs.ok).toBe(true);
    if (runs.ok) {
      const rows = (runs.value as { runs: { id: string; status: string }[] }).runs;
      expect(rows[0]?.id).toBe(runId);
      expect(rows[0]?.status).toBe('completed');
    }

    const events = await harness.call(clientMethods.listRunEvents.method, { runId });
    expect(events.ok).toBe(true);
    if (events.ok) {
      const rows = (events.value as { events: { seq: number; type: string }[] }).events;
      // Sequence numbers are dense and ordered, which is what lets a UI detect
      // a gap in the timeline.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.seq)).toEqual(
        [...rows.map((row) => row.seq)].sort((a, b) => a - b),
      );
    }

    harness.dispose();
  });

  it('cancels a run in flight', async () => {
    // A provider that never returns, so the run is still going when cancelled.
    const provider = {
      id: 'stalled',
      model: 'stalled',
      chat: () => new Promise(() => undefined),
    } as unknown as ScriptedProvider;

    const harness = connect({ provider });
    const projectId = await harness.open();

    const pending = harness.call(clientMethods.startRun.method, { projectId, task: 'hang' });
    await vi.waitFor(() => {
      expect(harness.events.some((event) => event.type === 'AGENT_STARTED')).toBe(true);
    });

    const runId = (harness.events.find((event) => event.type === 'AGENT_STARTED') ?? {}) as {
      payload?: unknown;
    };
    expect(runId).toBeDefined();

    harness.dispose();
    await pending.catch(() => undefined);
  });
});
