/**
 * The Postman API: fetching collections the user already has.
 *
 * This is a *transport*, and deliberately nothing more. Phase 2 already turns a
 * Postman collection into the canonical IR — every request, method, URL,
 * parameter, header, auth block, body, variable, and saved response example is
 * handled in `postman.ts` and tested there. Adding a second normalizer here
 * would be duplicate architecture whose two halves drift apart.
 *
 * So the division is:
 *
 *   PostmanApiClient  — talk to api.getpostman.com, cache, handle failure
 *   parsePostman      — turn a collection document into an ApiSpec (existing)
 *
 * `fetchCollectionSpec` composes the two, and that composition is the only new
 * concept. Any other source — OpenAPI, Swagger, cURL, documentation — reaches
 * the same IR through its own parser, and nothing downstream can tell which one
 * a spec came from beyond its `source.format`.
 *
 * The API key is handled exactly as every other credential in this system: a
 * secret reference resolved at the moment of use, registered with the shared
 * `Redactor`, sent in a header, never logged and never returned.
 *
 * Source: https://learning.postman.com/docs/developer/postman-api/ (read 2026-09).
 */

import type { Redactor, SecretResolver } from '@aica/security-engine';
import type { ApiSpec } from '@aica/api-ir';
import type { Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, errors, ok, silentLogger } from '@aica/shared';

// The HTTP executor already defines this shape; redefining it here would be a
// second name for one concept.
import type { FetchLike } from './executor.js';
import { asArray, asRecord, asString, asText, isRecord } from './json.js';
import { parsePostman } from './postman.js';

/** Postman's documented API host. */
export const POSTMAN_DEFAULT_BASE_URL = 'https://api.getpostman.com';

/** The documented authentication header. Not `Authorization`. */
export const POSTMAN_API_KEY_HEADER = 'X-API-Key';

/** A workspace, reduced to what a picker needs. */
export interface PostmanWorkspace {
  readonly id: string;
  readonly name: string;
  /** `personal`, `team`, `private`, `public`, or whatever Postman reports. */
  readonly type?: string;
  readonly description?: string;
}

/** A collection reference. `uid` is what fetching a collection requires. */
export interface PostmanCollectionRef {
  readonly uid: string;
  readonly id: string;
  readonly name: string;
  readonly owner?: string;
  readonly updatedAt?: string;
}

export interface PostmanApiClientOptions {
  /**
   * Secret reference for the API key, e.g. `env:POSTMAN_API_KEY`, or
   * `keychain:postman` when the VS Code extension supplies it from
   * SecretStorage through the resolver's keychain reader.
   */
  readonly apiKeyRef: string;
  readonly secrets: SecretResolver;
  readonly redactor: Redactor;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** How long a cached response stays fresh. Zero disables caching. */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 300;

/** Statuses worth repeating. Postman rate-limits, so 429 is included. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** Guards against a pathological collection exhausting memory. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/**
 * A read-only client for the Postman API.
 *
 * Read-only on purpose: this system imports API definitions, it does not manage
 * someone's Postman account. A client that could delete a collection would be a
 * capability with no use here and a real blast radius if misused.
 */
export class PostmanApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: PostmanApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? POSTMAN_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.logger = (options.logger ?? silentLogger).child('postman');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Verify the key works, without fetching anything large. */
  async healthCheck(): Promise<Result<true>> {
    const response = await this.request('/me', { cache: false });
    return response.ok ? ok(true) : err(response.error);
  }

  /** Every workspace the key can see. */
  async listWorkspaces(): Promise<Result<readonly PostmanWorkspace[]>> {
    const response = await this.request('/workspaces', { cache: true });
    if (!response.ok) return response;

    const raw = asArray(asRecord(response.value)?.workspaces) ?? [];
    const workspaces = raw
      .map((entry) => toWorkspace(entry))
      .filter((entry): entry is PostmanWorkspace => entry !== undefined);

    return ok(workspaces);
  }

