/**
 * The tools the agent is given.
 *
 * §5.5 makes this the only route from a model to a side effect, so the set is
 * deliberately small and each entry is deliberately narrow. Three rules decide
 * what is in it:
 *
 * **No tool takes a path it does not check.** Every filesystem path goes
 * through the project's `PathPolicy`, so containment is not a property of the
 * tool being written carefully.
 *
 * **Reading is retrieval, never a dump.** There is no "read the repository"
 * tool. `code_search` returns ranked declarations under a byte budget (§51,
 * §63) and `fs_read` reads one bounded file, because the failure mode this
 * whole system exists to avoid is a model reasoning about a repository it was
 * handed wholesale.
 *
 * **Proposing is not writing.** `propose_patch` computes a preview and stages
 * it; `apply_patch` writes, transactionally, and is the only tool that does.
 * Splitting them is what keeps the diff-review step real: an agent that could
 * only write would make review a formality performed after the fact.
 */

import { z } from 'zod';

import { retrieve } from '@aica/code-intelligence';
import { analyzeImpact, describeImpact } from '@aica/code-graph';
import { makePatch } from '@aica/fs-engine';
import type { FilePatch } from '@aica/fs-engine';
import type { AnyToolDefinition } from '@aica/tool-registry';
import { defineTool, eraseTool } from '@aica/tool-registry';
import type { Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok } from '@aica/shared';

import type { ProjectSession } from '../project.js';
import { resolveImpactTarget } from '../summaries.js';
import type { PatchRegistry } from './patches.js';

export interface ToolsetOptions {
  readonly session: ProjectSession;
  readonly patches: PatchRegistry;
  /** Whether the agent may apply its own patches, or only propose them. */
  readonly canApply: boolean;
}

/**
 * Build the toolset for one project.
 *
 * Closed over the session rather than looked up per call: a tool that resolved
 * its own project from an id would be a tool that could be pointed at another
 * one, and §48's isolation is worth more than the flexibility.
 */
