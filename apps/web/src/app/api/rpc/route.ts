/**
 * The browser's only way to reach the agent.
 *
 * Same origin, so the token stays on this side and CORS never enters into it.
 * The method allowlist lives in `callAgent`, which means a page cannot widen
 * what the dashboard is able to do by asking for a different method name.
 */

import { NextResponse } from 'next/server';

import { callAgent } from '@/lib/agent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  let body: { method?: unknown; params?: unknown };

  try {
    body = (await request.json()) as { method?: unknown; params?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: { message: 'Body is not JSON.' } },
      { status: 400 },
    );
  }

  if (typeof body.method !== 'string') {
    return NextResponse.json(
      { ok: false, error: { message: 'A "method" is required.' } },
      { status: 400 },
    );
  }

  const result = await callAgent(body.method, body.params, { signal: request.signal });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
