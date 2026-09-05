/**
 * Structured error taxonomy.
 *
 * Every failure mode named in specification section 64 has a stable code so
 * that callers, the UI, and the auto-repair loop can branch on the kind of
 * failure without string matching on messages.
 */
export const ErrorCode = {
  /** Input failed schema validation before any side effect occurred. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** Blocked by policy: allowlist, path containment, environment restriction. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** The user declined an approval request. */
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  /** Operation exceeded its wall-clock budget. */
  TIMEOUT: 'TIMEOUT',
  /** Operation was cancelled by the user or by a parent abort. */
  ABORTED: 'ABORTED',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  /** Transport-level network failure (DNS, connection, socket). */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** The remote API returned an error status. */
  API_ERROR: 'API_ERROR',
  AUTH_FAILURE: 'AUTH_FAILURE',
  RATE_LIMITED: 'RATE_LIMITED',
  /** A response could not be parsed into its expected shape. */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  /** The AI provider failed (outage, refusal, invalid tool call). */
  MODEL_FAILURE: 'MODEL_FAILURE',
  /** A tool handler failed for a reason of its own. */
  TOOL_FAILURE: 'TOOL_FAILURE',
  /** A patch precondition failed; the file changed underneath the agent. */
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  /** Output exceeded a configured size limit. */
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  /** A spec or codebase contradiction the agent must not silently resolve. */
  CONFLICT: 'CONFLICT',
  /** Not attempted because a required capability is absent. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** A configuration value is missing or invalid. */
  CONFIG_ERROR: 'CONFIG_ERROR',
  /** Should not happen; indicates a defect in this system. */
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Codes for which a bare retry can plausibly succeed. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.TIMEOUT,
  ErrorCode.NETWORK_ERROR,
  ErrorCode.RATE_LIMITED,
  ErrorCode.MODEL_FAILURE,
]);

export interface AgentErrorJSON {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly cause?: string;
}

export interface AgentErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  /** Overrides the default derived from the code. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * The single error type crossing every internal boundary.
 *
 * `details` is structured so the UI and the repair loop can act on it. It must
 * never contain secret material; redaction is applied at the emit boundary, but
 * callers are still expected not to put credentials in here.
 */
export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: AgentErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AgentError';
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  toJSON(): AgentErrorJSON {
    const json: {
      code: ErrorCode;
      message: string;
      retryable: boolean;
      details?: Readonly<Record<string, unknown>>;
      cause?: string;
    } = { code: this.code, message: this.message, retryable: this.retryable };
    if (Object.keys(this.details).length > 0) json.details = this.details;
    if (this.cause !== undefined) json.cause = describeCause(this.cause);
    return json;
  }

  /** Convert an unknown thrown value into an AgentError without losing information. */
  static from(value: unknown, fallbackCode: ErrorCode = ErrorCode.INTERNAL): AgentError {
    if (value instanceof AgentError) return value;
    if (value instanceof Error) {
      return new AgentError(classifyNodeError(value) ?? fallbackCode, value.message, {
        cause: value,
      });
    }
    return new AgentError(fallbackCode, describeCause(value), { cause: value });
  }
}

function describeCause(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Map well-known Node.js error codes onto our taxonomy so filesystem and
 * network failures arrive pre-classified rather than as INTERNAL.
 */
function classifyNodeError(error: Error): ErrorCode | undefined {
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  switch (code) {
    case 'ENOENT':
      return ErrorCode.NOT_FOUND;
    case 'EEXIST':
      return ErrorCode.ALREADY_EXISTS;
    case 'EACCES':
    case 'EPERM':
      return ErrorCode.PERMISSION_DENIED;
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return ErrorCode.TIMEOUT;
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EPIPE':
      return ErrorCode.NETWORK_ERROR;
    case 'ABORT_ERR':
      return ErrorCode.ABORTED;
    case 'ERR_INVALID_URL':
      return ErrorCode.INVALID_INPUT;
    default:
      return undefined;
  }
}

type Details = Record<string, unknown>;

/** Convenience constructors for the codes used most often. */
export const errors = {
  invalidInput: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.INVALID_INPUT, message, { details }),
  permissionDenied: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.PERMISSION_DENIED, message, { details }),
  approvalDenied: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.APPROVAL_DENIED, message, { details }),
  notFound: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.NOT_FOUND, message, { details }),
  alreadyExists: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.ALREADY_EXISTS, message, { details }),
  timeout: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.TIMEOUT, message, { details }),
  aborted: (message = 'Operation aborted', details?: Details): AgentError =>
    new AgentError(ErrorCode.ABORTED, message, { details }),
  toolFailure: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.TOOL_FAILURE, message, { details }),
  preconditionFailed: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.PRECONDITION_FAILED, message, { details }),
  limitExceeded: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.LIMIT_EXCEEDED, message, { details }),
  conflict: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.CONFLICT, message, { details }),
  unsupported: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.UNSUPPORTED, message, { details }),
  configError: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.CONFIG_ERROR, message, { details }),
  internal: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.INTERNAL, message, { details }),
  modelFailure: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.MODEL_FAILURE, message, { details }),
  malformedResponse: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.MALFORMED_RESPONSE, message, { details }),
  apiError: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.API_ERROR, message, { details }),
  authFailure: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.AUTH_FAILURE, message, { details }),
  rateLimited: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.RATE_LIMITED, message, { details }),
  networkError: (message: string, details?: Details): AgentError =>
    new AgentError(ErrorCode.NETWORK_ERROR, message, { details }),
} as const;