export function buildToolset(options: ToolsetOptions): AnyToolDefinition[] {
  const { session, patches } = options;

  const tools: AnyToolDefinition[] = [
    eraseTool(
      defineTool({
        name: 'code_search',
        title: 'Search the codebase',
        description: [
          'Find declarations relevant to a description of intent, ranked by relevance.',
          'Returns signatures and locations under a size budget, not whole files.',
          'Use this first: it is how you find where something lives without reading the repository.',
        ].join(' '),
        category: 'code-intelligence',
        inputSchema: z.object({
          query: z.string().min(1).describe('What you are looking for, in words.'),
          files: z
            .array(z.string())
            .optional()
            .describe('Files already known to be relevant; each is included and expanded.'),
          maxItems: z.number().int().positive().max(50).default(20),
        }),
        risk: 'READ_ONLY',
        actionKind: 'file_read',
        mutates: false,
        describeCall: (input) => `search: ${input.query}`,
        handler: (input) => {
          const index = session.codeIndex;
          if (!index) return err(notIndexed());

          const result = retrieve(index, {
            text: input.query,
            ...(input.files ? { files: input.files } : {}),
            maxItems: input.maxItems,
          });

          return ok({
            matches: result.items.map((item) => ({
              file: item.file,
              symbol: item.symbol?.name,
              kind: item.symbol?.kind,
              line: item.symbol?.location.start.line,
              signature: item.snippet,
              why: item.reasons.join(', '),
            })),
            // Truncation is reported, not hidden. "These are the matches" and
            // "these are the matches that fit" are different claims.
            truncated: result.truncated,
            omitted: result.omitted,
          });
        },
      }),
    ),

    eraseTool(
      defineTool({
        name: 'fs_read',
        title: 'Read a file',
        description: [
          'Read one file from the project, bounded in size.',
          'Read a file before editing it: an anchored edit needs the exact text it is replacing.',
        ].join(' '),
        category: 'filesystem',
        inputSchema: z.object({
          path: z.string().min(1).describe('Project-relative path.'),
          startLine: z.number().int().positive().optional(),
          endLine: z.number().int().positive().optional(),
        }),
        risk: 'READ_ONLY',
        actionKind: 'file_read',
        mutates: false,
        describeCall: (input) => `read ${input.path}`,
        handler: async (input) => {
          const read = await session.requireReader().read(input.path, {
            ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
            ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
          });
          if (!read.ok) return read;

          return ok({
            path: input.path,
            content: read.value.content,
            truncated: read.value.truncated,
            lines: read.value.totalLines,
            // The hash the agent should pass back as `expectedHash`, so an edit
            // fails loudly if the file changed underneath it (§37).
            hash: read.value.hash,
          });
        },
      }),
    ),

    eraseTool(
      defineTool({
        name: 'fs_list',
        title: 'List files',
        description:
          'List files and directories under a project-relative path, honouring ignore rules.',
        category: 'filesystem',
        inputSchema: z.object({
          path: z.string().default('.'),
          recursive: z.boolean().default(false),
          maxEntries: z.number().int().positive().max(500).default(200),
        }),
        risk: 'READ_ONLY',
        actionKind: 'file_read',
        mutates: false,
        describeCall: (input) => `list ${input.path}`,
        handler: async (input) => {
          const listed = await session
            .requireReader()
            .list(input.path, { recursive: input.recursive, maxEntries: input.maxEntries });
          if (!listed.ok) return listed;

          return ok({
            entries: listed.value.entries.map((entry) => ({
              path: entry.path,
              kind: entry.kind,
              bytes: entry.bytes,
            })),
            truncated: listed.value.truncated,
          });
        },
      }),
    ),

    eraseTool(
      defineTool({
        name: 'api_search',
        title: 'Search the API catalog',
        description: [
          'Find endpoints in the imported API specifications.',
          'Returns method, path, summary, and whether the codebase already calls each one.',
        ].join(' '),
        category: 'api',
        inputSchema: z.object({
          query: z.string().min(1),
          limit: z.number().int().positive().max(50).default(15),
        }),
        risk: 'READ_ONLY',
        actionKind: 'file_read',
        mutates: false,
        describeCall: (input) => `api search: ${input.query}`,
        handler: (input) => {
          const hits = session.endpoints().search(input.query, { limit: input.limit });

          return ok({
            endpoints: hits.map((hit) => ({
              apiId: hit.record.specId,
              id: hit.record.endpoint.id,
              method: hit.record.endpoint.method,
              path: hit.record.endpoint.path,
              summary: hit.record.endpoint.summary,
              score: Number(hit.score.toFixed(3)),
            })),
          });
        },
      }),
    ),

    eraseTool(
      defineTool({
        name: 'api_endpoint',
        title: 'Describe an endpoint',
        description: [
          'Full detail for one endpoint: parameters, request body, responses, and how it authenticates.',
          'Authentication is described as a scheme — never a credential value.',
        ].join(' '),
        category: 'api',
        inputSchema: z.object({
          endpointId: z.string().min(1).describe('For example "POST /orders".'),
          apiId: z.string().optional(),
        }),
        risk: 'READ_ONLY',
        actionKind: 'file_read',
        mutates: false,
        describeCall: (input) => input.endpointId,
        handler: (input) => {
          const record = session.endpoints().find(input.endpointId, input.apiId);
          if (!record) {
            return err(
              new AgentError(ErrorCode.NOT_FOUND, `No endpoint "${input.endpointId}" is imported.`),
            );
          }

          const endpoint = record.endpoint;
          const spec = session.api(record.specId)?.spec;

          return ok({
            id: endpoint.id,
            method: endpoint.method,
            path: endpoint.path,
            summary: endpoint.summary,
            description: endpoint.description,
            servers: (endpoint.servers.length > 0 ? endpoint.servers : (spec?.servers ?? [])).map(
              (server) => server.url,
            ),
            parameters: endpoint.parameters.map((parameter) => ({
              name: parameter.name,
              location: parameter.in,
              required: parameter.required,
              description: parameter.description,
            })),
            requestBody: endpoint.requestBody
              ? {
                  required: endpoint.requestBody.required,
                  mediaTypes: endpoint.requestBody.content.map((entry) => entry.mediaType),
                }
              : undefined,
            responses: endpoint.responses.map((response) => ({
              status: response.status,
              description: response.description,
            })),
            // Scheme identifiers, so a plan can say "use the bearer scheme"
            // without a value ever entering model context.
            securitySchemes: (endpoint.security.length > 0
              ? endpoint.security
              : (spec?.security ?? [])
            )
              .flat()
              .map((requirement) => requirement.schemeId),
          });
        },
      }),
    ),

    eraseTool(
      defineTool({
        name: 'code_impact',
        title: 'Analyze impact',
        description: [
          'What depends on a file or a symbol, and what the analysis could not see.',
          'Use this before changing anything shared. The blind spots are part of the answer.',
        ].join(' '),
        category: 'code-intelligence',
        inputSchema: z.object({
          file: z.string().min(1),
          symbol: z.string().optional(),
        }),
        risk: 'READ_ONLY',
        actionKind: 'file_read',
        mutates: false,
        describeCall: (input) => `impact of ${input.symbol ?? input.file}`,
        handler: (input) => {
          const index = session.codeIndex;
          const graph = session.codeGraph;
          if (!index || !graph) return err(notIndexed());

          const targetId = resolveImpactTarget(graph, index, input.file, input.symbol);
          if (!targetId) {
            return err(
              new AgentError(
                ErrorCode.NOT_FOUND,
                `"${input.symbol ?? input.file}" is not in the index, or the name is ambiguous.`,
              ),
            );
          }

          const report = analyzeImpact(graph, index, targetId);
          if (!report) {
            return err(new AgentError(ErrorCode.NOT_FOUND, `"${targetId}" is not in the graph.`));
          }

          return ok({ summary: describeImpact(report), files: report.files });
        },
      }),
    ),

    eraseTool(
      defineTool({
        name: 'propose_patch',
        title: 'Propose a change',
        description: [
          'Propose an edit for review. This does not write anything.',
          'Prefer anchored edits: give the exact existing text and its replacement.',
          'Pass the hash returned by fs_read as expectedHash so the edit fails loudly if the file changed.',
          'The result is a diff the user reviews; apply_patch is what writes it.',
        ].join(' '),
        category: 'filesystem',
        inputSchema: z.object({
          rationale: z.string().min(1).describe('Why this change, in one or two sentences.'),
          files: z
            .array(
              z.object({
                path: z.string().min(1),
                expectedHash: z.string().optional(),
                edits: z
                  .array(
                    z.object({
                      oldText: z.string().min(1),
                      newText: z.string(),
                      replaceAll: z.boolean().default(false),
                    }),
                  )
                  .optional()
                  .describe('Anchored edits. Preferred.'),
                create: z.string().optional().describe('Contents of a new file.'),
                delete: z.boolean().default(false),
              }),
            )
            .min(1)
            .max(20),
        }),
        // Nothing on disk changes, so this is read-only with respect to the
        // workspace. What it produces is a proposal.
        risk: 'READ_ONLY',
        actionKind: 'file_read',
        mutates: false,
        describeCall: (input) => `propose changes to ${input.files.length} file(s)`,
        handler: async (input) => {
          const filePatches = toFilePatches(input.files);
          if (!filePatches.ok) return filePatches;

          const patch = makePatch(input.rationale, filePatches.value);
          const preview = await session.patchEngine().preview(patch);
          if (!preview.ok) return preview;

          patches.stage(patch, preview.value);

          return ok({
            patchId: patch.id,
            files: preview.value.files,
            diff: preview.value.diff,
            note: options.canApply
              ? 'Staged. Call apply_patch with this patchId to write it.'
              : 'Staged for the user to review. You are not permitted to apply it yourself.',
          });
        },
      }),
    ),
  ];

  if (options.canApply) {
    tools.push(
      eraseTool(
        defineTool({
          name: 'apply_patch',
          title: 'Apply a proposed change',
          description: [
            'Write a previously proposed patch to disk, transactionally.',
            'Either every file is written or none is.',
            'Only patches created by propose_patch in this run can be applied.',
          ].join(' '),
          category: 'filesystem',
          inputSchema: z.object({ patchId: z.string().min(1) }),
          risk: 'HIGH_RISK_WRITE',
          actionKind: 'patch_apply',
          mutates: true,
          describeCall: (input) => {
            const staged = patches.get(input.patchId);
            return staged
              ? `apply changes to ${staged.preview.files.map((file) => file.path).join(', ')}`
              : `apply patch ${input.patchId}`;
          },
          handler: async (input) => {
            const staged = patches.get(input.patchId);
            if (!staged) {
              // An id the agent invented, or one from another run. Applying a
              // patch nobody previewed would bypass review entirely.
              return err(
                new AgentError(
                  ErrorCode.NOT_FOUND,
                  `No patch "${input.patchId}" was proposed in this run. Call propose_patch first.`,
                ),
              );
            }

            const applied = await session.patchEngine().apply(staged.patch);
            if (!applied.ok) return applied;

            patches.markApplied(input.patchId, applied.value);
            return ok({ patchId: input.patchId, files: applied.value.files });
          },
        }),
      ),
    );
  }

  tools.push(
    eraseTool(
      defineTool({
        name: 'validate',
        title: 'Run the project checks',
        description: [
          'Run the configured typecheck, lint, test, and build commands.',
          'Checks stop at the first failure, because later checks tell you nothing once the code does not compile.',
          'A check with no configured command is reported as skipped, not as passed.',
        ].join(' '),
        category: 'validation',
        inputSchema: z.object({
          only: z
            .array(z.enum(['typecheck', 'lint', 'test', 'build', 'contractTest', 'e2e']))
            .optional(),
        }),
        risk: 'LOW_RISK_WRITE',
        actionKind: 'command',
        mutates: false,
        timeoutMs: 10 * 60 * 1000,
        describeCall: (input) => `validate${input.only ? `: ${input.only.join(', ')}` : ''}`,
        handler: async (input, context) => {
          const report = await session.validation().run({
            ...(input.only ? { only: input.only } : {}),
            signal: context.signal,
          });
          if (!report.ok) return report;

          return ok({
            passed: report.value.passed,
            checks: report.value.results.map((result) => ({
              check: result.check,
              passed: result.passed,
              skipped: result.skippedReason,
              findings: result.findings.length,
            })),
            findings: report.value.findings.slice(0, 30).map((finding) => ({
              check: finding.check,
              message: finding.message,
              file: finding.file,
              line: finding.line,
              code: finding.code,
            })),
          });
        },
      }),
    ),
  );

  return tools;
}

