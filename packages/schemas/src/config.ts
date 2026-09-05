import { z } from 'zod';

/**
 * Project configuration (specification section 49), the single schema
 * authority. One Zod definition produces the runtime validator, the static
 * type, and the JSON Schema used for editor completion, so the three cannot
 * drift apart.
 *
 * Every field has a safe default. An absent `agent.config.json` yields a
 * configuration that can read the repository and run nothing else without
 * asking, which is the correct posture for a tool that has not been configured
 * yet.
 */

export const targetEnvironmentSchema = z.enum(['local', 'staging', 'production']);

export const approvalModeSchema = z.enum([
  'readOnly',
  'askAlways',
  'askOnApiAndDestructive',
  'askOnDestructive',
  'reviewEveryPatch',
  'auto',
]);

export const providerKindSchema = z.enum([
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'scripted',
]);

/**
 * A secret is referenced, never embedded. The pattern is enforced here so that
 * a literal key in configuration is a validation failure rather than a leak.
 */
export const secretReferenceSchema = z
  .string()
  .regex(
    /^(env|file|keychain|prompt):[A-Za-z0-9_./-]+$/,
    'Must be a secret reference such as env:PAYMENT_API_KEY, not a literal credential.',
  );

export const modelConfigSchema = z.object({
  provider: providerKindSchema.default('openrouter'),
  /** Provider-specific model identifier, e.g. "anthropic/claude-sonnet-4.5". */
  model: z.string().min(1).default('anthropic/claude-sonnet-4.5'),
  apiKeyRef: secretReferenceSchema.default('env:OPENROUTER_API_KEY'),
  baseUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).default(0),
  maxOutputTokens: z.number().int().positive().max(200_000).default(8_192),
  /** Upper bound on provider/tool round trips in one run. */
  maxIterations: z.number().int().positive().max(200).default(40),
});

export const permissionsConfigSchema = z.object({
  approvalMode: approvalModeSchema.default('askAlways'),
  allowedEnvironments: z.array(targetEnvironmentSchema).default(['local']),
  /** When false the agent may modify code but never send a real request. */
  apiExecutionEnabled: z.boolean().default(false),
  allowedMutationMethods: z
    .array(z.enum(['POST', 'PUT', 'PATCH', 'DELETE']))
    .default(['POST', 'PUT', 'PATCH']),
  /** Extra programs added to the command allowlist, by name only. */
  additionalCommands: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).default([]),
  blockedCommands: z.array(z.string()).default([]),
  /** Permit requests to loopback and private addresses. */
  allowPrivateNetwork: z.boolean().default(false),
  allowInsecureHttp: z.boolean().default(false),
  allowedHosts: z.array(z.string()).default([]),
  blockedHosts: z.array(z.string()).default([]),
});

/**
 * Validation commands (specification section 38). Left empty by default and
 * discovered from the repository's own scripts, because assuming `npm test`
 * is exactly the kind of guess that produces a false "tests passed".
 */
export const validationConfigSchema = z.object({
  typecheck: z.array(z.string()).optional(),
  lint: z.array(z.string()).optional(),
  test: z.array(z.string()).optional(),
  build: z.array(z.string()).optional(),
  e2e: z.array(z.string()).optional(),
  contractTest: z.array(z.string()).optional(),
  /** Wall-clock budget per validation step. */
  timeoutMs: z.number().int().positive().default(300_000),
  /** Bounded auto-repair (specification section 39). */
  maxRepairAttempts: z.number().int().min(0).max(10).default(3),
});

export const mcpServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  /** Environment passed to a stdio server, values as secret references. */
  env: z.record(z.string(), secretReferenceSchema).default({}),
  enabled: z.boolean().default(true),
  /** Tools permitted from this server; empty means all discovered tools. */
  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default([]),
  /** Confirm every tool from this server regardless of its declared risk. */
  requireApproval: z.boolean().default(true),
  allowedEnvironments: z.array(targetEnvironmentSchema).default(['local']),
});

export const apiSourceConfigSchema = z.object({
  name: z.string().min(1),
  format: z
    .enum([
      'openapi',
      'swagger',
      'postman',
      // A collection fetched live from the Postman API rather than read from a
      // file. It reaches the same IR through the same parser; only the
      // transport differs.
      'postman-api',
      'curl',
      'json',
      'yaml',
      'markdown',
      'html',
      'url',
    ])
    .optional(),
  /** Path inside the project, or a URL. */
  source: z.string().min(1),
  baseUrl: z.string().optional(),
  /** Per-environment base URLs. */
  environments: z.record(targetEnvironmentSchema, z.string().url()).default({}),
  authRef: secretReferenceSchema.optional(),
});

/**
 * Connecting to a Postman account.
 *
 * The key is a reference, resolved at use. In the VS Code extension it comes
 * from SecretStorage through the resolver's keychain provider, so the value
 * never lives in a settings file: `keychain:postman`.
 */
