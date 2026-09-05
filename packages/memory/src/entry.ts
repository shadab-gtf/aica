/**
 * Scoped memory (§4): what the agent is allowed to remember between runs.
 *
 * The point is narrow and worth stating, because "memory" invites scope creep.
 * It is for facts about *this project* that were expensive to establish and do
 * not change: which HTTP client the codebase uses, that migrations live in an
 * unusual directory, that a particular test is flaky for a known reason. Those
 * get re-derived from scratch on every run otherwise, and the agent arrives at
 * the same conclusion at the same cost each time.
 *
 * It is emphatically not a cache of tool results, and not a place to put
 * anything the index can answer. A fact the index knows should come from the
 * index, where it is re-derived from source and therefore cannot go stale — §2
 * puts AST facts above stored state for exactly this reason. A remembered fact
 * that contradicts the code is worse than no memory at all, because it is
 * confident.
 *
 * **Secret-free by construction.** A store that accepts arbitrary text will
 * eventually hold a credential — somebody will remember "the staging token is
 * abc123" and mean well. So a value that looks like a credential is *refused*
 * on write, with an error saying what to store instead. A secret *reference*
 * (`env:PAYMENT_API_KEY`) is fine and is the intended shape; a secret value is
 * not, and the difference is enforced here rather than hoped for.
 */

import { z } from 'zod';

/**
 * Who a memory belongs to.
 *
 * Three scopes, resolved most-specific-first. `task` is deliberately
 * short-lived: it exists so a multi-turn conversation can carry a decision
 * forward without that decision becoming a permanent belief about the project.
 */
export const MemoryScope = {
  /** True of this machine and every project on it. Rare, and rightly so. */
  global: 'global',
  /** True of this repository. The scope nearly everything belongs in. */
  project: 'project',
  /** True for the current task only. Discarded when it ends. */
  task: 'task',
} as const;

export type MemoryScope = (typeof MemoryScope)[keyof typeof MemoryScope];

/** Most specific first. A `task` fact overrides a `project` one of the same key. */
export const SCOPE_PRECEDENCE: readonly MemoryScope[] = [
  MemoryScope.task,
  MemoryScope.project,
  MemoryScope.global,
];

export const memoryEntrySchema = z.object({
  scope: z.enum([MemoryScope.global, MemoryScope.project, MemoryScope.task]),
  /**
   * Dotted, lower-case, and stable. A key is how a later run finds a fact
   * again, so it is a name rather than a sentence: `http.client`, not "we use
   * axios here".
   */
  key: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
      'A memory key is dotted lower-case, e.g. http.client.',
    ),
  /** The fact itself, in a sentence somebody could read. */
  value: z.string().min(1).max(2000),
  /**
   * Why this is believed. A memory with no provenance is a rumour, and the
   * first thing anyone asks of a surprising one is where it came from.
   */
  source: z.string().max(300).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

/**
 * Shapes that are credentials rather than facts.
 *
 * Matched against the whole value, and deliberately broad: a false refusal
 * costs someone a rephrase, while a false acceptance puts a live key in a
 * durable store that is later read into a prompt. The asymmetry decides how
 * aggressive this should be.
 */
const CREDENTIAL_SHAPES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'an OpenAI-style key' },
  { pattern: /\bsk-or-v1-[A-Za-z0-9]{16,}/, what: 'an OpenRouter key' },
  { pattern: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/, what: 'a Supabase key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/, what: 'a GitHub token' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/, what: 'a Google API key' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, what: 'a JWT' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/, what: 'a bearer token' },
  {
    // `PASSWORD=hunter2`, `api_key: "abc..."`, `PAYMENT_API_KEY=...`.
    //
    // No `\b` in front, deliberately: `\b` treats `_` as a word character, so
    // `\bapi_key` does not match inside `PAYMENT_API_KEY` — and prefixed
    // SCREAMING_SNAKE names are the commonest form this takes. Requiring the
    // separator and eight characters after it is what keeps ordinary prose like
    // "the token: see above" from matching.
    pattern:
      /(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?\s*[:=]\s*['"]?[^\s'"]{8,}/i,
    what: 'an assignment that looks like a credential',
  },
];

/** A reference is the shape memory *wants*; it names a secret without being one. */
const SECRET_REFERENCE = /^(env|file|keychain|prompt):[A-Za-z0-9_./-]+$/;

export interface CredentialVerdict {
  readonly isCredential: boolean;
  readonly what?: string;
}

/**
 * Does this value look like a credential rather than a fact?
 *
 * A bare secret reference is explicitly allowed: `env:PAYMENT_API_KEY` is the
 * whole point — it records *where* a credential comes from without recording
 * the credential. A value that merely mentions a reference alongside other
 * prose is still scanned, because "the key is env:FOO, currently sk-abc..." is
 * exactly the mistake this is here to catch.
 */
export function looksLikeCredential(value: string): CredentialVerdict {
  const trimmed = value.trim();

  if (SECRET_REFERENCE.test(trimmed)) return { isCredential: false };

  for (const shape of CREDENTIAL_SHAPES) {
    if (shape.pattern.test(trimmed)) return { isCredential: true, what: shape.what };
  }

  return { isCredential: false };
}
