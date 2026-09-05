/**
 * The normalized schema node.
 *
 * OpenAPI, Swagger, Postman, and hand-written documentation all describe data
 * shapes differently. Every parser lowers its input into this one type, so the
 * rest of the system — contract validation, type generation, mismatch detection
 * — has exactly one shape to reason about.
 *
 * Deliberate design points:
 *
 * - `unknown` is a first-class kind. When a specification does not say what a
 *   field holds, that is recorded rather than guessed, because inventing a type
 *   is how an agent ends up generating code against an API that does not exist.
 * - Enumerations are preserved exactly. They are the single most common source
 *   of API-to-frontend contract mismatch (a UI comparing against "completed"
 *   when the API returns "success"), so they must survive normalization intact.
 * - Nullability is separate from optionality. A field that is present but null
 *   and a field that may be absent are different bugs.
 */

export type SchemaKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'
  | 'object'
  | 'array'
  | 'enum'
  | 'union'
  | 'intersection'
  | 'ref'
  | 'unknown';

interface SchemaBase {
  readonly kind: SchemaKind;
  readonly description?: string;
  /** True when the value may be null, independently of being optional. */
  readonly nullable?: boolean;
  readonly deprecated?: boolean;
  /** Example drawn from the source specification, never invented. */
  readonly example?: unknown;
  /** Format hint such as "date-time", "uuid", "email". */
  readonly format?: string;
  readonly default?: unknown;
  /** True when the source marked this read-only (present in responses only). */
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
}

export interface StringSchema extends SchemaBase {
  readonly kind: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface NumberSchema extends SchemaBase {
  readonly kind: 'number' | 'integer';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
}

export interface BooleanSchema extends SchemaBase {
  readonly kind: 'boolean';
}

export interface NullSchema extends SchemaBase {
  readonly kind: 'null';
}

export interface ObjectProperty {
  readonly name: string;
  readonly schema: SchemaNode;
  readonly required: boolean;
}

export interface ObjectSchema extends SchemaBase {
  readonly kind: 'object';
  readonly properties: readonly ObjectProperty[];
  /**
   * Schema for unlisted properties, or `false` when the source closed the
   * object. `undefined` means the source did not say.
   */
  readonly additionalProperties?: SchemaNode | false;
  readonly title?: string;
}

export interface ArraySchema extends SchemaBase {
  readonly kind: 'array';
  readonly items: SchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

export interface EnumSchema extends SchemaBase {
  readonly kind: 'enum';
  /** Exact values from the specification, in source order. */
  readonly values: readonly (string | number | boolean | null)[];
  /** Underlying primitive, when the source declared one. */
  readonly base?: 'string' | 'number' | 'integer' | 'boolean';
}

export interface UnionSchema extends SchemaBase {
  readonly kind: 'union';
  readonly options: readonly SchemaNode[];
  /** Property whose value selects the variant, when the source declares one. */
  readonly discriminator?: string;
}

export interface IntersectionSchema extends SchemaBase {
  readonly kind: 'intersection';
  readonly parts: readonly SchemaNode[];
}

/**
 * A named reference that was not inlined, either because the target was missing
 * or because inlining would not terminate (a recursive type). Recorded rather
 * than dropped so the gap is visible.
 */
export interface RefSchema extends SchemaBase {
  readonly kind: 'ref';
  readonly ref: string;
  readonly name: string;
  /** True when this reference exists only to break a cycle. */
  readonly circular?: boolean;
}

export interface UnknownSchema extends SchemaBase {
  readonly kind: 'unknown';
  /** Why the shape is unknown, so the agent can say so rather than guess. */
  readonly reason?: string;
}

export type SchemaNode =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | NullSchema
  | ObjectSchema
  | ArraySchema
  | EnumSchema
  | UnionSchema
  | IntersectionSchema
  | RefSchema
  | UnknownSchema;

export const unknownSchema = (reason?: string): UnknownSchema => ({
  kind: 'unknown',
  ...(reason ? { reason } : {}),
});

/** Look up a property on an object schema. */
export function getProperty(schema: SchemaNode, name: string): ObjectProperty | undefined {
  return schema.kind === 'object'
    ? schema.properties.find((property) => property.name === name)
    : undefined;
}

/**
 * Resolve a dotted path such as `data.items.status` against a schema, stepping
 * through arrays automatically. Used by contract validation to check what the
 * frontend actually reads against what the API actually returns.
 */
export function resolvePath(schema: SchemaNode, path: string): SchemaNode | undefined {
  let current: SchemaNode | undefined = schema;

  for (const segment of path.split('.').filter((part) => part.length > 0)) {
    if (!current) return undefined;

    // Array indexing is implicit: `items.status` reads through the element.
    while (current?.kind === 'array') current = current.items;

    if (current?.kind === 'union') {
      // A path is only resolvable if every variant carries it. The annotation
      // is required: `current` is reassigned from `resolved`, so inferring
      // `resolved` from the narrowed type of `current` would be circular.
      const resolved: (SchemaNode | undefined)[] = current.options.map((option) =>
        resolvePath(option, segment),
      );
      current = resolved.every((node) => node !== undefined) ? resolved[0] : undefined;
      continue;
    }

    if (current?.kind !== 'object') return undefined;
    current = getProperty(current, segment)?.schema;
  }

  return current;
}

/** Enumerate every leaf path in an object schema, for contract comparison. */
export function listPaths(schema: SchemaNode, prefix = '', depth = 0): string[] {
  if (depth > 8) return [];
  const paths: string[] = [];

  switch (schema.kind) {
    case 'object':
      for (const property of schema.properties) {
        const path = prefix ? `${prefix}.${property.name}` : property.name;
        paths.push(path);
        paths.push(...listPaths(property.schema, path, depth + 1));
      }
      break;
    case 'array':
      paths.push(...listPaths(schema.items, prefix, depth + 1));
      break;
    case 'union':
      for (const option of schema.options) paths.push(...listPaths(option, prefix, depth + 1));
      break;
    case 'intersection':
      for (const part of schema.parts) paths.push(...listPaths(part, prefix, depth + 1));
      break;
    default:
      break;
  }

  return [...new Set(paths)];
}

/** Collect every enumeration in a schema, keyed by its path. */
export function listEnums(
  schema: SchemaNode,
  prefix = '',
  depth = 0,
): Array<{ path: string; values: readonly (string | number | boolean | null)[] }> {
  if (depth > 8) return [];
  const found: Array<{ path: string; values: readonly (string | number | boolean | null)[] }> = [];

  switch (schema.kind) {
    case 'enum':
      found.push({ path: prefix, values: schema.values });
      break;
    case 'object':
      for (const property of schema.properties) {
        const path = prefix ? `${prefix}.${property.name}` : property.name;
        found.push(...listEnums(property.schema, path, depth + 1));
      }
      break;
    case 'array':
      found.push(...listEnums(schema.items, prefix, depth + 1));
      break;
    case 'union':
      for (const option of schema.options) found.push(...listEnums(option, prefix, depth + 1));
      break;
    case 'intersection':
      for (const part of schema.parts) found.push(...listEnums(part, prefix, depth + 1));
      break;
    default:
      break;
  }

  return found;
}

/**
 * Render a schema as a TypeScript type. Used when generating client types and
 * when showing the user what an endpoint returns.
 *
 * `unknown` is rendered as `unknown`, never as `any`: an under-specified API
 * should make the compiler ask questions, not stay silent.
 */
export function toTypeScript(schema: SchemaNode, indent = 0, depth = 0): string {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);

