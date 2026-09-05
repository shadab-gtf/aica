/**
 * Infer a schema from observed payloads.
 *
 * A cURL command and a Postman collection carry example bodies rather than
 * declarations, and later phases feed real HTTP responses through the same
 * path. Observed data is genuine evidence — it outranks the model, and where a
 * specification is absent it is the only evidence there is — but it is weaker
 * than a declaration, and the inference is careful to claim no more than the
 * samples support:
 *
 * - **Required means observed in every sample.** One payload proves a field can
 *   be present, not that the API always sends it, so a field missing from any
 *   sample is optional.
 * - **A `null` sample gives nullability, not a type.** It produces a nullable
 *   `unknown`, which merges cleanly once a non-null sample arrives.
 * - **Formats are only recognized when unambiguous.** A UUID-shaped string is a
 *   UUID; a string of digits is not silently a number.
 * - **Credential-shaped values never become examples.** A pasted request is a
 *   common way for a live key to end up in a catalog, and the catalog is shown
 *   in the UI and sent to a model.
 */

import type { ObjectProperty, SchemaNode } from '@aica/api-ir';
import { unknownSchema } from '@aica/api-ir';
import { looksLikeCredential, looksSensitiveKey } from '@aica/security-engine';

export interface InferOptions {
  /** Stop descending past this depth; deeper values become `unknown`. */
  readonly maxDepth?: number;
  /** Attach observed values as examples. On by default. */
  readonly includeExamples?: boolean;
}

const DEFAULT_MAX_DEPTH = 12;

/** Infer a schema from a single observed value. */
export function inferSchema(sample: unknown, options: InferOptions = {}): SchemaNode {
  return inferSchemaFromSamples([sample], options);
}

/**
 * Infer one schema covering every sample. Samples are merged rather than
 * unioned blindly, so ten responses of the same shape produce one object type,
 * not a ten-way union.
 */
export function inferSchemaFromSamples(
  samples: readonly unknown[],
  options: InferOptions = {},
): SchemaNode {
  if (samples.length === 0) return unknownSchema('no sample values were observed');

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const includeExamples = options.includeExamples !== false;

  return merge(
    samples.map((sample) => fromValue(sample, { maxDepth, includeExamples }, 0, undefined)),
  );
}

interface Context {
  readonly maxDepth: number;
  readonly includeExamples: boolean;
}

function fromValue(
  value: unknown,
  context: Context,
  depth: number,
  key: string | undefined,
): SchemaNode {
  if (depth > context.maxDepth) {
    return unknownSchema(`value nested deeper than ${context.maxDepth} levels`);
  }

  if (value === null) {
    return { kind: 'unknown', nullable: true, reason: 'the only observed value was null' };
  }

  switch (typeof value) {
    case 'boolean':
      return withExample({ kind: 'boolean' }, value, context, key);

    case 'number':
      return withExample(
        { kind: Number.isInteger(value) ? 'integer' : 'number' },
        value,
        context,
        key,
      );

    case 'string':
      return fromString(value, context, key);

    case 'object':
      return Array.isArray(value)
        ? fromArray(value, context, depth)
        : fromObject(value as Record<string, unknown>, context, depth);

    default:
      // `undefined`, `function`, `symbol`, `bigint` cannot appear in JSON.
      return unknownSchema(`observed value of unsupported type "${typeof value}"`);
  }
}

function fromString(value: string, context: Context, key: string | undefined): SchemaNode {
  const format = detectFormat(value);
  const node: SchemaNode = format ? { kind: 'string', format } : { kind: 'string' };
  return withExample(node, value, context, key);
}

function fromArray(values: readonly unknown[], context: Context, depth: number): SchemaNode {
  if (values.length === 0) {
    return { kind: 'array', items: unknownSchema('the observed array was empty') };
  }

  const items = merge(values.map((entry) => fromValue(entry, context, depth + 1, undefined)));
  return { kind: 'array', items };
}

function fromObject(value: Record<string, unknown>, context: Context, depth: number): SchemaNode {
  const properties: ObjectProperty[] = Object.entries(value).map(([name, entry]) => ({
    name,
    // A single sample proves presence; `merge` demotes this to optional as soon
    // as another sample omits the field.
    required: true,
    schema: fromValue(entry, context, depth + 1, name),
  }));

  return { kind: 'object', properties };
}

