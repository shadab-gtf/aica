/**
 * The Jules coding-agent provider.
 *
 * Everything Jules-specific stops here. The class implements
 * `CodingAgentProvider` and returns only provider-neutral types, so the
 * orchestrator above it cannot tell — and must not be able to tell — which
 * agent did the work.
 *
 * How the API key is handled is the security-critical part:
 *
 * - It is supplied as a *reference* (`env:JULES_API_KEY`) and resolved through
 *   `SecretResolver` at the moment of use, which registers the value with the
 *   shared `Redactor`. From then on it is scrubbed from every log line, event,
 *   and prompt automatically.
 * - It is never stored on the instance, never returned, never placed in an
 *   error message, and never handed to a model. The resolver holds it.
 * - It travels in the `x-goog-api-key` header and nowhere else — never a query
 *   parameter, which would put it in URLs and therefore in logs.
 *
 * Retries are bounded and applied only to requests that are safe to repeat.
 * Creating a session is not one of them: a retried `create` after an ambiguous
 * timeout would start a second agent on the same repository.
 */

import type { Redactor, SecretResolver } from '@aica/security-engine';
import type { Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, errors, ok, silentLogger } from '@aica/shared';

import type {
  CodingActivity,
  CodingAgentCapabilities,
  CodingAgentProvider,
  CodingRepository,
  CodingResult,
  CodingSession,
  CodingTask,
} from '../../contract.js';
import { CodingSessionState } from '../../contract.js';
import {
  assertBriefIsSafe,
  assertMessageIsSafe,
  validateBranch,
  validateSourceId,
} from '../../safety.js';
import { isRecord, toCodingActivity, toCodingSession, toRepository } from './mapping.js';
import type {
  JulesCreateSessionRequest,
  JulesErrorResponse,
  JulesListActivitiesResponse,
  JulesListSourcesResponse,
} from './types.js';
import { JULES_API_KEY_HEADER, JULES_DEFAULT_BASE_URL } from './types.js';

/** Injected so tests need no network; matches the shape of global `fetch`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JulesProviderOptions {
  /**
   * Secret reference for the API key, e.g. `env:JULES_API_KEY`. A literal key
   * is rejected: the whole point of the reference is that the value never sits
   * in configuration.
   */
  readonly apiKeyRef: string;
  readonly secrets: SecretResolver;
  readonly redactor: Redactor;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;

