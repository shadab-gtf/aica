/**
 * API ↔ code matching: does this codebase already call this endpoint?
 *
 * This is where the two halves of the system meet. Phase 2 gave a normalized
 * view of an API; Phase 3 gave a normalized view of a repository. Matching them
 * is what turns "integrate POST /payments" from a code-generation prompt into
 * an informed edit: the agent can find the existing client, the existing
 * authentication, and the existing call sites, and extend them rather than
 * inventing a parallel stack beside them.
 *
 * The match is **structural, not semantic**. A documented `/orders/{orderId}`
 * has the signature `/orders/{}`; a template literal `` `/orders/${id}` `` in
 * the code collapses to the same string. That is an exact comparison of two
 * indexed facts — no model, no fuzzy scoring on the decisive step — which is
 * what makes the result usable as evidence rather than as a suggestion.
 *
 * Where the evidence is weaker, the match says so. A name-similarity hit is
 * reported as a candidate with its reasons; it never silently becomes a fact.
 */

import type { ApiSpec, Endpoint } from '@aica/api-ir';
import { normalizePath, pathSignature } from '@aica/api-ir';
import type { CodeIndex, FileIndex, SymbolRecord, UrlLiteral } from '@aica/code-intelligence';

export const MatchStrength = {
  /** The path signature matched exactly. */
  exact: 'exact',
  /** The path matched once a base URL prefix was accounted for. */
  prefixed: 'prefixed',
  /** Only names or terms lined up; the path was not found in the code. */
  nominal: 'nominal',
} as const;

export type MatchStrength = (typeof MatchStrength)[keyof typeof MatchStrength];

/** A place in the codebase that appears to call a documented endpoint. */
export interface CallSite {
  readonly file: string;
  /** Declaration containing the call, when the literal sits inside one. */
  readonly symbol?: SymbolRecord;
  readonly literal: UrlLiteral;
  readonly strength: MatchStrength;
  /** Why this was matched, for showing the user. */
  readonly reasons: readonly string[];
}

export interface EndpointMatch {
  readonly endpoint: Endpoint;
  readonly callSites: readonly CallSite[];
  /** True when at least one call site matched on path structure. */
  readonly implemented: boolean;
}

/**
 * The repository's existing HTTP conventions.
 *
 * Reported so a plan can say "reuse this" with a specific file rather than a
 * platitude. Everything here is observed; nothing is assumed to exist.
 */
export interface ClientConventions {
  /** Base URLs found in the code, most common first. */
  readonly baseUrls: readonly { value: string; file: string; symbol?: SymbolRecord }[];
  /** Files holding several endpoint literals — the API client layer. */
  readonly clientFiles: readonly string[];
  /** Exported functions in those files, which new calls should sit beside. */
  readonly clientFunctions: readonly SymbolRecord[];
  /** Symbols whose names suggest they build authentication headers. */
  readonly authHelpers: readonly SymbolRecord[];
  /** HTTP mechanisms observed, so a plan can forbid introducing another. */
  readonly httpMechanisms: readonly string[];
}

const AUTH_NAME_PATTERN = /auth|token|credential|bearer|apikey|api_key|session|login|sign/i;

/** Package and global names that mean "this code performs HTTP". */
const HTTP_MECHANISMS: Readonly<Record<string, string>> = {
  fetch: 'fetch',
  axios: 'axios',
  got: 'got',
  ky: 'ky',
  superagent: 'superagent',
  undici: 'undici',
  request: 'request',
  XMLHttpRequest: 'XMLHttpRequest',
};

// ---------------------------------------------------------------------------
// Endpoint matching
// ---------------------------------------------------------------------------

