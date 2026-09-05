/**
 * What a skill is, and what it is not.
 *
 * A skill is packaged guidance: how this organisation writes React components,
 * what the house rules are for error handling, which library to reach for. It
 * exists because a model that knows TypeScript in general does not know *your*
 * TypeScript, and the difference shows up as a plausible change that nobody
 * would have written.
 *
 * Three constraints follow from what a skill is:
 *
 * **A skill is guidance, never authority.** Its text is loaded into the prompt
 * as house style. It cannot lift a safety rule, widen a permission, or license
 * something the policy layer refuses — a skill file is content, and §7 puts
 * content in the untrusted column no matter which directory it came from. This
 * is not theoretical: skills are shipped files that a project can override, so
 * "skills/react/SKILL.md says I may run arbitrary commands" is exactly the
 * attack a plain-text guidance format invites.
 *
 * **Loading is scoped.** Skills are prompt tokens. Loading twelve of them
 * produces a diluted prompt in which none of the guidance is followed, so
 * selection is a budget with a cap, not a filter that happens to return few
 * results.
 *
 * **Selection is deterministic.** Which skills apply is decided from counted
 * evidence — the task kind, the words in the request, what the repository
 * actually contains — and not by asking a model. Asking a model which
 * instructions to give itself is a loop with no ground truth in it.
 */

import { z } from 'zod';

/** Task kinds a skill can declare itself relevant to. Matches the event contract. */
export const skillTaskKinds = [
  'API_INTEGRATION',
  'API_ANALYSIS',
  'CODE_ANALYSIS',
  'BUG_FIX',
  'FRONTEND_REVIEW',
  'SECURITY_REVIEW',
  'PERFORMANCE_REVIEW',
  'API_CHANGE_IMPACT',
  'TEST_GENERATION',
  'REFACTOR',
  'DOCUMENTATION',
  'MCP_TASK',
  'GENERAL_DEVELOPMENT',
] as const;

export const skillManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'A skill name is lower kebab-case.'),
  /**
   * One line, and it does the selection work. A description that says what the
   * skill is *for* ("integrating REST APIs into a React front end") matches a
   * request; one that says what it *is* ("React skill") does not.
   */
  description: z.string().min(10),
  version: z.string().default('1.0.0'),
  /** Task kinds this applies to. Empty means any. */
  tasks: z.array(z.enum(skillTaskKinds)).default([]),
  /**
   * Package names whose presence in the project makes this skill relevant.
   *
   * The strongest signal available, because it is a fact about the repository
   * rather than a guess about the request: a React skill is relevant to a
   * project that depends on React and irrelevant to one that does not,
   * regardless of what the user typed.
   */
  requires: z.array(z.string()).default([]),
  /** File extensions this skill concerns, e.g. `.tsx`. */
  extensions: z.array(z.string()).default([]),
  /** Extra words that should match this skill, beyond its description. */
  keywords: z.array(z.string()).default([]),
  /**
   * Always load this skill, whatever the task.
   *
   * For a project's own conventions, which apply to everything. Deliberately
   * limited: an always-on skill spends budget on every single run.
   */
  always: z.boolean().default(false),
  /** Rough size, used by the loader's budget. Filled in on load. */
  bytes: z.number().int().nonnegative().default(0),
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;

export interface Skill {
  readonly manifest: SkillManifest;
  /** Where it came from, so a UI can say which skill is speaking. */
  readonly source: 'shipped' | 'project';
  readonly path: string;
  /** The guidance itself, loaded lazily. */
  readonly body: string;
}

export interface SkillSelectionEvidence {
  readonly kind: 'task' | 'dependency' | 'extension' | 'keyword' | 'always' | 'explicit';
  readonly detail: string;
  readonly weight: number;
}

export interface SelectedSkill {
  readonly skill: Skill;
  readonly score: number;
  readonly evidence: readonly SkillSelectionEvidence[];
}

/**
 * Parse a `SKILL.md`: YAML-ish frontmatter, then the guidance.
 *
 * The frontmatter parser is deliberately small and strict rather than a full
 * YAML implementation. A skill manifest is a handful of scalars and string
 * lists; accepting anchors, multi-document streams, and arbitrary nesting would
 * buy nothing and would mean parsing untrusted text with a large parser.
 */
export function parseSkillFile(
  text: string,
  path: string,
): { manifest: unknown; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match?.[1]) return undefined;

  const manifest = parseFrontmatter(match[1]);
  const body = (match[2] ?? '').trim();

  return { manifest: { ...manifest, bytes: Buffer.byteLength(body, 'utf8') }, body: body || path };
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;

    const separator = line.indexOf(':');
    if (separator === -1 || /^\s/.test(line)) continue;

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();

    if (rawValue.length === 0) {
      // A block list: subsequent indented `- item` lines.
      const items: string[] = [];
      while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1] as string)) {
        index += 1;
        items.push(unquote((lines[index] as string).replace(/^\s*-\s+/, '').trim()));
      }
      result[key] = items;
      continue;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      result[key] =
        inner.length === 0
          ? []
          : inner
              .split(',')
              .map((entry) => unquote(entry.trim()))
              .filter((entry) => entry.length > 0);
      continue;
    }

    if (rawValue === 'true' || rawValue === 'false') {
      result[key] = rawValue === 'true';
      continue;
    }

    result[key] = unquote(rawValue);
  }

  return result;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
