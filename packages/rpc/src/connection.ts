/**
 * A JSON-RPC peer.
 *
 * Symmetric on purpose: the same class runs in the agent server and in the
 * extension host. Both sides can call and both sides can be called, because the
 * server genuinely needs to ask the editor questions — read this secret from
 * SecretStorage, get the user to approve this write — and a one-directional
 * protocol turns those into polling loops.
 *
 * What this layer guarantees:
 *
 * - **A handler that throws becomes an error response, never a crash.** One bad
 *   request must not take down a connection that other work depends on.
 * - **Every pending request is settled.** If the transport closes, everything
 *   in flight rejects immediately rather than hanging until some caller's
 *   timeout, if it even has one.
 * - **Cancellation is cooperative and honest.** A cancel notification aborts the
 *   handler's signal; the response still comes back, as an `ABORTED` error. A
 *   cancelled request that silently never replies is indistinguishable from a
 *   hung one.
 */

import type { Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok, silentLogger } from '@aica/shared';

import { MessageDecoder, encodeMessage } from './framing.js';
import type {
  Message,
  NotificationMessage,
  RequestId,
  RequestMessage,
  ResponseMessage,
} from './protocol.js';
import {
  JSONRPC_VERSION,
  fromResponseError,
  isNotification,
  isRequest,
  isResponse,
  toRpcErrorCode,
} from './protocol.js';

/** The one method every peer implements, so cancellation always works. */
export const CANCEL_METHOD = '$/cancelRequest';

export interface RequestContext {
  /** Aborted when the caller cancels. Handlers should pass it down. */
  readonly signal: AbortSignal;
  readonly method: string;
  readonly id: RequestId;
}

export type RequestHandler = (params: unknown, context: RequestContext) => Promise<Result<unknown>>;
export type NotificationHandler = (params: unknown) => void;

/** The byte-level transport, kept abstract so tests need no pipes. */
export interface Transport {
  send(data: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface ConnectionOptions {
  readonly transport: Transport;
  readonly logger?: Logger;
  /** Requests that outlive this are settled as timeouts. Zero disables it. */
  readonly requestTimeoutMs?: number;
}

interface Pending {
  readonly method: string;
  readonly resolve: (result: Result<unknown>) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class RpcConnection {
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly decoder = new MessageDecoder();
  private readonly requestTimeoutMs: number;

  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<RequestId, Pending>();
  private readonly inFlight = new Map<RequestId, AbortController>();

  private nextId = 1;
  private closed = false;

  constructor(options: ConnectionOptions) {
    this.transport = options.transport;
    this.logger = (options.logger ?? silentLogger).child('rpc');
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.transport.onData((chunk) => {
      this.receive(chunk);
    });
    this.transport.onClose(() => {
      this.dispose(new AgentError(ErrorCode.ABORTED, 'The connection closed.'));
    });

    this.onNotification(CANCEL_METHOD, (params) => {
      const id = (params as { id?: RequestId } | undefined)?.id;
      if (id !== undefined) this.inFlight.get(id)?.abort();
    });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Methods this peer answers, which is also what `initialize` advertises. */
  get methods(): readonly string[] {
    return [...this.requestHandlers.keys()].sort();
  }

  /**
   * Call the peer.
   *
   * Never throws and never hangs: a transport failure, a timeout, or a close
   * all arrive as an `Err`, so a caller has exactly one thing to handle.
   */
  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.closed) {
      return err(new AgentError(ErrorCode.ABORTED, `Cannot call "${method}": connection closed.`));
    }

    const id = this.nextId++;

    return new Promise<Result<unknown>>((resolve) => {
      let settled = false;
      const settle = (result: Result<unknown>): void => {
        if (settled) return;
        settled = true;
        const entry = this.pending.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        resolve(result);
      };

      const cancel = (): void => {
        this.notify(CANCEL_METHOD, { id });
        settle(err(new AgentError(ErrorCode.ABORTED, `"${method}" was cancelled.`)));
      };

      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              // Tell the peer to stop working on something nobody is waiting
              // for any more, then settle locally.
              this.notify(CANCEL_METHOD, { id });
              settle(
                err(
                  new AgentError(ErrorCode.TIMEOUT, `"${method}" did not respond in time.`, {
                    details: { method, timeoutMs: this.requestTimeoutMs },
                  }),
                ),
              );
            }, this.requestTimeoutMs)
          : undefined;
      timer?.unref?.();

      this.pending.set(id, { method, resolve: settle, timer });

      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });

      const sent = this.send({ jsonrpc: JSONRPC_VERSION, id, method, params });
      if (!sent.ok) settle(sent);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    // A notification has no reply, so a send failure has nobody to report to.
    // It is logged rather than thrown: dropping a status update must not break
    // the caller that produced it.
    const sent = this.send({ jsonrpc: JSONRPC_VERSION, method, params });
    if (!sent.ok) this.logger.debug('notification dropped', { method });
  }

