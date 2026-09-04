import { AgentError, ErrorCode, errors } from './errors.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

/**
 * Bounds an operation in wall-clock time and converts every outcome, including
 * a throw, into a Result. Used at every boundary that can hang: child
 * processes, HTTP requests, provider streams, MCP calls.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; label: string; signal?: AbortSignal },
): Promise<Result<T>> {
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(options.signal?.reason);

  if (options.signal) {
    if (options.signal.aborted) return err(errors.aborted(`${options.label} aborted before start`));
    options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const value = await operation(controller.signal);
    return ok(value);
  } catch (error) {
    if (timedOut) {
      return err(
        errors.timeout(`${options.label} timed out after ${options.timeoutMs}ms`, {
          timeoutMs: options.timeoutMs,
        }),
      );
    }
    if (options.signal?.aborted) return err(errors.aborted(`${options.label} aborted`));
    return err(AgentError.from(error, ErrorCode.INTERNAL));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Wrap a throwing operation so it yields a Result instead. */
export async function attempt<T>(
  operation: () => Promise<T>,
  fallbackCode: ErrorCode = ErrorCode.INTERNAL,
): Promise<Result<T>> {
  try {
    return ok(await operation());
  } catch (error) {
    return err(AgentError.from(error, fallbackCode));
  }
}

export function attemptSync<T>(
  operation: () => T,
  fallbackCode: ErrorCode = ErrorCode.INTERNAL,
): Result<T> {
  try {
    return ok(operation());
  } catch (error) {
    return err(AgentError.from(error, fallbackCode));
  }
}

export interface RetryOptions {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs?: number;
  readonly signal?: AbortSignal;
  readonly onRetry?: (attempt: number, error: AgentError) => void;
  /** Defaults to the error's own `retryable` flag. */
  readonly isRetryable?: (error: AgentError) => boolean;
  /** Injectable for deterministic tests; defaults to Math.random. */
  readonly random?: () => number;
}

/**
 * Retry with exponential backoff and full jitter, honouring the error
 * taxonomy: only errors marked retryable are retried, so a PERMISSION_DENIED
 * fails immediately instead of being hammered.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<Result<T>>,
  options: RetryOptions,
): Promise<Result<T>> {
  const maxDelay = options.maxDelayMs ?? 30_000;
  const random = options.random ?? Math.random;
  const retryable = options.isRetryable ?? ((error: AgentError) => error.retryable);

  let last: Result<T> = err(errors.internal('retry() called with attempts < 1'));

  for (let attempt = 1; attempt <= Math.max(1, options.attempts); attempt += 1) {
    if (options.signal?.aborted) return err(errors.aborted('Retry aborted'));
    last = await operation(attempt);
    if (last.ok) return last;
    if (attempt === options.attempts || !retryable(last.error)) return last;

    options.onRetry?.(attempt, last.error);
    const ceiling = Math.min(maxDelay, options.baseDelayMs * 2 ** (attempt - 1));
    await delay(Math.floor(random() * ceiling), options.signal);
  }

  return last;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run tasks with bounded concurrency, preserving input order in the output.
 * Used by the indexer and by parallel validation steps.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
