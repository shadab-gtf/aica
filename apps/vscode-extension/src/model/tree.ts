/**
 * Tree shapes for the sidebar.
 *
 * Pure descriptors, turned into `vscode.TreeItem`s by a thin adapter. Building
 * them here means the labels, the grouping, and — most importantly — what is
 * shown when there is nothing to show can all be tested directly.
 *
 * That last point is the one worth stating. An empty tree in VS Code renders as
 * blank space, and blank space reads as "this feature is broken" far more often
 * than it reads as "there is nothing here yet". Every view in this file
 * produces an explicit placeholder that says which of the two it is, and what
 * to do next.
 */

import type { ApiSummary, EndpointSummary, PlanSummary, ValidationSummary } from '@aica/schemas';

export type NodeKind =
  | 'api'
  | 'endpoint'
  | 'plan'
  | 'planStep'
  | 'planSection'
  | 'planDetail'
  | 'check'
  | 'finding'
  | 'placeholder';

export interface TreeNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** Codicon id, e.g. `check`, `error`, `symbol-method`. */
  readonly icon?: string;
  readonly children?: readonly TreeNode[];
  /** Set when activating the node should reveal a location. */
  readonly location?: { file: string; line?: number };
  /** Drives `when` clauses for context menus. */
  readonly contextValue?: string;
}

export function placeholder(id: string, label: string, tooltip?: string): TreeNode {
  return {
    id,
    kind: 'placeholder',
    label,
    icon: 'info',
    ...(tooltip !== undefined ? { tooltip } : {}),
  };
}

// ---------------------------------------------------------------------------
// API catalog
// ---------------------------------------------------------------------------

export function apiCatalogTree(
  apis: readonly ApiSummary[],
  endpointsByApi: ReadonlyMap<string, readonly EndpointSummary[]>,
): TreeNode[] {
  if (apis.length === 0) {
    return [
      placeholder(
        'apis:empty',
        'No API imported yet',
        'Import an OpenAPI document, a Postman collection, or a cURL command to populate the catalog.',
      ),
    ];
  }

  return apis.map((api) => {
    const endpoints = endpointsByApi.get(api.apiId) ?? [];

    return {
      id: `api:${api.apiId}`,
      kind: 'api' as const,
      label: api.name,
      description: api.version ? `${api.version} · ${api.format}` : api.format,
      tooltip: describeApi(api),
      icon: 'cloud',
      contextValue: 'aica.api',
      children:
        endpoints.length === 0
          ? [placeholder(`api:${api.apiId}:empty`, 'No endpoints in this specification')]
          : endpoints.map(endpointNode),
    };
  });
}

export function endpointNode(endpoint: EndpointSummary): TreeNode {
  const calls = endpoint.callSites.length;

  return {
    id: `endpoint:${endpoint.apiId}:${endpoint.id}`,
    kind: 'endpoint',
    label: `${endpoint.method} ${endpoint.path}`,
    // The call count is the single most useful fact here: it is the difference
    // between "integrate this" and "this is already wired up".
    description: calls > 0 ? `${calls} call site${calls === 1 ? '' : 's'}` : undefined,
    tooltip: describeEndpoint(endpoint),
    icon: endpoint.requiresAuth ? 'lock' : 'symbol-method',
    contextValue: 'aica.endpoint',
    ...(endpoint.callSites[0]
      ? { location: { file: endpoint.callSites[0].file, line: endpoint.callSites[0].line } }
      : {}),
    ...(calls > 0
      ? {
          children: endpoint.callSites.map((site, index) => ({
            id: `endpoint:${endpoint.apiId}:${endpoint.id}:call:${index}`,
            kind: 'endpoint' as const,
            label: site.file,
            description: `line ${site.line}`,
            icon: 'go-to-file',
            location: { file: site.file, line: site.line },
          })),
        }
      : {}),
  };
}

function describeApi(api: ApiSummary): string {
  const lines = [
    `${api.name}${api.version ? ` ${api.version}` : ''}`,
    `${api.endpointCount} endpoint${api.endpointCount === 1 ? '' : 's'} · imported as ${api.format}`,
  ];
  if (api.servers.length > 0) lines.push(`Servers: ${api.servers.join(', ')}`);
  if (api.securitySchemes.length > 0) {
    // Scheme names only. A scheme is a description of how to authenticate; a
    // credential never reaches this process, let alone a tooltip.
    lines.push(`Security schemes: ${api.securitySchemes.join(', ')}`);
  }
  return lines.join('\n');
}

