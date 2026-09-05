/**
 * Internal types to wire shapes.
 *
 * This is the boundary where the server's rich domain objects become the small
 * flat records a UI can render. Keeping it in one place and keeping it pure has
 * a specific payoff: these are the functions that decide what a user interface
 * is *allowed to see*, and a pure function that maps one record to another is
 * something a test can pin down exhaustively.
 *
 * The rule is subtraction, never addition. Nothing here invents a field, infers
 * a value, or fills a gap with a plausible default — an endpoint with no
 * summary arrives at the UI with no summary, because "no description" and "a
 * description we made up" must not look the same to someone deciding whether to
 * trust a plan.
 */

import type { ApiSpec, Endpoint } from '@aica/api-ir';
import { isPublic, referencedSchemeIds } from '@aica/api-ir';
import type { CodeGraph, ImpactReport } from '@aica/code-graph';
import type { CodeIndex, IndexStats, RetrievalResult } from '@aica/code-intelligence';
import type { CallSite, IntegrationPlan } from '@aica/integration-planner';
import type {
  ApiSummary,
  CodeMatch,
  EndpointSummary,
  ImpactSummary,
  IndexSummary,
  PlanSummary,
  ValidationSummary,
} from '@aica/schemas';
import type { Diagnosis, ValidationReport } from '@aica/validation-engine';

export function toIndexSummary(stats: IndexStats, resolutionRate: number): IndexSummary {
  return {
    files: stats.files,
    symbols: stats.symbols,
    references: stats.references,
    resolvedReferences: stats.resolvedReferences,
    externalReferences: stats.externalReferences,
    memberReferences: stats.memberReferences,
    unresolvedReferences: stats.unresolvedReferences,
    unresolvedImports: stats.unresolvedImports,
    durationMs: stats.durationMs,
    skipped: [...stats.skipped],
    resolutionRate,
  };
}

export function toApiSummary(spec: ApiSpec, format: string): ApiSummary {
  return {
    apiId: spec.id,
    name: spec.title,
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    format,
    endpointCount: spec.endpoints.length,
    servers: spec.servers.map((server) => server.url),
    securitySchemes: spec.authSchemes.map((scheme) => scheme.id),
  };
}

/**
 * One endpoint, with the call sites the workspace already has.
 *
 * The call sites are the reason this mapper takes matches rather than reading
 * them itself: "this endpoint is already called in three places" is the single
 * most useful thing the catalog can tell someone about to integrate it, and it
 * is evidence from the index rather than anything the endpoint knows.
 */
export function toEndpointSummary(
  endpoint: Endpoint,
  apiId: string,
  callSites: readonly CallSite[] = [],
): EndpointSummary {
  const requiresAuth =
    endpoint.security.length > 0
      ? !isPublic(endpoint.security)
      : // An endpoint declaring nothing inherits the specification default,
        // which the caller resolves before getting here. Absent both, the
        // honest answer is that no authentication is documented.
        false;

  return {
    id: endpoint.id,
    apiId,
    method: endpoint.method,
    path: endpoint.path,
    ...(endpoint.summary !== undefined ? { summary: endpoint.summary } : {}),
    ...(endpoint.operationId !== undefined ? { operationId: endpoint.operationId } : {}),
    tags: [...endpoint.tags],
    requiresAuth,
    callSites: callSites.map((site) => ({
      file: site.file,
      line: site.literal.location.start.line,
    })),
  };
}

/** Resolve an endpoint's effective security against the specification default. */
export function effectiveSecurity(endpoint: Endpoint, spec: ApiSpec): readonly string[] {
  const options = endpoint.security.length > 0 ? endpoint.security : spec.security;
  return isPublic(options) ? [] : referencedSchemeIds(options);
}

export function toCodeMatches(result: RetrievalResult): CodeMatch[] {
  return result.items.map((item) => ({
    file: item.file,
    ...(item.symbol ? { symbol: item.symbol.name, line: item.symbol.location.start.line } : {}),
    kind: item.symbol?.kind ?? 'file',
    score: Number(item.score.toFixed(3)),
    ...(item.snippet ? { excerpt: item.snippet } : {}),
  }));
}

