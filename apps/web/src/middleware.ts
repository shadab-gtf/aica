import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * A per-request Content Security Policy, with a nonce.
 *
 * The policy has to be built here rather than in `next.config.mjs` because it
 * contains a value that changes on every request. That is the whole point: Next
 * bootstraps hydration with an inline script, so a static `script-src 'self'`
 * blocks it — and the failure is quiet and nasty. The page still renders,
 * because the HTML is server-rendered; it is simply dead. Nothing hydrates, no
 * client component runs, and the live event stream never opens. It looks like a
 * page that works.
 *
 * The alternative would be `'unsafe-inline'`, which is the same as having no
 * script policy at all. A nonce keeps the policy strict: Next stamps its own
 * scripts with the nonce it finds here, and anything injected into the page
 * later has no way to guess it.
 *
 * `'strict-dynamic'` is what lets a nonced script load the chunks it needs
 * without every chunk URL being listed.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const isDev = process.env.NODE_ENV !== 'production';
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Styles stay `unsafe-inline`: React writes inline `style` attributes, and
    // a nonce cannot cover an attribute. The exposure is a page that can be
    // restyled, not one that can be scripted.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // The only thing this page talks to is itself. The agent server is reached
    // through this app's route handlers, never from the browser — so a script
    // that did get in could not reach it.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

  const headers = new Headers(request.headers);
  // Next reads this to stamp its own inline scripts.
  headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  /**
   * Everything except static assets.
   *
   * A CSP on a hashed chunk file buys nothing — the policy that matters is the
   * one on the document that loads it — and running middleware for every asset
   * is a cost on every request.
   */
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
