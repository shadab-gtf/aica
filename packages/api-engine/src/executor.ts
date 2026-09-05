/**
 * The HTTP executor: the only path from the IR to a real request.
 *
 * This is the one component in `api-engine` with a side effect, and it is the
 * point where several phase-1 policies finally meet:
 *
 * - **SSRF policy** validates every URL and re-validates on each redirect, so a
 *   documented endpoint cannot be used to reach the metadata service or a
 *   private address.
 * - **Risk classification and the approval gate** decide whether the request may
 *   be sent at all. A `DELETE` against production is never automatic.
 * - **Secret resolution** turns `env:PAYMENT_API_KEY` into a value at the moment
 *   of use, registering it with the redactor so it is scrubbed from everything
 *   downstream. The value is never stored in the IR, in the plan the caller
 *   sees, or in the returned exchange.
 *
 * Two properties are worth stating outright because they are easy to get wrong:
 *
 * - **Redirects are followed manually, and credentials are dropped when the
 *   origin changes.** Automatic redirect following forwards the `Authorization`
 *   header to whatever host the response names, which is a standard way to hand
 *   a token to a third party.
 * - **A non-2xx response is a result, not an error.** The caller asked what the
 *   API does; a 422 is an answer. `Err` is reserved for requests that could not
 *   be attempted or completed at all.
 *
 * The response body's shape is inferred and returned alongside it. A real
 * response outranks the specification as evidence, so this is what lets
 * `compareSchemas` check what an API actually returns against what it claims.
 */

import type {
  ApiSpec,
  AuthScheme,
  Endpoint,
  HttpMethod,
  SchemaNode,
  SecurityOption,
} from '@aica/api-ir';
import {
  effectiveSecurity,
  fillPath,
  isPublic,
  preferredBody,
  requiredSecretRefs,
  satisfiableOption,
} from '@aica/api-ir';
import type { ApprovalGate, Redactor, SecretResolver, SsrfPolicy } from '@aica/security-engine';
import { classifyHttpRisk } from '@aica/security-engine';
import type { Result, RiskLevel, TargetEnvironment } from '@aica/shared';
import { Limits, err, errors, ok } from '@aica/shared';

import { inferSchema } from './infer.js';

/** Values supplied for one call, filling the endpoint's declared parameters. */
export interface RequestInput {
  readonly pathParameters?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialized according to `mediaType`, or the endpoint's preferred type. */
  readonly body?: unknown;
  readonly mediaType?: string;
  /** Overrides the specification's server, e.g. to target staging. */
  readonly serverUrl?: string;
  /** Values for `{variable}` placeholders in the server URL. */
  readonly serverVariables?: Readonly<Record<string, string>>;
}

/** What was sent, with credentials already redacted. Safe to log and display. */
export interface RequestSummary {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyPreview?: string;
}

export interface HttpExchange {
  readonly request: RequestSummary;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Redacted, and truncated at the configured byte cap. */
  readonly body: string;
  /** Present when the body parsed as JSON. */
  readonly json?: unknown;
  /**
   * Shape inferred from the actual response. This is evidence about the API
   * that outranks its specification, and is what contract validation compares.
   */
  readonly schema?: SchemaNode;
  readonly durationMs: number;
  /** Each URL followed, in order, every one re-validated before the hop. */
  readonly redirects: readonly string[];
  readonly truncated: boolean;
}

