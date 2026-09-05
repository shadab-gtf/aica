/**
 * A connection to one MCP server.
 *
 * The transport is a child process speaking newline-delimited JSON-RPC on its
 * stdio, which is what the protocol specifies. The JSON-RPC layer itself is
 * `@aica/rpc` with the line-delimited codec, so request correlation,
 * cancellation, timeouts and "settle everything when the pipe dies" are the
 * same code the editor connection uses.
 *
 * What is specific to talking to somebody else's program:
 *
 * - **The handshake negotiates.** This client proposes the newest revision it
 *   knows and accepts whatever the server answers with, provided it is a
 *   revision this client can actually speak. Insisting on one version breaks
 *   against every server older or newer than it.
 * - **Every response is validated.** §7 puts a server's output in the untrusted
 *   column, and a shape that does not match is a malformed response rather than
 *   something to read fields out of hopefully.
 * - **Instructions from a server are carried, not obeyed.** `instructions` and
 *   tool descriptions are instruction-shaped text from a third-party program.
 *   They are shown and they are given to the model as *tool documentation*;
 *   they are never treated as a directive by this system.
 * - **A server that dies is a server that failed.** Everything pending settles,
 *   and the failure is reported once rather than as a timeout per call.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

import type { Transport } from '@aica/rpc';
import { RpcConnection, lineDelimitedCodec, streamTransport } from '@aica/rpc';
import type { McpServerConfig } from '@aica/schemas';
import type { Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok, silentLogger } from '@aica/shared';

import type { McpCallResult, McpResource, McpServerInfo, McpToolDescriptor } from './protocol.js';
import {
  MCP_METHODS,
  PREFERRED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  callToolResultSchema,
  initializeResultSchema,
  listResourcesResultSchema,
  listToolsResultSchema,
  readResourceResultSchema,
} from './protocol.js';

export interface McpClientOptions {
  readonly config: McpServerConfig;
  readonly logger?: Logger;
  /** Environment for a stdio server, with secret references already resolved. */
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Injected in tests, so no process is spawned and nothing is installed. */
  readonly transport?: Transport;
  readonly spawnImpl?: typeof spawn;
}

export interface McpConnectionInfo {
  readonly serverInfo: McpServerInfo;
  readonly protocolVersion: string;
  readonly capabilities: { tools: boolean; resources: boolean; prompts: boolean };
  /** Free text the server offered. Shown to a user, never injected as a directive. */
  readonly instructions?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** A server offering thousands of tools is a prompt-size problem, not a feature. */
const MAX_TOOLS = 200;
const MAX_PAGES = 20;

export class McpClient {
  private readonly logger: Logger;
  private connection: RpcConnection | undefined;
  private child: ChildProcess | undefined;
  private info: McpConnectionInfo | undefined;
  private stderrTail: string[] = [];

  constructor(private readonly options: McpClientOptions) {
    this.logger = (options.logger ?? silentLogger).child('mcp');
  }

  get name(): string {
    return this.options.config.name;
  }

  get connectionInfo(): McpConnectionInfo | undefined {
    return this.info;
  }

  get isConnected(): boolean {
    return this.connection !== undefined && !this.connection.isClosed && this.info !== undefined;
  }