function describeEndpoint(endpoint: EndpointSummary): string {
  const lines = [`${endpoint.method} ${endpoint.path}`];
  if (endpoint.summary) lines.push(endpoint.summary);
  if (endpoint.operationId) lines.push(`operationId: ${endpoint.operationId}`);
  if (endpoint.tags.length > 0) lines.push(`Tags: ${endpoint.tags.join(', ')}`);
  lines.push(endpoint.requiresAuth ? 'Requires authentication' : 'No authentication documented');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export function planTree(plan: PlanSummary | undefined): TreeNode[] {
  if (!plan) {
    return [
      placeholder(
        'plan:empty',
        'No plan yet',
        'Describe what you want to build and a plan will be constructed from the indexed evidence.',
      ),
    ];
  }

  const nodes: TreeNode[] = [
    {
      id: 'plan:summary',
      kind: 'plan',
      label: plan.endpoint ? `${plan.endpoint.method} ${plan.endpoint.path}` : plan.intent.action,
      description: `${plan.confidence} confidence`,
      tooltip: plan.intent.description,
      icon: confidenceIcon(plan.confidence),
      contextValue: 'aica.plan',
    },
  ];

  // Open questions come first when there are any. A low-confidence plan whose
  // unknowns are three scrolls below the steps invites someone to start
  // executing before reading them.
  if (plan.openQuestions.length > 0) {
    nodes.push(
      section('plan:questions', 'Open questions', 'question', plan.openQuestions, 'unanswered'),
    );
  }

  nodes.push({
    id: 'plan:steps',
    kind: 'planSection',
    label: 'Steps',
    description: `${plan.steps.length}`,
    icon: 'list-ordered',
    children:
      plan.steps.length === 0
        ? [placeholder('plan:steps:empty', 'No steps were derived')]
        : plan.steps.map((step) => ({
            id: `plan:step:${step.order}`,
            kind: 'planStep' as const,
            label: `${step.order}. ${step.description}`,
            ...(step.file ? { description: step.file, location: { file: step.file } } : {}),
            icon: 'circle-outline',
          })),
  });

  if (plan.targetFiles.length > 0) {
    nodes.push(fileSection('plan:targets', 'Target files', 'edit', plan.targetFiles));
  }
  if (plan.protectedFiles.length > 0) {
    nodes.push(
      fileSection(
        'plan:protected',
        'Do not modify',
        'shield',
        plan.protectedFiles,
        'Shared modules whose blast radius is wide.',
      ),
    );
  }
  if (plan.constraints.length > 0) {
    nodes.push(section('plan:constraints', 'Constraints', 'law', plan.constraints));
  }
  if (plan.validation.length > 0) {
    nodes.push(section('plan:validation', 'Validation', 'beaker', plan.validation));
  }
  if (plan.evidence.length > 0) {
    // Every claim above traces to something counted. Showing the evidence is
    // what lets a user disagree with the plan for a specific reason.
    nodes.push(section('plan:evidence', 'Evidence', 'search', plan.evidence));
  }

  return nodes;
}

function section(
  id: string,
  label: string,
  icon: string,
  entries: readonly string[],
  childDescription?: string,
): TreeNode {
  return {
    id,
    kind: 'planSection',
    label,
    description: `${entries.length}`,
    icon,
    children: entries.map((entry, index) => ({
      id: `${id}:${index}`,
      kind: 'planDetail' as const,
      label: entry,
      icon: 'dash',
      ...(childDescription !== undefined ? { description: childDescription } : {}),
    })),
  };
}

function fileSection(
  id: string,
  label: string,
  icon: string,
  files: readonly string[],
  tooltip?: string,
): TreeNode {
  return {
    id,
    kind: 'planSection',
    label,
    description: `${files.length}`,
    icon,
    ...(tooltip !== undefined ? { tooltip } : {}),
    children: files.map((file, index) => ({
      id: `${id}:${index}`,
      kind: 'planDetail' as const,
      label: file,
      icon: 'file-code',
      location: { file },
    })),
  };
}

function confidenceIcon(confidence: PlanSummary['confidence']): string {
  if (confidence === 'high') return 'pass';
  if (confidence === 'medium') return 'warning';
  return 'question';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validationTree(summary: ValidationSummary | undefined): TreeNode[] {
  if (!summary) {
    return [placeholder('validation:empty', 'Not run yet', 'Run the checks to see results here.')];
  }

  const nodes: TreeNode[] = summary.results.map((result) => ({
    id: `check:${result.check}`,
    kind: 'check' as const,
    label: result.check,
    // A skipped check is labelled skipped, never folded into "passed". A check
    // that could not run has not passed.
    description:
      result.skippedReason !== undefined
        ? 'skipped'
        : result.timedOut
          ? 'timed out'
          : `${result.passed ? 'passed' : 'failed'} · ${formatDuration(result.durationMs)}`,
    ...(result.skippedReason !== undefined ? { tooltip: result.skippedReason } : {}),
    icon:
      result.skippedReason !== undefined
        ? 'circle-slash'
        : result.passed
          ? 'pass'
          : result.timedOut
            ? 'watch'
            : 'error',
    ...(result.findingCount > 0
      ? {
          children: summary.findings
            .filter((finding) => finding.check === result.check)
            .map((finding, index) => ({
              id: `check:${result.check}:finding:${index}`,
              kind: 'finding' as const,
              label: finding.testName ? `${finding.testName}: ${finding.message}` : finding.message,
              ...(finding.file
                ? {
                    description: finding.line ? `${finding.file}:${finding.line}` : finding.file,
                    location: {
                      file: finding.file,
                      ...(finding.line ? { line: finding.line } : {}),
                    },
                  }
                : {}),
              icon: finding.severity === 'error' ? 'error' : 'warning',
            })),
        }
      : {}),
  }));

  if (summary.diagnosis) {
    nodes.unshift({
      id: 'validation:diagnosis',
      kind: 'planSection',
      label: summary.diagnosis.summary,
      description: summary.diagnosis.repairable ? 'repairable' : 'not repairable',
      tooltip: summary.diagnosis.rationale,
      icon: summary.diagnosis.repairable ? 'lightbulb' : 'circle-slash',
      children: summary.diagnosis.groups.map((group, index) => ({
        id: `validation:diagnosis:${index}`,
        kind: 'planDetail' as const,
        label: group.summary,
        description: `${group.count} finding${group.count === 1 ? '' : 's'}`,
        ...(group.files[0] ? { location: { file: group.files[0] } } : {}),
        icon: 'debug-breakpoint-data',
      })),
    });
  }

  return nodes.length > 0
    ? nodes
    : [placeholder('validation:none', 'No checks are configured for this project')];
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Flatten a tree, for tests and for a "reveal by id" lookup. */
export function flatten(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}