/** Status codes worth repeating a request for. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

const MAX_ACTIVITY_PAGES = 20;
const ACTIVITY_PAGE_SIZE = 100;

export class JulesProvider implements CodingAgentProvider {
  readonly name = 'jules';

  /**
   * Jules documents no cancel method, so cancellation is reported as
   * unsupported rather than faked. A caller that needs to stop a session gets
   * a clear answer instead of a silent no-op.
   */
  readonly capabilities: CodingAgentCapabilities = {
    cancel: false,
    followUp: true,
    planApproval: true,
    unifiedDiff: true,
  };

  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;

  constructor(private readonly options: JulesProviderOptions) {
    this.baseUrl = (options.baseUrl ?? JULES_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.logger = (options.logger ?? silentLogger).child('jules');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = options.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async healthCheck(): Promise<Result<true>> {
    // Listing sources is the cheapest authenticated call, so it verifies the
    // key and reachability without creating anything.
    const response = await this.request<JulesListSourcesResponse>('GET', '/sources', {
      query: { pageSize: '1' },
      retry: true,
    });
    return response.ok ? ok(true) : err(response.error);
  }

  async listRepositories(): Promise<Result<readonly CodingRepository[]>> {
    const response = await this.request<JulesListSourcesResponse>('GET', '/sources', {
      query: { pageSize: '100' },
      retry: true,
    });
    if (!response.ok) return response;

    const sources = Array.isArray(response.value?.sources) ? response.value.sources : [];
    const repositories = sources
      .map((source) => toRepository(source))
      .filter((entry): entry is { sourceId: string; label: string } => entry !== undefined)
      .map(({ sourceId }) => ({ sourceId }));

    return ok(repositories);
  }

  async createSession(task: CodingTask): Promise<Result<CodingSession>> {
    const source = validateSourceId(task.repository.sourceId);
    if (!source.ok) return source;

    const brief = assertBriefIsSafe(task.brief);
    if (!brief.ok) return brief;

    let startingBranch: string | undefined;
    if (task.repository.startingBranch !== undefined) {
      const branch = validateBranch(task.repository.startingBranch);
      if (!branch.ok) return branch;
      startingBranch = branch.value;
    }

    const body: JulesCreateSessionRequest = {
      prompt: brief.value,
      title: task.title.slice(0, 200),
      sourceContext: {
        source: `sources/${source.value}`,
        ...(startingBranch ? { githubRepoContext: { startingBranch } } : {}),
      },
      // Defaults to requiring approval: an agent editing a repository
      // unattended is what the approval gate exists to prevent.
      requirePlanApproval: task.requirePlanApproval !== false,
    };

    // Deliberately not retried. A create that timed out may well have
    // succeeded, and repeating it would start a second agent on the same
    // repository — a duplicate branch and duplicate work.
    const response = await this.request<unknown>('POST', '/sessions', { body, retry: false });
    if (!response.ok) return response;

    return toCodingSession(response.value, { redactor: this.options.redactor, now: this.now() });
  }

  async getSession(sessionId: string): Promise<Result<CodingSession>> {
    const id = validateSessionId(sessionId);
    if (!id.ok) return id;

    const response = await this.request<unknown>('GET', `/sessions/${id.value}`, { retry: true });
    if (!response.ok) return response;

    return toCodingSession(response.value, { redactor: this.options.redactor, now: this.now() });
  }

  /**
   * Every activity in a session, oldest first.
   *
   * Paging is bounded: a session that somehow produced unbounded activities
   * must not be able to exhaust memory or spin here forever.
   */
  async getActivities(sessionId: string): Promise<Result<readonly CodingActivity[]>> {
    const id = validateSessionId(sessionId);
    if (!id.ok) return id;

    const collected: CodingActivity[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
      const response = await this.request<JulesListActivitiesResponse>(
        'GET',
        `/sessions/${id.value}/activities`,
        {
          query: {
            pageSize: String(ACTIVITY_PAGE_SIZE),
            ...(pageToken ? { pageToken } : {}),
          },
          retry: true,
        },
      );
      if (!response.ok) return response;

      const activities = Array.isArray(response.value?.activities) ? response.value.activities : [];
      for (const raw of activities) {
        const activity = toCodingActivity(raw, {
          redactor: this.options.redactor,
          now: this.now(),
        });
        // An unparseable activity is skipped rather than failing the whole
        // listing: one bad event must not hide the other ninety-nine.
        if (activity) collected.push(activity);
      }

      const next = response.value?.nextPageToken;
      if (typeof next !== 'string' || next.length === 0) break;
      pageToken = next;
    }

    collected.sort((left, right) => left.createdAt - right.createdAt);
    return ok(collected);
  }

  async sendMessage(sessionId: string, message: string): Promise<Result<void>> {
    const id = validateSessionId(sessionId);
    if (!id.ok) return id;

    const safe = assertMessageIsSafe(message);
    if (!safe.ok) return safe;

    const response = await this.request<unknown>('POST', `/sessions/${id.value}:sendMessage`, {
      body: { prompt: safe.value },
      // Not retried: a repeated message would be delivered twice, and the agent
      // would act on it twice.
      retry: false,
    });

    return response.ok ? ok(undefined) : err(response.error);
  }

  async approvePlan(sessionId: string): Promise<Result<void>> {
    const id = validateSessionId(sessionId);
    if (!id.ok) return id;

    const response = await this.request<unknown>('POST', `/sessions/${id.value}:approvePlan`, {
      body: {},
      retry: false,
    });

    return response.ok ? ok(undefined) : err(response.error);
  }

  /**
   * Collect the outcome of a session.
   *
   * The state comes from the session and the changes from its activities: Jules
   * reports a patch as an artifact on an activity, not as a field on the
   * session, so both calls are required for a complete answer.
   */
  async getResult(sessionId: string): Promise<Result<CodingResult>> {
    const session = await this.getSession(sessionId);
    if (!session.ok) return session;

    const activities = await this.getActivities(sessionId);
    if (!activities.ok) return activities;

    const changeSets = activities.value
      .map((activity) => activity.changes)
      .filter((changes): changes is NonNullable<typeof changes> => changes !== undefined);

    const lastAgentMessage = [...activities.value]
      .reverse()
      .find((activity) => activity.kind === 'agentMessage');

    const failure = [...activities.value].reverse().find((activity) => activity.kind === 'failed');

    return ok({
      sessionId,
      state: session.value.state,
      changeSets,
      ...(lastAgentMessage ? { summary: lastAgentMessage.description } : {}),
      ...(failure?.description
        ? { failureReason: failure.description }
        : session.value.failureReason
          ? { failureReason: session.value.failureReason }
          : {}),
    });
  }

  /** Jules documents no cancellation. Saying so beats pretending. */
  async cancel(_sessionId: string): Promise<Result<void>> {
    return err(
      errors.unsupported(
        'The Jules API does not provide a cancel method. The session must be stopped from the Jules web app, or left to finish.',
        { provider: this.name },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string>;
      retry: boolean;
    },
  ): Promise<Result<T>> {
    const key = await this.options.secrets.resolve(this.options.apiKeyRef);
    if (!key.ok) {
      return err(
        errors.configError(
          `The Jules API key could not be resolved from "${this.options.apiKeyRef}". Set it and try again.`,
          { reference: this.options.apiKeyRef },
        ),
      );
    }

    const url = this.buildUrl(path, options.query);
    const attempts = options.retry ? this.maxRetries + 1 : 1;

    let lastError = errors.internal('No attempt was made.');

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const outcome = await this.attempt<T>(method, url, key.value, options.body);

      if (outcome.ok) return outcome;
      lastError = outcome.error;

      const retryable = outcome.error.retryable && attempt < attempts - 1;
      if (!retryable) return err(lastError);

      // Exponential backoff. Jules documents 429 without a Retry-After, so a
      // fixed schedule is used rather than one invented from a header.
      await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
      this.logger.debug('retrying Jules request', { method, attempt: attempt + 1 });
    }

    return err(lastError);
  }

  private async attempt<T>(
    method: string,
    url: string,
    apiKey: string,
    body: unknown,
  ): Promise<Result<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          // The key travels here and nowhere else — never in the URL, which
          // would put it into every access log along the way.
          [JULES_API_KEY_HEADER]: apiKey,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) return err(this.toError(response.status, text));

      if (text.trim().length === 0) return ok(undefined as T);

      try {
        return ok(JSON.parse(text) as T);
      } catch {
        return err(
          errors.malformedResponse('Jules returned a body that is not valid JSON.', {
            status: response.status,
          }),
        );
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        return err(errors.timeout(`Jules did not respond within ${this.timeoutMs}ms.`, { method }));
      }
      return err(errors.networkError(`Could not reach Jules: ${describe(cause)}`, { method }));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turn an HTTP failure into this system's error taxonomy.
   *
   * The response body is parsed for Google's error envelope but is *not*
   * included verbatim: it is remote text that reaches logs and possibly a
   * prompt, so only its message field is used, redacted and bounded.
   */
  private toError(status: number, body: string) {
    const message = this.messageFrom(body);
    const detail = message ? `: ${message}` : '';

    switch (status) {
      case 400:
        return errors.invalidInput(`Jules rejected the request${detail}`, { status });
      case 401:
        return errors.authFailure(
          `Jules rejected the API key${detail}. Check that JULES_API_KEY is set and current.`,
          { status },
        );
      case 403:
        return errors.permissionDenied(`The Jules API key is not permitted to do this${detail}`, {
          status,
        });
      case 404:
        return errors.notFound(`Jules has no such resource${detail}`, { status });
      case 429:
        return errors.rateLimited(`Jules rate limit reached${detail}`, { status });
      default:
        break;
    }

    if (RETRYABLE_STATUSES.has(status)) {
      // `retryable` is a property of the error, not a detail on it: the retry
      // loop branches on `error.retryable`, and putting the flag in `details`
      // would leave every 5xx looking permanent.
      return new AgentError(ErrorCode.API_ERROR, `Jules is unavailable (HTTP ${status})${detail}`, {
        details: { status },
        retryable: true,
      });
    }

    return errors.apiError(`Jules returned HTTP ${status}${detail}`, { status });
  }

  private messageFrom(body: string): string | undefined {
    try {
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) return undefined;

      const envelope = parsed as JulesErrorResponse;
      const message = envelope.error?.message;
      if (typeof message !== 'string') return undefined;

      return this.options.redactor.text(message).slice(0, 300);
    } catch {
      return undefined;
    }
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  }
}

/**
 * A session identifier goes straight into a request path, so it is validated
 * the same way a repository identifier is.
 */
function validateSessionId(raw: string): Result<string> {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith('sessions/') ? trimmed.slice('sessions/'.length) : trimmed;

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(bare)) {
    return err(errors.invalidInput(`"${raw}" is not a valid Jules session identifier.`));
  }

  return ok(bare);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Terminal states, re-exported for callers polling a session. */
export { CodingSessionState };