/**
 * Attach an observed value as an example unless it is credential-shaped or sits
 * under a credential-shaped key.
 */
function withExample(
  node: SchemaNode,
  value: string | number | boolean,
  context: Context,
  key: string | undefined,
): SchemaNode {
  if (!context.includeExamples) return node;
  if (typeof value === 'string' && looksLikeCredential(value)) return node;
  if (key !== undefined && looksSensitiveKey(key)) return node;
  return { ...node, example: value };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const FORMAT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i],
  ['date-time', /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/],
  ['date', /^\d{4}-\d{2}-\d{2}$/],
  ['email', /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/],
  ['uri', /^https?:\/\/[^\s]+$/i],
  ['ipv4', /^(\d{1,3}\.){3}\d{1,3}$/],
];

/**
 * Recognize a string format only when the shape is unambiguous. A guess here
 * becomes a generated type and then a runtime failure, so the bar is high.
 */
export function detectFormat(value: string): string | undefined {
  for (const [format, pattern] of FORMAT_PATTERNS) {
    if (pattern.test(value)) return format;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** Combine schemas describing the same position across several samples. */
export function merge(nodes: readonly SchemaNode[]): SchemaNode {
  const first = nodes[0];
  if (first === undefined) return unknownSchema('no sample values were observed');
  return nodes.slice(1).reduce<SchemaNode>((left, right) => mergePair(left, right), first);
}

function mergePair(left: SchemaNode, right: SchemaNode): SchemaNode {
  // A null-only observation carries nullability and nothing else, so it folds
  // into whatever the other samples turned out to be.
  if (left.kind === 'unknown' && left.nullable === true && right.kind !== 'unknown') {
    return { ...right, nullable: true };
  }
  if (right.kind === 'unknown' && right.nullable === true && left.kind !== 'unknown') {
    return { ...left, nullable: true };
  }

  if (left.kind === 'unknown') return right;
  if (right.kind === 'unknown') return left;

  const nullable = left.nullable === true || right.nullable === true ? true : undefined;

  if (left.kind === 'object' && right.kind === 'object') {
    return withNullable({ kind: 'object', properties: mergeProperties(left, right) }, nullable);
  }

  if (left.kind === 'array' && right.kind === 'array') {
    return withNullable({ kind: 'array', items: mergePair(left.items, right.items) }, nullable);
  }

  // An integer sample followed by a fractional one describes a number.
  if (isNumeric(left) && isNumeric(right)) {
    const kind = left.kind === 'integer' && right.kind === 'integer' ? 'integer' : 'number';
    return withNullable({ ...left, kind }, nullable);
  }

  if (left.kind === right.kind) {
    // Same primitive kind: keep the first, which carries the earliest example.
    return withNullable(left, nullable);
  }

  return withNullable({ kind: 'union', options: flattenOptions(left, right) }, nullable);
}

function mergeProperties(
  left: SchemaNode & { kind: 'object' },
  right: SchemaNode & { kind: 'object' },
): ObjectProperty[] {
  const names = new Set([
    ...left.properties.map((property) => property.name),
    ...right.properties.map((property) => property.name),
  ]);

  return [...names].map((name) => {
    const inLeft = left.properties.find((property) => property.name === name);
    const inRight = right.properties.find((property) => property.name === name);

    if (inLeft && inRight) {
      return {
        name,
        required: inLeft.required && inRight.required,
        schema: mergePair(inLeft.schema, inRight.schema),
      };
    }

    // Absent from one sample, so its presence is not guaranteed.
    const present = (inLeft ?? inRight) as ObjectProperty;
    return { name, required: false, schema: present.schema };
  });
}

function flattenOptions(left: SchemaNode, right: SchemaNode): SchemaNode[] {
  const options = [
    ...(left.kind === 'union' ? left.options : [left]),
    ...(right.kind === 'union' ? right.options : [right]),
  ];

  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.kind)) return false;
    seen.add(option.kind);
    return true;
  });
}

function isNumeric(node: SchemaNode): boolean {
  return node.kind === 'number' || node.kind === 'integer';
}

function withNullable(node: SchemaNode, nullable: true | undefined): SchemaNode {
  return nullable ? { ...node, nullable } : node;
}
