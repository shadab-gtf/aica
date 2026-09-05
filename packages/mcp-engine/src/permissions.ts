/**
 * What an MCP tool is allowed to do.
 *
 * This is the file that decides whether the whole MCP integration is a
 * capability or a hole, and the reasoning behind it is worth stating plainly.
 *
 * An MCP server is a third-party program the user installed with one line of
 * configuration. It describes its own tools, including hints about whether they
 * are read-only or destructive. Those descriptions are the *only* thing this
 * system knows about what a tool does — it cannot inspect the implementation,
 * and it will not run it to find out.
 *
 * So the rule is: **a server's self-description may raise the risk this system
 * assigns, never lower it.** A tool that says `readOnlyHint: true` is a program
 * asserting it is harmless, which is exactly the assertion that cannot be taken
 * on trust; a tool that says `destructiveHint: true` is volunteering something
 * against its own interest, which is worth acting on. The asymmetry is not
 * pessimism, it is the difference between evidence and a claim.
 *
 * The consequence: an unknown MCP tool defaults to requiring approval. A user
 * who knows better can allowlist a specific tool by name in configuration —
 * which is a decision a person made about a specific tool, not a decision a
 * program made about itself.
 */

import type { McpServerConfig } from '@aica/schemas';
import type { RiskLevel } from '@aica/shared';

import type { McpToolDescriptor } from './protocol.js';

export interface McpToolPolicy {
  readonly risk: RiskLevel;
  /** Whether a call must be confirmed, regardless of the approval mode. */
  readonly alwaysConfirm: boolean;
  /** Whether this tool may be offered to the model at all. */
  readonly allowed: boolean;
  /** Why, in words a user can read in a permission prompt. */
  readonly rationale: string;
}

/**
 * Words in a tool's name that suggest it changes something.
 *
 * Matched against *tokens*, not with a word-boundary regular expression. ``
 * treats `_` as a word character, so `delete` does not match
 * `delete_everything` — and snake_case is the naming convention MCP tools
 * actually use, which would have made this whole heuristic close to useless
 * against real servers while looking correct in a test with a spaced name.
 */
const MUTATING_WORDS: ReadonlySet<string> = new Set([
  'write',
  'create',
  'update',
  'delete',
  'remove',
  'drop',
  'insert',
  'patch',
  'put',
  'post',
  'send',
  'exec',
  'execute',
  'run',
  'install',
  'uninstall',
  'deploy',
  'publish',
  'push',
  'merge',
  'revoke',
  'grant',
  'reset',
  'set',
  'add',
  'edit',
  'modify',
  'rename',
  'move',
]);

/** Words that suggest something irreversible. */
const DESTRUCTIVE_WORDS: ReadonlySet<string> = new Set([
  'delete',
  'destroy',
  'drop',
  'purge',
  'wipe',
  'truncate',
  'remove',
  'revoke',
  'force',
  'reset',
  'erase',
  'kill',
  'terminate',
  'uninstall',
]);

/**
 * Split a tool name into words.
 *
 * Handles the three conventions a server might use — `delete_file`,
 * `deleteFile`, `delete-file` — because which one a server picked says nothing
 * about what its tools do.
 */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

function hasWord(name: string, words: ReadonlySet<string>): boolean {
  return tokenize(name).some((token) => words.has(token));
}

/**
 * Classify one discovered tool.
 *
 * Deterministic, and derived only from the server's declaration plus the
 * project's configuration. No model is consulted: a risk assessment produced by
 * a model could not be used to decide whether to trust a model.
 */
