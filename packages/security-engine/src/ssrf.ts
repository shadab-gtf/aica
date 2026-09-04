import { lookup } from 'node:dns/promises';
import net from 'node:net';

import type { Result } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';

/**
 * SSRF protection for the API executor (specification section 34).
 *
 * The threat is specific: endpoint URLs and base URLs arrive from API
 * specifications, documentation, and model output, none of which are trusted.
 * Without this guard, "integrate this API" is a primitive for reaching the
 * loopback interface, the private network, and cloud instance metadata.
 *
 * Two checks, both required:
 *
 * 1. **Syntactic** — protocol, port, and obvious hostname forms.
 * 2. **Resolved-address** — DNS is resolved and every returned address is
 *    validated, which is what defeats a hostname that points at 127.0.0.1 or
 *    169.254.169.254. Redirects are re-validated at each hop, because only
 *    checking the first URL leaves a trivial bypass.
 */

export const ALLOWED_PROTOCOLS: readonly string[] = ['https:', 'http:'];

/**
 * Cloud instance-metadata addresses. Reaching these yields credentials, so they
 * are denied by name as well as by range.
 */
const METADATA_HOSTS: readonly string[] = [
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '100.100.100.200',
  'fd00:ec2::254',
];

/** Hostnames that always mean "this machine". */
const LOCALHOST_NAMES: readonly string[] = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  '0.0.0.0',
  '[::]',
];

export interface SsrfPolicyOptions {
  /**
   * When set, only these hostnames are permitted. Suffix form `.example.com`
   * matches subdomains. An allowlist supersedes every heuristic below.
   */
  readonly allowedHosts?: readonly string[];
  /** Hostnames refused even if otherwise acceptable. */
  readonly blockedHosts?: readonly string[];
  /**
   * Permit private, loopback, and link-local targets. Required for local
   * development against a service on 127.0.0.1, and off by default.
   */
  readonly allowPrivateNetwork?: boolean;
  /** Permit plaintext HTTP. Off by default outside the private network. */
  readonly allowInsecureHttp?: boolean;
  /** Ports permitted; empty means the protocol default plus common dev ports. */
  readonly allowedPorts?: readonly number[];
  /** Injectable resolver for tests. */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

export interface UrlVerdict {
  readonly url: URL;
  readonly hostname: string;
  readonly addresses: readonly string[];
  readonly isPrivate: boolean;
}

const DEFAULT_DEV_PORTS: readonly number[] = [
  80, 443, 3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 8443, 9000,
];

export class SsrfPolicy {
  private readonly options: SsrfPolicyOptions;
  private readonly resolveHost: (hostname: string) => Promise<readonly string[]>;

  constructor(options: SsrfPolicyOptions = {}) {
    this.options = options;
    this.resolveHost = options.resolveHost ?? defaultResolver;
  }