/** The subset of `fetch` the executor uses, so tests need no network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiExecutorOptions {
  /** Required: without a policy there is no SSRF protection, so none is assumed. */
  readonly ssrf: SsrfPolicy;
  readonly redactor: Redactor;
  /** Resolves `env:NAME` references. Absent means no scheme can be satisfied. */
  readonly secrets?: SecretResolver;
  /** Absent means no approval is sought and only policy-free calls proceed. */
  readonly approvals?: ApprovalGate;
  readonly environment?: TargetEnvironment;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export class ApiExecutor {
  private readonly ssrf: SsrfPolicy;
  private readonly redactor: Redactor;
  private readonly secrets: SecretResolver | undefined;
  private readonly approvals: ApprovalGate | undefined;
  private readonly environment: TargetEnvironment;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;

  constructor(options: ApiExecutorOptions) {
    this.ssrf = options.ssrf;
    this.redactor = options.redactor;
    this.secrets = options.secrets;
    this.approvals = options.approvals;
    this.environment = options.environment ?? 'local';
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? Limits.defaultHttpTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? Limits.maxHttpResponseBytes;
    this.maxRedirects = options.maxRedirects ?? Limits.maxHttpRedirects;
  }

  /**
   * Send a request to one documented endpoint.
   *
   * The order is deliberate: the request is built, then classified, then
   * authorized, then validated, and only then sent. Authorization happens
   * before DNS resolution so that a request the user would refuse is never
   * announced to a DNS server.
   */
  async execute(
    spec: ApiSpec,
    endpoint: Endpoint,
    input: RequestInput = {},
  ): Promise<Result<HttpExchange>> {
    const built = buildUrl(spec, endpoint, input);
    if (!built.ok) return built;

    const risk = classifyHttpRisk(endpoint.method, this.environment);
    if (typeof risk !== 'string') {
      // `classifyHttpRisk` refuses to guess at a non-method such as "UPDATE".
      return err(errors.invalidInput(risk.invalid, { method: endpoint.method }));
    }

    const authorized = await this.authorize(endpoint, built.value, risk);
    if (!authorized.ok) return authorized;

    const headers = await this.buildHeaders(spec, endpoint, input);
    if (!headers.ok) return headers;

    const body = serializeBody(endpoint, input);
    if (!body.ok) return body;

    if (body.value) {
      headers.value['content-type'] ??= body.value.mediaType;
    }

    return this.send(endpoint.method, built.value, headers.value, body.value?.text);
  }

  private async authorize(endpoint: Endpoint, url: string, risk: RiskLevel): Promise<Result<true>> {
    if (!this.approvals) return ok(true);

    const record = await this.approvals.authorize({
      kind: 'api_request',
      risk,
      subject: `${endpoint.method} ${endpoint.path}`,
      // The detail is shown to a human, so it passes through redaction even
      // though a URL should not contain a credential in the first place.
      detail: this.redactor.text(url),
      environment: this.environment,
      method: endpoint.method,
    });

    return record.ok ? ok(true) : err(record.error);
  }

  /**
   * Resolve the endpoint's authentication and merge it with caller headers.
   *
   * A scheme that cannot be satisfied fails here rather than producing a 401
   * later, and the error names the exact references to set.
   */
  private async buildHeaders(
    spec: ApiSpec,
    endpoint: Endpoint,
    input: RequestInput,
  ): Promise<Result<Record<string, string>>> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }

    const options = effectiveSecurity(spec, endpoint);
    if (isPublic(options)) return ok(headers);

    const option = satisfiableOption(options, spec.authSchemes);
    if (!option) return err(unsatisfiableAuth(spec, endpoint, options));

    for (const requirement of option) {
      const scheme = spec.authSchemes.find((candidate) => candidate.id === requirement.schemeId);
      if (!scheme) continue;

      const applied = await this.applyScheme(scheme, headers);
      if (!applied.ok) return applied;
    }

    return ok(headers);
  }

  private async applyScheme(
    scheme: AuthScheme,
    headers: Record<string, string>,
  ): Promise<Result<true>> {
    if (scheme.kind === 'none') return ok(true);

    if (!this.secrets) {
      return err(
        errors.configError(
          `Cannot satisfy authentication scheme "${scheme.id}": no secret resolver is configured.`,
          { schemeId: scheme.id },
        ),
      );
    }

    // Resolution registers the value with the redactor, which is what makes it
    // scrubbable from every later log line, event, and prompt.
    const resolveRef = async (reference: string | undefined): Promise<Result<string>> =>
      reference === undefined
        ? err(
            errors.configError(`Scheme "${scheme.id}" has no secret reference configured.`, {
              schemeId: scheme.id,
            }),
          )
        : (this.secrets as SecretResolver).resolve(reference);

    switch (scheme.kind) {
      case 'apiKey': {
        const value = await resolveRef(scheme.secretRef);
        if (!value.ok) return value;
        if (scheme.in === 'header') {
          headers[scheme.name.toLowerCase()] = `${scheme.valuePrefix ?? ''}${value.value}`;
        } else if (scheme.in === 'cookie') {
          headers.cookie = appendCookie(headers.cookie, scheme.name, value.value);
        } else {
          // A query-string key is applied by the caller through `input.query`;
          // putting a credential in a URL here would leak it into the summary.
          return err(
            errors.unsupported(
              `Scheme "${scheme.id}" places its key in the query string; supply it through the request's query values so it is not recorded in the request URL.`,
              { schemeId: scheme.id },
            ),
          );
        }
        return ok(true);
      }

      case 'bearer':
      case 'jwt': {
        const value = await resolveRef(scheme.secretRef);
        if (!value.ok) return value;
        headers[(scheme.headerName ?? 'Authorization').toLowerCase()] = `Bearer ${value.value}`;
        return ok(true);
      }

      case 'basic': {
        const username = await resolveRef(scheme.usernameRef);
        if (!username.ok) return username;
        const password = await resolveRef(scheme.passwordRef);
        if (!password.ok) return password;
        const encoded = Buffer.from(`${username.value}:${password.value}`).toString('base64');
        // The encoded pair is itself a credential, so it is registered too.
        this.redactor.registerValue(encoded);
        headers.authorization = `Basic ${encoded}`;
        return ok(true);
      }

      case 'cookie': {
        const value = await resolveRef(scheme.secretRef);
        if (!value.ok) return value;
        headers.cookie = appendCookie(headers.cookie, scheme.name, value.value);
        return ok(true);
      }

      case 'oauth2': {
        // A resolved access token is used directly; performing the flow itself
        // needs a browser or a token endpoint call and belongs above this layer.
        const value = await resolveRef(scheme.secretRef);
        if (!value.ok) return value;
        headers.authorization = `Bearer ${value.value}`;
        return ok(true);
      }

      default:
        return err(
          errors.unsupported(
            `Authentication scheme "${scheme.id}" of kind "${scheme.kind}" cannot be applied automatically.`,
            { schemeId: scheme.id, kind: scheme.kind },
          ),
        );
    }
  }

  /**
   * Validate, send, and follow redirects manually.
   *
   * Every hop is checked against the SSRF policy before it is taken, and the
   * credential headers are dropped as soon as the origin changes.
   */
  private async send(
    method: HttpMethod,
    initialUrl: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<Result<HttpExchange>> {
    const started = Date.now();
    const redirects: string[] = [];

    let url = initialUrl;
    let currentHeaders = headers;
    let currentMethod = method;
    let currentBody = body;

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const verdict = await this.ssrf.check(url);
      if (!verdict.ok) return verdict;

      const response = await this.sendOnce(url, currentMethod, currentHeaders, currentBody);
      if (!response.ok) return response;

      const location = response.value.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.value.status) || location === null) {
        return this.toExchange(
          response.value,
          { method: currentMethod, url, headers: currentHeaders, body: currentBody },
          redirects,
          Date.now() - started,
        );
      }

      const next = resolveLocation(url, location);
      if (!next) {
        return err(
          errors.malformedResponse(`Redirect to an unparseable location: ${location}`, { url }),
        );
      }

      if (sameOrigin(url, next)) {
        currentHeaders = { ...currentHeaders };
      } else {
        // Forwarding credentials across origins hands the token to whatever
        // host the response named.
        currentHeaders = withoutCredentials(currentHeaders);
      }

      // 303, and 301/302 in practice, turn the follow-up into a GET.
      if (
        response.value.status === 303 ||
        (response.value.status < 303 && currentMethod === 'POST')
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
        delete currentHeaders['content-type'];
      }

      redirects.push(next);
      url = next;
    }

    return err(
      errors.limitExceeded(`Exceeded ${this.maxRedirects} redirects`, {
        url: initialUrl,
        redirects,
      }),
    );
  }

  private async sendOnce(
    url: string,
    method: HttpMethod,
    headers: Readonly<Record<string, string>>,
    body: string | undefined,
  ): Promise<Result<Response>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: { ...headers },
        body,
        // Redirects are handled above so each hop can be re-validated.
        redirect: 'manual',
        signal: controller.signal,
      });
      return ok(response);
    } catch (cause) {
      if (controller.signal.aborted) {
        return err(
          errors.timeout(`Request timed out after ${this.timeoutMs}ms`, {
            url: this.redactor.text(url),
            method,
          }),
        );
      }
      return err(
        errors.networkError(`Request failed: ${describe(cause)}`, {
          url: this.redactor.text(url),
          method,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async toExchange(
    response: Response,
    sent: { method: HttpMethod; url: string; headers: Record<string, string>; body?: string },
    redirects: readonly string[],
    durationMs: number,
  ): Promise<Result<HttpExchange>> {
    const read = await this.readBody(response);
    if (!read.ok) return read;

    const body = this.redactor.text(read.value.text);
    const json = tryParseJson(body);

    return ok(
      compactExchange({
        request: {
          method: sent.method,
          url: this.redactor.text(sent.url),
          headers: this.redactor.value(redactHeaderNames(sent.headers)),
          bodyPreview:
            sent.body === undefined
              ? undefined
              : this.redactor.text(sent.body.slice(0, Limits.eventPreviewChars)),
        },
        status: response.status,
        statusText: response.statusText,
        headers: this.redactor.value(headersToObject(response.headers)),
        body,
        json,
        // Inferring from the parsed value gives the caller a shape to compare
        // against the specification; a non-JSON body yields no claim at all.
        schema: json === undefined ? undefined : inferSchema(json),
        durationMs,
        redirects,
        truncated: read.value.truncated,
      }),
    );
  }

  /** Read at most the configured cap, so a huge response cannot exhaust memory. */
  private async readBody(
    response: Response,
  ): Promise<Result<{ text: string; truncated: boolean }>> {
    const stream = response.body;
    if (!stream) return ok({ text: '', truncated: false });

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const remaining = this.maxResponseBytes - total;
        if (value.byteLength >= remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          truncated = true;
          break;
        }

        chunks.push(value);
        total += value.byteLength;
      }
    } catch (cause) {
      return err(errors.networkError(`Failed reading response body: ${describe(cause)}`));
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    return ok({ text: Buffer.concat(chunks).toString('utf8'), truncated });
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/**
 * Build the absolute URL for a call: server, base path, filled path template,
 * and query values.
 *
 * Exported because it is useful on its own — showing the user what would be
 * called, without calling it.
 */
export function buildUrl(
  spec: ApiSpec,
  endpoint: Endpoint,
  input: RequestInput = {},
): Result<string> {
  const servers = endpoint.servers.length > 0 ? endpoint.servers : spec.servers;
  const template = input.serverUrl ?? servers[0]?.url;

  if (template === undefined) {
    return err(
      errors.configError(
        `No server is known for ${endpoint.id}; supply one through the request input.`,
        { endpointId: endpoint.id },
      ),
    );
  }

  const base = substituteServerVariables(
    template,
    servers[0]?.variables ?? [],
    input.serverVariables,
  );
  if (!base.ok) return base;

  const missing = requiredPathParameters(endpoint).filter(
    (name) => input.pathParameters?.[name] === undefined,
  );
  if (missing.length > 0) {
    return err(
      errors.invalidInput(
        `${endpoint.id} needs path parameter(s) ${missing.join(', ')}, which were not supplied.`,
        { endpointId: endpoint.id, missing },
      ),
    );
  }

  const path = fillPath(endpoint.path, input.pathParameters ?? {});

  let url: URL;
  try {
    url = new URL(`${base.value.replace(/\/+$/, '')}${path}`);
  } catch {
    return err(
      errors.configError(
        `Server "${base.value}" is not an absolute URL, so no request can be built.`,
        {
          endpointId: endpoint.id,
          server: base.value,
        },
      ),
    );
  }

  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item));
    }
  }

  return ok(url.toString());
}

