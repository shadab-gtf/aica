/**
 * Small helpers for walking untrusted JSON documents.
 *
 * Everything a parser reads — an OpenAPI file, a Postman export — is untrusted
 * input of unknown shape. These accessors return `undefined` rather than
 * throwing on a wrong type, so a malformed corner of a document degrades into a
 * warning instead of aborting the whole import.
 */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Non-empty trimmed string, or `undefined`. Empty descriptions are noise. */
export function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Build an object literal that omits absent values, so the IR does not carry
 * `{ description: undefined }` noise into snapshots and equality checks.
 */
export function compact<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result as T;
}

const POINTER_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/~/g, '~0'],
  [/\//g, '~1'],
];

/** Escape one JSON Pointer segment (RFC 6901). */
export function escapePointer(segment: string): string {
  let escaped = segment;
  for (const [pattern, replacement] of POINTER_ESCAPES)
    escaped = escaped.replace(pattern, replacement);
  return escaped;
}

export function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function pointer(...segments: readonly string[]): string {
  return `#/${segments.map(escapePointer).join('/')}`;
}

/**
 * Resolve a local JSON Pointer (`#/components/schemas/User`) against a root
 * document. External and remote references are deliberately unsupported:
 * fetching them would be a network side effect inside a parser, and a parser
 * must be pure. An unresolvable reference is reported, never silently skipped.
 */
export function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;

  const path = ref.slice(1).replace(/^\//, '');
  if (path.length === 0) return root;

  let current: unknown = root;
  for (const rawSegment of path.split('/')) {
    const segment = unescapePointer(rawSegment);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    if (!(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Last segment of a reference, used as the generated type name. */
export function refName(ref: string): string {
  const segment = ref.split('/').pop() ?? ref;
  return unescapePointer(segment);
}
