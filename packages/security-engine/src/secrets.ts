import type { Result } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';

import type { Redactor } from './redaction.js';
import { looksSensitiveKey } from './redaction.js';

/**
 * Secret references and environment filtering (specification section 7).
 *
 * Nothing in this system stores or transports a credential value. What is
 * stored, planned with, written into generated code, and shown in the UI is a
 * *reference* such as `env:PAYMENT_API_KEY`. The value is resolved at the
 * moment of use, handed straight to the HTTP client or the child process, and
 * registered with the redactor so any later appearance in output is scrubbed.
 *
 * This is why a generated API client contains `process.env.PAYMENT_API_KEY`
 * rather than a literal key: the literal never exists anywhere the agent can
 * reach it.
 */

export const SECRET_REFERENCE_PATTERN = /^(env|file|keychain|prompt):([A-Za-z0-9_./-]+)$/;

export type SecretProviderKind = 'env' | 'file' | 'keychain' | 'prompt';

export interface SecretReference {
  readonly kind: SecretProviderKind;
  readonly name: string;
  /** Canonical form, e.g. "env:PAYMENT_API_KEY". */
  readonly raw: string;
}

export function parseSecretReference(raw: string): Result<SecretReference> {
  const match = SECRET_REFERENCE_PATTERN.exec(raw.trim());
  if (!match?.[1] || !match[2]) {
    return err(
      errors.invalidInput(
        `"${raw}" is not a secret reference. Use env:NAME, file:PATH, keychain:NAME, or prompt:NAME.`,
        { value: raw },
      ),
    );
  }
  return ok({
    kind: match[1] as SecretProviderKind,
    name: match[2],
    raw: `${match[1]}:${match[2]}`,
  });
}

/**
 * Guard against a literal credential being passed where a reference belongs.
 * Catches the common mistake of writing the key into configuration.
 */
export function assertNotLiteralSecret(value: string, context: string): Result<true> {
  if (SECRET_REFERENCE_PATTERN.test(value.trim())) return ok(true);
  if (looksLikeCredential(value)) {
    return err(
      errors.invalidInput(
        `${context} appears to contain a literal credential. Supply a secret reference such as env:MY_API_KEY instead.`,
        { context },
      ),
    );
  }
  return ok(true);
}

/** Heuristic: does this string look like a credential rather than a name? */
export function looksLikeCredential(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 16) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^(?:sk|pk|rk)[-_]/i.test(trimmed)) return true;
  if (/^(?:ghp|gho|ghu|ghs|ghr|github_pat)_/.test(trimmed)) return true;
  if (/^xox[abposr]-/.test(trimmed)) return true;
  if (/^AIza[A-Za-z0-9_-]{35}$/.test(trimmed)) return true;
  if (/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(trimmed)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) return true;
  // High-entropy opaque strings of credential length.
  return trimmed.length >= 32 && /^[A-Za-z0-9_\-+/=]{32,}$/.test(trimmed) && hasMixedCase(trimmed);
}

function hasMixedCase(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z0-9]/.test(value);
}

export interface SecretResolverOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Registers every resolved value so later output is redacted. */
  readonly redactor?: Redactor;
  /** Resolvers for the non-environment providers, wired by the server. */
  readonly fileReader?: (path: string) => Promise<string>;
  readonly keychainReader?: (name: string) => Promise<string>;
  readonly prompter?: (name: string) => Promise<string>;
}

/**
 * Resolves references to values at the point of use.
 *
 * Resolved values are cached for the lifetime of the resolver so that a prompt
 * is not repeated, and are never returned in bulk: each call resolves exactly
 * the one reference asked for.
 */
export class SecretResolver {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly redactor: Redactor | undefined;
  private readonly options: SecretResolverOptions;
  private readonly cache = new Map<string, string>();

  constructor(options: SecretResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.redactor = options.redactor;
    this.options = options;
  }

  /** Which references resolved successfully, without exposing their values. */
  get resolvedReferences(): readonly string[] {
    return [...this.cache.keys()];
  }

