/**
 * The code knowledge graph.
 *
 * The index answers questions about one file at a time. The graph answers the
 * question the agent actually has before it changes anything: *what else does
 * this touch?* It is built entirely from indexed facts — no heuristics, no
 * model — so a path through it is a chain of real declarations and real
 * references that can be shown to the user.
 *
 * Two node kinds, because both questions get asked. "Which files does this
 * change affect" is a module-level question; "who calls this function" is a
 * symbol-level one. Keeping both in one graph means an impact query can cross
 * between them: a change to a symbol reaches its file, which reaches the files
 * that import it, which reach the symbols in those.
 *
 * Edges record *why* a relationship exists. An impact report that says "this
 * component is affected" is much less useful than one that says it is affected
 * because it calls a function whose signature changed.
 */

import type { CodeIndex, FileIndex, SymbolRecord } from '@aica/code-intelligence';

export const NodeKind = {
  file: 'file',
  symbol: 'symbol',
} as const;

export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

export const EdgeKind = {
  /** A file imports another file. */
  imports: 'imports',
  /** A file re-exports from another file. */
  reExports: 'reExports',
  /** A file declares a symbol. */
  declares: 'declares',
  /** A symbol calls another symbol. */
  calls: 'calls',
  /** A symbol names another in a type position. */
  usesType: 'usesType',
  /** A symbol constructs another. */
  constructs: 'constructs',
  /** A symbol reads or writes another. */
  references: 'references',
  /**
   * A module binds a name by importing or re-exporting it. This is exposure,
   * not use: a barrel that re-exports a type does not depend on it the way a
   * function that calls it does, and conflating the two makes every symbol in a
   * repository with an index file look used.
   */
  exposes: 'exposes',
  /** A class or interface extends or implements another. */
  extends: 'extends',
  /** A symbol is a member of a class, interface, or enum. */
  memberOf: 'memberOf',
} as const;

export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

export interface GraphNode {
  /** A file path, or a symbol id. */
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  /** File this node is in, which for a file node is itself. */
  readonly file: string;
  readonly symbolKind?: SymbolRecord['kind'];
  readonly exported?: boolean;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** How many occurrences this edge summarizes. */
  readonly count: number;
}

export type Direction = 'out' | 'in' | 'both';

export interface TraversalOptions {
  readonly depth?: number;
  readonly direction?: Direction;
  /** Restrict to these edge kinds. */
  readonly kinds?: readonly EdgeKind[];
  /** Cap on nodes returned, so one query cannot walk a whole monorepo. */
  readonly maxNodes?: number;
}

/** One hop of a path, kept so a result can explain itself. */
export interface PathStep {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

const DEFAULT_MAX_NODES = 500;

export class CodeGraph {
  private readonly nodesById: ReadonlyMap<string, GraphNode>;
  private readonly out: ReadonlyMap<string, readonly GraphEdge[]>;
  private readonly in: ReadonlyMap<string, readonly GraphEdge[]>;

  constructor(
    readonly nodes: readonly GraphNode[],
    readonly edges: readonly GraphEdge[],
  ) {
    this.nodesById = new Map(nodes.map((node) => [node.id, node]));

    const out = new Map<string, GraphEdge[]>();
    const incoming = new Map<string, GraphEdge[]>();

    for (const edge of edges) {
      const fromList = out.get(edge.from);
      if (fromList) fromList.push(edge);
      else out.set(edge.from, [edge]);

      const toList = incoming.get(edge.to);
      if (toList) toList.push(edge);
      else incoming.set(edge.to, [edge]);
    }

    this.out = out;
    this.in = incoming;
  }

