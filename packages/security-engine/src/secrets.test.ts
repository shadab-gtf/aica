import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, isErr, isOk, unwrap } from '@aica/shared';

import { Redactor } from './redaction.js';
import {
  SecretResolver,
  assertNotLiteralSecret,
  buildChildEnv,
  listSensitiveEnvNames,
  looksLikeCredential,
  parseSecretReference,
} from './secrets.js';

describe('secret references', () => {
  it('parses each supported provider', () => {
    expect(unwrap(parseSecretReference('env:PAYMENT_API_KEY'))).toMatchObject({
      kind: 'env',
      name: 'PAYMENT_API_KEY',
      raw: 'env:PAYMENT_API_KEY',
    });
    expect(unwrap(parseSecretReference('file:./secrets/token')).kind).toBe('file');
    expect(unwrap(parseSecretReference('keychain:stripe')).kind).toBe('keychain');
    expect(unwrap(parseSecretReference('prompt:otp')).kind).toBe('prompt');
  });

  it('rejects something that is not a reference, and says what to use', () => {
    const result = parseSecretReference('sk_live_51H8xQ2abcdefghijk');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
    expect(isErr(result) && result.error.message).toMatch(/env:NAME/);
  });

  it('catches a literal credential passed where a reference belongs', () => {
    const result = assertNotLiteralSecret('ghp_abcdefghijklmnopqrstuvwxyz0123', 'auth.apiKey');
    expect(isErr(result) && result.error.message).toMatch(/secret reference/i);
  });

  it('accepts a reference and accepts ordinary values', () => {
    expect(isOk(assertNotLiteralSecret('env:PAYMENT_API_KEY', 'auth.apiKey'))).toBe(true);
    expect(isOk(assertNotLiteralSecret('https://api.example.com', 'baseUrl'))).toBe(true);
    expect(isOk(assertNotLiteralSecret('X-Api-Key', 'auth.headerName'))).toBe(true);
  });
});

describe('looksLikeCredential', () => {
  it.each([
    'sk_live_51H8xQ2abcdefghijklmno',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'xoxb-1234567890-abcdefghij',
    'AIzaSyD1abcdefghijklmnopqrstuvwxyz01234',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    'aB3xY9zQ7mN2pL5kR8wT1vC4nH6jF0dG',
  ])('flags %s', (value) => {
    expect(looksLikeCredential(value)).toBe(true);
  });

  it.each([
    'short',
    'PAYMENT_API_KEY',
    'https://api.example.com/v1/payments',
    'a normal sentence of text',
    'application/json',
  ])('does not flag %s', (value) => {
    expect(looksLikeCredential(value)).toBe(false);
  });
});

describe('SecretResolver', () => {
  it('resolves from the environment', async () => {
    const resolver = new SecretResolver({ env: { PAYMENT_API_KEY: 'value-from-env' } });
    expect(unwrap(await resolver.resolve('env:PAYMENT_API_KEY'))).toBe('value-from-env');
  });

  it('explains what to do when the variable is unset', async () => {
    const resolver = new SecretResolver({ env: {} });
    const result = await resolver.resolve('env:MISSING_KEY');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.CONFIG_ERROR);
    expect(isErr(result) && result.error.message).toMatch(/never stores credential values/i);
  });

  it('rejects an empty value rather than sending an empty credential', async () => {
    const resolver = new SecretResolver({ env: { EMPTY_KEY: '' } });
    expect(isErr(await resolver.resolve('env:EMPTY_KEY'))).toBe(true);
  });

  it('registers the resolved value with the redactor, so later output is scrubbed', async () => {
    const redactor = new Redactor();
    const resolver = new SecretResolver({
      env: { OPAQUE_TOKEN: 'nondescriptvalue123' },
      redactor,
    });

    // Before resolution the value is invisible to pattern rules.
    expect(redactor.text('saw nondescriptvalue123')).toContain('nondescriptvalue123');

    await resolver.resolve('env:OPAQUE_TOKEN');

    expect(redactor.text('saw nondescriptvalue123')).not.toContain('nondescriptvalue123');
  });

  it('caches so an interactive prompt is asked only once', async () => {
    const prompter = vi.fn(async () => 'typed-value');
    const resolver = new SecretResolver({ prompter });
    await resolver.resolve('prompt:otp');
    await resolver.resolve('prompt:otp');
    expect(prompter).toHaveBeenCalledTimes(1);
  });

  it('reports which references resolved, never their values', async () => {
    const resolver = new SecretResolver({ env: { A_TOKEN: 'aaaaaaaaaa' } });
    await resolver.resolve('env:A_TOKEN');
    expect(resolver.resolvedReferences).toEqual(['env:A_TOKEN']);
    expect(JSON.stringify(resolver.resolvedReferences)).not.toContain('aaaaaaaaaa');
  });

  it('reports an unconfigured provider rather than failing obscurely', async () => {
    const resolver = new SecretResolver({ env: {} });
    const result = await resolver.resolve('keychain:stripe');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.UNSUPPORTED);
  });

  it('surfaces a file provider failure as a configuration error', async () => {
    const resolver = new SecretResolver({
      fileReader: async () => {
        throw new Error('ENOENT');
      },
    });
    const result = await resolver.resolve('file:./missing');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.CONFIG_ERROR);
  });
});

describe('buildChildEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    NODE_ENV: 'test',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    STRIPE_API_KEY: 'must-not-leak',
    DATABASE_URL: 'postgres://user:pw@host/db',
    RANDOM_VAR: 'also-not-inherited',
  };

  it('does not inherit the parent environment wholesale', () => {
    const env = buildChildEnv({ source });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.STRIPE_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it('includes what a build actually needs', () => {
    const env = buildChildEnv({ source });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.NODE_ENV).toBe('test');
  });

  it('passes through only explicitly named variables', () => {
    const env = buildChildEnv({ source, passthrough: ['DATABASE_URL'] });
    expect(env.DATABASE_URL).toBe('postgres://user:pw@host/db');
    expect(env.STRIPE_API_KEY).toBeUndefined();
  });

  it('injects per-command values', () => {
    const env = buildChildEnv({ source, inject: { CI: '1', FORCE_COLOR: '0' } });
    expect(env.CI).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
  });

  it('can omit the essentials entirely for a fully isolated child', () => {
    const env = buildChildEnv({ source, includeEssentials: false, inject: { ONLY: 'this' } });
    expect(env).toEqual({ ONLY: 'this' });
  });
});

describe('listSensitiveEnvNames', () => {
  it('names credential-shaped variables without exposing values', () => {
    const names = listSensitiveEnvNames({
      STRIPE_API_KEY: 'secret',
      DB_PASSWORD: 'secret',
      PORT: '3000',
      PUBLIC_URL: 'https://example.com',
    });
    expect(names).toEqual(['DB_PASSWORD', 'STRIPE_API_KEY']);
  });
});
