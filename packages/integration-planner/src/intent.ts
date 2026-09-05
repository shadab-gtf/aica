/**
 * Intent understanding: what the user actually asked for.
 *
 * This runs *before* any model call, and for most real requests it finishes the
 * job on its own. "Integrate POST /payments into the checkout form" states its
 * action, its endpoint, and its target file explicitly; asking a model to
 * extract those would add latency, cost, and a failure mode, to recover
 * information the sentence already contains.
 *
 * The design follows `TaskRouter` (§5.6): classify deterministically first,
 * consult the model only for genuinely ambiguous input. So this module never
 * calls a model. It returns what it could extract plus an honest account of
 * what stayed ambiguous, and the caller decides whether that warrants asking
 * the user or asking a model.
 */

import type { HttpMethod } from '@aica/api-ir';
import { isHttpMethod } from '@aica/api-ir';

export const IntentAction = {
  /** Wire an API endpoint into existing code. */
  integrate: 'integrate',
  /** Repair something that is already there and broken. */
  fix: 'fix',
  /** Change structure without changing behaviour. */
  refactor: 'refactor',
  /** Add or update tests. */
  test: 'test',
  /** Answer a question; make no change. */
  explain: 'explain',
  unknown: 'unknown',
} as const;

export type IntentAction = (typeof IntentAction)[keyof typeof IntentAction];

export interface Intent {
  readonly action: IntentAction;
  /** The request as written, kept so nothing downstream has to paraphrase it. */
  readonly text: string;
  /** An HTTP method named explicitly, in upper case. */
  readonly method?: HttpMethod;
  /** A request path named explicitly, e.g. `/payments`. */
  readonly path?: string;
  /** File paths the user named, verbatim. */
  readonly files: readonly string[];
  /** Identifiers the user named — a component, a function, a type. */
  readonly symbols: readonly string[];
  /** Content words, for searching the API catalog and the code index. */
  readonly terms: readonly string[];
  /**
   * What could not be determined from the text. Non-empty means the caller
   * should resolve it — by matching, by asking a model, or by asking the user —
   * rather than proceeding on an assumption.
   */
  readonly ambiguities: readonly string[];
}

/** Verbs that name an action, checked longest-phrase-first. */
const ACTION_PATTERNS: ReadonlyArray<readonly [RegExp, IntentAction]> = [
  [/\b(integrat|wire|hook|connect|call|consume|add\s+(?:the\s+)?(?:api|endpoint))/i, 'integrate'],
  [/\b(fix|repair|broken|failing|bug|error|not\s+working|regress)/i, 'fix'],
  [/\b(refactor|clean\s*up|restructure|rename|extract|simplif)/i, 'refactor'],
  [/\b(test|spec|coverage)/i, 'test'],
  [/\b(explain|what\s+does|how\s+does|why\s+does|where\s+is|show\s+me|describe)/i, 'explain'],
];

/** `POST /payments` — an explicit endpoint mention. */
const ENDPOINT_PATTERN = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/[^\s`"'<>()|,]*)/;

/**
 * A request path named without a method: "integrate the /refunds endpoint".
 *
 * Worth recognizing separately, because knowing the path but not the method is
 * a different and far more recoverable gap than knowing neither — the path
 * narrows the catalog to a handful of endpoints the user can pick between.
 * A letter is required after the slash so that dates and division do not match.
 */
const BARE_PATH_PATTERN = /(?:^|[\s`"'(])(\/[A-Za-z][^\s`"'<>()|,]*)/;

/** A file path: has a directory separator or a source extension. */
const FILE_PATTERN =
  /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,4}|[\w.-]+\.(?:tsx?|jsx?|mts|cts|mjs|cjs|json|md))/gi;