function notIndexed(): AgentError {
  return new AgentError(
    ErrorCode.PRECONDITION_FAILED,
    'The project has not been indexed yet, so the codebase cannot be searched.',
  );
}

/** Turn the model's file descriptions into patch operations, or refuse. */
function toFilePatches(
  files: readonly {
    path: string;
    expectedHash?: string;
    edits?: readonly { oldText: string; newText: string; replaceAll: boolean }[];
    create?: string;
    delete: boolean;
  }[],
): Result<FilePatch[]> {
  const patches: FilePatch[] = [];

  for (const file of files) {
    const declared = [
      file.edits?.length ? 'edits' : undefined,
      file.create !== undefined ? 'create' : undefined,
      file.delete ? 'delete' : undefined,
    ].filter((entry) => entry !== undefined);

    if (declared.length !== 1) {
      // Ambiguity here is not recoverable by guessing. "Create this file and
      // also apply these edits to it" has no single correct reading, and
      // picking one silently is how a patch does something nobody asked for.
      return err(
        new AgentError(
          ErrorCode.INVALID_INPUT,
          `"${file.path}" must specify exactly one of edits, create, or delete — it specified ${declared.length === 0 ? 'none' : declared.join(' and ')}.`,
        ),
      );
    }

    if (file.delete) {
      patches.push({
        path: file.path,
        operation: { kind: 'delete' },
        ...(file.expectedHash ? { expectedHash: file.expectedHash } : {}),
      });
      continue;
    }

    if (file.create !== undefined) {
      patches.push({ path: file.path, operation: { kind: 'create', content: file.create } });
      continue;
    }

    patches.push({
      path: file.path,
      operation: {
        kind: 'edit',
        edits: (file.edits ?? []).map((edit) => ({
          oldText: edit.oldText,
          newText: edit.newText,
          replaceAll: edit.replaceAll,
        })),
      },
      ...(file.expectedHash ? { expectedHash: file.expectedHash } : {}),
    });
  }

  return ok(patches);
}
