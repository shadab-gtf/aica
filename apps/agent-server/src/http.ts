/**
 * The dashboard's transport: HTTP for calls, SSE for the event stream.
 *
 * The same gateway the editor talks to, reached a different way. Nothing about
 * policy, validation, or project isolation changes — a transport decides how a
 * request arrives and nothing else (§3).
 *
 * A local HTTP server that can index a codebase, run commands, and call APIs is
 * a capability sitting on a port, so four things are non-negotiable:
 *
 * **Loopback only.** Bound to `127.0.0.1`, never `0.0.0.0`. A dashboard is for
 * the person at the machine; binding to every interface would put an agent that
 * can write files on the office network.
 *
 * **A token on every request.** Generated per process, never persisted, and
 * compared in constant time. Without it, any page in the user's browser could
 * reach this server through JavaScript — localhost is not a security boundary
 * against the browser the user is already running.
 *
 * **No permissive CORS.** The token is not enough on its own: a browser will
 * happily send a request to localhost from any origin, and a `*` on
 * `Access-Control-Allow-Origin` would make the token the only thing standing
 * between a random page and this server. Origins are allowlisted.
 *
 * **DNS-rebinding defence.** An attacker's domain can resolve to 127.0.0.1,
 * which makes their page same-origin with this server. Checking the `Host`
 * header against the loopback names is what stops that.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type { AgentEvent, EventBus, Logger } from '@aica/shared';
import { silentLogger } from '@aica/shared';

import type { Gateway } from './gateway.js';

export interface HttpGatewayOptions {
  readonly gateway: Gateway;
  readonly bus: EventBus;
  readonly logger?: Logger;
  /** Loopback port. Zero asks the operating system for a free one. */
  readonly port?: number;
  /**
   * Supplied only by a test that needs a known value. In a real process the
   * token is generated, so it cannot be guessed from configuration a user
   * checked into a repository.
   */
  readonly token?: string;
  /** Browser origins permitted to call. Defaults to the dev and preview ports. */
  readonly allowedOrigins?: readonly string[];
}

/** Where a Next.js dashboard runs, in development and after a build. */
const DEFAULT_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

