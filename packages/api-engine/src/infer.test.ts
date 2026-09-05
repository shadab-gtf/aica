import type { ArraySchema, ObjectSchema, UnionSchema } from '@aica/api-ir';
import { describe, expect, it } from 'vitest';

import { detectFormat, inferSchema, inferSchemaFromSamples, merge } from './infer.js';

describe('inferSchema', () => {
  it('reads primitives, distinguishing integers from other numbers', () => {
    expect(inferSchema('hello')).toEqual({ kind: 'string', example: 'hello' });
    expect(inferSchema(42)).toEqual({ kind: 'integer', example: 42 });
    expect(inferSchema(4.5)).toEqual({ kind: 'number', example: 4.5 });
    expect(inferSchema(true)).toEqual({ kind: 'boolean', example: true });
  });

  it('treats a null sample as nullability, not as a type', () => {
    expect(inferSchema(null)).toEqual({
      kind: 'unknown',
      nullable: true,
      reason: 'the only observed value was null',
    });
  });

  it('marks fields of a single sample as required', () => {
    const schema = inferSchema({ id: '1', name: 'a' }) as ObjectSchema;
    expect(schema.properties.every((property) => property.required)).toBe(true);
  });

  it('records an empty array as an unknown element type rather than guessing', () => {
    const schema = inferSchema([]) as ArraySchema;
    expect(schema.items).toMatchObject({ kind: 'unknown' });
  });

  it('merges array elements into one item schema', () => {
    const schema = inferSchema([{ a: 1 }, { a: 2, b: 'x' }]) as ArraySchema;
    const items = schema.items as ObjectSchema;
    expect(items.properties.find((property) => property.name === 'a')?.required).toBe(true);
    // `b` was absent from one element, so its presence is not guaranteed.
    expect(items.properties.find((property) => property.name === 'b')?.required).toBe(false);
  });

  it('stops descending past the depth limit', () => {
    const deep = { a: { b: { c: { d: 'x' } } } };
    const schema = inferSchema(deep, { maxDepth: 2 }) as ObjectSchema;
    const b = (schema.properties[0]?.schema as ObjectSchema).properties[0]?.schema as ObjectSchema;
    expect(b.properties[0]?.schema).toMatchObject({ kind: 'unknown' });
  });

  it('omits examples when asked', () => {
    expect(inferSchema('hello', { includeExamples: false })).toEqual({ kind: 'string' });
  });
});

describe('credential safety', () => {
  it('does not keep a credential-shaped value as an example', () => {
    const schema = inferSchema({ token: 'aB3xY9zQ7mN2pL5kR8wT1vC4nH6jF0dG' }) as ObjectSchema;
    expect(schema.properties[0]?.schema).toEqual({ kind: 'string' });
  });

  it('does not keep a value under a credential-shaped key, however innocent it looks', () => {
    const schema = inferSchema({ password: 'abc', apiKey: 'xyz' }) as ObjectSchema;
    expect(schema.properties[0]?.schema).toEqual({ kind: 'string' });
    expect(schema.properties[1]?.schema).toEqual({ kind: 'string' });
  });

  it('keeps ordinary values', () => {
    const schema = inferSchema({ name: 'alice' }) as ObjectSchema;
    expect(schema.properties[0]?.schema).toEqual({ kind: 'string', example: 'alice' });
  });
});

describe('detectFormat', () => {
  it.each([
    ['3fa85f64-5717-4562-b3fc-2c963f66afa6', 'uuid'],
    ['2024-01-31T12:00:00Z', 'date-time'],
    ['2024-01-31T12:00:00.123+02:00', 'date-time'],
    ['2024-01-31', 'date'],
    ['alice@example.com', 'email'],
    ['https://example.com/a', 'uri'],
    ['192.168.0.1', 'ipv4'],
  ])('recognizes %s as %s', (value, expected) => {
    expect(detectFormat(value)).toBe(expected);
  });

  it.each(['12345', 'not a date', '2024-13-99T', 'a@b', 'plain text'])(
    'does not guess a format for %s',
    (value) => {
      expect(detectFormat(value)).toBeUndefined();
    },
  );
});

describe('merging samples', () => {
  it('requires a field only when every sample has it', () => {
    const schema = inferSchemaFromSamples([
      { id: '1', name: 'a', note: 'x' },
      { id: '2', name: 'b' },
    ]) as ObjectSchema;

    expect(schema.properties.find((property) => property.name === 'id')?.required).toBe(true);
    expect(schema.properties.find((property) => property.name === 'note')?.required).toBe(false);
  });

  it('folds a null observation into the type the other samples show', () => {
    const schema = inferSchemaFromSamples([{ note: null }, { note: 'x' }]) as ObjectSchema;
    expect(schema.properties[0]?.schema).toMatchObject({ kind: 'string', nullable: true });
  });

  it('widens integer to number when a fractional sample appears', () => {
    expect(inferSchemaFromSamples([1, 2.5])).toMatchObject({ kind: 'number' });
    expect(inferSchemaFromSamples([1, 2])).toMatchObject({ kind: 'integer' });
  });

  it('unions genuinely different types', () => {
    const schema = inferSchemaFromSamples(['a', 1]) as UnionSchema;
    expect(schema.kind).toBe('union');
    expect(schema.options.map((option) => option.kind)).toEqual(['string', 'integer']);
  });

  it('does not union the same kind repeatedly', () => {
    expect(inferSchemaFromSamples(['a', 'b', 'c']).kind).toBe('string');
  });

  it('merges nested objects', () => {
    const schema = inferSchemaFromSamples([
      { user: { id: 1, email: 'a@b.co' } },
      { user: { id: 2 } },
    ]) as ObjectSchema;

    const user = schema.properties[0]?.schema as ObjectSchema;
    expect(user.properties.find((property) => property.name === 'email')?.required).toBe(false);
  });

  it('reports having seen nothing rather than inventing a shape', () => {
    expect(inferSchemaFromSamples([])).toMatchObject({ kind: 'unknown' });
    expect(merge([])).toMatchObject({ kind: 'unknown' });
  });
});