/** A backticked or capitalised identifier. */
const BACKTICKED = /`([^`]+)`/g;
const IDENTIFIER = /\b([A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)*)\b/g;

export function parseIntent(text: string): Intent {
  const trimmed = text.trim();
  const ambiguities: string[] = [];

  const endpoint = ENDPOINT_PATTERN.exec(trimmed);
  const method =
    endpoint && isHttpMethod(endpoint[1] as string) ? (endpoint[1] as HttpMethod) : undefined;

  const bare = endpoint ? undefined : BARE_PATH_PATTERN.exec(trimmed);
  const rawPath = endpoint ? (endpoint[2] as string) : bare ? (bare[1] as string) : undefined;
  // A file path is not a request path, even though both start with a slash.
  const path =
    rawPath !== undefined && !/\.[a-z]{1,4}$/i.test(rawPath)
      ? stripTrailingPunctuation(rawPath)
      : undefined;

  const files = extractFiles(trimmed);
  const symbols = extractSymbols(trimmed, files);
  const action = classifyAction(trimmed, { hasEndpoint: endpoint !== null || path !== undefined });

  if (action === 'unknown') {
    ambiguities.push('The request does not state what kind of change is wanted.');
  }
  if (action === 'integrate' && method === undefined) {
    // Naming an endpoint without a method is the single most common ambiguity,
    // and guessing GET is how an agent silently reads instead of writing.
    ambiguities.push(
      path === undefined
        ? 'No API endpoint is named, so the one to integrate must be identified by matching.'
        : `No HTTP method is given for "${path}"; several may exist on that path.`,
    );
  }
  if (files.length === 0 && symbols.length === 0) {
    ambiguities.push('No file or symbol is named, so the target must be found by matching.');
  }

  return {
    action,
    text: trimmed,
    ...(method ? { method } : {}),
    ...(path ? { path } : {}),
    files,
    symbols,
    terms: contentTerms(trimmed),
    ambiguities,
  };
}

function classifyAction(text: string, context: { hasEndpoint: boolean }): IntentAction {
  for (const [pattern, action] of ACTION_PATTERNS) {
    if (pattern.test(text)) return action;
  }
  // Naming an endpoint with no verb at all reads as "deal with this endpoint",
  // which in this product means integrating it.
  return context.hasEndpoint ? 'integrate' : 'unknown';
}

function extractFiles(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(FILE_PATTERN)) {
    const candidate = (match[1] as string).replace(/[.,;:]$/, '');
    // A bare `package.json` mention is usually prose, not a target.
    if (candidate.includes('/') || /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(candidate)) {
      found.add(candidate);
    }
  }

  return [...found];
}

function extractSymbols(text: string, files: readonly string[]): string[] {
  const found = new Set<string>();
  const fileText = files.join(' ');

  for (const match of text.matchAll(BACKTICKED)) {
    const value = (match[1] as string).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(value)) found.add(value);
  }

  for (const match of text.matchAll(IDENTIFIER)) {
    const value = match[1] as string;
    // Skip HTTP methods and anything that is part of a path already captured.
    if (isHttpMethod(value)) continue;
    if (fileText.includes(value)) continue;
    // A single capitalised word is usually just the start of a sentence.
    if (!/[a-z]/.test(value) || !/[A-Z].*[a-z].*[A-Z]/.test(value)) continue;
    found.add(value);
  }

  return [...found];
}

function stripTrailingPunctuation(path: string): string {
  return path.replace(/[.,;:]+$/, '');
}

/**
 * Content words for searching. Deliberately keeps short API vocabulary such as
 * `api` and `get`, which a generic stop-word list would discard.
 */
export function contentTerms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'onto',
  'our',
  'please',
  'can',
  'you',
  'should',
  'would',
  'need',
  'want',
  'make',
  'sure',
  'existing',
  'new',
  'use',
  'using',
]);

/** One-line summary for a plan header or a UI row. */
export function describeIntent(intent: Intent): string {
  const endpoint = intent.method && intent.path ? ` ${intent.method} ${intent.path}` : '';
  const target = intent.files[0] ? ` in ${intent.files[0]}` : '';
  return `${intent.action}${endpoint}${target}`;
}
