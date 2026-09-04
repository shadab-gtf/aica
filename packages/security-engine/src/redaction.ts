/**
 * Secret redaction (specification sections 7 and 65).
 *
 * This is the last line of defense, not the only one. Secrets are also kept out
 * of prompt context and out of source by design; redaction exists because a
 * credential can still arrive incidentally, inside a command's stderr, an HTTP
 * error body, or a file the agent read.
 *
 * Two complementary mechanisms:
 *
 * 1. Pattern redaction catches credential *shapes* (provider key formats, JWTs,
 *    PEM blocks, `Authorization` headers, cookies, assignment-shaped secrets).
 * 2. Known-value redaction catches the exact strings the process actually holds
 *    (resolved environment secrets). This is the reliable half: a key with no
 *    recognisable prefix is invisible to patterns but not to this.
 *
 * Redaction is applied structurally, so a secret nested in an object, an array,
 * a Map, or an Error message is caught rather than only top-level strings.
 */

export const REDACTED = '[REDACTED]';

/** Header and field names whose values are replaced wholesale, never matched. */
const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|proxy-authorization|www-authenticate|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-amz-security-token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|secret|client[-_]?secret|private[-_]?key|password|passwd|pwd|passphrase|credential|credentials|session[-_]?token|signature|sig)$/i;

type Replacer = (match: string, ...groups: (string | undefined)[]) => string;

interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Replacement string (may reference capture groups) or a replacer function. */
  readonly replacement: string | Replacer;
}

/**
 * Ordered pattern rules. Order matters: structured forms (headers, assignments)
 * run before bare-token forms so that the surrounding context is preserved in
 * the output, which keeps redacted logs readable.
 */
const RULES: readonly RedactionRule[] = [
  // PEM private key blocks, including the body.
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replacement: `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  },
  // Authorization-style headers in raw text (curl output, logs, HAR dumps).
  //
  // A header value legitimately contains spaces ("Bearer <token>"), so an
  // unquoted value is consumed to the end of the line. Stopping at whitespace
  // would leave the credential itself in place and redact only the scheme.
  // A quoted value is consumed to its closing quote instead, so that an inline
  // JSON object keeps its remaining fields intact.
  {
    name: 'authorization-header',
    pattern: new RegExp(
      String.raw`\b(authorization|proxy-authorization|www-authenticate|x-api-key|x-auth-token|x-access-token|x-amz-security-token|cookie|set-cookie)(["']?\s*[:=]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\n\r]+))`,
      'gi',
    ),
    replacement: (_match, name, separator, doubleQuoted, singleQuoted) => {
      if (doubleQuoted !== undefined) return `${name}${separator}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${name}${separator}'${REDACTED}'`;
      return `${name}${separator}${REDACTED}`;
    },
  },
  // Bearer / Basic credentials wherever they appear.
  {
    name: 'auth-scheme',
    pattern: /\b(Bearer|Basic|Digest|HMAC|AWS4-HMAC-SHA256 Credential)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: `$1 ${REDACTED}`,
  },
  // JWTs: three base64url segments. Matched before generic assignments so the
  // whole token is replaced rather than half of it.
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replacement: REDACTED,
  },
  // Well-known provider key formats.
  {
    name: 'openai-style-key',
    pattern: /\bsk-(?:proj-|live-|test-|ant-|or-v1-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'stripe-key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'sendgrid-key',
    pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
    replacement: REDACTED,
  },
  // Assignment-shaped secrets: KEY=value, "key": "value", key: value.
  // The value must look like a credential (length and character class) to keep
  // this from redacting ordinary configuration.
  {
    name: 'secret-assignment',
    pattern: new RegExp(
      String.raw`(["'\w[\]-]*(?:secret|token|password|passwd|pwd|passphrase|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|credential|auth)["'\s]*)(\s*[:=]\s*)(["']?)([A-Za-z0-9_\-./+=~]{8,})\3`,
      'gi',
    ),
    replacement: `$1$2$3${REDACTED}$3`,
  },
  // Credentials embedded in a URL userinfo section.
  {
    name: 'url-userinfo',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replacement: `$1$2:${REDACTED}@`,
  },
];

export interface RedactorOptions {
  /**
   * Exact secret values to remove wherever they appear. Values shorter than
   * `minKnownValueLength` are ignored, because redacting a short string such as
   * "dev" would corrupt unrelated output.
   */
  readonly knownValues?: Iterable<string>;
  readonly minKnownValueLength?: number;
  /** Additional project-specific patterns. */
  readonly extraPatterns?: readonly RegExp[];
  /** Maximum depth walked when redacting nested structures. */
  readonly maxDepth?: number;
}