  /** Start the server, shake hands, and record what it can do. */
  async connect(): Promise<Result<McpConnectionInfo>> {
    if (this.info) return ok(this.info);

    const spawned = this.options.transport ? ok(this.options.transport) : this.spawnServer();
    if (!spawned.ok) return spawned;

    this.connection = new RpcConnection({
      transport: spawned.value,
      codec: lineDelimitedCodec,
      logger: this.logger,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const response = await this.connection.request(MCP_METHODS.initialize, {
      protocolVersion: PREFERRED_PROTOCOL_VERSION,
      // Only capabilities this client genuinely implements. Advertising
      // `sampling` and then not answering turns a server's call into a timeout.
      capabilities: {},
      clientInfo: {
        name: this.options.clientName ?? 'aica',
        version: this.options.clientVersion ?? '0.1.0',
      },
    });

    if (!response.ok) {
      this.close();
      return err(this.startupFailure(response.error));
    }

    const parsed = initializeResultSchema.safeParse(response.value);
    if (!parsed.success) {
      this.close();
      return err(
        new AgentError(
          ErrorCode.MALFORMED_RESPONSE,
          `The "${this.name}" MCP server did not return a usable initialize result.`,
          { details: { server: this.name } },
        ),
      );
    }

    const negotiated = parsed.data.protocolVersion;
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
      // Refused rather than attempted. A version this client cannot speak means
      // the shapes below may differ, and guessing produces failures that look
      // like bugs in the server.
      this.close();
      return err(
        new AgentError(
          ErrorCode.UNSUPPORTED,
          `The "${this.name}" MCP server speaks protocol ${negotiated}, which this client does not support. It supports: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
          { details: { server: this.name, negotiated } },
        ),
      );
    }

    // The specification requires this before any other request.
    this.connection.notify(MCP_METHODS.initialized, {});

    this.info = {
      serverInfo: parsed.data.serverInfo,
      protocolVersion: negotiated,
      capabilities: {
        tools: parsed.data.capabilities.tools !== undefined,
        resources: parsed.data.capabilities.resources !== undefined,
        prompts: parsed.data.capabilities.prompts !== undefined,
      },
      ...(parsed.data.instructions !== undefined ? { instructions: parsed.data.instructions } : {}),
    };

    this.logger.info('connected', {
      server: this.name,
      protocol: negotiated,
      implementation: parsed.data.serverInfo.name,
    });

    return ok(this.info);
  }

  /**
   * Every tool the server offers.
   *
   * Paginated and capped. A server advertising two thousand tools would
   * otherwise put two thousand schemas in front of a model, which costs money,
   * degrades selection, and is a denial of service with extra steps.
   */
  async listTools(): Promise<Result<McpToolDescriptor[]>> {
    if (!this.connection || !this.info) return err(this.notConnected());
    if (!this.info.capabilities.tools) return ok([]);

    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.connection.request(
        MCP_METHODS.listTools,
        cursor === undefined ? {} : { cursor },
      );
      if (!response.ok) return response;

      const parsed = listToolsResultSchema.safeParse(response.value);
      if (!parsed.success) {
        return err(
          new AgentError(
            ErrorCode.MALFORMED_RESPONSE,
            `The "${this.name}" MCP server returned a tool list this client cannot read.`,
            { details: { server: this.name } },
          ),
        );
      }

      tools.push(...parsed.data.tools);

      if (tools.length >= MAX_TOOLS) {
        this.logger.warn('tool list truncated', { server: this.name, cap: MAX_TOOLS });
        return ok(tools.slice(0, MAX_TOOLS));
      }

      cursor = parsed.data.nextCursor;
      if (cursor === undefined) break;
    }

    return ok(tools);
  }

  /**
   * Call a tool.
   *
   * `isError: true` in the result is *not* turned into a failed `Result`. It
   * means the call succeeded and the tool reported a problem — which is
   * something the model can read and act on, and something quite different from
   * the call not happening.
   */
  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<Result<McpCallResult>> {
    if (!this.connection || !this.info) return err(this.notConnected());

    const response = await this.connection.request(
      MCP_METHODS.callTool,
      { name, arguments: args ?? {} },
      signal,
    );
    if (!response.ok) return response;

    const parsed = callToolResultSchema.safeParse(response.value);
    if (!parsed.success) {
      return err(
        new AgentError(
          ErrorCode.MALFORMED_RESPONSE,
          `The "${this.name}" MCP server returned a result for "${name}" that this client cannot read.`,
          { details: { server: this.name, tool: name } },
        ),
      );
    }

    return ok(parsed.data);
  }

  async listResources(): Promise<Result<McpResource[]>> {
    if (!this.connection || !this.info) return err(this.notConnected());
    if (!this.info.capabilities.resources) return ok([]);

    const response = await this.connection.request(MCP_METHODS.listResources, {});
    if (!response.ok) return response;

    const parsed = listResourcesResultSchema.safeParse(response.value);
    if (!parsed.success) {
      return err(
        new AgentError(
          ErrorCode.MALFORMED_RESPONSE,
          `The "${this.name}" MCP server returned a resource list this client cannot read.`,
        ),
      );
    }

    return ok(parsed.data.resources);
  }

  async readResource(uri: string): Promise<Result<string>> {
    if (!this.connection || !this.info) return err(this.notConnected());

    const response = await this.connection.request(MCP_METHODS.readResource, { uri });
    if (!response.ok) return response;

    const parsed = readResourceResultSchema.safeParse(response.value);
    if (!parsed.success) {
      return err(
        new AgentError(
          ErrorCode.MALFORMED_RESPONSE,
          `The "${this.name}" MCP server returned resource contents this client cannot read.`,
        ),
      );
    }

    // Text only. A base64 blob is named rather than decoded: this system has no
    // use for one, and inflating an arbitrary blob from an untrusted server
    // into memory is a cost with no benefit.
    return ok(
      parsed.data.contents
        .map((entry) => entry.text ?? `[binary ${entry.mimeType ?? 'content'} at ${entry.uri}]`)
        .join('\n'),
    );
  }

  /** Notice a server that has gone away, without waiting for a call to fail. */
  async ping(): Promise<Result<true>> {
    if (!this.connection) return err(this.notConnected());
    const response = await this.connection.request(MCP_METHODS.ping, {});
    return response.ok ? ok(true) : err(response.error);
  }

  close(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.info = undefined;

    const child = this.child;
    if (child) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2000);
      timer.unref?.();
      this.child = undefined;
    }
  }

  // -------------------------------------------------------------------------

  private spawnServer(): Result<Transport> {
    const config = this.options.config;

    if (config.transport !== 'stdio') {
      return err(
        new AgentError(
          ErrorCode.UNSUPPORTED,
          `The "${this.name}" server uses the "${config.transport}" transport, which is not implemented. Only stdio servers are supported.`,
        ),
      );
    }

    if (!config.command) {
      return err(
        new AgentError(ErrorCode.CONFIG_ERROR, `The "${this.name}" server has no command to run.`),
      );
    }

    const spawnFn = this.options.spawnImpl ?? spawn;

    const child = spawnFn(config.command, [...config.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A filtered environment: a server gets what it was configured to get and
      // the bare minimum to run, not the whole environment of a process that
      // holds this user's credentials.
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
        ...(process.platform === 'win32'
          ? {
              SYSTEMROOT: process.env['SYSTEMROOT'] ?? '',
              APPDATA: process.env['APPDATA'] ?? '',
            }
          : {}),
        ...this.options.env,
      },
      windowsHide: true,
      detached: false,
    });

    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Kept for the failure message. A server that exits during startup
      // usually explains itself here and nowhere else, and "the server did not
      // respond" without that text is unactionable.
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.logger.debug('server stderr', { server: this.name });
    });

    if (!child.stdout || !child.stdin) {
      return err(
        new AgentError(ErrorCode.INTERNAL, `The "${this.name}" server has no usable stdio.`),
      );
    }

    return ok(streamTransport(child.stdout, child.stdin));
  }

  private startupFailure(cause: AgentError): AgentError {
    const stderr = this.stderrTail.join('').trim().slice(-800);

    return new AgentError(
      ErrorCode.CONFIG_ERROR,
      stderr.length > 0
        ? `The "${this.name}" MCP server did not start: ${cause.message}\n${stderr}`
        : `The "${this.name}" MCP server did not start: ${cause.message}`,
      { details: { server: this.name }, cause },
    );
  }

  private notConnected(): AgentError {
    return new AgentError(
      ErrorCode.PRECONDITION_FAILED,
      `The "${this.name}" MCP server is not connected.`,
      { details: { server: this.name } },
    );
  }
}