  get nodeCount(): number {
    return this.nodesById.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  node(id: string): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  has(id: string): boolean {
    return this.nodesById.has(id);
  }

  outgoing(id: string, kinds?: readonly EdgeKind[]): readonly GraphEdge[] {
    return filterKinds(this.out.get(id) ?? [], kinds);
  }

  incoming(id: string, kinds?: readonly EdgeKind[]): readonly GraphEdge[] {
    return filterKinds(this.in.get(id) ?? [], kinds);
  }

  /** Nodes declared in a file, plus the file node itself. */
  nodesIn(file: string): GraphNode[] {
    return this.nodes.filter((node) => node.file === file);
  }

  /**
   * Breadth-first traversal from a node, returning what was reached and at what
   * depth. Depth matters: a direct caller and something six hops away are not
   * equally affected, and the caller deserves to know which it is looking at.
   */
  reach(
    start: string,
    options: TraversalOptions = {},
  ): Map<string, { depth: number; via: PathStep | undefined }> {
    const maxDepth = options.depth ?? 3;
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    const direction = options.direction ?? 'out';

    const seen = new Map<string, { depth: number; via: PathStep | undefined }>();
    if (!this.has(start)) return seen;

    seen.set(start, { depth: 0, via: undefined });
    let frontier: string[] = [start];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];

      for (const current of frontier) {
        for (const edge of this.edgesFrom(current, direction, options.kinds)) {
          const neighbour = edge.from === current ? edge.to : edge.from;
          if (seen.has(neighbour)) continue;

          seen.set(neighbour, {
            depth,
            via: { from: edge.from, to: edge.to, kind: edge.kind },
          });
          next.push(neighbour);

          if (seen.size >= maxNodes) return seen;
        }
      }

      frontier = next;
    }

    return seen;
  }

  /** Neighbours of a node, nearest first. */
  neighbors(id: string, options: TraversalOptions = {}): GraphNode[] {
    const reached = this.reach(id, options);
    reached.delete(id);

    return [...reached.entries()]
      .sort((left, right) => left[1].depth - right[1].depth || left[0].localeCompare(right[0]))
      .map(([nodeId]) => this.nodesById.get(nodeId))
      .filter((node): node is GraphNode => node !== undefined);
  }

  /**
   * The induced subgraph over a set of nodes and everything within `depth` of
   * them. This is what gets shown in the dashboard and handed to the model as
   * context: a bounded, relevant slice rather than the whole graph.
   */
  subgraph(ids: readonly string[], options: TraversalOptions = {}): CodeGraph {
    const included = new Set<string>();

    for (const id of ids) {
      for (const nodeId of this.reach(id, {
        ...options,
        direction: options.direction ?? 'both',
      }).keys()) {
        included.add(nodeId);
      }
    }

    const nodes = this.nodes.filter((node) => included.has(node.id));
    const edges = this.edges.filter((edge) => included.has(edge.from) && included.has(edge.to));

    return new CodeGraph(nodes, edges);
  }

  /**
   * Shortest path between two nodes, as the hops that connect them.
   *
   * Used to answer "how does this component end up depending on that type?" —
   * a question whose answer is a chain the user can verify, not an assertion.
   */
  pathBetween(from: string, to: string, options: TraversalOptions = {}): PathStep[] | undefined {
    if (!this.has(from) || !this.has(to)) return undefined;
    if (from === to) return [];

    const maxDepth = options.depth ?? 8;
    const direction = options.direction ?? 'out';

    const cameFrom = new Map<string, PathStep>();
    const seen = new Set<string>([from]);
    let frontier = [from];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];

      for (const current of frontier) {
        for (const edge of this.edgesFrom(current, direction, options.kinds)) {
          const neighbour = edge.from === current ? edge.to : edge.from;
          if (seen.has(neighbour)) continue;

          seen.add(neighbour);
          cameFrom.set(neighbour, { from: edge.from, to: edge.to, kind: edge.kind });

          if (neighbour === to) return rebuildPath(cameFrom, from, to);
          next.push(neighbour);
        }
      }

      frontier = next;
    }

    return undefined;
  }

  private edgesFrom(
    id: string,
    direction: Direction,
    kinds?: readonly EdgeKind[],
  ): readonly GraphEdge[] {
    if (direction === 'out') return this.outgoing(id, kinds);
    if (direction === 'in') return this.incoming(id, kinds);
    return [...this.outgoing(id, kinds), ...this.incoming(id, kinds)];
  }
}

