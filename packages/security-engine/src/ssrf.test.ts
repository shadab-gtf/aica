import { describe, expect, it } from 'vitest';
import { ErrorCode, isErr, isOk, unwrap } from '@aica/shared';

import { SsrfPolicy, hostMatches, isPrivateAddress } from './ssrf.js';

/** Resolver stub, so these tests never touch real DNS. */
const resolver = (map: Record<string, string[]>) => async (hostname: string) => {
  const addresses = map[hostname];
  if (!addresses) throw new Error(`NXDOMAIN ${hostname}`);
  return addresses;
};

const publicDns = resolver({
  'api.example.com': ['93.184.216.34'],
  'api.stripe.com': ['104.18.12.20'],
  'evil.example.com': ['127.0.0.1'],
  'rebind.example.com': ['203.0.113.9', '169.254.169.254'],
  'internal.corp.example.com': ['10.1.2.3'],
});

const policy = (overrides = {}) => new SsrfPolicy({ resolveHost: publicDns, ...overrides });

describe('protocol and URL shape', () => {
  it('accepts an ordinary HTTPS API URL', async () => {
    const verdict = unwrap(await policy().check('https://api.example.com/v1/payments'));
    expect(verdict.hostname).toBe('api.example.com');
    expect(verdict.isPrivate).toBe(false);
    expect(verdict.addresses).toContain('93.184.216.34');
  });

  it.each(['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/plain,hi', 'ws://x/'])(
    'refuses the %s scheme',
    async (url) => {
      const result = await policy().check(url);
      expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    },
  );

  it('refuses a malformed URL', async () => {
    const result = await policy().check('not a url');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it('refuses credentials embedded in the URL', async () => {
    const result = await policy().check('https://user:pass@api.example.com/v1');
    expect(isErr(result) && result.error.message).toMatch(/secret reference/i);
  });
});

describe('loopback, private, and metadata targets', () => {
  it.each([
    'http://localhost:3000/api',
    'http://127.0.0.1:8080/api',
    'http://[::1]:8080/api',
    'http://0.0.0.0:8080/api',
  ])('refuses %s by default', async (url) => {
    const result = await policy().check(url);
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('refuses a public hostname that resolves to loopback', async () => {
    const result = await policy().check('https://evil.example.com/api');
    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.message).toMatch(/private or loopback/i);
  });

  it('refuses when any resolved address is private, not just the first', async () => {
    const result = await policy().check('https://rebind.example.com/api');
    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.message).toMatch(/169\.254\.169\.254/);
  });

  it('refuses cloud instance metadata by address and by name', async () => {
    const byAddress = await policy().check('http://169.254.169.254/latest/meta-data/');
    expect(isErr(byAddress)).toBe(true);

    const byName = await policy().check('http://metadata.google.internal/computeMetadata/v1/');
    expect(isErr(byName) && byName.error.message).toMatch(/metadata/i);
  });

  it('refuses metadata even when the private network is enabled', async () => {
    const result = await policy({ allowPrivateNetwork: true }).check(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    );
    expect(isErr(result)).toBe(true);
  });

  it('permits the private network when the project opts in', async () => {
    const result = await policy({ allowPrivateNetwork: true }).check('http://localhost:3000/api');
    expect(isOk(result)).toBe(true);
    expect(isOk(result) && result.value.isPrivate).toBe(true);
  });

  it('treats a single-label host as internal', async () => {
    const result = await policy().check('http://intranet/api');
    expect(isErr(result)).toBe(true);
  });

  it('refuses .internal and .local suffixes', async () => {
    expect(isErr(await policy().check('https://svc.internal/api'))).toBe(true);
    expect(isErr(await policy().check('https://printer.local/api'))).toBe(true);
  });
});

describe('allow and block lists', () => {
  it('restricts to the allowlist when one is configured', async () => {
    const restricted = policy({ allowedHosts: ['api.stripe.com'] });
    expect(isOk(await restricted.check('https://api.stripe.com/v1/charges'))).toBe(true);

    const denied = await restricted.check('https://api.example.com/v1');
    expect(isErr(denied) && denied.error.message).toMatch(/allowed hosts/i);
  });

  it('matches subdomains with a suffix pattern', () => {
    expect(hostMatches('api.example.com', '.example.com')).toBe(true);
    expect(hostMatches('api.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '.example.com')).toBe(true);
    expect(hostMatches('api.notexample.com', '.example.com')).toBe(false);
  });

  it('lets an explicit allowlist authorise a private host, since an operator chose it', async () => {
    const configured = new SsrfPolicy({
      resolveHost: publicDns,
      allowedHosts: ['internal.corp.example.com'],
    });
    expect(isOk(await configured.check('https://internal.corp.example.com/api'))).toBe(true);
  });

  it('honours a blocklist over everything else', async () => {
    const blocked = policy({ blockedHosts: ['api.example.com'] });
    const result = await blocked.check('https://api.example.com/v1');
    expect(isErr(result) && result.error.message).toMatch(/blocked/i);
  });
});

describe('ports and transport security', () => {
  it('refuses an unusual port', async () => {
    const result = await policy().check('https://api.example.com:22/');
    expect(isErr(result) && result.error.message).toMatch(/Port 22/);
  });

  it('permits configured ports', async () => {
    const custom = policy({ allowedPorts: [8443] });
    expect(isOk(await custom.check('https://api.example.com:8443/v1'))).toBe(true);
  });

  it('refuses plaintext HTTP to a public host', async () => {
    const result = await policy().check('http://api.example.com/v1');
    expect(isErr(result) && result.error.message).toMatch(/unencrypted|HTTPS/i);
  });

  it('permits plaintext HTTP once explicitly enabled', async () => {
    expect(isOk(await policy({ allowInsecureHttp: true }).check('http://api.example.com/v1'))).toBe(
      true,
    );
  });
});

describe('redirects', () => {
  it('re-validates a redirect target', async () => {
    const from = new URL('https://api.example.com/v1/pay');
    const result = await policy().checkRedirect(from, 'https://evil.example.com/steal');
    expect(isErr(result)).toBe(true);
  });

  it('refuses a redirect that downgrades HTTPS to HTTP', async () => {
    const from = new URL('https://api.example.com/v1');
    const result = await policy().checkRedirect(from, 'http://api.example.com/v1');
    expect(isErr(result) && result.error.message).toMatch(/downgrade/i);
  });

  it('resolves a relative redirect against the original URL', async () => {
    const from = new URL('https://api.example.com/v1/pay');
    const result = await policy().checkRedirect(from, '/v2/pay');
    expect(isOk(result) && result.value.url.pathname).toBe('/v2/pay');
  });

  it('refuses a redirect to metadata', async () => {
    const from = new URL('https://api.example.com/v1');
    const result = await policy().checkRedirect(from, 'http://169.254.169.254/latest/');
    expect(isErr(result)).toBe(true);
  });
});

describe('DNS failure', () => {
  it('reports a host that does not resolve', async () => {
    const result = await policy().check('https://nonexistent.example.com/api');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])('classifies %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])(
    'classifies %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it('returns false for a string that is not an IP address at all', () => {
    // Such a value is a hostname as far as the policy is concerned, and is
    // classified by the hostname rules rather than by address range.
    expect(isPrivateAddress('999.1.1.1')).toBe(false);
    expect(isPrivateAddress('api.example.com')).toBe(false);
  });
});
