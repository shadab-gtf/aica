/**
 * Wire types for the Jules REST API (`v1alpha`).
 *
 * These mirror the documented API and exist only inside this directory. They
 * are never re-exported from the package, never returned to a caller, and never
 * stored: everything crossing the package boundary is the provider-neutral
 * shape in `contract.ts`. Confining them here is what makes Jules replaceable.
 *
 * Every field is optional, because these describe *what a remote service said*,
 * not what this system requires. A response missing a field it documents is a
 * condition to handle, not a type error to crash on — so the parser validates
 * and the types stay permissive.
 *
 * Source: https://jules.google/docs/api/reference/ (v1alpha), read 2026-09.
 */

/** `https://jules.googleapis.com/v1alpha` unless overridden for testing. */
export const JULES_DEFAULT_BASE_URL = 'https://jules.googleapis.com/v1alpha';

/** The API key header Jules documents. Not `Authorization`. */
export const JULES_API_KEY_HEADER = 'x-goog-api-key';

/**
 * Session lifecycle as Jules reports it.
 *
 * Kept as a string union rather than an enum because the service may add
 * states; an unrecognized value is mapped explicitly rather than crashing.
 */
export type JulesSessionState =
  | 'STATE_UNSPECIFIED'
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'FAILED'
  | 'COMPLETED';

export interface JulesGitHubRepoContext {
  readonly startingBranch?: string;
}

export interface JulesSourceContext {
  /** `sources/{sourceId}`. */
  readonly source?: string;
  readonly githubRepoContext?: JulesGitHubRepoContext;
}

export interface JulesSession {
  /** `sessions/{sessionId}`. */
  readonly name?: string;
  readonly id?: string;
  readonly prompt?: string;
  readonly title?: string;
  readonly sourceContext?: JulesSourceContext;
  readonly requirePlanApproval?: boolean;
  readonly automationMode?: string;
  readonly createTime?: string;
  readonly updateTime?: string;
  readonly state?: JulesSessionState | string;
  /** Web app URL for a human to watch the session. */
  readonly url?: string;
  readonly outputs?: readonly unknown[];
}

export interface JulesCreateSessionRequest {
  readonly prompt: string;
  readonly title?: string;
  readonly sourceContext: {
    readonly source: string;
    readonly githubRepoContext?: { readonly startingBranch?: string };
  };
  readonly requirePlanApproval?: boolean;
}

export interface JulesGitPatch {
  readonly baseCommitId?: string;
  readonly unidiffPatch?: string;
  readonly suggestedCommitMessage?: string;
}

export interface JulesChangeSet {
  readonly source?: string;
  readonly gitPatch?: JulesGitPatch;
}

export interface JulesBashOutput {
  readonly command?: string;
  readonly output?: string;
  readonly exitCode?: number;
}

export interface JulesArtifact {
  readonly changeSet?: JulesChangeSet;
  readonly bashOutput?: JulesBashOutput;
  readonly media?: { readonly mimeType?: string; readonly data?: string };
}

/**
 * An activity. Exactly one of the event fields is populated, which is how the
 * kind is determined — Jules does not send a discriminant field.
 */
export interface JulesActivity {
  readonly name?: string;
  readonly id?: string;
  readonly originator?: string;
  readonly description?: string;
  readonly createTime?: string;
  readonly artifacts?: readonly JulesArtifact[];

  readonly planGenerated?: { readonly id?: string; readonly steps?: readonly unknown[] };
  readonly planApproved?: { readonly planId?: string };
  readonly userMessaged?: { readonly userMessage?: string };
  readonly agentMessaged?: { readonly agentMessage?: string };
  readonly progressUpdated?: { readonly title?: string; readonly description?: string };
  readonly sessionCompleted?: Record<string, unknown>;
  readonly sessionFailed?: { readonly reason?: string };
}

export interface JulesListActivitiesResponse {
  readonly activities?: readonly JulesActivity[];
  readonly nextPageToken?: string;
}

export interface JulesBranch {
  readonly displayName?: string;
}

export interface JulesGitHubRepo {
  readonly owner?: string;
  readonly repo?: string;
  readonly isPrivate?: boolean;
  readonly defaultBranch?: JulesBranch;
  readonly branches?: readonly JulesBranch[];
}

export interface JulesSource {
  /** `sources/{sourceId}`. */
  readonly name?: string;
  readonly id?: string;
  readonly githubRepo?: JulesGitHubRepo;
}

export interface JulesListSourcesResponse {
  readonly sources?: readonly JulesSource[];
  readonly nextPageToken?: string;
}

/** Google's standard error envelope. */
export interface JulesErrorResponse {
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
  };
}
