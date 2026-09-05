/**
 * The endpoint index: the lookup surface over every API a project knows about.
 *
 * Three questions have to be answered fast and identically every time:
 *
 * 1. "Which endpoint is `GET /users/42`?" — attributing a concrete request seen
 *    in code or in a cURL command to a documented endpoint.
 * 2. "Which endpoints are about refunds?" — turning a user's phrasing into
 *    candidates, before any model is involved.
 * 3. "Do these two specifications describe the same endpoint twice?"
 *
 * Ranking here is deterministic and explainable: every result carries the terms
 * and fields it matched on. That matters because the search result becomes the
 * evidence for the agent's endpoint choice, and evidence a model produced could
 * not be used to check a model.
 */

import type { ApiSpec, Endpoint, HttpMethod } from '@aica/api-ir';
import { endpointSignature, matchPath, normalizePath } from '@aica/api-ir';

export interface EndpointRecord {
  readonly specId: string;
  readonly specTitle: string;
  readonly endpoint: Endpoint;
}

export interface SearchResult {
  readonly record: EndpointRecord;
  readonly score: number;
  /** Which fields contributed, for showing why a result was chosen. */
  readonly matchedOn: readonly string[];
}

export interface SearchOptions {
  readonly limit?: number;
  readonly method?: HttpMethod;
  readonly tag?: string;
  /** Restrict to one specification. */
  readonly specId?: string;
  /** Results scoring below this are dropped. Defaults to a small positive. */
  readonly minScore?: number;
}

export interface PathMatch {
  readonly record: EndpointRecord;
  /** Values captured from the concrete path, e.g. `{ id: '42' }`. */
  readonly parameters: Readonly<Record<string, string>>;
}

/** Field weights. Path and operationId name the endpoint; prose describes it. */
const FIELD_WEIGHTS: Readonly<Record<string, number>> = {
  path: 3,
  operationId: 3,
  summary: 2,
  tags: 2,
  description: 1,
};

export class EndpointIndex {
  private readonly records: EndpointRecord[] = [];
  private readonly documents = new Map<EndpointRecord, IndexedDocument>();

  constructor(specs: readonly ApiSpec[] = []) {
    for (const spec of specs) this.add(spec);
  }

  add(spec: ApiSpec): void {
    for (const endpoint of spec.endpoints) {
      const record: EndpointRecord = { specId: spec.id, specTitle: spec.title, endpoint };
      this.records.push(record);
      this.documents.set(record, buildDocument(endpoint));
    }
  }

  get size(): number {
    return this.records.length;
  }

  all(): readonly EndpointRecord[] {
    return this.records;
  }

  /** Exact lookup by canonical endpoint id, optionally within one spec. */
  find(endpointId: string, specId?: string): EndpointRecord | undefined {
    return this.records.find(
      (record) =>
        record.endpoint.id === endpointId && (specId === undefined || record.specId === specId),
    );
  }

  byTag(tag: string): EndpointRecord[] {
    const needle = tag.toLowerCase();
    return this.records.filter((record) =>
      record.endpoint.tags.some((candidate) => candidate.toLowerCase() === needle),
    );
  }

  /**
   * Attribute a concrete request to the endpoints whose templates it fits.
   *
   * More than one template can match — `/users/me` and `/users/{id}` both
   * accept `/users/me` — so all matches are returned, most specific first. The
   * caller decides; guessing here would hide the ambiguity.
   */
  match(method: HttpMethod, concretePath: string): PathMatch[] {
    const path = normalizePath(concretePath);

    return this.records
      .filter((record) => record.endpoint.method === method)
      .map((record) => {
        const parameters = matchPath(record.endpoint.path, path);
        return parameters === undefined ? undefined : { record, parameters };
      })
      .filter((match): match is PathMatch => match !== undefined)
      .sort(
        (left, right) =>
          Object.keys(left.parameters).length - Object.keys(right.parameters).length ||
          left.record.endpoint.id.localeCompare(right.record.endpoint.id),
      );
  }

