import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { Id, Result, RiskLevel, TargetEnvironment } from '@aica/shared';
import type { ActionKind } from '@aica/security-engine';

/**
 * The tool contract (specification section 15).
 *
 * The model never touches the filesystem, the network, or a shell directly. It
 * selects a tool by name and supplies arguments; everything else is performed
 * by deterministic code behind this interface.
 *
 * A tool declares its own risk and its own action kind, which is what lets the
 * security engine make one uniform policy decision across built-in tools, MCP
 * tools, and API calls.
 */

export const ToolCategory = {
  filesystem: 'filesystem',
  codeIntelligence: 'code-intelligence',
  api: 'api',
  terminal: 'terminal',
  git: 'git',
  validation: 'validation',
  mcp: 'mcp',
  planning: 'planning',
} as const;

export type ToolCategory = (typeof ToolCategory)[keyof typeof ToolCategory];

export interface ToolContext {
  readonly runId: Id<'run'>;
  readonly projectId: Id<'proj'>;
  readonly signal: AbortSignal;
  /** Environment this call targets, when relevant to policy. */
  readonly environment?: TargetEnvironment;
}

/**
 * A tool definition. `Input` is inferred from the Zod schema, so the handler's
 * parameter type and the validation that guards it can never disagree.
 */
export interface ToolDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny, Output = unknown> {
  readonly name: string;
  /** One line shown in the UI. */
  readonly title: string;
  /**
   * Description given to the model. This is the tool's real interface
   * documentation: it must state what the tool does, when to use it, and what
   * it refuses to do.
   */
  readonly description: string;
  readonly category: ToolCategory;
  readonly inputSchema: Schema;
  readonly risk: RiskLevel;
  readonly actionKind: ActionKind;
  /** True when the tool changes state. Read-only tools skip approval. */
  readonly mutates: boolean;
  /** Force confirmation regardless of approval mode. */
  readonly alwaysConfirm?: boolean;
  /** Per-call wall-clock budget; falls back to the dispatcher default. */
  readonly timeoutMs?: number;
  /**
   * Short human-readable subject for the approval prompt and the run timeline,
   * derived from the validated input. Keeps prompts specific ("POST /payments")
   * instead of generic ("execute_request").
   */
  readonly describeCall?: (input: z.infer<Schema>) => string;
  readonly handler: (
    input: z.infer<Schema>,
    context: ToolContext,
  ) => Promise<Result<Output>> | Result<Output>;
}

/** Helper that preserves inference when declaring a tool. */
export function defineTool<Schema extends z.ZodTypeAny, Output>(
  definition: ToolDefinition<Schema, Output>,
): ToolDefinition<Schema, Output> {
  return definition;
}

/** The shape a provider needs in order to advertise a tool to the model. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * Derive the JSON Schema shown to the model from the same Zod schema that
 * validates execution. This is the single point that prevents the advertised
 * contract from drifting from the enforced one.
 */
export function toToolSpec(definition: ToolDefinition): ToolSpec {
  const parameters = zodToJsonSchema(definition.inputSchema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // Providers reject a schema carrying a $schema key or a top-level title.
  delete parameters.$schema;
  delete parameters.title;
  delete parameters.default;

  return {
    name: definition.name,
    description: definition.description,
    parameters,
  };
}
