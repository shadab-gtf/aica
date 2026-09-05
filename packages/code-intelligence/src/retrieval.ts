/**
 * Retrieval: assembling context instead of dumping a repository.
 *
 * Specification sections 51 and 63 forbid loading a codebase into a prompt, and
 * this is the mechanism that makes that possible rather than aspirational.
 * Given a question, it returns a *bounded, ranked, explained* slice of the
 * index — and the budget is enforced here, not left to a caller's discretion,
 * because the failure mode being prevented is a caller that means well and
 * passes everything.
 *
 * Three properties matter:
 *
 * - **Deterministic.** Ranking is term overlap over indexed facts. The same
 *   question against the same index returns the same context every time, which
 *   is what makes an agent run reproducible and a golden scenario meaningful.
 * - **Explained.** Every item carries the reasons it was selected. When the
 *   agent later says "I changed this because it calls that", the retrieval step
 *   can be audited rather than trusted.
 * - **Declaration-shaped.** A symbol's signature and doc comment are usually
 *   what answers a question; the whole file rarely is. Retrieval returns
 *   declarations, and the caller reads a full file only when it decides to.
 */

import type { CodeIndex } from './indexer.js';
import type { SymbolRecord } from './symbols.js';

export interface RetrievalQuery {
  /** Natural-language intent, e.g. "cancel an order". */
  readonly text?: string;
  /** Symbol ids already known to be relevant; each is included and expanded. */
  readonly symbols?: readonly string[];
  /** Files already known to be relevant, e.g. the open editor tab. */
  readonly files?: readonly string[];
  /** Follow imports and dependents this many hops from a seed. */
  readonly expandDepth?: number;
  readonly maxItems?: number;
  /** Byte budget across every returned snippet. */
  readonly maxBytes?: number;
}

export interface RetrievedItem {
  readonly file: string;
  readonly symbol?: SymbolRecord;
  readonly score: number;
  /** Why this was selected, in the order the reasons applied. */
  readonly reasons: readonly string[];
  /** Signature plus doc: what goes into the prompt. */
  readonly snippet: string;
  readonly bytes: number;
}

export interface RetrievalResult {
  readonly items: readonly RetrievedItem[];
  readonly bytes: number;
  /** True when the budget cut the results short. */
  readonly truncated: boolean;
  /** Items that scored above zero but did not fit. */
  readonly omitted: number;
}

const DEFAULT_MAX_ITEMS = 24;
const DEFAULT_MAX_BYTES = 24 * 1024;
const DEFAULT_EXPAND_DEPTH = 1;

/** Field weights: a name states what something is, prose only describes it. */
const WEIGHTS = {
  name: 6,
  path: 3,
  doc: 2,
  signature: 1,
  seedSymbol: 100,
  seedFile: 40,
  expanded: 8,
  exported: 1.5,
} as const;

/**
 * Select the most relevant declarations for a query.
 *
 * Seeds — explicitly named symbols and files — always outrank text matches,
 * because the caller already knows those are relevant and retrieval should not
 * second-guess evidence it was handed.
 */
export function retrieve(index: CodeIndex, query: RetrievalQuery = {}): RetrievalResult {
  const maxItems = query.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBytes = query.maxBytes ?? DEFAULT_MAX_BYTES;

  const scores = new Map<string, { score: number; reasons: string[] }>();

  const add = (id: string, amount: number, reason: string): void => {
    const existing = scores.get(id);
    if (existing) {
      existing.score += amount;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      scores.set(id, { score: amount, reasons: [reason] });
    }
  };

  scoreSeeds(index, query, add);
  scoreText(index, query.text, add);

  const ranked = [...scores.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        // A stable tiebreak keeps identical inputs producing identical context.
        left.id.localeCompare(right.id),
    );

  return collect(index, ranked, maxItems, maxBytes);
}

