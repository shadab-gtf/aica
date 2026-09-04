/**
 * Central resource limits.
 *
 * These exist so that "the agent must not dump the repository into the model"
 * (specification sections 51, 63) and "resource limits" (section 35) are
 * concrete numbers enforced in code, not aspirations. Every limit is
 * overridable per project through configuration.
 */
export const Limits = {
  /** Largest single file the agent will read into context, in bytes. */
  maxReadBytes: 512 * 1024,
  /** Largest number of lines returned by one read. */
  maxReadLines: 4_000,
  /** Largest file the indexer will parse; beyond this it records metadata only. */
  maxIndexBytes: 2 * 1024 * 1024,
  /** Cap on entries returned by a single listing. */
  maxListEntries: 2_000,
  /** Cap on matches returned by a single search. */
  maxSearchMatches: 500,
  /** Cap on files a single patch may touch. */
  maxPatchFiles: 50,
  /** Cap on captured stdout/stderr per command, in bytes. */
  maxCommandOutputBytes: 1024 * 1024,
  /** Default wall-clock budget for a shell command. */
  defaultCommandTimeoutMs: 120_000,
  /** Default wall-clock budget for one tool call. */
  defaultToolTimeoutMs: 60_000,
  /** Default wall-clock budget for one outbound HTTP request. */
  defaultHttpTimeoutMs: 30_000,
  /** Largest HTTP response body the executor will buffer, in bytes. */
  maxHttpResponseBytes: 8 * 1024 * 1024,
  /** Maximum redirects followed by the API executor, each re-validated. */
  maxHttpRedirects: 5,
  /** Maximum provider/tool iterations in one agent run. */
  maxAgentIterations: 40,
  /** Default cap on auto-repair attempts (specification section 39). */
  maxRepairAttempts: 3,
  /** Characters of a tool result surfaced in an event preview. */
  eventPreviewChars: 400,
} as const;

export type LimitName = keyof typeof Limits;

/** Truncate for display, marking that truncation happened. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const omitted = value.length - max;
  return `${value.slice(0, max)}\n... [truncated ${omitted} characters]`;
}

/** Truncate an object's JSON form for use in an event preview. */
export function previewJson(value: unknown, max: number = Limits.eventPreviewChars): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unserializable]';
  }
  return truncate(text, max);
}
