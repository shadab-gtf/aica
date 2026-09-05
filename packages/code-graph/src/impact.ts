/**
 * Impact analysis: what breaks if this changes.
 *
 * This is the question that decides whether a plan is safe, and it is asked
 * before every non-trivial edit. The answer has to be conservative in one
 * direction and honest in the other:
 *
 * - **Reachability is over-approximate.** Everything that transitively depends
 *   on the target is reported, even where a change might turn out to be
 *   compatible. Missing an affected caller is how an agent ships a break;
 *   listing one extra is how it wastes a reviewer's minute.
 * - **Confidence is not.** Each affected item carries the distance and the
 *   chain of edges that reached it, so "directly calls the function you are
 *   changing" is distinguishable from "imports a module that re-exports it".
 *
 * What this cannot see is stated rather than papered over: dynamic dispatch,
 * reflection, string-keyed access, and member calls whose receiver type is not
 * knowable syntactically produce no edges, so `blindSpots` reports how much of
 * the file's behaviour was invisible to the analysis.
 */

import type { CodeIndex } from '@aica/code-intelligence';

import type { CodeGraph, EdgeKind, GraphNode, PathStep } from './graph.js';
import { NodeKind } from './graph.js';

export interface AffectedItem {
  readonly node: GraphNode;
  /** Hops from the change. 1 means it depends on the target directly. */
  readonly distance: number;
  /** The edge that reached it, for explaining the finding. */
  readonly via: PathStep | undefined;
}

export interface ImpactReport {
  /** The node the analysis started from. */
  readonly target: GraphNode;
  /** Everything that depends on the target, nearest first. */
  readonly affected: readonly AffectedItem[];
  /** Files containing anything affected, which is what a reviewer opens. */
  readonly files: readonly string[];
  /** Affected symbols that the workspace exports, so the blast radius may leave it. */
  readonly publicApi: readonly GraphNode[];
  /** True when the traversal hit its cap and the report is partial. */
  readonly truncated: boolean;
  /**
   * References the index could not attribute, in the files involved. These are
   * the places a change could break something this analysis cannot see.
   */
  readonly blindSpots: readonly BlindSpot[];
}

export interface BlindSpot {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly reason: 'member' | 'unresolved';
}

export interface ImpactOptions {
  /** How far to follow dependents. */
  readonly depth?: number;
  readonly maxNodes?: number;
  /** Restrict the traversal to these edge kinds. */
  readonly kinds?: readonly EdgeKind[];
}

const DEFAULT_DEPTH = 5;
const DEFAULT_MAX_NODES = 300;

/**
 * Edges an impact traversal follows backwards.
 *
 * `declares` and `memberOf` are deliberately absent. A file declaring a symbol
 * is not a dependent of it, and following that edge inbound would let any
 * symbol change reach its own file and from there everything that imports the
 * file — which is to say, a change to one type would report the whole
 * repository as affected. A type's own members are likewise part of the change
 * rather than casualties of it.
 */
const DEFAULT_IMPACT_KINDS: readonly EdgeKind[] = [
  'imports',
  'reExports',
  'calls',
  'constructs',
  'usesType',
  'references',
  'extends',
  'exposes',
];

/**
 * Everything affected by changing a symbol or a file.
 *
 * The traversal runs *inbound*: from the target to the things that depend on
 * it. Running it outbound would answer the opposite question — what the target
 * needs — which is `dependenciesOf`.
 */
export function analyzeImpact(
  graph: CodeGraph,
  index: CodeIndex,
  targetId: string,
  options: ImpactOptions = {},
): ImpactReport | undefined {
  const target = graph.node(targetId);
  if (!target) return undefined;

  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  const reached = graph.reach(targetId, {
    direction: 'in',
    depth: options.depth ?? DEFAULT_DEPTH,
    maxNodes,
    kinds: options.kinds ?? DEFAULT_IMPACT_KINDS,
  });

  reached.delete(targetId);

  const affected: AffectedItem[] = [...reached.entries()]
    .map(([id, entry]) => {
      const node = graph.node(id);
      return node ? { node, distance: entry.depth, via: entry.via } : undefined;
    })
    .filter((item): item is AffectedItem => item !== undefined)
    .sort(
      (left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id),
    );

  const files = [...new Set([target.file, ...affected.map((item) => item.node.file)])].sort();

  const publicApi = affected
    .filter((item) => item.node.kind === NodeKind.symbol && item.node.exported === true)
    .map((item) => item.node);

  return {
    target,
    affected,
    files,
    publicApi,
    truncated: reached.size >= maxNodes - 1,
    blindSpots: findBlindSpots(index, files, target),
  };
}

