/**
 * The event stream, proxied.
 *
 * `EventSource` cannot set headers, which is why the agent server accepts its
 * token in a query string — and why the browser must never be the one holding
 * it. Proxying here means the token is attached on this side: the page opens an
 * `EventSource` against its own origin with no credential in the URL at all.
 *
 * The upstream body is passed through untouched. Re-framing SSE would mean
 * re-implementing event ids and retry semantics for no reason.
 */

import { agentEndpoint } from '@/lib/agent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const endpoint = agentEndpoint();
  if (!endpoint) {
    return new Response('The agent server is not configured.', { status: 503 });
  }

  const projectId = new URL(request.url).searchParams.get('projectId');
  const upstream = new URL('/events', endpoint.url);
  upstream.searchParams.set('token', endpoint.token);
  if (projectId) upstream.searchParams.set('projectId', projectId);

  let response: Response;
  try {
    response = await fetch(upstream, {
      headers: { accept: 'text/event-stream' },
      // The browser navigating away has to reach the agent, or the agent keeps
      // streaming to nobody and holds a subscription for the life of the
      // process.
      signal: request.signal,
      cache: 'no-store',
    });
  } catch {
    return new Response('The agent server could not be reached.', { status: 502 });
  }

  if (!response.ok || !response.body) {
    return new Response('The agent server refused the stream.', { status: response.status });
  }

  return new Response(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