export const postmanConfigSchema = z.object({
  apiKeyRef: secretReferenceSchema.optional(),
  /** Workspace the user selected, so the picker can start where they left off. */
  workspaceId: z.string().min(1).optional(),
  /** Collections to import, by uid. */
  collectionUids: z.array(z.string().min(1)).default([]),
  /** How long a fetched workspace or collection stays fresh. */
  cacheTtlMs: z
    .number()
    .int()
    .min(0)
    .default(5 * 60 * 1000),
  requestTimeoutMs: z.number().int().positive().default(20_000),
});

/**
 * Where run history and the code catalog are kept.
 *
 * Postgres, through a local Supabase stack, and local is a security property
 * rather than a deployment preference: a symbol index is a map of a private
 * codebase, and §7 forbids it leaving the machine by accident. The default URL
 * is loopback. Pointing this at a hosted project is possible and deliberate —
 * it takes editing `url` and supplying a key reference — which is the right
 * amount of friction for a decision that changes where source metadata lives.
 *
 * Disabled by default. With no database the server keeps everything in memory
 * and loses it on restart; nothing else changes. Indexing a repository must not
 * require Docker to be running.
 */
export const databaseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url().default('http://127.0.0.1:54321'),
  /**
   * Service-role key, as a reference. The server bypasses row-level security,
   * which is why the schema enables RLS everywhere with no policies: any other
   * key can read nothing.
   */
  serviceKeyRef: secretReferenceSchema.optional(),
  /** Rows per insert when writing an index projection. */
  batchSize: z.number().int().positive().max(5000).default(500),
});

export const privacyConfigSchema = z.object({
  /** Paths never read into model context, beyond the built-in exclusions. */
  excludePaths: z.array(z.string()).default([]),
  /** Additional ignore patterns for indexing. */
  ignorePaths: z.array(z.string()).default([]),
  /** Extra regular expressions treated as secrets during redaction. */
  extraRedactionPatterns: z.array(z.string()).default([]),
  /** Refuse to send any source to an external provider. */
  localOnly: z.boolean().default(false),
});

/**
 * Coding agents this system can delegate implementation to.
 *
 * A coding agent is an execution provider, not the product's intelligence: the
 * planner writes the brief and the validation pipeline decides whether the
 * result is any good. Adding one here is meant to be the whole change needed to
 * switch, which is why nothing provider-specific appears in the schema.
 */
export const codingAgentKindSchema = z.enum(['jules', 'none']);

export const codingAgentConfigSchema = z.object({
  provider: codingAgentKindSchema.default('none'),
  /**
   * Where the API key comes from, e.g. `env:JULES_API_KEY`. A literal key fails
   * validation: the reference is the whole point.
   */
  apiKeyRef: secretReferenceSchema.optional(),
  /** Provider-assigned repository identifier the agent works on. */
  sourceId: z.string().min(1).optional(),
  /** Branch work starts from. Defaults to the repository's own default. */
  startingBranch: z.string().min(1).optional(),
  /**
   * Require the agent to surface its plan for approval before executing.
   * On by default: an agent editing a repository unattended is exactly what the
   * approval gate exists to prevent.
   */
  requirePlanApproval: z.boolean().default(true),
  /** Wall-clock budget for one delegated task. */
  maxDurationMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  /** Automatic repair rounds after a failed validation. */
  maxRepairAttempts: z.number().int().min(0).max(10).default(3),
  pollIntervalMs: z.number().int().positive().default(5_000),
  requestTimeoutMs: z.number().int().positive().default(30_000),
});

export const agentConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  projectName: z.string().min(1).optional(),
  model: modelConfigSchema.default({}),
  permissions: permissionsConfigSchema.default({}),
  validation: validationConfigSchema.default({}),
  privacy: privacyConfigSchema.default({}),
  database: databaseConfigSchema.default({}),
  mcpServers: z.array(mcpServerConfigSchema).default([]),
  codingAgent: codingAgentConfigSchema.default({}),
  apis: z.array(apiSourceConfigSchema).default([]),
  postman: postmanConfigSchema.default({}),
  /** Skills enabled for this project; empty means automatic selection. */
  skills: z.array(z.string()).default([]),
  /** Project conventions the agent must respect, in plain language. */
  conventions: z.array(z.string()).default([]),
});

export type TargetEnvironment = z.infer<typeof targetEnvironmentSchema>;
export type ApprovalModeConfig = z.infer<typeof approvalModeSchema>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;
export type ValidationConfig = z.infer<typeof validationConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type CodingAgentKind = z.infer<typeof codingAgentKindSchema>;
export type CodingAgentConfig = z.infer<typeof codingAgentConfigSchema>;
export type ApiSourceConfig = z.infer<typeof apiSourceConfigSchema>;
export type PostmanConfig = z.infer<typeof postmanConfigSchema>;
export type PrivacyConfig = z.infer<typeof privacyConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** The configuration used when a project has none, favouring safety. */
export function defaultConfig(): AgentConfig {
  return agentConfigSchema.parse({});
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Parse configuration, returning structured issues rather than throwing, so the
 * UI can point at the offending field.
 */
export function parseConfig(
  input: unknown,
): { ok: true; config: AgentConfig } | { ok: false; issues: readonly ConfigIssue[] } {
  const result = agentConfigSchema.safeParse(input);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}