/**
 * Find where the codebase calls each endpoint of a specification.
 *
 * Base paths are handled the way `compareSpecs` handles them, and in both
 * directions, because the prefix can sit on either side:
 *
 * - The spec's server is `https://api.test/v1` and its path is `/orders`, while
 *   the code writes `/v1/orders` in full.
 * - The spec's server is the bare origin and its path is `/v1/orders` — which
 *   is what every cURL-derived spec looks like — while the code keeps `/v1` in
 *   a `BASE_URL` constant and writes only `/orders`.
 *
 * Missing the second case is not a near miss. It reports an endpoint the
 * codebase already calls as uncalled, and a plan built on that goes off to
 * write a second client beside the one that is already there.
 *
 * Both prefixes are evidence, not assumption: one is read from the spec's
 * servers, the other from absolute URLs found in the code.
 */
export function matchEndpoints(spec: ApiSpec, index: CodeIndex): EndpointMatch[] {
  const literals = collectLiterals(index);
  const bases = basePathsOf(spec);
  const codeBases = codeBasePaths(index);

  return spec.endpoints.map((endpoint) => {
    const callSites = findCallSites(endpoint, literals, bases, codeBases, index);
    return {
      endpoint,
      callSites,
      implemented: callSites.some((site) => site.strength !== MatchStrength.nominal),
    };
  });
}

/** Where one endpoint is called, if anywhere. */
export function matchEndpoint(endpoint: Endpoint, spec: ApiSpec, index: CodeIndex): EndpointMatch {
  const found = matchEndpoints({ ...spec, endpoints: [endpoint] }, index);
  return found[0] as EndpointMatch;
}

interface IndexedLiteral {
  readonly file: string;
  readonly literal: UrlLiteral;
  readonly signature: string;
}

function collectLiterals(index: CodeIndex): IndexedLiteral[] {
  const found: IndexedLiteral[] = [];

  for (const file of index.files) {
    for (const literal of file.urlLiterals) {
      found.push({ file: file.path, literal, signature: literalSignature(literal.value) });
    }
  }

  return found;
}

/**
 * Reduce a code literal to a comparable path signature.
 *
 * An absolute URL contributes only its path. A trailing `{}` that is not its
 * own segment came from an appended query string — `` `/orders${suffix}` `` —
 * and is dropped, because it is not part of the path.
 */
