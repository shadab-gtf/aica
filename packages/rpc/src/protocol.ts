/**
 * JSON-RPC 2.0 message shapes and the error-code mapping.
 *
 * The wire format is JSON-RPC because it is bidirectional by construction. The
 * server needs to call *back* into the extension — to ask VS Code's
 * SecretStorage for a value, or to put an approval prompt in front of the user
 * — and a request/response protocol where only one side may ask questions
 * would force those into polling.
 */

import type { AgentErrorJSON } from '@aica/shared';
import { AgentError, ErrorCode } from '@aica/shared';

export const JSONRPC_VERSION = '2.0';

export type RequestId = number | string;

export interface RequestMessage {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface NotificationMessage {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

export interface ResponseError {
  readonly code: number;
  readonly message: string;
  /** The structured `AgentError`, so the far side loses nothing in transit. */
  readonly data?: AgentErrorJSON;
}

export interface ResponseMessage {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RequestId | null;
  readonly result?: unknown;
  readonly error?: ResponseError;
}

export type Message = RequestMessage | NotificationMessage | ResponseMessage;

/** The reserved JSON-RPC codes, plus this protocol's own range. */
export const RpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Reserved implementation-defined range starts at -32099. */
  requestCancelled: -32800,
  serverShuttingDown: -32801,
  applicationError: -32000,
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

/**
 * Map an `AgentError` onto a JSON-RPC code.
 *
 * The full error travels in `data`, so this mapping only has to be good enough
 * for a generic JSON-RPC client. Anything the mapping does not recognise
 * becomes an application error rather than an internal one: `internalError`
 * should mean "this server has a bug", and a denied approval is not a bug.
 */
export function toRpcErrorCode(error: AgentError): number {
  switch (error.code) {
    case ErrorCode.INVALID_INPUT:
      return RpcErrorCode.invalidParams;
    case ErrorCode.UNSUPPORTED:
      return RpcErrorCode.methodNotFound;
    case ErrorCode.ABORTED:
      return RpcErrorCode.requestCancelled;
    case ErrorCode.INTERNAL:
      return RpcErrorCode.internalError;
    default:
      return RpcErrorCode.applicationError;
  }
}

/** Rebuild an `AgentError` from a response, preferring the structured form. */
export function fromResponseError(error: ResponseError): AgentError {
  if (error.data) return AgentError.fromJSON(error.data);

  const code =
    error.code === RpcErrorCode.invalidParams
      ? ErrorCode.INVALID_INPUT
      : error.code === RpcErrorCode.methodNotFound
        ? ErrorCode.UNSUPPORTED
        : error.code === RpcErrorCode.requestCancelled
          ? ErrorCode.ABORTED
          : ErrorCode.INTERNAL;

  return new AgentError(code, error.message, { details: { rpcCode: error.code } });
}

export function isRequest(message: unknown): message is RequestMessage {
  if (!isMessage(message)) return false;
  const id = message['id'];
  return typeof message['method'] === 'string' && id !== undefined && id !== null;
}

export function isNotification(message: unknown): message is NotificationMessage {
  if (!isMessage(message)) return false;
  return typeof message['method'] === 'string' && message['id'] === undefined;
}

export function isResponse(message: unknown): message is ResponseMessage {
  if (!isMessage(message)) return false;
  return (
    message['method'] === undefined &&
    (message['result'] !== undefined || message['error'] !== undefined)
  );
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === JSONRPC_VERSION
  );
}