  /**
   * Validate a URL, resolving DNS. Returns the parsed URL plus the addresses it
   * resolved to, so the caller can pin the connection to a validated address
   * rather than re-resolving and risking a DNS rebind between check and use.
   */
  async check(rawUrl: string): Promise<Result<UrlVerdict>> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return err(errors.invalidInput('Malformed URL', { url: rawUrl }));
    }

    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
      return err(
        errors.permissionDenied(
          `Protocol "${url.protocol}" is not permitted. Only ${ALLOWED_PROTOCOLS.join(' and ')} are allowed.`,
          { url: url.origin, protocol: url.protocol },
        ),
      );
    }

    if (url.username !== '' || url.password !== '') {
      return err(
        errors.invalidInput(
          'Credentials embedded in the URL are not accepted. Supply authentication as a secret reference instead.',
          { host: url.hostname },
        ),
      );
    }

    const hostname = normalizeHostname(url.hostname);

    if (this.options.blockedHosts?.some((entry) => hostMatches(hostname, entry))) {
      return err(errors.permissionDenied('Host is explicitly blocked', { host: hostname }));
    }

    // An explicit allowlist is authoritative: an operator who names a host has
    // made the decision, including for private addresses.
    const allowlisted =
      this.options.allowedHosts !== undefined &&
      this.options.allowedHosts.some((entry) => hostMatches(hostname, entry));

    if (
      this.options.allowedHosts !== undefined &&
      this.options.allowedHosts.length > 0 &&
      !allowlisted
    ) {
      return err(
        errors.permissionDenied(`Host "${hostname}" is not in the project's allowed hosts.`, {
          host: hostname,
          allowed: this.options.allowedHosts,
        }),
      );
    }

    if (METADATA_HOSTS.includes(hostname)) {
      return err(
        errors.permissionDenied(
          'Cloud instance-metadata endpoints are never reachable through the API executor.',
          { host: hostname },
        ),
      );
    }

    const portVerdict = this.checkPort(url);
    if (!portVerdict.ok) return portVerdict;

    const addresses = await this.resolveAddresses(hostname);
    if (!addresses.ok) return addresses;

    const privateAddress = addresses.value.find((address) => isPrivateAddress(address));
    const isPrivate = privateAddress !== undefined || isPrivateHostname(hostname);

    if (isPrivate && !this.options.allowPrivateNetwork && !allowlisted) {
      return err(
        errors.permissionDenied(
          `"${hostname}" resolves to a private or loopback address (${privateAddress ?? hostname}). Enable the private network in project configuration, or add the host to the allowlist, if this is intended.`,
          { host: hostname, address: privateAddress ?? hostname },
        ),
      );
    }

    if (url.protocol === 'http:' && !isPrivate && !this.options.allowInsecureHttp && !allowlisted) {
      return err(
        errors.permissionDenied(
          'Plaintext HTTP to a public host is refused; credentials would travel unencrypted. Use HTTPS or enable insecure HTTP explicitly.',
          { host: hostname },
        ),
      );
    }

    return ok({ url, hostname, addresses: addresses.value, isPrivate });
  }

  /**
   * Re-validate a redirect target. Called at every hop, and additionally
   * refuses a cross-origin redirect that downgrades the protocol.
   */
  async checkRedirect(from: URL, location: string): Promise<Result<UrlVerdict>> {
    let target: URL;
    try {
      target = new URL(location, from);
    } catch {
      return err(errors.malformedResponse('Redirect Location is not a valid URL', { location }));
    }

    if (from.protocol === 'https:' && target.protocol === 'http:') {
      return err(
        errors.permissionDenied('Refusing a redirect that downgrades HTTPS to HTTP', {
          from: from.origin,
          to: target.origin,
        }),
      );
    }

    return this.check(target.toString());
  }

  private checkPort(url: URL): Result<true> {
    if (url.port === '') return ok(true);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return err(errors.invalidInput('Invalid port', { port: url.port }));
    }
    const allowed = this.options.allowedPorts ?? DEFAULT_DEV_PORTS;
    if (!allowed.includes(port)) {
      return err(
        errors.permissionDenied(
          `Port ${port} is not permitted. Allowed ports: ${allowed.join(', ')}.`,
          { port },
        ),
      );
    }
    return ok(true);
  }

  private async resolveAddresses(hostname: string): Promise<Result<readonly string[]>> {
    // A literal address needs no resolution, and passing it to DNS would be
    // pointless work.
    if (net.isIP(hostname) !== 0) return ok([hostname]);

    if (LOCALHOST_NAMES.includes(hostname)) return ok(['127.0.0.1']);

    try {
      const addresses = await this.resolveHost(hostname);
      if (addresses.length === 0) {
        return err(errors.notFound('Host did not resolve to any address', { host: hostname }));
      }
      return ok(addresses);
    } catch (error) {
      return err(
        errors.notFound(`Could not resolve "${hostname}"`, {
          host: hostname,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

function normalizeHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  // URL keeps IPv6 literals bracketed; strip for address classification.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // A trailing dot is a fully-qualified form of the same name.
  if (host.endsWith('.') && host.length > 1) host = host.slice(0, -1);
  return host;
}

/** Suffix-aware host matching: `.example.com` matches any subdomain. */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = normalizeHostname(hostname);
  const entry = pattern.toLowerCase().trim();
  if (entry === '*') return true;
  if (entry.startsWith('*.')) return host === entry.slice(2) || host.endsWith(entry.slice(1));
  if (entry.startsWith('.')) return host === entry.slice(1) || host.endsWith(entry);
  return host === entry;
}

function isPrivateHostname(hostname: string): boolean {
  if (LOCALHOST_NAMES.includes(hostname)) return true;
  return (
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.home.arpa') ||
    // A single-label name is resolved by internal search domains.
    !hostname.includes('.')
  );
}

/**
 * Classify an IP address as private, loopback, link-local, or otherwise
 * non-routable. Covers the ranges an SSRF payload actually targets, including
 * IPv4-mapped IPv6 forms such as `::ffff:127.0.0.1`.
 */
export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address.toLowerCase());
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // Unparseable: fail closed.
  }
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, includes metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  if (address === '::' || address === '::1') return true;

  // IPv4-mapped and IPv4-compatible forms carry an embedded IPv4 address.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);

  const firstGroup = address.split(':')[0] ?? '';
  const leading = Number.parseInt(firstGroup || '0', 16);

  if ((leading & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((leading & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((leading & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (address.startsWith('fd00:ec2')) return true; // AWS IPv6 metadata
  if (address.startsWith('2001:db8')) return true; // documentation range
  return false;
}