  /** Settle everything in flight and stop. Idempotent. */
  dispose(reason?: AgentError): void {
    if (this.closed) return;
    this.closed = true;

    const error = reason ?? new AgentError(ErrorCode.ABORTED, 'The connection was disposed.');

    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(err(error));
    }
    this.pending.clear();

    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();

    this.transport.close();
  }

  private send(message: Message): Result<true> {
    try {
      this.transport.send(encodeMessage(message));
      return ok(true);
    } catch (error) {
      return err(AgentError.from(error, ErrorCode.INTERNAL));
    }
  }

  private receive(chunk: Buffer): void {
    const decoded = this.decoder.push(chunk);

    if (!decoded.ok) {
      // A framing failure means the two ends disagree about where messages
      // start. Nothing after this point can be trusted, so the connection ends
      // rather than delivering garbage upward.
      this.logger.error('framing failure, closing connection', { reason: decoded.error.message });
      this.dispose(decoded.error);
      return;
    }

    for (const error of decoded.value.malformed) {
      this.logger.warn('discarded an unparseable frame', { reason: error.message });
    }

    for (const message of decoded.value.messages) this.dispatch(message);
  }

  private dispatch(message: unknown): void {
    if (isResponse(message)) {
      this.settleResponse(message);
      return;
    }
    if (isRequest(message)) {
      void this.handleRequest(message);
      return;
    }
    if (isNotification(message)) {
      this.handleNotification(message);
      return;
    }

    this.logger.warn('ignoring a message that is not JSON-RPC 2.0');
  }

  private settleResponse(message: ResponseMessage): void {
    if (message.id === null) return;

    const entry = this.pending.get(message.id);
    if (!entry) {
      // Late response to something already timed out or cancelled. Expected,
      // not an error.
      this.logger.debug('response for an unknown request', { id: String(message.id) });
      return;
    }

    entry.resolve(message.error ? err(fromResponseError(message.error)) : ok(message.result));
  }

  private handleNotification(message: NotificationMessage): void {
    const handler = this.notificationHandlers.get(message.method);
    if (!handler) {
      this.logger.debug('no handler for notification', { method: message.method });
      return;
    }
    try {
      handler(message.params);
    } catch (error) {
      // Nowhere to send this: a notification has no reply. Losing the handler's
      // failure is bad, losing the connection is worse.
      this.logger.error('notification handler threw', {
        method: message.method,
        reason: AgentError.from(error).message,
      });
    }
  }

  private async handleRequest(message: RequestMessage): Promise<void> {
    const handler = this.requestHandlers.get(message.method);

    if (!handler) {
      this.respondError(
        message.id,
        new AgentError(ErrorCode.UNSUPPORTED, `Unknown method "${message.method}".`, {
          details: { method: message.method },
        }),
      );
      return;
    }

    const controller = new AbortController();
    this.inFlight.set(message.id, controller);

    try {
      const result = await handler(message.params, {
        signal: controller.signal,
        method: message.method,
        id: message.id,
      });

      if (result.ok) this.respondResult(message.id, result.value);
      else this.respondError(message.id, result.error);
    } catch (error) {
      // A handler that throws is a bug in the handler, not grounds for taking
      // the connection down. Report it to the caller and carry on.
      const agentError = AgentError.from(error, ErrorCode.INTERNAL);
      this.logger.error('request handler threw', {
        method: message.method,
        reason: agentError.message,
      });
      this.respondError(message.id, agentError);
    } finally {
      this.inFlight.delete(message.id);
    }
  }

  private respondResult(id: RequestId, result: unknown): void {
    // `undefined` is not JSON, and a response with neither result nor error is
    // not a valid JSON-RPC response. `null` is the correct empty result.
    this.send({ jsonrpc: JSONRPC_VERSION, id, result: result ?? null });
  }

  private respondError(id: RequestId, error: AgentError): void {
    this.send({
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code: toRpcErrorCode(error), message: error.message, data: error.toJSON() },
    });
  }
}