  /**
   * Rank endpoints against a natural-language query using term overlap only.
   *
   * A term matches a field's token exactly, or as a prefix at half weight so
   * that "refund" reaches "refunds" without "user" reaching "username".
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const queryMethod = options.method ?? methodInQuery(query);
    const minScore = options.minScore ?? 0.01;

    const results: SearchResult[] = [];

    for (const record of this.records) {
      if (options.specId !== undefined && record.specId !== options.specId) continue;
      if (queryMethod !== undefined && record.endpoint.method !== queryMethod) continue;
      if (
        options.tag !== undefined &&
        !record.endpoint.tags.some((tag) => tag.toLowerCase() === options.tag?.toLowerCase())
      ) {
        continue;
      }

      const document = this.documents.get(record);
      if (!document) continue;

      const scored = score(terms, document);
      if (scored.score > minScore) {
        results.push({ record, score: scored.score, matchedOn: scored.matchedOn });
      }
    }

    return results
      .sort(
        (left, right) =>
          right.score - left.score ||
          // A stable tiebreak keeps identical inputs producing identical output,
          // which the golden scenarios depend on.
          left.record.endpoint.id.localeCompare(right.record.endpoint.id),
      )
      .slice(0, options.limit ?? 10);
  }

  /**
   * Endpoints indexed more than once under the same signature. Two specs
   * describing one API is normal; knowing it is what lets the agent compare
   * them instead of picking one arbitrarily.
   */
  duplicates(): EndpointRecord[][] {
    const groups = new Map<string, EndpointRecord[]>();

    for (const record of this.records) {
      const key = endpointSignature(record.endpoint);
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }

    return [...groups.values()].filter((group) => group.length > 1);
  }
}

// ---------------------------------------------------------------------------
// Indexing internals
// ---------------------------------------------------------------------------

interface IndexedDocument {
  /** Field name to the set of tokens it contributed. */
  readonly fields: ReadonlyMap<string, ReadonlySet<string>>;
}

function buildDocument(endpoint: Endpoint): IndexedDocument {
  const fields = new Map<string, ReadonlySet<string>>();

  fields.set('path', new Set(tokenize(endpoint.path)));
  fields.set('operationId', new Set(tokenize(endpoint.operationId ?? '')));
  fields.set('summary', new Set(tokenize(endpoint.summary ?? '')));
  fields.set('tags', new Set(endpoint.tags.flatMap((tag) => tokenize(tag))));
  fields.set('description', new Set(tokenize(endpoint.description ?? '')));

  return { fields };
}

function score(
  terms: readonly string[],
  document: IndexedDocument,
): { score: number; matchedOn: string[] } {
  let total = 0;
  const matchedOn = new Set<string>();

  for (const term of terms) {
    for (const [field, tokens] of document.fields) {
      const weight = FIELD_WEIGHTS[field] ?? 1;

      if (tokens.has(term)) {
        total += weight;
        matchedOn.add(field);
        continue;
      }

      // Prefix matching absorbs plurals and verb endings without a stemmer,
      // whose language-specific rules would be a poor fit for API vocabulary.
      if ([...tokens].some((token) => token.startsWith(term) || term.startsWith(token))) {
        total += weight / 2;
        matchedOn.add(field);
      }
    }
  }

  // Divide by term count so a long query cannot outscore a precise one purely
  // by having more words.
  return { score: total / terms.length, matchedOn: [...matchedOn] };
}

/**
 * Split text into lowercase terms, breaking camelCase and treating path
 * separators and `{}` as boundaries, so `/paymentIntents/{id}` yields
 * `payment`, `intents`, `id`.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Words that carry no signal in an API vocabulary. Deliberately short: dropping
 * a term that turns out to be meaningful costs a result, and API descriptions
 * are terse enough that generic stop-word lists remove too much.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'api',
  'endpoint',
  'request',
  'returns',
  'return',
]);

const METHOD_WORDS: ReadonlyMap<string, HttpMethod> = new Map<string, HttpMethod>([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
]);

/**
 * Pick up a method the user named explicitly, as in "the POST /orders call".
 * Only an upper-case mention counts: "get the user's orders" is prose, while
 * "GET /users" is a filter.
 */
function methodInQuery(query: string): HttpMethod | undefined {
  for (const word of query.split(/[^A-Za-z]+/)) {
    if (word !== word.toUpperCase()) continue;
    const method = METHOD_WORDS.get(word.toLowerCase());
    if (method) return method;
  }
  return undefined;
}
