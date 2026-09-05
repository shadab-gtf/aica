import { ParseWarningCode, successResponse } from '@aica/api-ir';
import type { ApiSpec, ObjectSchema } from '@aica/api-ir';
import { ErrorCode, isErr, unwrap } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import { parseCurl, parseCurlCommand, tokenizeCommand } from './curl.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop';
const API_KEY = 'aB3xY9zQ7mN2pL5kR8wT1vC4nH6jF0dG';

function spec(command: string): ApiSpec {
  return unwrap(parseCurl(command));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(unwrap(tokenizeCommand('curl -X POST https://x.test/y'))).toEqual([
      'curl',
      '-X',
      'POST',
      'https://x.test/y',
    ]);
  });

  it('keeps a single-quoted argument intact, including spaces and double quotes', () => {
    expect(unwrap(tokenizeCommand(`curl -d '{"a": 1, "b": "two"}'`))).toEqual([
      'curl',
      '-d',
      '{"a": 1, "b": "two"}',
    ]);
  });

  it('applies shell escaping rules inside double quotes only where the shell would', () => {
    expect(unwrap(tokenizeCommand('curl -H "X: \\"quoted\\"" -d "a\\\\b" -d "c\\nd"'))).toEqual([
      'curl',
      '-H',
      'X: "quoted"',
      '-d',
      'a\\b',
      '-d',
      'c\\nd',
    ]);
  });

  it('joins backslash and caret line continuations', () => {
    const command = 'curl https://x.test/y \\\n  -H "A: 1" ^\n  -H "B: 2"';
    expect(unwrap(tokenizeCommand(command))).toEqual([
      'curl',
      'https://x.test/y',
      '-H',
      'A: 1',
      '-H',
      'B: 2',
    ]);
  });

  it('preserves an empty quoted argument', () => {
    expect(unwrap(tokenizeCommand(`curl -d ''`))).toEqual(['curl', '-d', '']);
  });

  it('refuses to guess at an unterminated quote', () => {
    expect(isErr(tokenizeCommand(`curl -d 'unterminated`))).toBe(true);
    expect(isErr(tokenizeCommand('curl -d "unterminated'))).toBe(true);
    expect(isErr(tokenizeCommand('curl -d x\\'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

describe('parseCurlCommand', () => {
  it('rejects a command that is not curl', () => {
    const result = parseCurlCommand('wget https://x.test');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
    expect(isErr(result) && result.error.message).toMatch(/not a curl command/i);
  });

  it('rejects a command with no URL', () => {
    expect(isErr(parseCurlCommand('curl -X POST'))).toBe(true);
  });

  it('defaults the method the way curl does', () => {
    expect(unwrap(parseCurlCommand('curl https://x.test/y')).method).toBe('GET');
    expect(unwrap(parseCurlCommand(`curl https://x.test/y -d 'a=1'`)).method).toBe('POST');
    expect(unwrap(parseCurlCommand('curl -I https://x.test/y')).method).toBe('HEAD');
    expect(unwrap(parseCurlCommand('curl -X PATCH https://x.test/y')).method).toBe('PATCH');
  });

  it('assumes http when the scheme is missing, as curl does', () => {
    expect(unwrap(parseCurlCommand('curl api.test/v1/users')).url.href).toBe(
      'http://api.test/v1/users',
    );
  });

  it('accepts --flag=value as well as --flag value', () => {
    const request = unwrap(parseCurlCommand('curl --request=DELETE --url=https://x.test/y'));
    expect(request.method).toBe('DELETE');
    expect(request.url.pathname).toBe('/y');
  });

  it('concatenates repeated data flags', () => {
    expect(unwrap(parseCurlCommand(`curl https://x.test/y -d 'a=1' -d 'b=2'`)).body).toBe(
      'a=1&b=2',
    );
  });

  it('moves data onto the query string for -G', () => {
    const request = unwrap(parseCurlCommand(`curl -G https://x.test/y -d 'a=1' -d 'b=2'`));
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    expect(request.url.search).toBe('?a=1&b=2');
  });

  it('does not swallow the URL after an unrecognized value-taking flag', () => {
    expect(unwrap(parseCurlCommand('curl --max-time 30 https://x.test/y')).url.pathname).toBe('/y');
  });

  it('reports a body read from a file rather than reading it', () => {
    const request = unwrap(parseCurlCommand('curl https://x.test/y -d @payload.json'));
    expect(request.body).toBeUndefined();
    expect(request.warnings[0]?.message).toMatch(/payload\.json/);
  });

  it('reports shell substitution that was not evaluated', () => {
    const request = unwrap(
      parseCurlCommand('curl https://x.test/y -H "Authorization: Bearer $(get-token)"'),
    );
    expect(request.warnings.map((warning) => warning.code)).toContain(
      ParseWarningCode.MALFORMED_ENTRY,
    );
  });

  it('records that -u was used without keeping the credential', () => {
    const request = unwrap(parseCurlCommand('curl -u alice:hunter2 https://x.test/y'));
    expect(request.hasBasicAuth).toBe(true);
    expect(JSON.stringify(request)).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------
// Lowering into the IR
// ---------------------------------------------------------------------------

describe('parseCurl', () => {
  it('produces one endpoint with the observed method and path', () => {
    const parsed = spec('curl https://api.test/v1/users/42');
    expect(parsed.endpoints).toHaveLength(1);
    expect(parsed.endpoints[0]).toMatchObject({
      id: 'GET /v1/users/42',
      method: 'GET',
      path: '/v1/users/42',
    });
    expect(parsed.servers).toEqual([{ url: 'https://api.test', variables: [] }]);
    expect(parsed.source).toEqual({ format: 'curl', location: 'pasted cURL command' });
  });

  it('does not invent a path template from concrete values', () => {
    // `/users/42` is what was observed; guessing `/users/{id}` would be a claim
    // the command does not support.
    expect(spec('curl https://api.test/v1/users/42').endpoints[0]?.path).toBe('/v1/users/42');
  });

  it('records that the response shape is unknown', () => {
    const parsed = spec('curl https://api.test/v1/users');
    expect(parsed.endpoints[0]?.responses).toEqual([]);
    expect(successResponse(parsed.endpoints[0] as never)).toBeUndefined();
    expect(
      parsed.warnings.some((warning) => warning.message.includes('records a request only')),
    ).toBe(true);
  });

  it('turns query parameters into parameters with observed examples', () => {
    const parsed = spec(`curl 'https://api.test/v1/users?limit=10&status=active'`);
    const parameters = parsed.endpoints[0]?.parameters ?? [];
    // `10` arrived as the string "10". Typing it as an integer would be a guess
    // about the API's intent, not an observation about the request.
    expect(parameters.find((parameter) => parameter.name === 'limit')).toMatchObject({
      in: 'query',
      required: false,
      schema: { kind: 'string', example: '10' },
    });
    expect(parameters.find((parameter) => parameter.name === 'status')?.schema).toMatchObject({
      kind: 'string',
      example: 'active',
    });
  });

  it('keeps ordinary headers as parameters and drops structural ones', () => {
    const parsed = spec(
      `curl https://api.test/v1/users -H 'Accept: application/json' -H 'X-Tenant: acme' -H 'User-Agent: curl/8'`,
    );
    const names = (parsed.endpoints[0]?.parameters ?? []).map((parameter) => parameter.name);
    expect(names).toContain('X-Tenant');
    expect(names).toContain('Accept');
    expect(names).not.toContain('User-Agent');
  });
});

describe('credential handling', () => {
  it('records a bearer token as a scheme and keeps the token out of the IR', () => {
    const parsed = spec(`curl https://api.test/v1/users -H 'Authorization: Bearer ${JWT}'`);

    expect(parsed.authSchemes).toEqual([{ id: 'bearer', kind: 'jwt', bearerFormat: 'JWT' }]);
    expect(parsed.endpoints[0]?.security).toEqual([[{ schemeId: 'bearer', scopes: [] }]]);
    expect(JSON.stringify(parsed)).not.toContain(JWT);
    expect(
      parsed.warnings.find((warning) => warning.code === ParseWarningCode.LITERAL_CREDENTIAL)
        ?.message,
    ).toMatch(/env:API_TOKEN/);
  });

  it('distinguishes an opaque bearer token from a JWT', () => {
    const parsed = spec(`curl https://api.test/v1/users -H 'Authorization: Bearer ${API_KEY}'`);
    expect(parsed.authSchemes[0]).toEqual({ id: 'bearer', kind: 'bearer' });
  });

  it('names the environment variable to set for an API key header', () => {
    const parsed = spec(`curl https://api.test/v1/users -H 'X-Api-Key: ${API_KEY}'`);

    expect(parsed.authSchemes).toEqual([
      { id: 'x-api-key', kind: 'apiKey', in: 'header', name: 'X-Api-Key' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(API_KEY);
    expect(parsed.warnings.some((warning) => warning.message.includes('env:X_API_KEY'))).toBe(true);
  });

  it('handles a credential in the query string without keeping its value', () => {
    const parsed = spec(`curl 'https://api.test/v1/users?api_key=${API_KEY}&limit=5'`);

    expect(parsed.authSchemes).toEqual([
      { id: 'api_key', kind: 'apiKey', in: 'query', name: 'api_key' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(API_KEY);

    const parameter = parsed.endpoints[0]?.parameters.find((entry) => entry.name === 'api_key');
    expect(parameter?.schema).toEqual({ kind: 'string' });
    expect(parameter?.description).toMatch(/discarded/);
  });

  it('records basic credentials from -u without keeping them', () => {
    const parsed = spec('curl -u alice:hunter2 https://api.test/v1/users');
    expect(parsed.authSchemes).toEqual([{ id: 'basic', kind: 'basic' }]);
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
  });

  it('does not double-count one credential given two ways', () => {
    const parsed = spec(
      `curl -u alice:hunter2 -H 'Authorization: Basic YWxpY2U6aHVudGVyMg==' https://api.test/v1/x`,
    );
    expect(parsed.authSchemes).toEqual([{ id: 'basic', kind: 'basic' }]);
    expect(parsed.endpoints[0]?.security).toEqual([[{ schemeId: 'basic', scopes: [] }]]);
  });

  it('treats an unrecognized Authorization scheme as custom rather than guessing', () => {
    const parsed = spec(`curl https://api.test/v1/x -H 'Authorization: Signature ${API_KEY}'`);
    expect(parsed.authSchemes[0]).toMatchObject({
      id: 'authorization',
      kind: 'custom',
      headerNames: ['Authorization'],
    });
    expect(JSON.stringify(parsed)).not.toContain(API_KEY);
  });

  it('records a cookie without its value', () => {
    const parsed = spec(`curl https://api.test/v1/x -b 'session=${API_KEY}'`);
    expect(parsed.authSchemes[0]).toEqual({ id: 'cookie', kind: 'cookie', name: 'session' });
    expect(JSON.stringify(parsed)).not.toContain(API_KEY);
  });

  it('warns that certificate verification was disabled but does not adopt it', () => {
    const parsed = spec('curl -k https://api.test/v1/x');
    expect(
      parsed.warnings.some((warning) => warning.message.includes('will verify certificates')),
    ).toBe(true);
  });
});

describe('request bodies', () => {
  it('infers a schema from a JSON body', () => {
    const parsed = spec(
      `curl -X POST https://api.test/v1/orders -H 'Content-Type: application/json' ` +
        `-d '{"amount":1250,"currency":"usd","note":null,"items":[{"sku":"A1","qty":2}]}'`,
    );

    const body = parsed.endpoints[0]?.requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content[0]?.mediaType).toBe('application/json');

    const schema = body?.content[0]?.schema as ObjectSchema;
    expect(schema.properties.map((property) => property.name)).toEqual([
      'amount',
      'currency',
      'note',
      'items',
    ]);
    expect(schema.properties[0]?.schema).toMatchObject({ kind: 'integer', example: 1250 });
    expect(schema.properties[2]?.schema).toMatchObject({ kind: 'unknown', nullable: true });
  });

  it('parses a form-encoded body into fields', () => {
    const parsed = spec(`curl -X POST https://api.test/v1/login -d 'user=alice&remember=true'`);
    const body = parsed.endpoints[0]?.requestBody;
    expect(body?.content[0]?.mediaType).toBe('application/x-www-form-urlencoded');
    expect((body?.content[0]?.schema as ObjectSchema).properties.map((p) => p.name)).toEqual([
      'user',
      'remember',
    ]);
  });

  it('collects -F fields as a multipart body', () => {
    const parsed = spec(
      `curl -X POST https://api.test/v1/upload -F 'file=@photo.png' -F 'caption=hello'`,
    );
    const content = parsed.endpoints[0]?.requestBody?.content[0];
    expect(content?.mediaType).toBe('multipart/form-data');
    expect((content?.schema as ObjectSchema).properties.map((property) => property.name)).toEqual([
      'file',
      'caption',
    ]);
  });

  it('records an opaque body as unknown rather than mis-parsing it', () => {
    const parsed = spec(
      `curl -X POST https://api.test/v1/x -H 'Content-Type: application/xml' -d '<order id="1"/>'`,
    );
    const content = parsed.endpoints[0]?.requestBody?.content[0];
    expect(content?.mediaType).toBe('application/xml');
    expect(content?.schema).toMatchObject({ kind: 'unknown' });
  });

  it('applies the --json shorthand', () => {
    const parsed = spec(`curl https://api.test/v1/x --json '{"a":1}'`);
    expect(parsed.endpoints[0]?.method).toBe('POST');
    expect(parsed.endpoints[0]?.requestBody?.content[0]?.mediaType).toBe('application/json');
  });

  it('keeps a credential-shaped form field out of the examples', () => {
    const parsed = spec(
      `curl -X POST https://api.test/v1/login -d 'user=alice&password=hunter2secret'`,
    );
    const schema = parsed.endpoints[0]?.requestBody?.content[0]?.schema as ObjectSchema;
    const password = schema.properties.find((property) => property.name === 'password');
    expect(password?.schema).toEqual({ kind: 'string' });
    expect(JSON.stringify(parsed)).not.toContain('hunter2secret');
  });
});

describe('determinism', () => {
  it('parses the same command to the same IR', () => {
    const command = `curl -X POST 'https://api.test/v1/orders?trace=1' -H 'X-Tenant: acme' -d '{"a":1}'`;
    expect(spec(command)).toEqual(spec(command));
  });
});