/**
 * Applies redaction to strings and to arbitrary structures.
 *
 * A single instance is created at startup and shared, so that secrets
 * registered at any point (for example after an OAuth exchange) are redacted
 * everywhere from then on.
 */
export class Redactor {
  private readonly knownValues = new Set<string>();
  private readonly extraPatterns: readonly RegExp[];
  private readonly minKnownValueLength: number;
  private readonly maxDepth: number;

  constructor(options: RedactorOptions = {}) {
    this.minKnownValueLength = options.minKnownValueLength ?? 6;
    this.extraPatterns = options.extraPatterns ?? [];
    this.maxDepth = options.maxDepth ?? 12;
    for (const value of options.knownValues ?? []) this.registerValue(value);
  }

  /**
   * Register a literal secret value. Call this whenever a credential is
   * resolved, so later output containing it is scrubbed even though its format
   * is unrecognisable.
   */
  registerValue(value: string | undefined | null): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length < this.minKnownValueLength) return;
    this.knownValues.add(trimmed);
  }

  /**
   * Register every value from an environment-like object whose key looks
   * sensitive. This is how the process's own credentials become known values.
   */
  registerEnvSecrets(env: Readonly<Record<string, string | undefined>>): void {
    for (const [key, value] of Object.entries(env)) {
      if (looksSensitiveKey(key)) this.registerValue(value);
    }
  }

  get knownValueCount(): number {
    return this.knownValues.size;
  }

  /** Redact a string. */
  text(input: string): string {
    let output = input;

    // Known values first: they are exact and must win over partial patterns.
    for (const secret of this.knownValues) {
      if (output.includes(secret)) output = output.split(secret).join(REDACTED);
    }

    for (const rule of RULES) {
      // A fresh RegExp per call keeps `lastIndex` from leaking between calls on
      // these module-level global patterns.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      output =
        typeof rule.replacement === 'string'
          ? output.replace(pattern, rule.replacement)
          : output.replace(pattern, rule.replacement as (...args: string[]) => string);
    }

    for (const pattern of this.extraPatterns) {
      output = output.replace(new RegExp(pattern.source, ensureGlobal(pattern.flags)), REDACTED);
    }

    return output;
  }

  /**
   * Redact any value structurally. Objects and arrays are rebuilt rather than
   * mutated, so callers keep their original data. Keys that look sensitive have
   * their values replaced outright without pattern matching.
   */
  value<T>(input: T): T {
    return this.walk(input, 0) as T;
  }

  /** Bound sanitizer suitable for the logger and the event emitter. */
  readonly sanitize = <T>(input: T): T => this.value(input);

  private walk(input: unknown, depth: number): unknown {
    if (depth > this.maxDepth) return '[depth-limit]';

    if (typeof input === 'string') return this.text(input);
    if (input === null || input === undefined) return input;
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
      return input;
    }

    if (input instanceof Error) {
      // Errors are common carriers of leaked credentials in their message.
      const clone = new Error(this.text(input.message));
      clone.name = input.name;
      if (input.stack) clone.stack = this.text(input.stack);
      return clone;
    }

    if (Array.isArray(input)) return input.map((item) => this.walk(item, depth + 1));

    if (input instanceof Map) {
      return new Map(
        [...input.entries()].map(([key, value]) => [
          key,
          looksSensitiveKey(String(key)) ? REDACTED : this.walk(value, depth + 1),
        ]),
      );
    }

    if (input instanceof Set) {
      return new Set([...input].map((item) => this.walk(item, depth + 1)));
    }

    if (input instanceof Date || input instanceof RegExp) return input;

    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        out[key] = looksSensitiveKey(key) ? REDACTED : this.walk(value, depth + 1);
      }
      return out;
    }

    return input;
  }
}

/** True when a header, field, or environment variable name implies a secret. */
export function looksSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  const normalized = key.toLowerCase();
  return (
    /(?:^|[_.-])(?:secret|token|password|passwd|passphrase|credential|apikey|api_key|privatekey|private_key)(?:$|[_.-])/.test(
      normalized,
    ) ||
    normalized.endsWith('_secret') ||
    normalized.endsWith('_token') ||
    normalized.endsWith('_key') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('password')
  );
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

/** A shared redactor seeded from the current environment. */
export function createRedactor(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: RedactorOptions = {},
): Redactor {
  const redactor = new Redactor(options);
  redactor.registerEnvSecrets(env);
  return redactor;
}
