/**
 * The Integration Planner: turning evidence into an actionable plan.
 *
 * Everything above this layer — intent, the API catalog, the code index, the
 * graph — produces facts. This turns them into a decision: which endpoint,
 * which files, which constraints, what must be true before the change counts as
 * done.
 *
 * The plan is the product's own intelligence, and it stays here. Whatever
 * executes the plan — a coding agent, a model, a human — receives a brief
 * derived from indexed facts, not the user's raw sentence and not the
 * repository. That is what keeps an execution provider swappable: it is handed
 * a specification, not a research task.
 *
 * Two rules the planner never breaks:
 *
 * - **It plans only what the evidence supports.** No endpoint match means the
 *   plan says so and asks, rather than nominating a plausible endpoint.
 * - **It states what must not change.** An agent given only a goal will happily
 *   rewrite a shared module to reach it; the blast radius from impact analysis
 *   becomes an explicit boundary.
 */

import type { ApiSpec, AuthScheme, Endpoint } from '@aica/api-ir';
import {
  describeAuth,
  effectiveSecurity,
  preferredBody,
  referencedSchemeIds,
  requestSchema,
  successSchema,
  toTypeScript,
} from '@aica/api-ir';
import { EndpointIndex } from '@aica/api-engine';
import type { CodeIndex } from '@aica/code-intelligence';
import type { CodeGraph } from '@aica/code-graph';
import { analyzeImpact } from '@aica/code-graph';

import type { Intent } from './intent.js';
import { describeIntent } from './intent.js';
import type { CallSite, ClientConventions, EndpointMatch, TargetCandidate } from './matching.js';
import { findClientConventions, findTargets, matchEndpoint, relatedFiles } from './matching.js';

export const PlanConfidence = {
  high: 'high',
  medium: 'medium',
  low: 'low',
} as const;

export type PlanConfidence = (typeof PlanConfidence)[keyof typeof PlanConfidence];

export interface PlanStep {
  readonly order: number;
  readonly description: string;
  /** File the step concerns, when it concerns one. */
  readonly file?: string;
}

export interface IntegrationPlan {
  readonly intent: Intent;
  /** The endpoint being integrated, when one was identified. */
  readonly endpoint?: Endpoint;
  readonly spec?: ApiSpec;
  /** Where the codebase already calls this endpoint, if anywhere. */
  readonly existingCallSites: readonly CallSite[];
  /** The repository's observed HTTP and auth conventions. */
  readonly conventions: ClientConventions;
  /** Files the change should preferably touch, best first. */
  readonly targetFiles: readonly string[];
  /**
   * Files that must not be modified unless strictly necessary — shared modules
   * whose blast radius is wide.
   */
  readonly protectedFiles: readonly string[];
  readonly steps: readonly PlanStep[];
  readonly constraints: readonly string[];
  readonly validation: readonly string[];
  readonly expectedTests: readonly string[];
  readonly confidence: PlanConfidence;
  /**
   * Questions the planner could not answer from evidence. A non-empty list at
   * LOW confidence means the user should be asked before anything executes.
   */
  readonly openQuestions: readonly string[];
  /** Every fact above, traced to where it came from. */
  readonly evidence: readonly string[];
}

export interface PlanInputs {
  readonly intent: Intent;
  readonly code: CodeIndex;
  readonly graph?: CodeGraph;
  readonly specs?: readonly ApiSpec[];
  /** Files whose dependents make them risky to edit. */
  readonly protectedFileThreshold?: number;
}

const DEFAULT_PROTECTED_THRESHOLD = 3;

/**
 * A plan naming half the repository is not a plan. Targets are capped hard and
 * additionally filtered by score, so a file that merely shares one word with
 * the request never arrives as somewhere to go and change.
 */
const MAX_TARGET_FILES = 3;

/** A candidate must score at least this fraction of the best to be a target. */
const TARGET_SCORE_FLOOR = 0.25;

/** Added to a file that already calls the endpoint: strong, but below a name. */
const CALL_SITE_BOOST = 40;

/**
 * Build a plan from indexed evidence.
 *
 * Never fails: an under-determined request yields a LOW-confidence plan with
 * open questions, which is a more useful output than an error, because it tells
 * the user exactly what is missing.
 */
