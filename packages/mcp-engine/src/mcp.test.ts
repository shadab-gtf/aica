import type { Transport } from '@aica/rpc';
import { RpcConnection, createTransportPair, lineDelimitedCodec } from '@aica/rpc';
import { mcpServerConfigSchema } from '@aica/schemas';
import type { McpServerConfig } from '@aica/schemas';
import { ApprovalGate } from '@aica/security-engine';
import { ErrorCode, ok } from '@aica/shared';
import { ToolDispatcher, ToolRegistry, toToolSpec } from '@aica/tool-registry';
import { describe, expect, it, vi } from 'vitest';

import { McpClient } from './client.js';
import {
  classifyMcpTool,
  parseQualifiedName,
  qualifiedToolName,
  serverPermittedIn,
} from './permissions.js';
import { McpRegistry } from './registry.js';
import { PREFERRED_PROTOCOL_VERSION, renderContent } from './protocol.js';

/**
 * Golden scenario 8 — the Phase 7 gate.
 *
 * A real MCP server, in process, over the real line-delimited codec and the
 * real JSON-RPC layer. Only the pipe is simulated; nothing is spawned and
 * nothing is installed, which is the point — a test suite that npm-installs a
 * third-party server to prove the client works has tested npm.
 */

interface FakeServerOptions {
  readonly protocolVersion?: string;
  readonly tools?: readonly Record<string, unknown>[];
  readonly pages?: readonly { tools: Record<string, unknown>[]; nextCursor?: string }[];
  readonly onCall?: (name: string, args: unknown) => unknown;
  readonly declareTools?: boolean;
  readonly instructions?: string;
  readonly failInitialize?: boolean;
}