export function classifyMcpTool(tool: McpToolDescriptor, config: McpServerConfig): McpToolPolicy {
  const trusted = config.trustedTools.includes(tool.name);
  const denied = config.deniedTools.includes(tool.name);
  // An empty allowlist means every discovered tool; a non-empty one narrows the
  // set without saying anything about whether those tools are safe.
  const inScope = config.allowedTools.length === 0 || config.allowedTools.includes(tool.name);

  if (denied) {
    return {
      risk: 'DESTRUCTIVE',
      alwaysConfirm: true,
      allowed: false,
      rationale: `"${tool.name}" is denied by this project's configuration.`,
    };
  }

  if (!inScope) {
    return {
      risk: 'HIGH_RISK_WRITE',
      alwaysConfirm: true,
      allowed: false,
      rationale: `"${tool.name}" is not in this server's allowed tool list.`,
    };
  }

  const annotations = tool.annotations ?? {};
  const name = `${tool.name} ${tool.title ?? ''}`;

  // Start from the least trusting reading, then look for reasons to move.
  let risk: RiskLevel = 'HIGH_RISK_WRITE';
  let rationale =
    'An MCP tool whose behaviour this system cannot verify. Treated as a write until proven otherwise.';

  if (annotations.destructiveHint === true) {
    risk = 'DESTRUCTIVE';
    rationale = `"${tool.name}" declares itself destructive.`;
  } else if (hasWord(name, DESTRUCTIVE_WORDS)) {
    // The name is evidence the server did not intend to give.
    risk = 'DESTRUCTIVE';
    rationale = `"${tool.name}" is named like an irreversible operation.`;
  } else if (annotations.readOnlyHint === true) {
    if (hasWord(name, MUTATING_WORDS)) {
      // A tool called `delete_file` that claims to be read-only is either
      // mislabelled or lying. Either way the claim is worth nothing.
      risk = 'HIGH_RISK_WRITE';
      rationale = `"${tool.name}" claims to be read-only but is named like a write. The claim is not trusted.`;
    } else {
      // Still not READ_ONLY: this is a hint, and the tool has not been seen.
      // What it buys is one step down, not a free pass.
      risk = 'LOW_RISK_WRITE';
      rationale = `"${tool.name}" declares itself read-only. A server's claim about itself is a hint, so it still requires confirmation unless allowlisted.`;
    }
  }

  if (trusted) {
    // A person decided about this specific tool. That is the only thing that
    // moves a tool to READ_ONLY, and even then a destructive declaration wins:
    // a user trusting `delete_everything` has probably not read its
    // description.
    if (risk === 'DESTRUCTIVE') {
      return {
        risk,
        alwaysConfirm: true,
        allowed: true,
        rationale: `${rationale} It is trusted, but a destructive tool is confirmed every time.`,
      };
    }
    return {
      risk: 'READ_ONLY',
      alwaysConfirm: false,
      allowed: true,
      rationale: `"${tool.name}" is trusted by this project's configuration.`,
    };
  }

  return {
    risk,
    // `requireApproval` defaults to true in the schema, which is the posture an
    // unconfigured server should have.
    alwaysConfirm: config.requireApproval || risk === 'DESTRUCTIVE',
    allowed: true,
    rationale,
  };
}

/**
 * Whether a server may be used in the environment a run targets.
 *
 * A server that is fine against a local sandbox is not automatically fine
 * against production, and the configuration says which environments it was
 * approved for.
 */
export function serverPermittedIn(
  config: McpServerConfig,
  environment: string,
): { permitted: boolean; reason: string } {
  if (!config.enabled) {
    return { permitted: false, reason: `The "${config.name}" server is disabled.` };
  }

  if (!config.allowedEnvironments.includes(environment as never)) {
    return {
      permitted: false,
      reason: `The "${config.name}" server is not permitted against ${environment}. It allows: ${config.allowedEnvironments.join(', ')}.`,
    };
  }

  return {
    permitted: true,
    reason: `The "${config.name}" server is permitted against ${environment}.`,
  };
}

/**
 * The name an MCP tool is registered under.
 *
 * Namespaced by server, for two reasons. Two servers may both offer `search`,
 * and a bare name would let one shadow the other — a silent capability swap
 * that nobody would notice. And a prefixed name makes it visible in a run
 * timeline and an approval prompt that this call is leaving the system.
 */
export function qualifiedToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitize(serverName)}__${sanitize(toolName)}`;
}

/**
 * Recover the server and tool from a qualified name.
 *
 * Both halves are sanitized, so this recovers the *sanitized* names rather than
 * the originals — enough to explain a permission prompt or a timeline entry,
 * and deliberately not used to route a call. The registry keeps the real
 * descriptor, and that is what is sent back to the server.
 */
export function parseQualifiedName(
  qualified: string,
): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(qualified);
  if (!match?.[1] || !match[2]) return undefined;
  return { server: match[1], tool: match[2] };
}

/**
 * Make a name safe to advertise as a tool name.
 *
 * Lower snake_case, which is what the tool registry requires and what every
 * provider accepts. A server is free to call a tool anything at all —
 * `list-files`, `listFiles`, `List Files` — so substituting rather than
 * rejecting keeps a usable tool usable. The original name is still what gets
 * sent back to the server.
 */
function sanitize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