  /**
   * Collections in one workspace.
   *
   * A workspace's detail response carries its collection references, which is
   * the only way to scope collections to a workspace — `GET /collections`
   * returns everything the key can see, across all of them.
   */
  async listCollections(workspaceId: string): Promise<Result<readonly PostmanCollectionRef[]>> {
    const id = validateId(workspaceId, 'workspace');
    if (!id.ok) return id;

    const response = await this.request(`/workspaces/${id.value}`, { cache: true });
    if (!response.ok) return response;

    const workspace = asRecord(asRecord(response.value)?.workspace);
    if (!workspace) {
      return err(
        errors.malformedResponse('Postman returned a workspace response with no workspace object.'),
      );
    }

    const raw = asArray(workspace.collections) ?? [];
    const collections = raw
      .map((entry) => toCollectionRef(entry))
      .filter((entry): entry is PostmanCollectionRef => entry !== undefined);

    return ok(collections);
  }

  /** Every collection the key can see, across all workspaces. */
  async listAllCollections(): Promise<Result<readonly PostmanCollectionRef[]>> {
    const response = await this.request('/collections', { cache: true });
    if (!response.ok) return response;

    const raw = asArray(asRecord(response.value)?.collections) ?? [];
    const collections = raw
      .map((entry) => toCollectionRef(entry))
      .filter((entry): entry is PostmanCollectionRef => entry !== undefined);

    return ok(collections);
  }

  /**
   * The full collection document, unwrapped from Postman's envelope.
   *
   * Returned as the raw document rather than an `ApiSpec` so that the caller
   * can hand it to the existing parser — or to any other consumer — without
   * this client taking a view on how it should be normalized.
   */
  async fetchCollection(collectionUid: string): Promise<Result<unknown>> {
    const uid = validateId(collectionUid, 'collection');
    if (!uid.ok) return uid;

    const response = await this.request(`/collections/${uid.value}`, { cache: true });
    if (!response.ok) return response;

    const collection = asRecord(response.value)?.collection;
    if (!isRecord(collection)) {
      return err(
        errors.malformedResponse(`Postman returned no collection body for "${uid.value}".`, {
          uid: uid.value,
        }),
      );
    }

    return ok(collection);
  }

  /**
   * Fetch a collection and normalize it into the canonical IR.
   *
   * This is the whole point of the module, and it is three lines because the
   * normalization already exists: every consumer downstream sees the same
   * `ApiSpec` whether it came from Postman, OpenAPI, a cURL command, or prose.
   */
  async fetchCollectionSpec(
    collectionUid: string,
    options: { fallbackTitle?: string } = {},
  ): Promise<Result<ApiSpec>> {
    const document = await this.fetchCollection(collectionUid);
    if (!document.ok) return document;

    return parsePostman(document.value, {
      location: `postman:${collectionUid}`,
      ...(options.fallbackTitle ? { fallbackTitle: options.fallbackTitle } : {}),
    });
  }

  /** Drop cached responses, so a picker can offer an explicit refresh. */
  clearCache(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request(path: string, options: { cache: boolean }): Promise<Result<unknown>> {
    if (options.cache && this.cacheTtlMs > 0) {
      const hit = this.cache.get(path);
      if (hit && hit.expiresAt > this.now()) {
        this.logger.debug('cache hit', { path });
        return ok(hit.value);
      }
    }

    // Resolved per request and never held: the resolver caches it, registers it
    // with the redactor, and remains the only thing that has the value.
    const key = await this.options.secrets.resolve(this.options.apiKeyRef);
    if (!key.ok) {
      return err(
        errors.configError(
          `The Postman API key could not be resolved from "${this.options.apiKeyRef}". Set it and try again.`,
          { reference: this.options.apiKeyRef },
        ),
      );
    }

    const attempts = this.maxRetries + 1;
    let lastError = errors.internal('No attempt was made.');

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const outcome = await this.attempt(path, key.value);

      if (outcome.ok) {
        if (options.cache && this.cacheTtlMs > 0) {
          this.cache.set(path, {
            value: outcome.value,
            expiresAt: this.now() + this.cacheTtlMs,
          });
        }
        return outcome;
      }

      lastError = outcome.error;
      if (!outcome.error.retryable || attempt === attempts - 1) return err(lastError);

      await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
      this.logger.debug('retrying Postman request', { path, attempt: attempt + 1 });
    }

    return err(lastError);
  }