export function toPlanSummary(planId: string, plan: IntegrationPlan): PlanSummary {
  return {
    planId,
    intent: {
      action: plan.intent.action,
      description: plan.intent.text,
      ...(plan.intent.method ? { method: plan.intent.method } : {}),
      ...(plan.intent.path ? { path: plan.intent.path } : {}),
    },
    ...(plan.endpoint
      ? { endpoint: { method: plan.endpoint.method, path: plan.endpoint.path } }
      : {}),
    confidence: plan.confidence,
    steps: plan.steps.map((step) => ({
      order: step.order,
      description: step.description,
      ...(step.file ? { file: step.file } : {}),
    })),
    targetFiles: [...plan.targetFiles],
    protectedFiles: [...plan.protectedFiles],
    constraints: [...plan.constraints],
    validation: [...plan.validation],
    expectedTests: [...plan.expectedTests],
    openQuestions: [...plan.openQuestions],
    evidence: [...plan.evidence],
  };
}

/**
 * A validation report, with its diagnosis attached.
 *
 * Findings are carried in full rather than summarised into a count. The
 * extension turns each one into an editor diagnostic, and a count cannot be
 * placed on a line.
 */
export function toValidationSummary(
  report: ValidationReport,
  diagnosis?: Diagnosis,
): ValidationSummary {
  return {
    passed: report.passed,
    durationMs: report.durationMs,
    results: report.results.map((result) => ({
      check: result.check,
      passed: result.passed,
      durationMs: result.durationMs,
      timedOut: result.timedOut ?? false,
      ...(result.skippedReason !== undefined ? { skippedReason: result.skippedReason } : {}),
      findingCount: result.findings.length,
    })),
    findings: report.findings.map((finding) => ({
      check: finding.check,
      severity: finding.severity,
      message: finding.message,
      ...(finding.file !== undefined ? { file: finding.file } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      ...(finding.column !== undefined ? { column: finding.column } : {}),
      ...(finding.code !== undefined ? { code: finding.code } : {}),
      ...(finding.testName !== undefined ? { testName: finding.testName } : {}),
    })),
    ...(diagnosis && !diagnosis.passed
      ? {
          diagnosis: {
            category: diagnosis.category,
            summary: diagnosis.summary,
            repairable: diagnosis.repairable,
            rationale: diagnosis.rationale,
            groups: diagnosis.groups.map((group) => ({
              category: group.category,
              summary: group.summary,
              files: [...group.files],
              count: group.findings.length,
              weight: group.weight,
            })),
          },
        }
      : {}),
  };
}

export function toImpactSummary(report: ImpactReport): ImpactSummary {
  return {
    root: report.target.id,
    affected: report.affected.map((item) => ({
      id: item.node.id,
      file: item.node.file,
      name: item.node.label,
      distance: item.distance,
    })),
    files: [...report.files],
    // Blind spots travel to the UI on purpose. A report that lists what it
    // could not see is the difference between "nothing else is affected" and
    // "nothing else that I can prove", and only one of those is true.
    blindSpots: report.blindSpots.map((spot) => ({
      kind: spot.reason,
      detail: `${spot.name} at ${spot.file}:${spot.line}`,
    })),
    truncated: report.truncated,
  };
}

/** Resolve a UI selection — a file, or `file#Symbol` — to a graph node id. */
export function resolveImpactTarget(
  graph: CodeGraph,
  index: CodeIndex,
  file: string,
  symbol?: string,
): string | undefined {
  if (symbol) {
    const id = `${file}#${symbol}`;
    if (graph.node(id)) return id;

    // A symbol named without knowing its file still resolves, provided the name
    // is unambiguous. Guessing between two same-named symbols would produce a
    // confident report about the wrong one.
    const candidates = index.symbolsNamed(symbol);
    if (candidates.length === 1) return candidates[0]?.id;
    return undefined;
  }

  return graph.node(file) ? file : undefined;
}