/** Host header values that mean "this machine". Anything else is a rebind. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A body larger than this is refused before it is read. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpGatewayAddress {
  readonly port: number;
  readonly token: string;
  readonly url: string;
}

export class HttpGateway {
  private readonly logger: Logger;
  private readonly token: string;
  private readonly tokenDigest: Buffer;
  private readonly allowedOrigins: ReadonlySet<string>;
  private server: Server | undefined;
  private address: HttpGatewayAddress | undefined;

  constructor(private readonly options: HttpGatewayOptions) {
    this.logger = (options.logger ?? silentLogger).child('http');
    this.token = options.token ?? randomBytes(32).toString('base64url');
    this.tokenDigest = createHash('sha256').update(this.token).digest();
    this.allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
  }

  async listen(): Promise<HttpGatewayAddress> {
    if (this.address) return this.address;

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback, explicitly. Not `0.0.0.0`, not the default.
      server.listen(this.options.port ?? 0, '127.0.0.1', resolve);
    });

    const bound = server.address();
    const port = typeof bound === 'object' && bound !== null ? bound.port : 0;

    this.address = { port, token: this.token, url: `http://127.0.0.1:${port}` };
    this.logger.info('dashboard transport listening', { port });
    return this.address;
  }

  get listening(): HttpGatewayAddress | undefined {
    return this.address;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.address = undefined;
  }

  // -------------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;

    // Rebinding first: a request whose Host is an attacker's domain is refused
    // before anything reads a token that the attacker's page could not have.
    if (!this.hostIsLoopback(request)) {
      this.logger.warn('refused a request with a non-loopback Host header');
      this.send(response, 421, { error: 'This server only answers to localhost.' });
      return;
    }

    if (origin !== undefined && !this.allowedOrigins.has(origin)) {
      this.send(response, 403, { error: 'Origin not permitted.' });
      return;
    }

    if (origin !== undefined) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    // Unauthenticated, and deliberately so: a dashboard has to be able to tell
    // "the server is not running" from "my token is wrong", and this answers
    // the first without revealing anything.
    if (url.pathname === '/health') {
      this.send(response, 200, { ok: true, methods: this.options.gateway.methods.length });
      return;
    }

    if (!this.authorized(request, url)) {
      this.send(response, 401, { error: 'A valid token is required.' });
      return;
    }

    if (url.pathname === '/events' && request.method === 'GET') {
      this.streamEvents(request, response, url.searchParams.get('projectId'));
      return;
    }

    if (url.pathname === '/rpc' && request.method === 'POST') {
      await this.callMethod(request, response);
      return;
    }

    this.send(response, 404, { error: 'No such endpoint.' });
  }

  /**
   * Is the caller carrying the token?
   *
   * Accepted in a header, and — only for the event stream — in the query
   * string, because `EventSource` cannot set headers. That is a real weakening:
   * a URL ends up in browser history and in logs. It is confined to the one
   * endpoint that cannot work without it, and that endpoint is read-only.
   */
  private authorized(request: IncomingMessage, url: URL): boolean {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return this.tokenMatches(header.slice('Bearer '.length));
    }

    if (url.pathname === '/events') {
      const supplied = url.searchParams.get('token');
      if (supplied !== null) return this.tokenMatches(supplied);
    }

    return false;
  }

  /**
   * Compare in constant time.
   *
   * Both sides are hashed first so the comparison is over fixed-length buffers:
   * `timingSafeEqual` throws on a length mismatch, and catching that throw
   * would itself leak the length of the token.
   */
  private tokenMatches(supplied: string): boolean {
    const digest = createHash('sha256').update(supplied).digest();
    return timingSafeEqual(digest, this.tokenDigest);
  }

  private hostIsLoopback(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (typeof host !== 'string') return false;

    // Strip the port; IPv6 literals keep their brackets.
    const name = host.startsWith('[')
      ? host.slice(0, host.indexOf(']') + 1) || host
      : (host.split(':')[0] ?? host);

    return LOOPBACK_HOSTS.has(name.toLowerCase());
  }

  private async callMethod(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (!body.ok) {
      this.send(response, body.status, { error: body.error });
      return;
    }

    let parsed: { method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(body.text) as { method?: unknown; params?: unknown };
    } catch {
      this.send(response, 400, { error: 'The request body is not valid JSON.' });
      return;
    }

    if (typeof parsed.method !== 'string') {
      this.send(response, 400, { error: 'A "method" is required.' });
      return;
    }

    const controller = new AbortController();
    // A browser that navigates away should not leave an indexing pass running.
    request.on('close', () => controller.abort());

    const result = await this.options.gateway.dispatch(parsed.method, parsed.params, {
      signal: controller.signal,
      method: parsed.method,
      id: 0,
    });

    if (result.ok) {
      this.send(response, 200, { ok: true, value: result.value });
      return;
    }

    // The structured error travels whole. An HTTP status is a coarse summary of
    // it, not a replacement for it.
    this.send(response, statusFor(result.error.code), { ok: false, error: result.error.toJSON() });
  }

  /**
   * Stream events to a dashboard.
   *
   * Filtered by project, because §48's isolation applies to a stream exactly as
   * it applies to a query: a dashboard viewing one project must not receive
   * another project's tool calls.
   */
  private streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    projectId: string | null,
  ): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer would turn a live stream into a batch at the end.
      'X-Accel-Buffering': 'no',
    });

    // A comment, immediately. Headers alone do not always settle a stream
    // through an intermediary, and a client that has not received a byte cannot
    // distinguish an open-but-idle stream from one that is still connecting —
    // which is the difference between "nothing is happening" and "this is
    // broken".
    response.write(': connected\n\n');

    const write = (event: AgentEvent): void => {
      if (projectId !== null && event.projectId !== projectId) return;

      // `id` lets a browser resume with Last-Event-ID; `seq` is what detects a
      // gap, and both are already on the envelope.
      response.write(`id: ${event.seq}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = this.options.bus.subscribe(write);

    // A comment line every twenty seconds. Without it an idle stream is
    // indistinguishable from a dead one, and intermediaries will close it.
    const keepAlive = setInterval(() => response.write(': ping\n\n'), 20_000);
    keepAlive.unref?.();

    const stop = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };

    request.on('close', stop);
    response.on('close', stop);
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      // This is an API, not a document; nothing here should be sniffed, framed,
      // or cached.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    response.end(text);
  }
}

async function readBody(
  request: IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      // Refused rather than buffered. An unbounded body is a way to exhaust
      // memory without ever sending a valid request.
      request.destroy();
      return { ok: false, status: 413, error: 'The request body is too large.' };
    }
    chunks.push(buffer);
  }

  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/** A coarse HTTP summary of a structured error. The real one is in the body. */
function statusFor(code: string): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'PERMISSION_DENIED':
    case 'APPROVAL_DENIED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'ALREADY_EXISTS':
    case 'CONFLICT':
      return 409;
    case 'PRECONDITION_FAILED':
      return 412;
    case 'LIMIT_EXCEEDED':
      return 413;
    case 'UNSUPPORTED':
      return 501;
    case 'TIMEOUT':
      return 504;
    default:
      return 500;
  }
}
