import { describe, expect, it } from 'vitest';

import { REDACTED, Redactor, createRedactor, looksSensitiveKey } from './redaction.js';

describe('Redactor pattern rules', () => {
  const redactor = new Redactor();

  it('redacts an Authorization header without destroying the surrounding text', () => {
    const out = redactor.text(
      'GET /v1/payments\nAuthorization: Bearer abcdef1234567890\nAccept: */*',
    );
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('Authorization:');
    expect(out).toContain('Accept: */*');
  });

  it('redacts a bare bearer token', () => {
    expect(redactor.text('Bearer sometokenvalue12345')).toBe(`Bearer ${REDACTED}`);
  });

  it('redacts a JWT in full, all three segments', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redactor.text(`token=${jwt}`);
    expect(out).not.toContain('eyJhbGci');
    expect(out).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it.each([
    ['openai style', 'sk-proj-abcdefghijklmnopqrstuvwx'],
    ['stripe live', 'sk_live_51H8xQ2abcdefghijklmno'],
    ['github pat', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['slack bot', 'xoxb-1234567890-abcdefghij'],
    ['google api', 'AIzaSyD-abcdefghijklmnopqrstuvwxyz01234'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['sendgrid', 'SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwx'],
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('redacts a %s key', (_label, secret) => {
    const out = redactor.text(`the value is ${secret} ok`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('redacts a PEM private key block including its body', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0ZtP5nQ1234567890abcdefgh',
      'ijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactor.text(`key:\n${pem}\ndone`);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA');
    expect(out).toContain('done');
  });

  it('redacts assignment-shaped secrets in several syntaxes', () => {
    const out = redactor.text(
      [
        'PAYMENT_API_KEY=zq83hf83hf83hf83',
        '"clientSecret": "abcd1234efgh5678"',
        'password: correcthorsebattery',
      ].join('\n'),
    );
    expect(out).not.toContain('zq83hf83hf83hf83');
    expect(out).not.toContain('abcd1234efgh5678');
    expect(out).not.toContain('correcthorsebattery');
  });

  it('redacts credentials in a URL userinfo section but keeps the host', () => {
    const out = redactor.text('postgres://admin:supersecretpassword@db.example.com:5432/app');
    expect(out).not.toContain('supersecretpassword');
    expect(out).toContain('db.example.com:5432/app');
  });

  it('leaves ordinary configuration alone', () => {
    const text = 'PORT=3000\nNODE_ENV=production\nbaseUrl: https://api.example.com/v1';
    expect(redactor.text(text)).toBe(text);
  });
});

describe('Redactor known values', () => {
  it('redacts a credential with no recognisable format once registered', () => {
    const redactor = new Redactor();
    const opaque = 'plainlowercasenoformat';
    expect(redactor.text(opaque)).toBe(opaque);

    redactor.registerValue(opaque);
    expect(redactor.text(`value=${opaque}`)).not.toContain(opaque);
  });

  it('registers every occurrence, not just the first', () => {
    const redactor = new Redactor();
    redactor.registerValue('repeatedsecretvalue');
    const out = redactor.text('a repeatedsecretvalue b repeatedsecretvalue c');
    expect(out).not.toContain('repeatedsecretvalue');
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('ignores values too short to redact safely', () => {
    const redactor = new Redactor();
    redactor.registerValue('dev');
    expect(redactor.text('the dev server')).toBe('the dev server');
    expect(redactor.knownValueCount).toBe(0);
  });

  it('harvests sensitive values from an environment object', () => {
    const redactor = createRedactor({
      PAYMENT_API_KEY: 'envsourcedsecretvalue',
      PORT: '3000',
      PUBLIC_URL: 'https://example.com',
    });
    expect(redactor.text('using envsourcedsecretvalue now')).not.toContain('envsourcedsecretvalue');
    // Non-sensitive names are not harvested, so ordinary config still renders.
    expect(redactor.text('port 3000')).toBe('port 3000');
  });
});

describe('Redactor structural walking', () => {
  const redactor = new Redactor({ knownValues: ['deepsecretvalue'] });

  it('redacts nested objects and arrays', () => {
    const out = redactor.value({
      request: {
        headers: { Authorization: 'Bearer abcdefghijklmnop', accept: 'application/json' },
        items: [{ note: 'contains deepsecretvalue here' }],
      },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(serialized).not.toContain('deepsecretvalue');
    expect(serialized).toContain('application/json');
  });

  it('replaces values under sensitive keys outright', () => {
    const out = redactor.value({ apiKey: 'x', password: 'y', cookie: 'z', port: 3000 }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out.port).toBe(3000);
  });

  it('does not mutate the object it was given', () => {
    const original = { token: 'literalvalue' };
    redactor.value(original);
    expect(original.token).toBe('literalvalue');
  });

  it('redacts an Error message and stack', () => {
    const error = new Error('failed with Bearer abcdefghijklmnop');
    const out = redactor.value(error) as Error;
    expect(out.message).not.toContain('abcdefghijklmnop');
    expect(out.name).toBe('Error');
  });

  it('redacts Map values under sensitive keys and walks Sets', () => {
    const out = redactor.value({
      map: new Map([
        ['authorization', 'Bearer abcdefghijklmnop'],
        ['accept', 'application/json'],
      ]),
      set: new Set(['deepsecretvalue', 'safe']),
    }) as { map: Map<string, unknown>; set: Set<unknown> };
    expect(out.map.get('authorization')).toBe(REDACTED);
    expect(out.map.get('accept')).toBe('application/json');
    expect([...out.set]).toContain('safe');
    expect([...out.set]).not.toContain('deepsecretvalue');
  });

  it('terminates on a cyclic structure via the depth limit', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => redactor.value(cyclic)).not.toThrow();
  });

  it('preserves primitives and dates', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const out = redactor.value({ n: 1, b: true, nul: null, u: undefined, date }) as Record<
      string,
      unknown
    >;
    expect(out.n).toBe(1);
    expect(out.b).toBe(true);
    expect(out.nul).toBeNull();
    expect(out.date).toBe(date);
  });
});

describe('looksSensitiveKey', () => {
  it.each([
    'Authorization',
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'apiKey',
    'api_key',
    'accessToken',
    'refresh_token',
    'clientSecret',
    'PAYMENT_API_KEY',
    'DB_PASSWORD',
    'privateKey',
  ])('treats %s as sensitive', (key) => {
    expect(looksSensitiveKey(key)).toBe(true);
  });

  it.each(['accept', 'content-type', 'port', 'baseUrl', 'keyboard', 'monkey', 'userId'])(
    'treats %s as not sensitive',
    (key) => {
      expect(looksSensitiveKey(key)).toBe(false);
    },
  );
});
