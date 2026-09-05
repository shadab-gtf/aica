import { z } from 'zod';

import { targetEnvironmentSchema } from './config.js';

/**
 * The client/server protocol (§3): one contract, two implementations.
 *
 * The agent server owns all state and both user interfaces are clients, so this
 * file is the entire API between them. It follows the same rule as the tool
 * registry (§5.5): the schema that *describes* a call is the schema that
 * *guards* it, so the advertised contract and the enforced contract cannot
 * drift apart.
 *
 * Two things are deliberately not defined here.
 *
 * **The event payloads.** `shared` owns the event union (§5.1) as a
 * discriminated TypeScript type, and re-deriving thirty payloads in Zod would
 * create a second authority that could disagree with the first. Events cross
 * the wire inside a validated envelope and are narrowed on `type` by the
 * consumer, against that one definition.
 *
 * **Anything secret.** No schema here carries a credential. The one method that
 * returns a secret value — the reverse call into the editor's SecretStorage —
 * is named for exactly that, so it can be excluded from logging by name rather
 * than by hoping redaction catches it.
 */

/** Where the server may be asked to read an API definition from. */
export const apiImportSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    /** The document itself. Format is detected unless declared. */
    text: z.string().min(1),
    format: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('file'),
    /** Workspace-relative. Absolute paths and traversal are refused. */
    path: z.string().min(1),
    format: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('postman'),
    collectionUid: z.string().min(1),
  }),
]);

export type ApiImportSource = z.infer<typeof apiImportSourceSchema>;

export const projectIdParam = z.object({ projectId: z.string().min(1) });

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export const projectSummarySchema = z.object({
  projectId: z.string(),
  name: z.string(),
  root: z.string(),
  /** Configuration problems, reported rather than thrown so the UI can point at them. */
  configIssues: z.array(z.object({ path: z.string(), message: z.string() })),
  /** True when `agent.config.json` was found; defaults were used otherwise. */
  hasConfig: z.boolean(),
});

export const indexSummarySchema = z.object({
  files: z.number(),
  symbols: z.number(),
  references: z.number(),
  resolvedReferences: z.number(),
  externalReferences: z.number(),
  memberReferences: z.number(),
  unresolvedReferences: z.number(),
  unresolvedImports: z.number(),
  durationMs: z.number(),
  skipped: z.array(z.string()),
  /** Share of references attributed to a declaration, as a display figure. */
  resolutionRate: z.number(),
});

export const apiSummarySchema = z.object({
  apiId: z.string(),
  name: z.string(),
  version: z.string().optional(),
  format: z.string(),
  endpointCount: z.number(),
  servers: z.array(z.string()),
  securitySchemes: z.array(z.string()),
});

export const endpointSummarySchema = z.object({
  id: z.string(),
  apiId: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string().optional(),
  operationId: z.string().optional(),
  tags: z.array(z.string()),
  requiresAuth: z.boolean(),
  /** Where the workspace already calls it, if anywhere. */
  callSites: z.array(z.object({ file: z.string(), line: z.number() })),
});

export const codeMatchSchema = z.object({
  file: z.string(),
  symbol: z.string().optional(),
  line: z.number().optional(),
  kind: z.string(),
  score: z.number(),
  excerpt: z.string().optional(),
});

export const planSummarySchema = z.object({
  planId: z.string(),
  intent: z.object({
    action: z.string(),
    description: z.string(),
    method: z.string().optional(),
    path: z.string().optional(),
  }),
  endpoint: z.object({ method: z.string(), path: z.string() }).optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  steps: z.array(
    z.object({ order: z.number(), description: z.string(), file: z.string().optional() }),
  ),
  targetFiles: z.array(z.string()),
  protectedFiles: z.array(z.string()),
  constraints: z.array(z.string()),
  validation: z.array(z.string()),
  expectedTests: z.array(z.string()),
  openQuestions: z.array(z.string()),
  evidence: z.array(z.string()),
});

export const validationFindingSchema = z.object({
  check: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  code: z.string().optional(),
  testName: z.string().optional(),
});

export const validationSummarySchema = z.object({
  passed: z.boolean(),
  durationMs: z.number(),
  results: z.array(
    z.object({
      check: z.string(),
      passed: z.boolean(),
      durationMs: z.number(),
      timedOut: z.boolean(),
      skippedReason: z.string().optional(),
      findingCount: z.number(),
    }),
  ),
  findings: z.array(validationFindingSchema),
  diagnosis: z
    .object({
      category: z.string(),
      summary: z.string(),
      repairable: z.boolean(),
      rationale: z.string(),
      groups: z.array(
        z.object({
          category: z.string(),
          summary: z.string(),
          files: z.array(z.string()),
          count: z.number(),
          weight: z.number(),
        }),
      ),
    })
    .optional(),
});

