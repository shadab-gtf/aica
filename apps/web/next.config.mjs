/**
 * The dashboard is a local tool, not a deployed site.
 *
 * The security headers matter because this page holds a live connection to
 * something that can write to a codebase: a browser extension or an injected
 * script reaching it would be reaching the agent.
 *
 * `output: 'standalone'` is deliberately *not* set. It would let the app run
 * without a node_modules tree, which sounds useful — but `next start` refuses
 * to serve a standalone build, so the mode that is tested and the mode that
 * ships would be different ones. Nothing packages this app yet, so the
 * packaging mode can be added when something actually needs it.
 */
// The Content-Security-Policy is not here: it carries a per-request nonce and
// is set in `src/middleware.ts`. See the note there for why a static one broke
// hydration silently.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
