import { ErrorCode, isErr, unwrap } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import { detectSourceFormat, parseApiDocument, parseApiSource } from './source.js';

const openApiYaml = `
openapi: 3.0.3
info:
  title: Widgets API
  version: "1.0"
servers:
  - url: https://api.test/v1
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  type: string
`;

const openApiJson = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Widgets API' },
  paths: { '/widgets': { get: { responses: { '200': { description: 'ok' } } } } },
});

const postmanJson = JSON.stringify({
  info: {
    name: 'Widgets',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [{ name: 'List', request: { method: 'GET', url: { raw: 'https://api.test/v1/widgets' } } }],
});

describe('detectSourceFormat', () => {
  it('recognizes each supported source', () => {
    expect(detectSourceFormat(openApiYaml)).toBe('openapi');
    expect(detectSourceFormat(openApiJson)).toBe('openapi');
    expect(detectSourceFormat(postmanJson)).toBe('postman');
    expect(detectSourceFormat(`curl https://api.test/v1/widgets`)).toBe('curl');
    expect(detectSourceFormat('curl \\\n  https://api.test/v1/widgets')).toBe('curl');
  });

  it('recognizes a command by its program name, not by a substring', () => {
    // The word "curl" inside prose must not turn a document into a command.
    expect(detectSourceFormat('This API can be called with curl https://x.test')).toBe('unknown');
  });

  it('recognizes documentation only when it states an endpoint', () => {
    expect(detectSourceFormat('# Widgets\n\n## List\n\nGET /widgets\n')).toBe('docs');
    // Prose about an API is not a description of one.
    expect(detectSourceFormat('# Widgets\n\nA service for widgets.')).toBe('unknown');
  });

  it('prefers a structured format over prose when the text is both', () => {
    // The YAML body mentions paths, but it parses as OpenAPI, which wins.
    expect(detectSourceFormat(openApiYaml)).toBe('openapi');
  });

  it('says unknown rather than guessing', () => {
    expect(detectSourceFormat('')).toBe('unknown');
    expect(detectSourceFormat('just some prose')).toBe('unknown');
    expect(detectSourceFormat('{"a": 1}')).toBe('unknown');
    expect(detectSourceFormat('<html></html>')).toBe('unknown');
  });
});

describe('parseApiSource', () => {
  it('parses YAML as readily as JSON', () => {
    const spec = unwrap(parseApiSource(openApiYaml, { location: 'widgets.yaml' }));
    expect(spec.title).toBe('Widgets API');
    expect(spec.endpoints.map((endpoint) => endpoint.id)).toEqual(['GET /widgets']);
    expect(spec.source.location).toBe('widgets.yaml');
  });

  it('dispatches to the Postman parser', () => {
    const spec = unwrap(parseApiSource(postmanJson));
    expect(spec.source.format).toBe('postman');
  });

  it('dispatches to the cURL parser', () => {
    const spec = unwrap(parseApiSource(`curl https://api.test/v1/widgets`));
    expect(spec.source.format).toBe('curl');
    expect(spec.endpoints[0]?.id).toBe('GET /v1/widgets');
  });

  it('honours an explicit format over detection', () => {
    // Detection alone would call this unknown.
    const result = parseApiSource('{"openapi": "3.0.0"}', { format: 'openapi' });
    expect(unwrap(result).endpoints).toEqual([]);
  });

  it('dispatches to the documentation parser', () => {
    const spec = unwrap(parseApiSource('# Widgets\n\n## List\n\nGET /widgets\n'));
    expect(spec.source.format).toBe('manual');
    expect(spec.endpoints[0]?.id).toBe('GET /widgets');
  });

  it('reports an unrecognized source without throwing', () => {
    const result = parseApiSource('just some prose');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.UNSUPPORTED);
    expect(isErr(result) && result.error.message).toMatch(/OpenAPI.*Postman.*curl/i);
  });

  it('reports text that claims a format but does not parse', () => {
    const result = parseApiSource('openapi: 3.0.0\n  bad: [indent', { format: 'openapi' });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it('carries the location into the error details', () => {
    const result = parseApiSource('prose', { location: 'notes.txt' });
    expect(isErr(result) && result.error.details).toMatchObject({ location: 'notes.txt' });
  });
});

describe('parseApiDocument', () => {
  it('accepts an already-decoded document', () => {
    const spec = unwrap(parseApiDocument(JSON.parse(openApiJson)));
    expect(spec.title).toBe('Widgets API');
  });

  it('rejects a document that is neither format', () => {
    expect(isErr(parseApiDocument({ hello: 'world' }))).toBe(true);
  });
});