function filterKinds(
  edges: readonly GraphEdge[],
  kinds?: readonly EdgeKind[],
): readonly GraphEdge[] {
  return kinds === undefined ? edges : edges.filter((edge) => kinds.includes(edge.kind));
}

function rebuildPath(
  cameFrom: ReadonlyMap<string, PathStep>,
  from: string,
  to: string,
): PathStep[] {
  const steps: PathStep[] = [];
  let current = to;

  while (current !== from) {
    const step = cameFrom.get(current);
    if (!step) break;
    steps.unshift(step);
    current = step.from === current ? step.to : step.from;
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Reference kinds mapped onto the edge that describes them. */
const REFERENCE_EDGE_KINDS: Readonly<Record<string, EdgeKind>> = {
  call: EdgeKind.calls,
  construct: EdgeKind.constructs,
  type: EdgeKind.usesType,
  read: EdgeKind.references,
  write: EdgeKind.references,
  import: EdgeKind.exposes,
  export: EdgeKind.exposes,
};

/**
 * Build the graph from an index.
 *
 * Only resolved facts become edges. An unresolved reference — a global, a
 * member whose receiver type is unknown — contributes nothing, because an edge
 * to a declaration the index could not find would be an invented relationship,
 * and impact analysis built on invented relationships is worse than none.
 */
export function buildGraph(index: CodeIndex): CodeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addEdge = (from: string, to: string, kind: EdgeKind): void => {
    if (from === to) return;
    if (!nodes.has(from) || !nodes.has(to)) return;

    const key = `${from}\u0000${to}\u0000${kind}`;
    const existing = edges.get(key);
    edges.set(key, { from, to, kind, count: (existing?.count ?? 0) + 1 });
  };

  for (const file of index.files) {
    nodes.set(file.path, {
      id: file.path,
      kind: NodeKind.file,
      label: file.path,
      file: file.path,
    });

    for (const symbol of file.symbols) {
      nodes.set(symbol.id, {
        id: symbol.id,
        kind: NodeKind.symbol,
        label: symbol.name,
        file: file.path,
        symbolKind: symbol.kind,
        exported: symbol.exported,
      });
    }
  }

  for (const file of index.files) {
    addFileEdges(file, addEdge);
    addSymbolEdges(file, addEdge);
  }

  return new CodeGraph([...nodes.values()], [...edges.values()]);
}

function addFileEdges(
  file: FileIndex,
  addEdge: (from: string, to: string, kind: EdgeKind) => void,
): void {
  for (const record of file.imports) {
    if (record.resolvedFile === undefined) continue;
    addEdge(
      file.path,
      record.resolvedFile,
      record.kind === 'reExport' ? EdgeKind.reExports : EdgeKind.imports,
    );
  }

  for (const symbol of file.symbols) {
    addEdge(file.path, symbol.id, EdgeKind.declares);
  }
}

function addSymbolEdges(
  file: FileIndex,
  addEdge: (from: string, to: string, kind: EdgeKind) => void,
): void {
  for (const symbol of file.symbols) {
    if (symbol.container !== undefined) {
      addEdge(symbol.id, `${file.path}#${symbol.container}`, EdgeKind.memberOf);
    }
  }

  for (const reference of file.references) {
    if (reference.symbolId === undefined) continue;

    const edgeKind = REFERENCE_EDGE_KINDS[reference.kind] ?? EdgeKind.references;

    // A reference inside a declaration is that declaration depending on the
    // target; one at file scope is the file depending on it.
    const source = reference.fromSymbolId ?? file.path;
    addEdge(source, reference.symbolId, edgeKind);

    // The containing file depends on it too, which is what lets a file-level
    // impact query work without walking every symbol.
    if (reference.fromSymbolId !== undefined) {
      addEdge(file.path, reference.symbolId, EdgeKind.references);
    }
  }
}