export function literalSignature(value: string): string {
  let path = value.trim();

  const absolute = /^https?:\/\/[^/]*(\/.*)?$/i.exec(path);
  if (absolute) path = absolute[1] ?? '/';

  // `/orders{}` is `/orders` plus an interpolated query or suffix.
  path = path.replace(/(?<=[^/]){}$/, '');

  const query = path.search(/[?#]/);
  if (query >= 0) path = path.slice(0, query);

  if (path.length === 0) return '/';
  return pathSignature(path);
}

function findCallSites(
  endpoint: Endpoint,
  literals: readonly IndexedLiteral[],
  bases: readonly string[],
  codeBases: readonly string[],
  index: CodeIndex,
): CallSite[] {
  const target = pathSignature(endpoint.path);
  const prefixed = bases.map((base) => pathSignature(normalizePath(`${base}${endpoint.path}`)));
  const stripped = stripBases(endpoint.path, codeBases);

  const sites: CallSite[] = [];

  for (const entry of literals) {
    const symbol = entry.literal.fromSymbolId
      ? index.symbol(entry.literal.fromSymbolId)
      : undefined;

    if (entry.signature === target) {
      sites.push({
        file: entry.file,
        ...(symbol ? { symbol } : {}),
        literal: entry.literal,
        strength: MatchStrength.exact,
        reasons: [`request path ${entry.literal.value} matches ${endpoint.path}`],
      });
      continue;
    }

    if (prefixed.includes(entry.signature)) {
      sites.push({
        file: entry.file,
        ...(symbol ? { symbol } : {}),
        literal: entry.literal,
        strength: MatchStrength.prefixed,
        reasons: [
          `request path ${entry.literal.value} matches ${endpoint.path} including the server base path`,
        ],
      });
      continue;
    }

    if (stripped.includes(entry.signature)) {
      sites.push({
        file: entry.file,
        ...(symbol ? { symbol } : {}),
        literal: entry.literal,
        strength: MatchStrength.prefixed,
        reasons: [
          `request path ${entry.literal.value} matches ${endpoint.path} with the base path held separately in the code`,
        ],
      });
    }
  }

  return sites.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * Base paths the code itself uses, read from absolute URL literals.
 *
 * A `BASE_URL` of `https://api.test/v1` contributes `/v1`. An origin with no
 * path contributes nothing, and neither does an interpolated one — a base
 * assembled at runtime cannot be compared against a spec's static path.
 */
function codeBasePaths(index: CodeIndex): string[] {
  const bases = new Set<string>();

  for (const file of index.files) {
    for (const literal of file.urlLiterals) {
      const match = /^https?:\/\/[^/]*(\/.*)$/i.exec(literal.value.trim());
      const base = match?.[1]?.replace(/\/+$/, '');
      if (base && base.length > 1 && !base.includes('{')) bases.add(base);
    }
  }

  return [...bases];
}

/** Endpoint paths with a code-side base prefix removed, where one applies. */
function stripBases(endpointPath: string, codeBases: readonly string[]): string[] {
  const targets = new Set<string>();

  for (const base of codeBases) {
    if (!endpointPath.startsWith(`${base}/`)) continue;
    const remainder = endpointPath.slice(base.length);
    if (remainder.length > 1) targets.add(pathSignature(normalizePath(remainder)));
  }

  return [...targets];
}

/** Path prefixes of the specification's servers, e.g. `/v1`. */
function basePathsOf(spec: ApiSpec): string[] {
  const bases = new Set<string>();

  for (const server of spec.servers) {
    const withoutScheme = server.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    const base = withoutScheme.replace(/\/+$/, '');
    if (base.startsWith('/') && base.length > 1 && !base.includes('{')) bases.add(base);
  }

  return [...bases];
}

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

/**
 * Observe how this repository already talks to HTTP APIs.
 *
 * A plan that says "reuse the existing client" is only actionable if it can
 * name the file. Everything reported here was found in the index; where nothing
 * was found, the corresponding list is empty and the plan must say so rather
 * than assert a convention that does not exist.
 */
export function findClientConventions(index: CodeIndex): ClientConventions {
  const baseUrls: { value: string; file: string; symbol?: SymbolRecord }[] = [];
  const literalCounts = new Map<string, number>();

  for (const file of index.files) {
    for (const literal of file.urlLiterals) {
      if (/^https?:\/\//i.test(literal.value)) {
        const symbol = literal.fromSymbolId ? index.symbol(literal.fromSymbolId) : undefined;
        baseUrls.push({ value: literal.value, file: file.path, ...(symbol ? { symbol } : {}) });
      } else {
        literalCounts.set(file.path, (literalCounts.get(file.path) ?? 0) + 1);
      }
    }
  }

  // A file with more than one endpoint path in it is the API client layer;
  // a component with a single inline URL is not.
  const clientFiles = [...literalCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([path]) => path);

  const clientFunctions = clientFiles.flatMap((path) =>
    (index.file(path)?.symbols ?? []).filter(
      (symbol) =>
        symbol.exported &&
        symbol.container === undefined &&
        (symbol.kind === 'function' || symbol.kind === 'class'),
    ),
  );

  return {
    baseUrls,
    clientFiles,
    clientFunctions,
    authHelpers: findAuthHelpers(index),
    httpMechanisms: findHttpMechanisms(index),
  };
}

function findAuthHelpers(index: CodeIndex): SymbolRecord[] {
  return index.allSymbols
    .filter((symbol) => symbol.container === undefined)
    .filter((symbol) => AUTH_NAME_PATTERN.test(symbol.name))
    .filter((symbol) => symbol.kind === 'function' || symbol.kind === 'variable')
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Which HTTP mechanisms the code already uses.
 *
 * A plan's most valuable constraint is "do not add another HTTP client", and
 * that is only enforceable if the existing one is named.
 */
function findHttpMechanisms(index: CodeIndex): string[] {
  const found = new Set<string>();

  for (const file of index.files) {
    for (const record of file.imports) {
      const mechanism = HTTP_MECHANISMS[record.moduleSpecifier];
      if (mechanism) found.add(mechanism);
    }
    for (const reference of file.references) {
      if (reference.member === true) continue;
      const mechanism = HTTP_MECHANISMS[reference.name];
      // A bare `fetch` that resolves to a workspace declaration is a local
      // function of that name, not the platform API.
      if (mechanism && reference.symbolId === undefined) found.add(mechanism);
    }
  }

  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Locating the target of a change
// ---------------------------------------------------------------------------

export interface TargetCandidate {
  readonly file: string;
  readonly symbol?: SymbolRecord;
  readonly score: number;
  readonly reasons: readonly string[];
}

/**
 * Where a change should probably go.
 *
 * A file the user named outranks everything: they know their codebase. Failing
 * that, candidates are ranked by term overlap, and the result is a list rather
 * than a choice — picking one silently is how an agent edits the wrong file.
 */
export function findTargets(
  index: CodeIndex,
  options: { files?: readonly string[]; symbols?: readonly string[]; terms?: readonly string[] },
): TargetCandidate[] {
  const candidates = new Map<string, { score: number; reasons: string[]; symbol?: SymbolRecord }>();

  const bump = (file: string, score: number, reason: string, symbol?: SymbolRecord): void => {
    const existing = candidates.get(file);
    if (existing) {
      existing.score += score;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (symbol && !existing.symbol) existing.symbol = symbol;
    } else {
      candidates.set(file, { score, reasons: [reason], ...(symbol ? { symbol } : {}) });
    }
  };

  for (const named of options.files ?? []) {
    const resolved = resolveNamedFile(index, named);
    if (resolved) bump(resolved, 100, 'named in the request');
  }

  for (const name of options.symbols ?? []) {
    for (const symbol of index.symbolsNamed(name)) {
      bump(symbol.location.file, 60, `declares ${name}`, symbol);
    }
  }

  const terms = options.terms ?? [];
  if (terms.length > 0) {
    for (const symbol of index.allSymbols) {
      if (symbol.container !== undefined) continue;
      const haystack = tokenize(`${symbol.name} ${symbol.location.file}`);
      const hits = terms.filter((term) => haystack.some((token) => token.startsWith(term)));
      if (hits.length > 0) {
        bump(symbol.location.file, hits.length, `matches ${hits.join(', ')}`, symbol);
      }
    }
  }

  return [...candidates.entries()]
    .map(([file, entry]) => ({
      file,
      ...(entry.symbol ? { symbol: entry.symbol } : {}),
      score: entry.score,
      reasons: entry.reasons,
    }))
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
}

/** Match a path the user typed against an indexed file, allowing a suffix. */
function resolveNamedFile(index: CodeIndex, named: string): string | undefined {
  const normalized = named.replace(/^\.\//, '');
  if (index.file(normalized)) return normalized;

  const suffixMatches = index.files
    .map((file) => file.path)
    .filter((path) => path === normalized || path.endsWith(`/${normalized}`));

  // Exactly one match is a resolution; several is an ambiguity the caller must
  // not have silently decided for it.
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1);
}

/** Files that import the given file, so a change's neighbours are visible. */
export function relatedFiles(index: CodeIndex, file: string): string[] {
  const related = new Set<string>([...index.dependenciesOf(file), ...index.dependentsOf(file)]);
  related.delete(file);
  return [...related].sort();
}

/** True when a file appears to be a test, so a plan can treat it as such. */
export function isTestFile(file: FileIndex | string): boolean {
  const path = typeof file === 'string' ? file : file.path;
  return /(^|\/)(__tests__|test|tests)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}