function requiredPathParameters(endpoint: Endpoint): string[] {
  return [...endpoint.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string);
}

function substituteServerVariables(
  template: string,
  declared: readonly { name: string; default: string; enum?: readonly string[] }[],
  supplied: Readonly<Record<string, string>> | undefined,
): Result<string> {
  let failure: string | undefined;

  const resolved = template.replace(/\{([^{}]+)\}/g, (all, name: string) => {
    const variable = declared.find((candidate) => candidate.name === name);
    const value = supplied?.[name] ?? variable?.default;

    if (value === undefined) {
      failure = `Server variable "${name}" has no value and no default.`;
      return all;
    }
    if (variable?.enum && !variable.enum.includes(value)) {
      failure = `Server variable "${name}" must be one of ${variable.enum.join(', ')}, not "${value}".`;
      return all;
    }
    return value;
  });

  return failure === undefined ? ok(resolved) : err(errors.configError(failure));
}

interface SerializedBody {
  readonly mediaType: string;
  readonly text: string;
}

function serializeBody(
  endpoint: Endpoint,
  input: RequestInput,
): Result<SerializedBody | undefined> {
  if (input.body === undefined) return ok(undefined);

  const mediaType =
    input.mediaType ??
    (endpoint.requestBody ? preferredBody(endpoint.requestBody.content)?.mediaType : undefined) ??
    'application/json';

  if (typeof input.body === 'string') return ok({ mediaType, text: input.body });

  if (mediaType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(input.body as Record<string, unknown>)) {
      if (value !== undefined) params.append(name, String(value));
    }
    return ok({ mediaType, text: params.toString() });
  }

  try {
    return ok({ mediaType, text: JSON.stringify(input.body) });
  } catch (cause) {
    return err(
      errors.invalidInput(`Request body could not be serialized: ${describe(cause)}`, {
        endpointId: endpoint.id,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Headers that carry a credential and must not survive a cross-origin hop. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);

function withoutCredentials(headers: Readonly<Record<string, string>>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

/** Replace credential header values in the summary shown to callers. */
function redactHeaderNames(headers: Readonly<Record<string, string>>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    summary[name] = CREDENTIAL_HEADERS.has(name.toLowerCase()) ? '[REDACTED]' : value;
  }
  return summary;
}

function appendCookie(existing: string | undefined, name: string, value: string): string {
  const cookie = `${name}=${value}`;
  return existing ? `${existing}; ${cookie}` : cookie;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = key.toLowerCase() === 'set-cookie' ? '[REDACTED]' : value;
  });
  return result;
}

function resolveLocation(current: string, location: string): string | undefined {
  try {
    return new URL(location, current).toString();
  } catch {
    return undefined;
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function tryParseJson(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[[{"]|^-?\d|^true$|^false$|^null$/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Explain exactly which references are missing, so the user can finish the
 * configuration without guessing at variable names.
 */
function unsatisfiableAuth(spec: ApiSpec, endpoint: Endpoint, options: readonly SecurityOption[]) {
  const needed = options.map((option) =>
    option
      .map((requirement) => {
        const scheme = spec.authSchemes.find((candidate) => candidate.id === requirement.schemeId);
        if (!scheme) return `${requirement.schemeId} (not defined in the specification)`;
        const refs = requiredSecretRefs(scheme);
        return refs.length > 0
          ? `${scheme.id} (${refs.join(', ')})`
          : `${scheme.id} (no secret reference configured)`;
      })
      .join(' and '),
  );

  return errors.authFailure(
    `${endpoint.id} requires authentication that is not configured. Satisfy one of: ${needed.join(' | ')}.`,
    { endpointId: endpoint.id, options: needed },
  );
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function compactExchange(exchange: HttpExchange): HttpExchange {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exchange)) {
    if (value !== undefined) result[key] = value;
  }
  return result as unknown as HttpExchange;
}
