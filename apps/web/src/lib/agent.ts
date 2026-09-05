/**
 * Talking to the agent server, from the Next server.
 *
 * The important word is *from the Next server*. The browser never holds the
 * agent's token and never opens a connection to it: the page calls this app's
 * own route handlers, and those forward with the token attached. Three things
 * follow from that, and each of them is a hole the obvious design would have
 * left open:
 *
 * - **The token stays out of the browser.** No token in JavaScript, no token in
 *   an `EventSource` URL, and therefore none in browser history, in a referrer,
 *   or in whatever a browser extension can read.
 * - **Same-origin, so CORS stops mattering.** The agent server's origin
 *   allowlist becomes defence in depth rather than the thing holding the door.
 * - **One place decides what the dashboard may ask for.** A method the
 *   dashboard has no business calling can be refused here, in code, rather than
 *   trusted not to be called.
 *
 * `AICA_SERVER_URL` and `AICA_SERVER_TOKEN` are read from the environment and
 * are deliberately *not* prefixed `NEXT_PUBLIC_`: that prefix means "ship this
 * to the browser", which is the opposite of what a token wants.
 */

import 'server-only';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7333';

export interface AgentEndpoint {
  readonly url: string;
  readonly token: string;
}

/**
 * Where the agent server is, and how to prove we may talk to it.
 *
 * Returns `undefined` when the token is absent rather than falling back to an
 * empty one. A dashboard that cannot authenticate should say so plainly; one
 * that sends an empty token produces a 401 the user has to decode.
 */
export function agentEndpoint(env: NodeJS.ProcessEnv = process.env): AgentEndpoint | undefined {
  const token = env['AICA_SERVER_TOKEN'];
  if (!token) return undefined;

  return { url: env['AICA_SERVER_URL'] ?? DEFAULT_SERVER_URL, token };
}

/**
 * Methods the dashboard is allowed to call.
 *
 * An allowlist rather than a pass-through. The route handler is reachable by
 * anything running in the user's browser, and a pass-through would make this
 * app a confused deputy for the agent's entire method table — including the
 * ones that write. Read and act, yes; but each one is here because a page needs
 * it, not because it exists.
 */
export const DASHBOARD_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'project/open',
  'project/list',
  'project/status',
  'code/index',
  'code/search',
  'api/import',
  'api/list',
  'api/endpoints',
  'impact/analyze',
  'plan/create',
  'plan/brief',
  'validate/run',
  'run/start',
  'run/cancel',
  'run/list',
  'run/events',
  'patch/list',
  'patch/preview',
  'patch/apply',
  'patch/revert',
  'patch/discard',
  'postman/workspaces',
  'postman/collections',
]);

export interface CallFailure {
  readonly code: string;
  readonly message: string;
}

export type CallOutcome<T> = { ok: true; value: T } | { ok: false; error: CallFailure };

/**
 * Call one method.
 *
 * Never throws. A server that is not running is the single most likely state
 * this dashboard will find itself in — it is started separately — so "cannot
 * connect" is a normal outcome with a message, not an exception that renders a
 * stack trace at somebody.
 */
export async function callAgent<T>(
  method: string,
  params?: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<CallOutcome<T>> {
  const endpoint = agentEndpoint();
  if (!endpoint) {
    return {
      ok: false,
      error: {
        code: 'CONFIG_ERROR',
        message:
          'AICA_SERVER_TOKEN is not set, so this dashboard cannot authenticate to the agent server.',
      },
    };
  }

  if (!DASHBOARD_METHODS.has(method)) {
    return {
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: `The dashboard may not call "${method}".` },
    };
  }

  try {
    const response = await fetch(`${endpoint.url}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ method, params }),
      // Never cached: every one of these is a question about live state.
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const body = (await response.json()) as
      { ok: true; value: T } | { ok: false; error: CallFailure } | { error: string };

    if ('ok' in body) return body;

    return {
      ok: false,
      error: { code: `HTTP_${response.status}`, message: String(body.error) },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
        message: `The agent server at ${endpoint.url} could not be reached. Start it, or set AICA_SERVER_URL.`,
        ...(error instanceof Error ? {} : {}),
      },
    };
  }
}

/** Is the agent server up? Answered without a token, so it can say "not running". */
export async function agentHealth(): Promise<{ reachable: boolean; configured: boolean }> {
  const endpoint = agentEndpoint();
  const configured = endpoint !== undefined;
  const url = endpoint?.url ?? process.env['AICA_SERVER_URL'] ?? DEFAULT_SERVER_URL;

  try {
    const response = await fetch(`${url}/health`, { cache: 'no-store' });
    return { reachable: response.ok, configured };
  } catch {
    return { reachable: false, configured };
  }
}