export const impactSummarySchema = z.object({
  root: z.string(),
  affected: z.array(
    z.object({ id: z.string(), file: z.string(), name: z.string(), distance: z.number() }),
  ),
  files: z.array(z.string()),
  blindSpots: z.array(z.object({ kind: z.string(), detail: z.string() })),
  truncated: z.boolean(),
});

export const postmanWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
});

export const postmanCollectionSchema = z.object({
  uid: z.string(),
  id: z.string(),
  name: z.string(),
  owner: z.string().optional(),
  updatedAt: z.string().optional(),
});

/**
 * The envelope every event travels in.
 *
 * `payload` is `unknown` on purpose — see the note at the top of this file. The
 * envelope is validated because ordering and correlation depend on it; the
 * payload is narrowed by the consumer against `shared`'s event union.
 */
export const eventNotificationSchema = z.object({
  id: z.string(),
  runId: z.string(),
  projectId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

export const runSummarySchema = z.object({
  runId: z.string(),
  summary: z.string(),
  iterations: z.number(),
  toolCalls: z.number(),
  patchesProposed: z.number(),
  patchesApplied: z.number(),
  filesChanged: z.array(z.string()),
  /** What the run consumed. */
  usage: z.object({
    iterations: z.number(),
    toolCalls: z.number(),
    elapsedMs: z.number(),
    tokens: z.number(),
    costUsd: z.number(),
  }),
  /**
   * What left the machine, by host. Volumes and destinations, never payloads —
   * recording the bodies sent to a model would put a copy of the source on disk.
   */
  egress: z.array(
    z.object({
      host: z.string(),
      requests: z.number(),
      blocked: z.number(),
      requestBytes: z.number(),
    }),
  ),
  /**
   * Absent when nothing was written. "Nothing to validate" and "validation
   * passed" are different outcomes and the UI has to be able to tell them
   * apart.
   */
  validationPassed: z.boolean().optional(),
  stoppedBecause: z.string(),
});

export const patchSummarySchema = z.object({
  patchId: z.string(),
  rationale: z.string(),
  status: z.enum(['proposed', 'applied', 'reverted', 'discarded']),
  proposedAt: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['created', 'modified', 'deleted']),
      linesAdded: z.number(),
      linesRemoved: z.number(),
    }),
  ),
});

/**
 * A patch with both sides of every file.
 *
 * The only shape in this protocol that carries file contents, and it is asked
 * for by exactly one caller: the editor, which cannot render a diff view
 * without them. It is never part of an event, a run record, or a log line.
 */
export const patchContentSchema = z.object({
  patchId: z.string(),
  rationale: z.string(),
  diff: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      before: z.string().optional(),
      after: z.string().optional(),
    }),
  ),
});

export const runRecordSchema = z.object({
  id: z.string(),
  task: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  summary: z.string().optional(),
  toolCalls: z.number(),
  filesChanged: z.number(),
  validationPassed: z.boolean().optional(),
});

export const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  runId: z.string().optional(),
  actor: z.string(),
  action: z.string(),
  subject: z.string(),
  decision: z.string(),
  risk: z.string().optional(),
  reason: z.string().optional(),
});

export const observabilitySchema = z.object({
  runs: z.object({
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    filesChanged: z.number(),
    /**
     * Runs that changed something and passed their checks. Deliberately not
     * "runs that passed": a run that wrote nothing had nothing to validate.
     */
    validated: z.number(),
  }),
  audit: z.object({
    entries: z.number(),
    refusals: z.number(),
    /** What was refused, most recent first. The question this log answers. */
    recentRefusals: z.array(auditEntrySchema),
  }),
  egress: z.object({
    localOnly: z.boolean(),
    blocked: z.number(),
    byHost: z.array(
      z.object({
        host: z.string(),
        kind: z.string(),
        requests: z.number(),
        blocked: z.number(),
        requestBytes: z.number(),
        responseBytes: z.number(),
      }),
    ),
  }),
});

// ---------------------------------------------------------------------------
// Method contracts
// ---------------------------------------------------------------------------

export interface MethodContract<P extends z.ZodTypeAny, R extends z.ZodTypeAny> {
  readonly method: string;
  readonly params: P;
  readonly result: R;
}

function method<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  name: string,
  params: P,
  result: R,
): MethodContract<P, R> {
  return { method: name, params, result };
}

