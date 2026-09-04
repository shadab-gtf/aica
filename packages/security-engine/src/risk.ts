import type { RiskLevel, TargetEnvironment } from '@aica/shared';

/**
 * Risk classification (specification section 17) and the policy that decides
 * when a human must approve an action (sections 32 and 33).
 *
 * The same four levels apply uniformly to built-in tools, MCP tools, HTTP
 * requests, and shell commands, so there is one place to reason about what the
 * agent is allowed to do rather than a separate rule set per subsystem.
 */
export const RISK_ORDER: readonly RiskLevel[] = [
  'READ_ONLY',
  'LOW_RISK_WRITE',
  'HIGH_RISK_WRITE',
  'DESTRUCTIVE',
];

export function riskRank(level: RiskLevel): number {
  return RISK_ORDER.indexOf(level);
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

export function riskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return riskRank(level) >= riskRank(threshold);
}

/**
 * Interaction modes (specification section 32). The default favours safety:
 * code may be read freely, but nothing is written and no request is executed
 * without a decision.
 */
export const ApprovalMode = {
  /** Approve nothing interactively; only READ_ONLY proceeds. Used in CI. */
  readOnly: 'readOnly',
  /** Ask before any file modification, API execution, or destructive action. */
  askAlways: 'askAlways',
  /** Writes proceed; API execution and destructive actions still ask. */
  askOnApiAndDestructive: 'askOnApiAndDestructive',
  /** Only destructive actions ask. */
  askOnDestructive: 'askOnDestructive',
  /** Every patch is surfaced for review before it is applied. */
  reviewEveryPatch: 'reviewEveryPatch',
  /** Fully autonomous within the configured allowlists. */
  auto: 'auto',
} as const;

export type ApprovalMode = (typeof ApprovalMode)[keyof typeof ApprovalMode];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = ApprovalMode.askAlways;

/** What is being asked about, so the policy can distinguish a write from a call. */
export type ActionKind =
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'patch_apply'
  | 'command'
  | 'api_request'
  | 'git_write'
  | 'mcp_tool'
  | 'other';

export interface ActionDescriptor {
  readonly kind: ActionKind;
  readonly risk: RiskLevel;
  /** Short subject line, e.g. "POST /payments" or "pnpm test". */
  readonly subject: string;
  /** Human-readable specifics, already redacted. */
  readonly detail: string;
  readonly environment?: TargetEnvironment;
  /** HTTP method when the action is an API request. */
  readonly method?: string;
  /** Set when a tool declares its own confirmation requirement. */
  readonly requiresApproval?: boolean;
}

export interface PolicyContext {
  readonly mode: ApprovalMode;
  /** Environments the project permits at all. */
  readonly allowedEnvironments: readonly TargetEnvironment[];
  /**
   * When false, the agent may modify code but must never send a real request.
   * Corresponds to the "should the agent only modify code?" question in
   * specification section 3.
   */
  readonly apiExecutionEnabled: boolean;
  /** Mutating HTTP verbs permitted at all, per project policy. */
  readonly allowedMutationMethods?: readonly string[];
}

export type PolicyDecision =
  | { readonly outcome: 'allow'; readonly reason: string }
  | { readonly outcome: 'require_approval'; readonly reason: string }
  | { readonly outcome: 'deny'; readonly reason: string };

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** HTTP methods that are read-only and therefore safe to run unattended. */
export function isReadOnlyMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
}

/**
 * Classify an HTTP request's risk from its method and target environment.
 *
 * "UPDATE" is not an HTTP method (specification section 4); it is rejected here
 * so that a caller which produced it is forced to resolve it to PUT or PATCH
 * from API semantics rather than having a guess made silently.
 */
export function classifyHttpRisk(
  method: string,
  environment: TargetEnvironment,
): RiskLevel | { readonly invalid: string } {
  const upper = method.toUpperCase();
  if (upper === 'UPDATE') {
    return {
      invalid:
        'UPDATE is not an HTTP method. Resolve it to PUT (full replacement) or PATCH (partial update) from the API specification.',
    };
  }

  if (isReadOnlyMethod(upper)) return 'READ_ONLY';
  if (!MUTATING_METHODS.has(upper)) return 'HIGH_RISK_WRITE';

  if (upper === 'DELETE') return 'DESTRUCTIVE';
  // A mutation against production is a higher class of risk than the same
  // mutation locally, even though the request is identical.
  return environment === 'production' ? 'HIGH_RISK_WRITE' : 'LOW_RISK_WRITE';
}

