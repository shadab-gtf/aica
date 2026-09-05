/**
 * A record of what left the machine (§7).
 *
 * The threat table names "silent data egress" and gives three controls:
 * explicit exclusions, per-provider configuration, and a record of what left.
 * The first two are configuration; this is the third, and it is the one that
 * makes the other two checkable. A privacy setting nobody can verify is a
 * promise, not a control.
 *
 * What it counts and what it deliberately does not:
 *
 * **Destinations and volumes, never payloads.** Recording the bodies sent to a
 * model would create, on disk, a copy of exactly the source code the user was
 * worried about sending anywhere. The ledger answers "what host, how much, how
 * often, and was it allowed" — which is what a privacy question actually asks —
 * and answers "what exactly did it say" with a deliberate no.
 *
 * **Refusals, too.** A request the SSRF policy blocked is a fact worth keeping:
 * it is the evidence that the control fired, and a run whose ledger is all
 * refusals is a run that was trying to do something surprising.
 *
 * **`localOnly` is enforced here, not merely declared.** A project that says it
 * sends nothing outward gets a ledger that refuses to record a send, because
 * the send never happens.
 */

import type { Clock, Logger } from '@aica/shared';
import { silentLogger, systemClock } from '@aica/shared';

export const EgressKind = {
  /** A prompt sent to a model provider. */
  model: 'model',
  /** A request made against a documented API endpoint. */
  api: 'api',
  /** A call to a remote MCP server. */
  mcp: 'mcp',
  /** Fetching a specification or documentation. */
  fetch: 'fetch',
  /** Delegation to an external coding agent. */
  codingAgent: 'coding_agent',
} as const;

export type EgressKind = (typeof EgressKind)[keyof typeof EgressKind];

export interface EgressRecord {
  readonly at: string;
  readonly kind: EgressKind;
  /** Hostname only. A full URL frequently carries identifiers in its path. */
  readonly host: string;
  readonly method?: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
  /** False when a policy refused the request before it was made. */
  readonly sent: boolean;
  readonly reason?: string;
  /** Which provider or server, when there is a name for it. */
  readonly via?: string;
  readonly runId?: string;
}

export interface EgressSummary {
  readonly host: string;
  readonly kind: EgressKind;
  readonly requests: number;
  readonly blocked: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly firstAt: string;
  readonly lastAt: string;
}

export interface EgressLedgerOptions {
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** When true, nothing may leave. Every attempt is recorded as blocked. */
  readonly localOnly?: boolean;
  readonly retain?: number;
  readonly onRecord?: (record: EgressRecord) => void;
}

const DEFAULT_RETAIN = 5000;

export class EgressLedger {
  private readonly records: EgressRecord[] = [];
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly retain: number;

  constructor(private readonly options: EgressLedgerOptions = {}) {
    this.logger = (options.logger ?? silentLogger).child('egress');
    this.clock = options.clock ?? systemClock;
    this.retain = options.retain ?? DEFAULT_RETAIN;
  }

  get localOnly(): boolean {
    return this.options.localOnly === true;
  }

  /**
   * May a request to this host be made at all?
   *
   * Asked before sending, so `localOnly` is a refusal rather than an apology.
   * Loopback is exempt: a local Supabase or a local MCP server never leaves the
   * machine, and treating them as egress would make the setting unusable while
   * protecting nothing.
   */
  permits(host: string): { allowed: boolean; reason: string } {
    if (!this.localOnly) return { allowed: true, reason: 'Egress is permitted.' };

    if (isLoopback(host)) {
      return { allowed: true, reason: 'Loopback never leaves the machine.' };
    }

    return {
      allowed: false,
      reason: `This project is configured local-only, so nothing may be sent to ${host}.`,
    };
  }

  /** Record a request that was made. */
  record(input: {
    kind: EgressKind;
    host: string;
    method?: string;
    requestBytes?: number;
    responseBytes?: number;
    via?: string;
    runId?: string;
  }): EgressRecord {
    return this.append({
      at: new Date(this.clock.now()).toISOString(),
      kind: input.kind,
      host: normalizeHost(input.host),
      ...(input.method !== undefined ? { method: input.method } : {}),
      requestBytes: input.requestBytes ?? 0,
      responseBytes: input.responseBytes ?? 0,
      sent: true,
      ...(input.via !== undefined ? { via: input.via } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });
  }

  /** Record a request that a policy refused. */
  recordBlocked(input: {
    kind: EgressKind;
    host: string;
    reason: string;
    method?: string;
    via?: string;
    runId?: string;
  }): EgressRecord {
    this.logger.info('egress blocked', { host: input.host, kind: input.kind });

    return this.append({
      at: new Date(this.clock.now()).toISOString(),
      kind: input.kind,
      host: normalizeHost(input.host),
      ...(input.method !== undefined ? { method: input.method } : {}),
      requestBytes: 0,
      responseBytes: 0,
      sent: false,
      reason: input.reason,
      ...(input.via !== undefined ? { via: input.via } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });
  }

  private append(record: EgressRecord): EgressRecord {
    this.records.push(record);
    if (this.records.length > this.retain) this.records.shift();
    this.options.onRecord?.(record);
    return record;
  }

  get all(): readonly EgressRecord[] {
    return this.records;
  }

  /**
   * One row per host and kind.
   *
   * The shape a person actually reads: "this run sent 240KB to
   * openrouter.ai over 12 requests" is an answer; four hundred individual
   * request lines is a spreadsheet.
   */
  summarize(runId?: string): EgressSummary[] {
    const byKey = new Map<string, EgressSummary>();

    for (const record of this.records) {
      if (runId !== undefined && record.runId !== runId) continue;

      const key = `${record.host}|${record.kind}`;
      const existing = byKey.get(key);

      byKey.set(key, {
        host: record.host,
        kind: record.kind,
        requests: (existing?.requests ?? 0) + (record.sent ? 1 : 0),
        blocked: (existing?.blocked ?? 0) + (record.sent ? 0 : 1),
        requestBytes: (existing?.requestBytes ?? 0) + record.requestBytes,
        responseBytes: (existing?.responseBytes ?? 0) + record.responseBytes,
        firstAt: existing?.firstAt ?? record.at,
        lastAt: record.at,
      });
    }

    return [...byKey.values()].sort(
      (left, right) =>
        right.requestBytes - left.requestBytes || left.host.localeCompare(right.host),
    );
  }

  get totalRequestBytes(): number {
    return this.records.reduce((total, record) => total + record.requestBytes, 0);
  }

  get blockedCount(): number {
    return this.records.filter((record) => !record.sent).length;
  }

  /** A short report, for a run summary or a privacy question. */
  render(runId?: string): string {
    const summaries = this.summarize(runId);
    if (summaries.length === 0) return 'Nothing left this machine.';

    return summaries
      .map(
        (entry) =>
          `${entry.host} (${entry.kind}): ${entry.requests} request(s), ${formatBytes(entry.requestBytes)} sent, ${formatBytes(entry.responseBytes)} received${
            entry.blocked > 0 ? `, ${entry.blocked} blocked` : ''
          }`,
      )
      .join('\n');
  }
}

function normalizeHost(host: string): string {
  // Accepts a URL or a bare host. A path is dropped: it frequently carries an
  // identifier, and the ledger records destinations rather than targets.
  try {
    return new URL(host).hostname.toLowerCase();
  } catch {
    return (
      host
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0] ?? host
    );
  }
}

function isLoopback(host: string): boolean {
  const name = normalizeHost(host);
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