/** Calls the editor makes into the server. */
export const clientMethods = {
  initialize: method(
    'initialize',
    z.object({
      clientName: z.string().min(1),
      clientVersion: z.string().min(1),
      /** Reverse calls this client can answer. The server asks for nothing it did not offer. */
      capabilities: z
        .object({
          secretStorage: z.boolean().default(false),
          approvals: z.boolean().default(false),
        })
        .default({}),
    }),
    z.object({
      serverVersion: z.string(),
      protocolVersion: z.string(),
      methods: z.array(z.string()),
    }),
  ),

  shutdown: method('shutdown', z.object({}).default({}), z.object({ ok: z.literal(true) })),

  openProject: method(
    'project/open',
    z.object({ root: z.string().min(1), name: z.string().min(1).optional() }),
    projectSummarySchema,
  ),

  /**
   * Every project this server has open.
   *
   * The dashboard is started separately from the editor, so it has no way to
   * know a project id. Making it ask for one in configuration would mean
   * pasting a generated identifier into an environment variable to see a page.
   */
  listProjects: method(
    'project/list',
    z.object({}).default({}),
    z.object({ projects: z.array(projectSummarySchema) }),
  ),

  projectStatus: method(
    'project/status',
    projectIdParam,
    z.object({
      project: projectSummarySchema,
      index: indexSummarySchema.optional(),
      apiCount: z.number(),
      planCount: z.number(),
      /** Whether a Postman key reference is configured and resolvable. */
      postmanReady: z.boolean(),
    }),
  ),

  indexCode: method(
    'code/index',
    projectIdParam.extend({
      root: z.string().optional(),
      maxFiles: z.number().int().positive().optional(),
    }),
    indexSummarySchema,
  ),

  searchCode: method(
    'code/search',
    projectIdParam.extend({
      query: z.string().min(1),
      limit: z.number().int().positive().max(200).default(30),
    }),
    z.object({ matches: z.array(codeMatchSchema) }),
  ),

  importApi: method(
    'api/import',
    projectIdParam.extend({ name: z.string().min(1).optional(), source: apiImportSourceSchema }),
    apiSummarySchema,
  ),

  listApis: method('api/list', projectIdParam, z.object({ apis: z.array(apiSummarySchema) })),

  listEndpoints: method(
    'api/endpoints',
    projectIdParam.extend({
      apiId: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().max(500).default(200),
    }),
    z.object({ endpoints: z.array(endpointSummarySchema) }),
  ),

  listPostmanWorkspaces: method(
    'postman/workspaces',
    projectIdParam.extend({ refresh: z.boolean().default(false) }),
    z.object({ workspaces: z.array(postmanWorkspaceSchema) }),
  ),

  listPostmanCollections: method(
    'postman/collections',
    projectIdParam.extend({ workspaceId: z.string().min(1), refresh: z.boolean().default(false) }),
    z.object({ collections: z.array(postmanCollectionSchema) }),
  ),

  createPlan: method(
    'plan/create',
    projectIdParam.extend({ message: z.string().min(1), apiId: z.string().optional() }),
    planSummarySchema,
  ),

  getPlanBrief: method(
    'plan/brief',
    projectIdParam.extend({ planId: z.string().min(1) }),
    z.object({ brief: z.string() }),
  ),

  runValidation: method(
    'validate/run',
    projectIdParam.extend({
      only: z.array(z.string()).optional(),
      runAll: z.boolean().default(false),
    }),
    validationSummarySchema,
  ),

  analyzeImpact: method(
    'impact/analyze',
    projectIdParam.extend({ file: z.string().min(1), symbol: z.string().optional() }),
    impactSummarySchema,
  ),

  /**
   * Start a run.
   *
   * Long by nature — it plans, calls a model, edits, validates and repairs — so
   * progress arrives as events on the notification channel and this resolves
   * only at the end. A client that wants to stop it sends `run/cancel`, or
   * cancels the request itself; both reach the same abort signal.
   */
  startRun: method(
    'run/start',
    projectIdParam.extend({ task: z.string().min(1), apiId: z.string().optional() }),
    runSummarySchema,
  ),

  cancelRun: method(
    'run/cancel',
    z.object({ runId: z.string().min(1) }),
    z.object({ cancelled: z.boolean() }),
  ),

  listRuns: method(
    'run/list',
    projectIdParam.extend({ limit: z.number().int().positive().max(200).default(25) }),
    z.object({ runs: z.array(runRecordSchema) }),
  ),

  listRunEvents: method(
    'run/events',
    z.object({ runId: z.string().min(1), sinceSeq: z.number().int().nonnegative().default(0) }),
    z.object({ events: z.array(eventNotificationSchema) }),
  ),

  listPatches: method(
    'patch/list',
    projectIdParam,
    z.object({ patches: z.array(patchSummarySchema) }),
  ),

  previewPatch: method(
    'patch/preview',
    projectIdParam.extend({ patchId: z.string().min(1) }),
    patchContentSchema,
  ),

  applyPatch: method(
    'patch/apply',
    projectIdParam.extend({ patchId: z.string().min(1) }),
    z.object({ patchId: z.string(), files: z.array(z.string()) }),
  ),

  revertPatch: method(
    'patch/revert',
    projectIdParam.extend({ patchId: z.string().min(1) }),
    z.object({ patchId: z.string(), files: z.array(z.string()) }),
  ),

  /**
   * What this project has done, and what it refused to do.
   *
   * One method rather than three, because the three answers are read together:
   * "it ran twelve times, refused four things, and sent 240KB to one host" is a
   * picture, and the same facts in three places are a scavenger hunt.
   */
  observability: method('observability/summary', projectIdParam, observabilitySchema),

  auditTrail: method(
    'audit/list',
    projectIdParam.extend({
      runId: z.string().optional(),
      refusalsOnly: z.boolean().default(false),
      limit: z.number().int().positive().max(500).default(100),
    }),
    z.object({ entries: z.array(auditEntrySchema) }),
  ),

  discardPatch: method(
    'patch/discard',
    projectIdParam.extend({ patchId: z.string().min(1) }),
    z.object({ patchId: z.string(), discarded: z.boolean() }),
  ),
} as const;