  private async attempt(path: string, apiKey: string): Promise<Result<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          // The key travels here only — never a query parameter, which would
          // put it in every access log between here and Postman.
          [POSTMAN_API_KEY_HEADER]: apiKey,
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      const text = await response.text();

      if (text.length > MAX_RESPONSE_BYTES) {
        return err(
          errors.limitExceeded(
            `Postman returned ${text.length} bytes, above the ${MAX_RESPONSE_BYTES} limit.`,
            { path },
          ),
        );
      }

      if (!response.ok) return err(this.toError(response.status, text));

      try {
        return ok(JSON.parse(text));
      } catch {
        return err(
          errors.malformedResponse('Postman returned a body that is not valid JSON.', {
            status: response.status,
          }),
        );
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        return err(errors.timeout(`Postman did not respond within ${this.timeoutMs}ms.`, { path }));
      }
      return err(errors.networkError(`Could not reach Postman: ${describe(cause)}`, { path }));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map an HTTP failure onto the error taxonomy, without echoing the body. */
  private toError(status: number, body: string): AgentError {
    const message = this.messageFrom(body);
    const detail = message ? `: ${message}` : '';

    switch (status) {
      case 400:
        return errors.invalidInput(`Postman rejected the request${detail}`, { status });
      case 401:
      case 403:
        // Postman answers both for a key that is missing, revoked, or simply
        // lacks access to the resource; the fix is the same in each case.
        return errors.authFailure(
          `Postman rejected the API key${detail}. Check that it is set and has access.`,
          { status },
        );
      case 404:
        return errors.notFound(`Postman has no such resource${detail}`, { status });
      case 429:
        return new AgentError(ErrorCode.RATE_LIMITED, `Postman rate limit reached${detail}`, {
          details: { status },
          retryable: true,
        });
      default:
        break;
    }

    if (RETRYABLE_STATUSES.has(status)) {
      return new AgentError(
        ErrorCode.API_ERROR,
        `Postman is unavailable (HTTP ${status})${detail}`,
        { details: { status }, retryable: true },
      );
    }

    return errors.apiError(`Postman returned HTTP ${status}${detail}`, { status });
  }

  /**
   * Postman's error envelope is `{ error: { name, message } }`. Only the
   * message is used, redacted and bounded: it is remote text that reaches logs.
   */
  private messageFrom(body: string): string | undefined {
    try {
      const parsed: unknown = JSON.parse(body);
      const message = asString(asRecord(asRecord(parsed)?.error)?.message);
      if (message === undefined) return undefined;
      return this.options.redactor.text(message).slice(0, 300);
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing responses
// ---------------------------------------------------------------------------

function toWorkspace(raw: unknown): PostmanWorkspace | undefined {
  const record = asRecord(raw);
  const id = asText(record?.id);
  if (id === undefined) return undefined;

  return {
    id,
    name: asText(record?.name) ?? id,
    ...(asText(record?.type) ? { type: asText(record?.type) as string } : {}),
    ...(asText(record?.description) ? { description: asText(record?.description) as string } : {}),
  };
}

function toCollectionRef(raw: unknown): PostmanCollectionRef | undefined {
  const record = asRecord(raw);
  const uid = asText(record?.uid);
  const id = asText(record?.id);

  // `uid` is what fetching requires; without it the entry is unusable.
  if (uid === undefined) return undefined;

  return {
    uid,
    id: id ?? uid,
    name: asText(record?.name) ?? uid,
    ...(asText(record?.owner) ? { owner: asText(record?.owner) as string } : {}),
    ...(asText(record?.updatedAt) ? { updatedAt: asText(record?.updatedAt) as string } : {}),
  };
}

/**
 * Validate an identifier before it is interpolated into a request path.
 *
 * Postman ids are UUIDs and uids are `{ownerId}-{uuid}`. Anything else could
 * escape the path or smuggle a query, so it is refused rather than escaped —
 * the same reasoning as the command policy in §5.2.
 */
function validateId(raw: string, kind: string): Result<string> {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return err(errors.invalidInput(`The ${kind} identifier is empty.`));
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(trimmed)) {
    return err(
      errors.invalidInput(
        `"${trimmed}" is not a valid Postman ${kind} identifier. Expected letters, digits, and hyphens.`,
      ),
    );
  }

  return ok(trimmed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