/**
 * Places in the affected files where the index could not attribute a name.
 *
 * Reported only for names that match the target's own name: a member call
 * `order.status` somewhere in a file that also depends on `Order` may or may
 * not be reaching the thing being changed, and the agent should look rather
 * than assume either way.
 */
function findBlindSpots(
  index: CodeIndex,
  files: readonly string[],
  target: GraphNode,
): BlindSpot[] {
  const spots: BlindSpot[] = [];
  const targetName = target.kind === NodeKind.symbol ? target.label : undefined;
  if (targetName === undefined) return spots;

  for (const path of files) {
    const file = index.file(path);
    if (!file) continue;

    for (const reference of file.references) {
      if (reference.name !== targetName) continue;
      if (reference.symbolId !== undefined) continue;
      if (reference.external === true) continue;

      spots.push({
        file: path,
        name: reference.name,
        line: reference.location.start.line,
        reason: reference.member === true ? 'member' : 'unresolved',
      });
    }
  }

  return spots;
}

/** One-line summary for a plan or a review comment. */
export function describeImpact(report: ImpactReport): string {
  if (report.affected.length === 0) {
    return `Nothing in the workspace depends on ${report.target.label}.`;
  }

  const direct = report.affected.filter((item) => item.distance === 1).length;
  const fileCount = report.files.length;
  const suffix = report.truncated ? ' (partial: traversal limit reached)' : '';
  const exported = report.publicApi.length > 0 ? `, ${report.publicApi.length} exported` : '';

  return `${report.affected.length} affected (${direct} directly${exported}) across ${fileCount} file(s)${suffix}`;
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

/**
 * Import cycles between files.
 *
 * A cycle is worth surfacing on its own — it makes initialization order
 * fragile — and it also bounds impact analysis, since everything in a cycle is
 * affected by a change to anything else in it.
 */
export function findImportCycles(graph: CodeGraph, maxCycles = 50): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const fileNodes = graph.nodes.filter((node) => node.kind === NodeKind.file);
  const importKinds: EdgeKind[] = ['imports', 'reExports'];

  const visit = (id: string): void => {
    if (cycles.length >= maxCycles) return;

    const status = state.get(id);
    if (status === 'done') return;

    if (status === 'visiting') {
      const start = stack.indexOf(id);
      if (start !== -1) cycles.push([...stack.slice(start), id]);
      return;
    }

    state.set(id, 'visiting');
    stack.push(id);

    for (const edge of graph.outgoing(id, importKinds)) visit(edge.to);

    stack.pop();
    state.set(id, 'done');
  };

  for (const node of fileNodes) visit(node.id);

  return cycles;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Files nothing else imports.
 *
 * These are where a codebase is entered — an app entry, a route, a test — and
 * they are the natural place to start reading an unfamiliar repository.
 */
export function findEntryPoints(graph: CodeGraph): string[] {
  return graph.nodes
    .filter((node) => node.kind === NodeKind.file)
    .filter((node) => graph.incoming(node.id, ['imports', 'reExports']).length === 0)
    .map((node) => node.id)
    .sort();
}

/**
 * Symbols nothing in the workspace references.
 *
 * An exported one may be public API with external callers, so exportedness is
 * reported rather than used to filter — deleting something because this list
 * named it would be exactly the kind of confident wrong move the architecture
 * is built to prevent.
 */
export function findUnreferencedSymbols(graph: CodeGraph): GraphNode[] {
  return graph.nodes
    .filter((node) => node.kind === NodeKind.symbol)
    .filter((node) => {
      const inbound = graph.incoming(node.id);
      // Being declared by a file, belonging to a class, or being re-exported by
      // a barrel are all exposure rather than use.
      return inbound.every(
        (edge) => edge.kind === 'declares' || edge.kind === 'memberOf' || edge.kind === 'exposes',
      );
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