export function buildPlan(inputs: PlanInputs): IntegrationPlan {
  const { intent, code } = inputs;
  const evidence: string[] = [];
  const openQuestions: string[] = [...intent.ambiguities];

  const conventions = findClientConventions(code);
  recordConventionEvidence(conventions, evidence);

  const selected = selectEndpoint(intent, inputs.specs ?? [], evidence, openQuestions);
  const match = selected ? matchEndpoint(selected.endpoint, selected.spec, code) : undefined;

  if (match) recordMatchEvidence(match, evidence);

  const targets = selectTargets(intent, code, match, evidence);
  const targetFiles = targets.slice(0, MAX_TARGET_FILES).map((target) => target.file);

  // Protection is computed against the files actually chosen. Excluding every
  // scored candidate instead would silently unprotect a shared module that
  // merely shares vocabulary with the request.
  const protectedFiles = selectProtectedFiles(inputs, targetFiles, evidence);
  if (targetFiles.length === 0) {
    openQuestions.push('No file in the workspace could be identified as the place to change.');
  }

  return {
    intent,
    ...(selected ? { endpoint: selected.endpoint, spec: selected.spec } : {}),
    existingCallSites: match?.callSites ?? [],
    conventions,
    targetFiles,
    protectedFiles,
    steps: buildSteps(intent, selected?.endpoint, match, targetFiles, conventions),
    constraints: buildConstraints(conventions, protectedFiles),
    validation: buildValidation(),
    expectedTests: buildExpectedTests(targetFiles, selected?.endpoint),
    confidence: gradeConfidence(selected !== undefined, match, targetFiles, openQuestions),
    openQuestions,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Endpoint selection
// ---------------------------------------------------------------------------

interface SelectedEndpoint {
  readonly endpoint: Endpoint;
  readonly spec: ApiSpec;
}

function selectEndpoint(
  intent: Intent,
  specs: readonly ApiSpec[],
  evidence: string[],
  openQuestions: string[],
): SelectedEndpoint | undefined {
  if (specs.length === 0) {
    if (intent.action === 'integrate') {
      openQuestions.push('No API specification has been loaded, so no endpoint can be identified.');
    }
    return undefined;
  }

  const index = new EndpointIndex(specs);
  const byId = new Map(specs.flatMap((spec) => spec.endpoints.map((e) => [e.id, spec])));

  // An explicitly named method and path is a decision the user already made.
  if (intent.method && intent.path) {
    const exact = index.find(`${intent.method} ${intent.path}`);
    if (exact) {
      evidence.push(`Endpoint ${exact.endpoint.id} was named in the request.`);
      return { endpoint: exact.endpoint, spec: byId.get(exact.endpoint.id) as ApiSpec };
    }
    openQuestions.push(
      `The request names ${intent.method} ${intent.path}, which is not in any loaded specification.`,
    );
    return undefined;
  }

  const results = index.search(intent.text, {
    limit: 3,
    ...(intent.method ? { method: intent.method } : {}),
  });

  if (results.length === 0) {
    if (intent.action === 'integrate') {
      openQuestions.push('No endpoint in the loaded specifications matches the request.');
    }
    return undefined;
  }

  const best = results[0];
  const runnerUp = results[1];

  // Two endpoints scoring alike is a genuine ambiguity, not a tie to break.
  if (best && runnerUp && runnerUp.score >= best.score * 0.9) {
    openQuestions.push(
      `Several endpoints match: ${results.map((r) => r.record.endpoint.id).join(', ')}. Which is meant?`,
    );
  }

  if (!best) return undefined;

  evidence.push(
    `Endpoint ${best.record.endpoint.id} matched the request on ${best.matchedOn.join(', ')}.`,
  );
  return { endpoint: best.record.endpoint, spec: byId.get(best.record.endpoint.id) as ApiSpec };
}

// ---------------------------------------------------------------------------
// Targets and protection
// ---------------------------------------------------------------------------

function selectTargets(
  intent: Intent,
  code: CodeIndex,
  match: EndpointMatch | undefined,
  evidence: string[],
): TargetCandidate[] {
  const targets = findTargets(code, {
    files: intent.files,
    symbols: intent.symbols,
    terms: intent.terms,
  });

  // Already calling the endpoint is strong evidence that a file is where the
  // change belongs — but it is a boost, not an override. A file the user named
  // outranks it, because they know their codebase better than this does.
  const callSiteFiles = new Set((match?.callSites ?? []).map((site) => site.file));
  if (callSiteFiles.size > 0) {
    evidence.push(`The endpoint is already called in ${[...callSiteFiles].join(', ')}.`);
  }

  const boosted = targets.map((target) =>
    callSiteFiles.has(target.file)
      ? {
          ...target,
          score: target.score + CALL_SITE_BOOST,
          reasons: [...target.reasons, 'already calls this endpoint'],
        }
      : target,
  );

  const ranked = boosted.sort(
    (left, right) => right.score - left.score || left.file.localeCompare(right.file),
  );

  // Everything below a fraction of the best is vocabulary overlap, not a target.
  const best = ranked[0]?.score ?? 0;
  return ranked.filter((target) => target.score >= best * TARGET_SCORE_FLOOR);
}

/**
 * Files a change should stay out of.
 *
 * Derived from impact analysis: a module many others depend on is one where a
 * careless edit is expensive. The planner does not forbid touching them — some
 * changes genuinely require it — it makes the cost explicit.
 */
function selectProtectedFiles(
  inputs: PlanInputs,
  targetFiles: readonly string[],
  evidence: string[],
): string[] {
  const graph = inputs.graph;
  if (!graph) return [];

  const threshold = inputs.protectedFileThreshold ?? DEFAULT_PROTECTED_THRESHOLD;
  const targets = new Set(targetFiles);
  const risky: string[] = [];

  for (const file of inputs.code.files) {
    if (targets.has(file.path)) continue;

    const report = analyzeImpact(graph, inputs.code, file.path, { depth: 2 });
    const dependents = report?.affected.filter((item) => item.node.kind === 'file').length ?? 0;

    if (dependents >= threshold) {
      risky.push(file.path);
      evidence.push(`${file.path} has ${dependents} dependent file(s); editing it is high-impact.`);
    }
  }

  return risky.sort();
}

// ---------------------------------------------------------------------------
// Plan content
// ---------------------------------------------------------------------------

function buildSteps(
  intent: Intent,
  endpoint: Endpoint | undefined,
  match: EndpointMatch | undefined,
  targetFiles: readonly string[],
  conventions: ClientConventions,
): PlanStep[] {
  const steps: PlanStep[] = [];
  const push = (description: string, file?: string): void => {
    steps.push({ order: steps.length + 1, description, ...(file ? { file } : {}) });
  };

  if (endpoint) {
    const clientFile = conventions.clientFiles[0];

    if (match?.implemented) {
      const site = match.callSites[0];
      push(`Extend the existing call to ${endpoint.id} rather than adding a new one.`, site?.file);
    } else if (clientFile) {
      push(
        `Add a function for ${endpoint.id} to the existing API client, beside ${
          conventions.clientFunctions[0]?.name ?? 'its other functions'
        }.`,
        clientFile,
      );
    } else {
      push(`Add a typed function that calls ${endpoint.id}.`);
    }
  }

  for (const file of targetFiles.slice(0, 2)) {
    if (file === conventions.clientFiles[0]) continue;
    push(`Wire the call into ${file}, following the patterns already in it.`, file);
  }

  if (intent.action === 'integrate') {
    push('Handle the loading, error, and success states the surrounding code expects.');
  }

  push('Add or update tests covering the new behaviour, including the failure path.');
  push('Run typecheck, lint, tests, and build; fix anything they report.');

  return steps;
}

function buildConstraints(
  conventions: ClientConventions,
  protectedFiles: readonly string[],
): string[] {
  const constraints: string[] = [];

  if (conventions.httpMechanisms.length > 0) {
    constraints.push(
      `Use the existing HTTP mechanism (${conventions.httpMechanisms.join(', ')}); do not add another HTTP client.`,
    );
  } else {
    constraints.push('Do not add an HTTP client dependency without asking.');
  }

  if (conventions.clientFiles.length > 0) {
    constraints.push(`Reuse the existing API client in ${conventions.clientFiles.join(', ')}.`);
  }

  if (conventions.authHelpers.length > 0) {
    const helper = conventions.authHelpers[0];
    constraints.push(
      `Reuse the existing authentication mechanism (${helper?.name} in ${helper?.location.file}); do not build a second one.`,
    );
  }

  if (conventions.baseUrls.length > 0) {
    const base = conventions.baseUrls[0];
    constraints.push(
      `Use the configured base URL (${base?.symbol?.name ?? 'the existing constant'} in ${base?.file}); do not hard-code a host.`,
    );
  }

  constraints.push('Follow the patterns already present in the files being changed.');
  constraints.push('Do not modify files unrelated to this change.');

  if (protectedFiles.length > 0) {
    constraints.push(
      `Avoid modifying these widely-depended-on files unless strictly necessary: ${protectedFiles.join(', ')}.`,
    );
  }

  constraints.push('Never hard-code a credential; read secrets from the existing configuration.');

  return constraints;
}

function buildValidation(): string[] {
  return [
    'The project typechecks.',
    'The linter passes.',
    'The test suite passes.',
    'The build succeeds.',
    'The request and response shapes match the API specification.',
  ];
}

function buildExpectedTests(
  targetFiles: readonly string[],
  endpoint: Endpoint | undefined,
): string[] {
  const tests: string[] = [];

  if (endpoint) {
    tests.push(`A success path test for ${endpoint.id}.`);
    tests.push(`A failure path test for ${endpoint.id}, asserting the error is surfaced.`);
  }

  for (const file of targetFiles.slice(0, 1)) {
    tests.push(`A test covering the change in ${file}.`);
  }

  return tests;
}

function gradeConfidence(
  hasEndpoint: boolean,
  match: EndpointMatch | undefined,
  targetFiles: readonly string[],
  openQuestions: readonly string[],
): PlanConfidence {
  // Confidence is counted from evidence, never asserted (§5.6).
  let score = 0;
  if (hasEndpoint) score += 2;
  if (match?.implemented) score += 1;
  if (targetFiles.length > 0) score += 1;
  score -= openQuestions.length;

  if (score >= 3) return PlanConfidence.high;
  if (score >= 1) return PlanConfidence.medium;
  return PlanConfidence.low;
}

function recordConventionEvidence(conventions: ClientConventions, evidence: string[]): void {
  if (conventions.clientFiles.length > 0) {
    evidence.push(`API client layer identified: ${conventions.clientFiles.join(', ')}.`);
  }
  if (conventions.httpMechanisms.length > 0) {
    evidence.push(`HTTP mechanism in use: ${conventions.httpMechanisms.join(', ')}.`);
  }
  if (conventions.authHelpers.length > 0) {
    evidence.push(
      `Authentication helper found: ${conventions.authHelpers.map((s) => s.name).join(', ')}.`,
    );
  }
}

function recordMatchEvidence(match: EndpointMatch, evidence: string[]): void {
  for (const site of match.callSites) {
    evidence.push(
      `${site.file}${site.symbol ? ` (${site.symbol.name})` : ''}: ${site.reasons.join('; ')}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface BriefOptions {
  /** Include response and request type shapes. Defaults to true. */
  readonly includeSchemas?: boolean;
  /** Cap on the rendered brief, in characters. */
  readonly maxChars?: number;
}

const DEFAULT_MAX_BRIEF_CHARS = 8000;

/**
 * Render the plan as a brief for whatever will execute it.
 *
 * This is the text handed to a coding agent, and it is assembled entirely from
 * the plan — never from the raw user message and never from a repository dump.
 * It names files, quotes signatures the index actually holds, and states the
 * boundaries, so the executor is told what to do rather than asked to work it
 * out.
 *
 * It contains no credentials by construction: nothing here reads a secret
 * value, only the *names* of the mechanisms that supply them.
 */
export function renderBrief(plan: IntegrationPlan, options: BriefOptions = {}): string {
  const sections: string[] = [];
  const includeSchemas = options.includeSchemas !== false;

  sections.push(`# Objective\n\n${plan.intent.text}`);

  if (plan.endpoint && plan.spec) {
    sections.push(renderEndpoint(plan.endpoint, plan.spec, includeSchemas));
  }

  if (plan.existingCallSites.length > 0) {
    const lines = plan.existingCallSites.map(
      (site) =>
        `- ${site.file}${site.symbol ? ` — ${site.symbol.name}` : ''} (${site.literal.value})`,
    );
    sections.push(
      `# Existing call sites\n\nThis endpoint is already called here:\n${lines.join('\n')}`,
    );
  }

  sections.push(renderConventions(plan.conventions));

  if (plan.targetFiles.length > 0) {
    sections.push(
      `# Files to change\n\nPrefer changing these:\n${plan.targetFiles.map((f) => `- ${f}`).join('\n')}`,
    );
  }

  if (plan.protectedFiles.length > 0) {
    sections.push(
      `# Files to leave alone\n\nDo not modify these unless strictly necessary:\n${plan.protectedFiles
        .map((f) => `- ${f}`)
        .join('\n')}`,
    );
  }

  sections.push(
    `# Steps\n\n${plan.steps.map((step) => `${step.order}. ${step.description}`).join('\n')}`,
  );
  sections.push(`# Constraints\n\n${plan.constraints.map((c) => `- ${c}`).join('\n')}`);

  if (plan.expectedTests.length > 0) {
    sections.push(`# Tests\n\n${plan.expectedTests.map((t) => `- ${t}`).join('\n')}`);
  }

  sections.push(`# Definition of done\n\n${plan.validation.map((v) => `- ${v}`).join('\n')}`);

  const brief = sections.join('\n\n');
  const cap = options.maxChars ?? DEFAULT_MAX_BRIEF_CHARS;
  return brief.length > cap ? `${brief.slice(0, cap)}\n\n[brief truncated]` : brief;
}

function renderEndpoint(endpoint: Endpoint, spec: ApiSpec, includeSchemas: boolean): string {
  const lines: string[] = [`# API endpoint\n`, `${endpoint.method} ${endpoint.path}`];

  if (endpoint.summary) lines.push(endpoint.summary);
  if (spec.servers[0]) lines.push(`Server: ${spec.servers[0].url}`);

  const required = endpoint.parameters.filter((parameter) => parameter.required);
  if (required.length > 0) {
    lines.push(
      `\nRequired parameters:\n${required
        .map((parameter) => `- ${parameter.name} (${parameter.in})`)
        .join('\n')}`,
    );
  }

  const auth = renderAuth(spec, endpoint);
  if (auth) lines.push(`\nAuthentication: ${auth}`);

  if (includeSchemas) {
    const request = requestSchema(endpoint);
    if (request) lines.push(`\nRequest body:\n\`\`\`ts\n${toTypeScript(request)}\n\`\`\``);

    const response = successSchema(endpoint);
    if (response) lines.push(`\nSuccess response:\n\`\`\`ts\n${toTypeScript(response)}\n\`\`\``);

    const media = endpoint.requestBody ? preferredBody(endpoint.requestBody.content) : undefined;
    if (media) lines.push(`\nRequest content type: ${media.mediaType}`);
  }

  return lines.join('\n');
}

/**
 * Describe the authentication an endpoint needs — the scheme, never a value.
 *
 * The IR holds only secret *references*, so there is nothing secret to render;
 * this states that explicitly because the brief is sent to an external service.
 */
function renderAuth(spec: ApiSpec, endpoint: Endpoint): string | undefined {
  const options = effectiveSecurity(spec, endpoint);
  const ids = referencedSchemeIds(options);
  if (ids.length === 0) return undefined;

  const described = ids
    .map((id) => spec.authSchemes.find((scheme: AuthScheme) => scheme.id === id))
    .filter((scheme): scheme is AuthScheme => scheme !== undefined)
    .map((scheme) => describeAuth(scheme));

  if (described.length === 0) return undefined;
  return `${described.join(' or ')}. Use the project's existing credential handling; do not embed a key.`;
}

function renderConventions(conventions: ClientConventions): string {
  const lines: string[] = ['# Existing conventions\n'];

  if (conventions.clientFiles.length > 0) {
    lines.push(`API client: ${conventions.clientFiles.join(', ')}`);
  }
  for (const fn of conventions.clientFunctions.slice(0, 6)) {
    lines.push(`- ${fn.signature ?? fn.name} (${fn.location.file}:${fn.location.start.line})`);
  }
  if (conventions.authHelpers.length > 0) {
    const helper = conventions.authHelpers[0];
    lines.push(`Authentication helper: ${helper?.name} (${helper?.location.file})`);
  }
  if (conventions.httpMechanisms.length > 0) {
    lines.push(`HTTP mechanism: ${conventions.httpMechanisms.join(', ')}`);
  }
  if (conventions.baseUrls[0]) {
    lines.push(
      `Base URL constant: ${conventions.baseUrls[0].symbol?.name} in ${conventions.baseUrls[0].file}`,
    );
  }

  if (lines.length === 1) lines.push('None were detected in the repository.');
  return lines.join('\n');
}

/** One-line summary for a UI row or a log line. */
export function describePlan(plan: IntegrationPlan): string {
  const endpoint = plan.endpoint ? plan.endpoint.id : 'no endpoint identified';
  return `${describeIntent(plan.intent)} — ${endpoint}, ${plan.targetFiles.length} target file(s), confidence ${plan.confidence}`;
}

export { relatedFiles };