/**
 * The single decision point for "may the agent do this, and must it ask first?".
 *
 * Denials are absolute and cannot be resolved by asking; they mean the project
 * configuration forbids the action outright.
 */
export function evaluatePolicy(action: ActionDescriptor, context: PolicyContext): PolicyDecision {
  const environment = action.environment;

  if (environment && !context.allowedEnvironments.includes(environment)) {
    return {
      outcome: 'deny',
      reason: `Environment "${environment}" is not in the project's allowed environments (${context.allowedEnvironments.join(', ') || 'none'}).`,
    };
  }

  if (action.kind === 'api_request') {
    if (!context.apiExecutionEnabled) {
      return {
        outcome: 'deny',
        reason:
          'API execution is disabled for this project; the agent may only modify code. Enable it in project configuration to send real requests.',
      };
    }
    if (action.method) {
      const upper = action.method.toUpperCase();
      if (
        MUTATING_METHODS.has(upper) &&
        context.allowedMutationMethods &&
        !context.allowedMutationMethods.map((m) => m.toUpperCase()).includes(upper)
      ) {
        return {
          outcome: 'deny',
          reason: `HTTP ${upper} is not permitted by project policy.`,
        };
      }
    }
    // A destructive production request is never automatic, in any mode
    // (specification section 33).
    if (environment === 'production' && action.risk === 'DESTRUCTIVE') {
      return {
        outcome: 'require_approval',
        reason: 'Destructive production requests always require explicit confirmation.',
      };
    }
  }

  // A tool may demand confirmation regardless of mode.
  if (action.requiresApproval) {
    return { outcome: 'require_approval', reason: 'This operation always requires confirmation.' };
  }

  if (action.risk === 'READ_ONLY' && action.kind !== 'api_request') {
    return { outcome: 'allow', reason: 'Read-only operation.' };
  }

  switch (context.mode) {
    case ApprovalMode.readOnly:
      return action.risk === 'READ_ONLY'
        ? { outcome: 'allow', reason: 'Read-only operation in read-only mode.' }
        : {
            outcome: 'deny',
            reason:
              'The project is in read-only mode; no writes, commands, or requests are permitted.',
          };

    case ApprovalMode.askAlways:
      return {
        outcome: 'require_approval',
        reason: 'Approval mode requires confirmation for every side effect.',
      };

    case ApprovalMode.reviewEveryPatch:
      if (
        action.kind === 'patch_apply' ||
        action.kind === 'file_write' ||
        action.kind === 'file_delete'
      ) {
        return {
          outcome: 'require_approval',
          reason: 'Every patch is reviewed before it is applied.',
        };
      }
      return decideByRisk(action, 'HIGH_RISK_WRITE');

    case ApprovalMode.askOnApiAndDestructive:
      if (action.kind === 'api_request') {
        return isReadOnlyMethod(action.method ?? 'GET')
          ? { outcome: 'allow', reason: 'Read-only request in an approved environment.' }
          : { outcome: 'require_approval', reason: 'Mutating API requests require confirmation.' };
      }
      return decideByRisk(action, 'HIGH_RISK_WRITE');

    case ApprovalMode.askOnDestructive:
      return decideByRisk(action, 'DESTRUCTIVE');

    case ApprovalMode.auto:
      // Even in auto mode, DESTRUCTIVE is confirmed. Autonomy is not licence to
      // delete without asking (specification section 72).
      return decideByRisk(action, 'DESTRUCTIVE');

    default:
      return {
        outcome: 'require_approval',
        reason: 'Unrecognised approval mode; defaulting to ask.',
      };
  }
}

function decideByRisk(action: ActionDescriptor, threshold: RiskLevel): PolicyDecision {
  if (riskAtLeast(action.risk, threshold)) {
    return {
      outcome: 'require_approval',
      reason: `Risk level ${action.risk} requires confirmation.`,
    };
  }
  return { outcome: 'allow', reason: `Risk level ${action.risk} is permitted in this mode.` };
}