/**
 * Calls the server makes back into the editor.
 *
 * These exist because two capabilities live in the UI process and cannot be
 * moved: the operating system keychain that VS Code exposes as SecretStorage,
 * and the user. The server still decides *whether* a secret is needed and
 * *whether* an operation requires approval — §3's trust boundary is unchanged.
 * It is only asking the process that has hands to use them.
 */
export const serverMethods = {
  /**
   * Read one secret from the editor's SecretStorage.
   *
   * Named so that it is greppable and excludable. The value crosses one local
   * pipe between two processes owned by the same user, is registered with the
   * redactor the moment it arrives, and is never logged, echoed in an event, or
   * placed in model context.
   */
  readSecret: method(
    'client/readSecret',
    z.object({ name: z.string().min(1), reason: z.string().min(1) }),
    z.object({ found: z.boolean(), value: z.string().optional() }),
  ),

  requestApproval: method(
    'client/requestApproval',
    z.object({
      approvalId: z.string().min(1),
      subject: z.string().min(1),
      risk: z.enum(['READ_ONLY', 'LOW_RISK_WRITE', 'HIGH_RISK_WRITE', 'DESTRUCTIVE']),
      detail: z.string(),
      environment: targetEnvironmentSchema.optional(),
    }),
    z.object({ granted: z.boolean(), remembered: z.boolean().default(false) }),
  ),
} as const;

/** Notifications the server pushes. Fire-and-forget by definition. */
export const NOTIFY_EVENT = 'agent/event';
export const NOTIFY_LOG = 'agent/log';

export const logNotificationSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type IndexSummary = z.infer<typeof indexSummarySchema>;
export type ApiSummary = z.infer<typeof apiSummarySchema>;
export type EndpointSummary = z.infer<typeof endpointSummarySchema>;
export type CodeMatch = z.infer<typeof codeMatchSchema>;
export type PlanSummary = z.infer<typeof planSummarySchema>;
export type ValidationSummary = z.infer<typeof validationSummarySchema>;
export type ValidationFindingSummary = z.infer<typeof validationFindingSchema>;
export type ImpactSummary = z.infer<typeof impactSummarySchema>;
export type PostmanWorkspaceSummary = z.infer<typeof postmanWorkspaceSchema>;
export type PostmanCollectionSummary = z.infer<typeof postmanCollectionSchema>;
export type RunSummaryResult = z.infer<typeof runSummarySchema>;
export type AuditEntrySummary = z.infer<typeof auditEntrySchema>;
export type ObservabilitySummary = z.infer<typeof observabilitySchema>;
export type PatchSummary = z.infer<typeof patchSummarySchema>;
export type PatchContent = z.infer<typeof patchContentSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type EventNotification = z.infer<typeof eventNotificationSchema>;
export type LogNotification = z.infer<typeof logNotificationSchema>;

/**
 * What a *caller* must supply, which is not what a handler receives.
 *
 * A field with a default is required in the parsed value and optional in the
 * call — `z.input` is the side of that distinction the client needs, and using
 * `z.infer` here would force every caller to restate every default, which is
 * exactly the drift defaults exist to prevent.
 */
export type ParamsOf<C> = C extends MethodContract<infer P, z.ZodTypeAny> ? z.input<P> : never;

/** What a caller receives: the parsed value, with defaults applied. */
export type ResultOf<C> = C extends MethodContract<z.ZodTypeAny, infer R> ? z.output<R> : never;

/** Bumped when a change would make an older client misread a newer server. */
export const PROTOCOL_VERSION = '1';