/** An MCP server that speaks the protocol, in process. */
function fakeServer(options: FakeServerOptions = {}): {
  transport: Transport;
  calls: { name: string; args: unknown }[];
  dispose: () => void;
} {
  const [clientSide, serverSide] = createTransportPair();
  const calls: { name: string; args: unknown }[] = [];

  const server = new RpcConnection({
    transport: serverSide,
    codec: lineDelimitedCodec,
    requestTimeoutMs: 5000,
  });

  server.onRequest('initialize', async () => {
    if (options.failInitialize) {
      const { AgentError } = await import('@aica/shared');
      const { err } = await import('@aica/shared');
      return err(new AgentError(ErrorCode.INTERNAL, 'no'));
    }

    return ok({
      protocolVersion: options.protocolVersion ?? PREFERRED_PROTOCOL_VERSION,
      serverInfo: { name: 'fake-server', version: '1.0.0' },
      capabilities: options.declareTools === false ? {} : { tools: {} },
      ...(options.instructions ? { instructions: options.instructions } : {}),
    });
  });

  server.onRequest('tools/list', async (params) => {
    if (options.pages) {
      const cursor = (params as { cursor?: string } | undefined)?.cursor;
      const index = cursor === undefined ? 0 : Number(cursor);
      const page = options.pages[index];
      if (!page) return ok({ tools: [] });
      return ok({
        tools: page.tools,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      });
    }
    return ok({ tools: options.tools ?? [] });
  });

  server.onRequest('tools/call', async (params) => {
    const request = params as { name: string; arguments: unknown };
    calls.push({ name: request.name, args: request.arguments });
    return ok(
      options.onCall?.(request.name, request.arguments) ?? {
        content: [{ type: 'text', text: `ran ${request.name}` }],
      },
    );
  });

  server.onRequest('ping', async () => ok({}));

  return { transport: clientSide, calls, dispose: () => server.dispose() };
}

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return mcpServerConfigSchema.parse({ name: 'fake', command: 'noop', ...overrides });
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe('connecting to a server', () => {
  it('negotiates a protocol version and records what the server can do', async () => {
    const server = fakeServer({ instructions: 'Prefer the search tool.' });
    const client = new McpClient({ config: config(), transport: server.transport });

    const connected = await client.connect();
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    expect(connected.value.serverInfo.name).toBe('fake-server');
    expect(connected.value.capabilities.tools).toBe(true);
    // Carried so it can be shown; never injected as a directive (§7).
    expect(connected.value.instructions).toBe('Prefer the search tool.');

    client.close();
    server.dispose();
  });

  it('accepts an older revision the server chooses', async () => {
    const server = fakeServer({ protocolVersion: '2024-11-05' });
    const client = new McpClient({ config: config(), transport: server.transport });

    const connected = await client.connect();
    // Insisting on the newest revision would break against every server that
    // has not moved to it.
    expect(connected.ok && connected.value.protocolVersion).toBe('2024-11-05');

    client.close();
    server.dispose();
  });

  it('refuses a revision it cannot speak rather than guessing', async () => {
    const server = fakeServer({ protocolVersion: '1999-01-01' });
    const client = new McpClient({ config: config(), transport: server.transport });

    const connected = await client.connect();
    expect(connected.ok).toBe(false);
    if (!connected.ok) {
      expect(connected.error.code).toBe(ErrorCode.UNSUPPORTED);
      // The message names what it can speak, so the user can act on it.
      expect(connected.error.message).toContain('2025-06-18');
    }

    client.close();
    server.dispose();
  });

  it('reports a server that will not start as a configuration problem', async () => {
    const server = fakeServer({ failInitialize: true });
    const client = new McpClient({ config: config(), transport: server.transport });

    const connected = await client.connect();
    expect(connected.ok).toBe(false);
    if (!connected.ok) expect(connected.error.code).toBe(ErrorCode.CONFIG_ERROR);

    server.dispose();
  });

  it('refuses to call anything before the handshake', async () => {
    const client = new McpClient({ config: config(), transport: fakeServer().transport });

    const result = await client.callTool('anything', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('asks for no tools from a server that declares none', async () => {
    const server = fakeServer({ declareTools: false, tools: [{ name: 'hidden' }] });
    const client = new McpClient({ config: config(), transport: server.transport });

    await client.connect();
    const tools = await client.listTools();

    // Capabilities are the contract. Calling `tools/list` on a server that did
    // not advertise tools is asking for an error.
    expect(tools.ok && tools.value).toEqual([]);

    client.close();
    server.dispose();
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovering tools', () => {
  it('follows pagination', async () => {
    const server = fakeServer({
      pages: [
        { tools: [{ name: 'one' }], nextCursor: '1' },
        { tools: [{ name: 'two' }], nextCursor: '2' },
        { tools: [{ name: 'three' }] },
      ],
    });
    const client = new McpClient({ config: config(), transport: server.transport });

    await client.connect();
    const tools = await client.listTools();

    expect(tools.ok && tools.value.map((tool) => tool.name)).toEqual(['one', 'two', 'three']);

    client.close();
    server.dispose();
  });

  it('rejects a tool list it cannot read rather than half-reading it', async () => {
    const server = fakeServer({ tools: [{ notAName: true }] as never });
    const client = new McpClient({ config: config(), transport: server.transport });

    await client.connect();
    const tools = await client.listTools();

    expect(tools.ok).toBe(false);
    if (!tools.ok) expect(tools.error.code).toBe(ErrorCode.MALFORMED_RESPONSE);

    client.close();
    server.dispose();
  });
});

// ---------------------------------------------------------------------------
// Permissions — the part that decides whether this is a capability or a hole
// ---------------------------------------------------------------------------

describe('classifying an MCP tool', () => {
  it('treats an unknown tool as a write that needs approval', () => {
    const policy = classifyMcpTool({ name: 'do_something' }, config());

    // The system cannot see what a third-party tool does, and the safe reading
    // of "unknown" is not "harmless".
    expect(policy.risk).toBe('HIGH_RISK_WRITE');
    expect(policy.alwaysConfirm).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it('does not let a server declare itself harmless', () => {
    const policy = classifyMcpTool(
      { name: 'search_docs', annotations: { readOnlyHint: true } },
      config(),
    );

    // A hint buys one step down, not a free pass: a program asserting it is
    // safe is the assertion that cannot be taken on trust.
    expect(policy.risk).toBe('LOW_RISK_WRITE');
    expect(policy.alwaysConfirm).toBe(true);
  });

  it('believes a server that declares itself destructive', () => {
    const policy = classifyMcpTool(
      { name: 'tidy_up', annotations: { destructiveHint: true } },
      config(),
    );

    // Volunteered against its own interest, so it is worth acting on.
    expect(policy.risk).toBe('DESTRUCTIVE');
    expect(policy.alwaysConfirm).toBe(true);
  });

  it('disbelieves a read-only claim from a tool named like a write', () => {
    const policy = classifyMcpTool(
      { name: 'update_record', annotations: { readOnlyHint: true } },
      config(),
    );

    // The name is evidence the server did not intend to give.
    expect(policy.risk).toBe('HIGH_RISK_WRITE');
    expect(policy.rationale).toContain('not trusted');
  });

  it('reads a name whichever convention the server used', () => {
    // `` treats `_` as a word character, so a word-boundary pattern misses
    // `delete_file` entirely — and snake_case is what MCP tools are actually
    // named. All three conventions have to reach the same verdict.
    for (const name of ['delete_file', 'deleteFile', 'delete-file', 'Delete File']) {
      expect(classifyMcpTool({ name }, config()).risk, name).toBe('DESTRUCTIVE');
    }
  });

  it('does not match a word that merely contains a dangerous one', () => {
    // `undelete` and `resetting` are not `delete` and `reset`; matching on
    // substrings would classify half a server's tools as destructive.
    expect(classifyMcpTool({ name: 'list_deleted_items' }, config()).risk).toBe('HIGH_RISK_WRITE');
  });

  it('lets a person vouch for a specific tool', () => {
    const policy = classifyMcpTool(
      { name: 'search_docs' },
      config({ trustedTools: ['search_docs'] }),
    );

    // A decision a human made about a specific tool, which is the only thing
    // that reaches READ_ONLY.
    expect(policy.risk).toBe('READ_ONLY');
    expect(policy.alwaysConfirm).toBe(false);
  });

  it('still confirms a destructive tool even when it is trusted', () => {
    const policy = classifyMcpTool(
      { name: 'wipe_db', annotations: { destructiveHint: true } },
      config({ trustedTools: ['wipe_db'] }),
    );

    expect(policy.risk).toBe('DESTRUCTIVE');
    expect(policy.alwaysConfirm).toBe(true);
  });

  it('separates narrowing the tool set from trusting it', () => {
    // Restricting a server to three tools is a scoping decision, not a
    // statement that those three are safe.
    const scoped = classifyMcpTool({ name: 'search' }, config({ allowedTools: ['search'] }));
    expect(scoped.allowed).toBe(true);
    expect(scoped.risk).not.toBe('READ_ONLY');

    const excluded = classifyMcpTool({ name: 'other' }, config({ allowedTools: ['search'] }));
    expect(excluded.allowed).toBe(false);
  });

  it('excludes a denied tool entirely', () => {
    expect(classifyMcpTool({ name: 'bad' }, config({ deniedTools: ['bad'] })).allowed).toBe(false);
  });
});

describe('server-level permission', () => {
  it('refuses a disabled server', () => {
    expect(serverPermittedIn(config({ enabled: false }), 'local').permitted).toBe(false);
  });

  it('refuses an environment the server was not approved for', () => {
    const verdict = serverPermittedIn(config({ allowedEnvironments: ['local'] }), 'production');

    // A server that is fine against a sandbox is not automatically fine against
    // production.
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain('production');
  });
});

describe('tool naming', () => {
  it('namespaces by server so two servers cannot shadow each other', () => {
    expect(qualifiedToolName('github', 'search')).toBe('mcp__github__search');
    expect(qualifiedToolName('gitlab', 'search')).toBe('mcp__gitlab__search');
  });

  it('produces a name the tool registry will accept', () => {
    // The registry requires lower snake_case, and a server may call a tool
    // anything at all.
    expect(qualifiedToolName('My Server', 'listFiles')).toBe('mcp__my_server__list_files');
    expect(qualifiedToolName('a-b', 'c.d')).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('round-trips back to its parts', () => {
    expect(parseQualifiedName('mcp__github__search_code')).toEqual({
      server: 'github',
      tool: 'search_code',
    });
    expect(parseQualifiedName('fs_read')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Golden scenario 8: an MCP tool, discovered, gated, and called
// ---------------------------------------------------------------------------

describe('golden scenario 8: using a tool from an MCP server', () => {
  function registryFor(options: {
    tools: readonly Record<string, unknown>[];
    server?: Partial<McpServerConfig>;
    onCall?: FakeServerOptions['onCall'];
  }) {
    const fake = fakeServer({
      tools: options.tools,
      ...(options.onCall ? { onCall: options.onCall } : {}),
    });
    const serverConfig = config({ name: 'docs', ...options.server });

    const registry = new McpRegistry({
      servers: [serverConfig],
      environment: 'local',
      createClient: (clientOptions) =>
        new McpClient({ ...clientOptions, transport: fake.transport }),
    });

    return { registry, fake };
  }

  it('discovers a tool, registers it, and calls it through the dispatcher', async () => {
    const { registry, fake } = registryFor({
      tools: [
        {
          name: 'search_docs',
          description: 'Search the documentation for a phrase and return matching passages.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          annotations: { readOnlyHint: true },
        },
      ],
      server: { trustedTools: ['search_docs'] },
      onCall: (_name, args) => ({
        content: [{ type: 'text', text: `results for ${(args as { query: string }).query}` }],
      }),
    });

    const status = await registry.connectAll();
    expect(status[0]?.connected).toBe(true);
    expect(status[0]?.toolCount).toBe(1);

    const tools = new ToolRegistry();
    const registered = tools.registerAll(registry.toolDefinitions());
    expect(registered.ok, JSON.stringify(registered)).toBe(true);

    const approvals = vi.fn(async () => ({ granted: true }));
    const dispatcher = new ToolDispatcher({
      registry: tools,
      approvals: new ApprovalGate({
        context: { mode: 'askAlways', allowedEnvironments: ['local'], apiExecutionEnabled: false },
        responder: approvals,
      }),
    });

    const outcome = await dispatcher.dispatch(
      {
        id: 'call-1',
        name: 'mcp__docs__search_docs',
        arguments: { query: 'pagination' },
      },
      {
        runId: 'run_1',
        projectId: 'proj_1',
        signal: new AbortController().signal,
      },
    );

    expect(outcome.record.ok).toBe(true);
    expect(outcome.modelVisibleText).toContain('results for pagination');
    // The server received the tool's real name, not the namespaced one.
    expect(fake.calls[0]?.name).toBe('search_docs');

    registry.closeAll();
    fake.dispose();
  });

  it('advertises the server own JSON Schema to the model', async () => {
    const { registry, fake } = registryFor({
      tools: [
        {
          name: 'search_docs',
          description: 'Search the documentation for a phrase and return matching passages.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'number' } },
            required: ['query'],
          },
        },
      ],
    });

    await registry.connectAll();
    const definition = registry.toolDefinitions()[0];
    const spec = toToolSpec(definition as never);

    // Re-deriving a schema here would advertise a contract that disagrees with
    // the one the server actually enforces.
    expect(spec.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
    });

    registry.closeAll();
    fake.dispose();
  });

  it('requires approval for an untrusted tool and refuses when it is denied', async () => {
    const { registry, fake } = registryFor({
      tools: [
        {
          name: 'update_issue',
          description: 'Update an issue in the tracker with new field values.',
        },
      ],
    });

    await registry.connectAll();
    const tools = new ToolRegistry();
    tools.registerAll(registry.toolDefinitions());

    const dispatcher = new ToolDispatcher({
      registry: tools,
      approvals: new ApprovalGate({
        context: { mode: 'auto', allowedEnvironments: ['local'], apiExecutionEnabled: false },
        // Even in `auto`, an MCP tool is confirmed: `requireApproval` defaults
        // to true and the tool declares `alwaysConfirm`.
        responder: async () => ({ granted: false }),
      }),
    });

    const outcome = await dispatcher.dispatch(
      { id: 'call-1', name: 'mcp__docs__update_issue', arguments: {} },
      { runId: 'run_1', projectId: 'proj_1', signal: new AbortController().signal },
    );

    expect(outcome.record.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);

    registry.closeAll();
    fake.dispose();
  });

  it('tells the model that a server result is data, not instruction', async () => {
    const { registry, fake } = registryFor({
      tools: [{ name: 'fetch_page', description: 'Fetch a page and return its text content.' }],
    });

    await registry.connectAll();
    const definition = registry.toolDefinitions()[0];

    // §7: instruction-shaped text inside a result is not a directive.
    expect(definition?.description).toContain('not instruction');
    expect(definition?.description).toContain('docs');

    registry.closeAll();
    fake.dispose();
  });

  it('reports a tool failure as a result the model can act on, not a dead call', async () => {
    const { registry, fake } = registryFor({
      tools: [{ name: 'lookup', description: 'Look up a record by its identifier.' }],
      server: { trustedTools: ['lookup'] },
      onCall: () => ({ content: [{ type: 'text', text: 'no such record' }], isError: true }),
    });

    await registry.connectAll();
    const tools = new ToolRegistry();
    tools.registerAll(registry.toolDefinitions());

    const dispatcher = new ToolDispatcher({
      registry: tools,
      approvals: new ApprovalGate({
        context: { mode: 'auto', allowedEnvironments: ['local'], apiExecutionEnabled: false },
        responder: async () => ({ granted: true }),
      }),
    });

    const outcome = await dispatcher.dispatch(
      { id: 'call-1', name: 'mcp__docs__lookup', arguments: {} },
      { runId: 'run_1', projectId: 'proj_1', signal: new AbortController().signal },
    );

    // The call happened; the tool reported a problem. Those are different
    // things and the model needs to be able to tell them apart.
    expect(outcome.record.ok).toBe(true);
    expect(outcome.modelVisibleText).toContain('no such record');

    registry.closeAll();
    fake.dispose();
  });

  it('keeps working when one of several servers is broken', async () => {
    const good = fakeServer({
      tools: [{ name: 'search', description: 'Search the documentation for a phrase.' }],
    });
    const broken = fakeServer({ failInitialize: true });

    const registry = new McpRegistry({
      servers: [config({ name: 'good' }), config({ name: 'broken' })],
      environment: 'local',
      createClient: (options) =>
        new McpClient({
          ...options,
          transport: options.config.name === 'good' ? good.transport : broken.transport,
        }),
    });

    const status = await registry.connectAll();

    // One misconfigured entry in a config file must not be the reason an agent
    // cannot run at all.
    expect(status.find((entry) => entry.name === 'good')?.connected).toBe(true);
    expect(status.find((entry) => entry.name === 'broken')?.connected).toBe(false);
    expect(status.find((entry) => entry.name === 'broken')?.error).toBeTruthy();
    expect(registry.discovered).toHaveLength(1);

    registry.closeAll();
    good.dispose();
    broken.dispose();
  });

  it('skips a server that is not permitted in this environment', async () => {
    const server = fakeServer({ tools: [{ name: 'deploy' }] });
    const registry = new McpRegistry({
      servers: [config({ name: 'prod-only', allowedEnvironments: ['staging'] })],
      environment: 'local',
      createClient: (options) => new McpClient({ ...options, transport: server.transport }),
    });

    const status = await registry.connectAll();
    expect(status[0]?.connected).toBe(false);
    expect(registry.discovered).toHaveLength(0);

    server.dispose();
  });

  it('refuses a server that needs secrets with no resolver wired', async () => {
    const server = fakeServer();
    const registry = new McpRegistry({
      servers: [config({ name: 'needs-key', env: { API_KEY: 'env:SOME_KEY' } })],
      environment: 'local',
      createClient: (options) => new McpClient({ ...options, transport: server.transport }),
    });

    const status = await registry.connectAll();
    // A missing credential is a named configuration problem, not a mysterious
    // startup failure.
    expect(status[0]?.error).toContain('environment secrets');

    server.dispose();
  });
});

describe('rendering a result', () => {
  it('names a block it cannot read rather than dropping it', () => {
    const text = renderContent({
      content: [
        { type: 'text', text: 'here is a chart' },
        { type: 'image', mimeType: 'image/png' },
      ],
    });

    // Silence would let the model conclude the tool returned nothing.
    expect(text).toContain('here is a chart');
    expect(text).toContain('image/png');
  });

  it('truncates rather than flooding the context, and says it did', () => {
    const text = renderContent({ content: [{ type: 'text', text: 'x'.repeat(20_000) }] }, 100);

    expect(text.length).toBeLessThan(200);
    expect(text).toContain('truncated');
  });
});
