/**
 * The Model Context Protocol wire surface, as this client uses it.
 *
 * Only the parts the agent needs are modelled: the handshake, tool discovery,
 * tool invocation, and resources. Prompts and sampling are absent because
 * nothing consumes them yet, and a partially-implemented capability that
 * advertises itself is worse than an absent one.
 *
 * **Everything from a server is validated before it is used.** An MCP server is
 * a third-party program, frequently one the user installed with a single line
 * of configuration, and §7 puts its output firmly in the "untrusted data"
 * column. These schemas are the boundary: a response that does not match is a
 * malformed response, not something to pick fields out of hopefully.
 *
 * **Versions are negotiated, not assumed.** The client proposes the newest
 * revision it knows and accepts what the server answers with, provided it is a
 * revision this client can actually speak. Hardcoding one version would break
 * against every server that has not moved to it — and against every server that
 * has moved past it.
 */

import { z } from 'zod';

/**
 * Revisions this client can speak, newest first.
 *
 * The list is ordered because the first entry is what the client proposes. A
 * server answering with something else is honoured if it appears here at all,
 * which is what lets one client talk to servers of different ages.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0] as string;

export const MCP_METHODS = {
  initialize: 'initialize',
  initialized: 'notifications/initialized',
  ping: 'ping',
  listTools: 'tools/list',
  callTool: 'tools/call',
  listResources: 'resources/list',
  readResource: 'resources/read',
  toolListChanged: 'notifications/tools/list_changed',
} as const;

export const serverInfoSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  title: z.string().optional(),
});

export const initializeResultSchema = z.object({
  protocolVersion: z.string(),
  serverInfo: serverInfoSchema,
  capabilities: z
    .object({
      tools: z.object({ listChanged: z.boolean().optional() }).passthrough().optional(),
      resources: z
        .object({ subscribe: z.boolean().optional(), listChanged: z.boolean().optional() })
        .passthrough()
        .optional(),
      prompts: z.object({ listChanged: z.boolean().optional() }).passthrough().optional(),
      logging: z.object({}).passthrough().optional(),
    })
    .passthrough()
    .default({}),
  /**
   * Free text the server suggests adding to the model's context. Carried
   * through so it can be *shown*, and deliberately not injected into a prompt:
   * this is instruction-shaped text from an untrusted program, which §7 says is
   * data.
   */
  instructions: z.string().optional(),
});

/**
 * Hints a server attaches to its own tools.
 *
 * Their name in the specification is the important part: they are *hints*. A
 * server declaring `readOnlyHint: true` is a program asserting it is harmless,
 * which is precisely the assertion that cannot be taken on trust. This client
 * lets a hint raise the risk it assigns and never lower it.
 */
export const toolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .passthrough();

export const mcpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  /**
   * JSON Schema, passed to the model as the tool's contract. Kept as `unknown`
   * rather than modelled: JSON Schema is large, servers use varied dialects,
   * and re-implementing a validator for it here would be a second authority
   * that disagrees with the server's own.
   */
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  annotations: toolAnnotationsSchema.optional(),
});

export const listToolsResultSchema = z.object({
  tools: z.array(mcpToolSchema),
  nextCursor: z.string().optional(),
});

export const contentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    mimeType: z.string().optional(),
    uri: z.string().optional(),
  })
  .passthrough();

export const callToolResultSchema = z.object({
  content: z.array(contentBlockSchema).default([]),
  structuredContent: z.unknown().optional(),
  /**
   * A tool reporting its own failure. Distinct from a JSON-RPC error, which
   * means the *call* failed; this means the call succeeded and the tool did
   * not. The agent has to be able to tell those apart to know whether retrying
   * differently is worth anything.
   */
  isError: z.boolean().optional(),
});

export const resourceSchema = z.object({
  uri: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

export const listResourcesResultSchema = z.object({
  resources: z.array(resourceSchema),
  nextCursor: z.string().optional(),
});

export const readResourceResultSchema = z.object({
  contents: z.array(
    z
      .object({
        uri: z.string(),
        mimeType: z.string().optional(),
        text: z.string().optional(),
        blob: z.string().optional(),
      })
      .passthrough(),
  ),
});

export type McpServerInfo = z.infer<typeof serverInfoSchema>;
export type McpInitializeResult = z.infer<typeof initializeResultSchema>;
export type McpToolDescriptor = z.infer<typeof mcpToolSchema>;
export type McpToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type McpCallResult = z.infer<typeof callToolResultSchema>;
export type McpResource = z.infer<typeof resourceSchema>;

/**
 * Flatten a tool result into text for the model.
 *
 * Non-text blocks are named rather than dropped: "[image/png]" tells the model
 * something came back that it cannot read, which is true and useful, whereas
 * silence would let it conclude the tool returned nothing.
 */
export function renderContent(result: McpCallResult, maxChars = 8000): string {
  const parts = result.content.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'resource' && typeof block.uri === 'string')
      return `[resource ${block.uri}]`;
    return `[${block.mimeType ?? block.type}]`;
  });

  const text = parts.join('\n').trim();
  if (text.length <= maxChars) return text;

  return `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters]`;
}