function scoreSeeds(
  index: CodeIndex,
  query: RetrievalQuery,
  add: (id: string, amount: number, reason: string) => void,
): void {
  const depth = query.expandDepth ?? DEFAULT_EXPAND_DEPTH;

  for (const id of query.symbols ?? []) {
    if (index.symbol(id) === undefined) continue;
    add(id, WEIGHTS.seedSymbol, 'named in the request');

    // What the seed uses, and what uses it, are both usually needed to reason
    // about a change to it.
    for (const reference of index.referencesTo(id)) {
      if (reference.fromSymbolId !== undefined) {
        add(reference.fromSymbolId, WEIGHTS.expanded, `references ${labelOf(index, id)}`);
      }
    }
  }

  const seededFiles = new Set(query.files ?? []);
  for (const path of query.files ?? []) {
    const file = index.file(path);
    if (!file) continue;

    for (const symbol of file.symbols) {
      if (symbol.container === undefined) add(symbol.id, WEIGHTS.seedFile, `declared in ${path}`);
    }
  }

  // Expand across module edges, decaying with distance so a direct dependency
  // outranks something two hops away.
  let frontier = [...seededFiles];
  const visited = new Set(frontier);

  for (let hop = 1; hop <= depth; hop += 1) {
    const next: string[] = [];

    for (const path of frontier) {
      for (const neighbour of [...index.dependenciesOf(path), ...index.dependentsOf(path)]) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        next.push(neighbour);

        const file = index.file(neighbour);
        for (const symbol of file?.symbols ?? []) {
          if (symbol.container !== undefined) continue;
          // Only the exported surface of a neighbour is worth pulling in; its
          // internals are not what the caller is looking at.
          if (!symbol.exported) continue;
          add(symbol.id, WEIGHTS.expanded / hop, `imported by or importing ${path}`);
        }
      }
    }

    frontier = next;
  }
}

function scoreText(
  index: CodeIndex,
  text: string | undefined,
  add: (id: string, amount: number, reason: string) => void,
): void {
  const terms = tokenize(text ?? '');
  if (terms.length === 0) return;

  for (const symbol of index.allSymbols) {
    // Members are reached through their container, which carries the context.
    if (symbol.container !== undefined) continue;

    const nameTokens = tokenize(symbol.name);
    const pathTokens = tokenize(symbol.location.file);
    const docTokens = tokenize(symbol.doc ?? '');
    const signatureTokens = tokenize(symbol.signature ?? '');

    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      if (overlaps(nameTokens, term)) {
        score += WEIGHTS.name;
        matched.push(term);
        continue;
      }
      if (overlaps(pathTokens, term)) {
        score += WEIGHTS.path;
        matched.push(term);
        continue;
      }
      if (overlaps(docTokens, term)) {
        score += WEIGHTS.doc;
        matched.push(term);
        continue;
      }
      if (overlaps(signatureTokens, term)) {
        score += WEIGHTS.signature;
        matched.push(term);
      }
    }

    if (score === 0) continue;

    // An exported declaration is more likely to be what someone means than a
    // module-private one of the same name.
    if (symbol.exported) score *= WEIGHTS.exported;

    add(symbol.id, score / terms.length, `matches ${[...new Set(matched)].join(', ')}`);
  }
}

/** Fill the budget in rank order, stopping rather than overflowing it. */
function collect(
  index: CodeIndex,
  ranked: readonly { id: string; score: number; reasons: string[] }[],
  maxItems: number,
  maxBytes: number,
): RetrievalResult {
  const items: RetrievedItem[] = [];
  let bytes = 0;
  let omitted = 0;

  for (const entry of ranked) {
    if (items.length >= maxItems) {
      omitted += 1;
      continue;
    }

    const symbol = index.symbol(entry.id);
    if (!symbol) continue;

    const snippet = renderSnippet(symbol);
    const size = Buffer.byteLength(snippet, 'utf8');

    if (bytes + size > maxBytes) {
      omitted += 1;
      continue;
    }

    bytes += size;
    items.push({
      file: symbol.location.file,
      symbol,
      score: Number(entry.score.toFixed(4)),
      reasons: entry.reasons,
      snippet,
      bytes: size,
    });
  }

  return { items, bytes, truncated: omitted > 0, omitted };
}

/**
 * What actually goes into the prompt for one declaration.
 *
 * Location first, so any claim the model makes about it can be checked against
 * the file; then the doc, then the signature as written.
 */
function renderSnippet(symbol: SymbolRecord): string {
  const header = `${symbol.location.file}:${symbol.location.start.line} — ${symbol.kind} ${symbol.name}`;
  const doc = symbol.doc ? `\n${symbol.doc}` : '';
  const signature = symbol.signature ? `\n${symbol.signature}` : '';
  return `${header}${doc}${signature}`;
}

function labelOf(index: CodeIndex, id: string): string {
  return index.symbol(id)?.name ?? id;
}

/**
 * Split text into lowercase terms, breaking camelCase and path separators, so
 * `fetchOrders` and "fetch orders" produce the same terms.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Deliberately short. Code vocabulary is terse, and a generic stop-word list
 * removes terms like `get` and `type` that carry real meaning here.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'how',
  'does',
  'where',
  'what',
  'src',
]);

/** Exact match, or prefix in either direction so plurals and stems connect. */
function overlaps(tokens: readonly string[], term: string): boolean {
  return tokens.some((token) => token === term || token.startsWith(term) || term.startsWith(token));
}
