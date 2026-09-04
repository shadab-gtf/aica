import type { z } from 'zod';

import type { Result } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';

import type { AnyToolDefinition, ToolCategory, ToolDefinition, ToolSpec } from './tool.js';
import { eraseTool, toToolSpec } from './tool.js';

/**
 * The tool registry.
 *
 * Registration is explicit: a tool the agent can call is a tool someone
 * deliberately added. There is no dynamic discovery from the filesystem, and no
 * path by which the model can introduce a new capability mid-run. MCP tools are
 * registered here too, after passing MCP policy, so they are subject to exactly
 * the same dispatch and approval machinery as built-in tools.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  /**
   * Register a tool, preserving its inferred schema and output types at the
   * call site. Erasure for storage happens here, once.
   */
  register<Schema extends z.ZodTypeAny, Output>(
    definition: ToolDefinition<Schema, Output>,
  ): Result<void> {
    return this.registerErased(eraseTool(definition));
  }

  /**
   * Register an already-erased tool. This is the path MCP tools take, since
   * their schemas are discovered at runtime and have no static type.
   */
  registerErased(definition: AnyToolDefinition): Result<void> {
    if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) {
      return err(
        errors.invalidInput(
          `Tool name "${definition.name}" must be lower snake_case, which is what every provider accepts.`,
          { name: definition.name },
        ),
      );
    }
    if (this.tools.has(definition.name)) {
      return err(
        errors.alreadyExists(`A tool named "${definition.name}" is already registered.`, {
          name: definition.name,
        }),
      );
    }
    if (definition.description.trim().length < 20) {
      // A vague description is the most common cause of wrong tool selection,
      // so it is rejected at registration rather than debugged later.
      return err(
        errors.invalidInput(
          `Tool "${definition.name}" needs a description that states what it does and when to use it.`,
          { name: definition.name },
        ),
      );
    }

    this.tools.set(definition.name, definition);
    return ok(undefined);
  }

  /**
   * Register several tools, stopping at the first rejection.
   *
   * Takes already-erased definitions so a heterogeneous array of tools with
   * different schemas can be passed without the caller casting each one.
   */
  registerAll(definitions: readonly AnyToolDefinition[]): Result<void> {
    for (const definition of definitions) {
      const result = this.registerErased(definition);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  list(): readonly AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  byCategory(category: ToolCategory): readonly AnyToolDefinition[] {
    return this.list().filter((tool) => tool.category === category);
  }

  /**
   * Build the tool list advertised to the model.
   *
   * Filtering matters for context cost and for correctness: a run that is only
   * analysing code should not be shown a tool that executes HTTP requests, both
   * to save tokens and to remove the temptation.
   */
  specs(filter?: {
    categories?: readonly ToolCategory[];
    names?: readonly string[];
  }): readonly ToolSpec[] {
    let tools = this.list();
    if (filter?.categories?.length) {
      const allowed = new Set(filter.categories);
      tools = tools.filter((tool) => allowed.has(tool.category));
    }
    if (filter?.names?.length) {
      const allowed = new Set(filter.names);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }
    return tools.map((tool) => toToolSpec(tool));
  }

  /** Names only, for logging and for the UI's tool inventory. */
  names(): readonly string[] {
    return [...this.tools.keys()].sort();
  }
}