  if (depth > 12) return 'unknown';

  const withNull = (type: string): string => (schema.nullable ? `${type} | null` : type);

  switch (schema.kind) {
    case 'string':
      return withNull('string');
    case 'number':
    case 'integer':
      return withNull('number');
    case 'boolean':
      return withNull('boolean');
    case 'null':
      return 'null';
    case 'enum':
      return withNull(
        schema.values
          .map((value) => (typeof value === 'string' ? `'${value}'` : String(value)))
          .join(' | '),
      );
    case 'array':
      return withNull(`Array<${toTypeScript(schema.items, indent, depth + 1)}>`);
    case 'union':
      return withNull(
        schema.options.map((option) => toTypeScript(option, indent, depth + 1)).join(' | '),
      );
    case 'intersection':
      return withNull(
        schema.parts.map((part) => toTypeScript(part, indent, depth + 1)).join(' & '),
      );
    case 'ref':
      return withNull(schema.name);
    case 'object': {
      if (schema.properties.length === 0) {
        // `false` means the source closed the object; `undefined` means it did
        // not say, which is an open object of unknown values.
        if (schema.additionalProperties === false) return withNull('Record<string, never>');
        return withNull(
          schema.additionalProperties
            ? `Record<string, ${toTypeScript(schema.additionalProperties, indent, depth + 1)}>`
            : 'Record<string, unknown>',
        );
      }
      const lines = schema.properties.map((property) => {
        const optional = property.required ? '' : '?';
        const type = toTypeScript(property.schema, indent + 1, depth + 1);
        return `${inner}${quoteKey(property.name)}${optional}: ${type};`;
      });
      return withNull(`{\n${lines.join('\n')}\n${pad}}`);
    }
    case 'unknown':
    default:
      return 'unknown';
  }
}

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`;
}

/** Short human-readable description of a schema, for the UI and for prompts. */
export function describeSchema(schema: SchemaNode): string {
  switch (schema.kind) {
    case 'object':
      return `object with ${schema.properties.length} field(s)`;
    case 'array':
      return `array of ${describeSchema(schema.items)}`;
    case 'enum':
      return `one of ${schema.values.map((value) => JSON.stringify(value)).join(', ')}`;
    case 'union':
      return schema.options.map(describeSchema).join(' or ');
    case 'ref':
      return schema.name;
    case 'unknown':
      return schema.reason ? `unspecified (${schema.reason})` : 'unspecified';
    default:
      return schema.kind;
  }
}