  async resolve(reference: string | SecretReference): Promise<Result<string>> {
    const parsed = typeof reference === 'string' ? parseSecretReference(reference) : ok(reference);
    if (!parsed.ok) return parsed;
    const ref = parsed.value;

    const cached = this.cache.get(ref.raw);
    if (cached !== undefined) return ok(cached);

    const value = await this.load(ref);
    if (!value.ok) return value;

    if (value.value.length === 0) {
      return err(
        errors.configError(`Secret "${ref.raw}" resolved to an empty value.`, {
          reference: ref.raw,
        }),
      );
    }

    this.cache.set(ref.raw, value.value);
    // Registering here is what makes the value redactable everywhere later,
    // including in output from processes and HTTP responses.
    this.redactor?.registerValue(value.value);
    return ok(value.value);
  }

  private async load(ref: SecretReference): Promise<Result<string>> {
    switch (ref.kind) {
      case 'env': {
        const value = this.env[ref.name];
        if (value === undefined) {
          return err(
            errors.configError(
              `Environment variable "${ref.name}" is not set. Set it in your shell or in the project's .env file; the agent never stores credential values.`,
              { reference: ref.raw },
            ),
          );
        }
        return ok(value);
      }
      case 'file': {
        if (!this.options.fileReader) {
          return err(errors.unsupported('No file secret provider is configured.'));
        }
        try {
          return ok((await this.options.fileReader(ref.name)).trim());
        } catch (error) {
          return err(
            errors.configError(`Could not read secret file "${ref.name}"`, {
              cause: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      case 'keychain': {
        if (!this.options.keychainReader) {
          return err(errors.unsupported('No keychain secret provider is configured.'));
        }
        try {
          return ok(await this.options.keychainReader(ref.name));
        } catch (error) {
          return err(
            errors.configError(`Could not read "${ref.name}" from secure storage`, {
              cause: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      case 'prompt': {
        if (!this.options.prompter) {
          return err(errors.unsupported('No interactive secret prompt is available.'));
        }
        try {
          return ok(await this.options.prompter(ref.name));
        } catch (error) {
          return err(
            errors.configError(`Secret "${ref.name}" was not supplied`, {
              cause: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      default:
        return err(errors.unsupported(`Unknown secret provider "${ref.kind as string}"`));
    }
  }
}

/**
 * Build the environment for a child process (specification section 35).
 *
 * Inheriting the parent environment wholesale would hand every credential the
 * developer happens to have exported to any command the agent runs. Instead the
 * child receives a minimal base, plus explicitly named passthrough variables,
 * plus explicitly injected values.
 */
export interface EnvFilterOptions {
  readonly source?: Readonly<Record<string, string | undefined>>;
  /** Variables the child genuinely needs, named explicitly. */
  readonly passthrough?: readonly string[];
  /** Values injected for this command only. */
  readonly inject?: Readonly<Record<string, string>>;
  /** Add the platform's PATH and locale essentials. Default true. */
  readonly includeEssentials?: boolean;
}

/**
 * Variables a build or test command needs in order to function at all.
 * PATH is essential; anything credential-shaped is not on this list.
 */
const ESSENTIAL_VARS: readonly string[] = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SHELL',
  'COMSPEC',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
];

export function buildChildEnv(options: EnvFilterOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const out: Record<string, string> = {};

  if (options.includeEssentials !== false) {
    for (const name of ESSENTIAL_VARS) {
      const value = source[name];
      if (value !== undefined) out[name] = value;
    }
  }

  for (const name of options.passthrough ?? []) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }

  for (const [name, value] of Object.entries(options.inject ?? {})) {
    out[name] = value;
  }

  return out;
}

/**
 * Report which environment variables look credential-shaped, by name only.
 * Used to tell the user what the agent is deliberately not passing through,
 * and to seed the redactor.
 */
export function listSensitiveEnvNames(
  source: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  return Object.keys(source)
    .filter((name) => looksSensitiveKey(name))
    .sort();
}
