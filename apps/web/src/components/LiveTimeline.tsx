'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The live event stream.
 *
 * Four things this has to get right, all of them about being honest under
 * conditions the happy path never sees:
 *
 * **Gaps are visible.** Every event carries a sequence number, and a jump means
 * something was missed — a reconnect, a slow reader, a dropped stream. A
 * timeline that quietly renumbers is a timeline that cannot be used as a
 * record, so a gap is drawn as a gap.
 *
 * **Connection state is stated.** "Nothing is happening" and "the stream is
 * down" look identical in a list that only shows events, and they call for
 * completely different reactions.
 *
 * **Nothing is interpolated as markup.** Payloads carry file paths, tool
 * output, and API descriptions — all of it ultimately from documents this
 * project treats as untrusted (§7). React escapes text by construction, and
 * this component never reaches for anything that would bypass that.
 *
 * **The list is bounded.** A long run emits thousands of events, and a page
 * that keeps every one of them becomes unusable during exactly the run somebody
 * is watching.
 */

const MAX_ROWS = 400;

interface Entry {
  seq: number;
  type: string;
  label: string;
  tone: 'info' | 'success' | 'error' | 'warning';
}

type Connection = 'connecting' | 'live' | 'closed';

export function LiveTimeline({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // No token in this URL: the page talks to its own origin, and the route
    // handler attaches the credential on the server side.
    const url = projectId
      ? `/api/events?projectId=${encodeURIComponent(projectId)}`
      : '/api/events';
    const source = new EventSource(url);

    source.onopen = () => setConnection('live');
    source.onerror = () => setConnection('closed');

    source.onmessage = (event: MessageEvent<string>) => {
      let parsed: { seq?: number; type?: string; payload?: unknown };
      try {
        parsed = JSON.parse(event.data) as typeof parsed;
      } catch {
        return;
      }

      if (typeof parsed.seq !== 'number' || typeof parsed.type !== 'string') return;

      const entry: Entry = {
        seq: parsed.seq,
        type: parsed.type,
        label: describe(parsed.type, parsed.payload),
        tone: toneFor(parsed.type, parsed.payload),
      };

      setEntries((previous) => [...previous, entry].slice(-MAX_ROWS));
    };

    return () => source.close();
  }, [projectId]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    // Only follow when the reader is already at the bottom. Yanking the scroll
    // position out from under someone reading history is worse than making them
    // scroll down.
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (atBottom) list.scrollTop = list.scrollHeight;
  }, [entries]);

  const rows = useMemo(() => withGaps(entries), [entries]);

  return (
    <div>
      <p style={{ margin: '0 0 8px' }}>
        <span
          className={`badge ${connection === 'live' ? 'ok' : connection === 'closed' ? 'error' : 'warn'}`}
        >
          {connection === 'live' ? 'live' : connection === 'closed' ? 'disconnected' : 'connecting'}
        </span>{' '}
        <span style={{ color: 'var(--muted)' }}>
          {connection === 'closed'
            ? 'The event stream is down. Reload once the agent server is running again.'
            : `${entries.length} event(s) this session.`}
        </span>
      </p>

      <div className="timeline" ref={listRef} data-testid="timeline">
        {rows.length === 0 ? (
          <div className="empty" style={{ padding: '20px 12px' }}>
            Nothing is running. Start a task from the editor and it will appear here.
          </div>
        ) : (
          rows.map((row) =>
            row.kind === 'gap' ? (
              <div className="row warning" key={`gap-${row.from}-${row.to}`}>
                <span className="seq">—</span>
                <span className="type">gap</span>
                <span className="detail">
                  {row.to - row.from - 1} event(s) between {row.from} and {row.to} were not
                  received.
                </span>
              </div>
            ) : (
              <div className={`row ${row.entry.tone}`} key={`${row.entry.seq}-${row.entry.type}`}>
                <span className="seq">{row.entry.seq}</span>
                <span className="type">{row.entry.type}</span>
                <span className="detail">{row.entry.label}</span>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

type Row = { kind: 'entry'; entry: Entry } | { kind: 'gap'; from: number; to: number };

/** Insert an explicit marker wherever the sequence skipped. */
function withGaps(entries: readonly Entry[]): Row[] {
  const rows: Row[] = [];

  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    if (previous && entry.seq > previous.seq + 1) {
      rows.push({ kind: 'gap', from: previous.seq, to: entry.seq });
    }
    rows.push({ kind: 'entry', entry });
  }

  return rows;
}

function field(payload: unknown, name: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function describe(type: string, payload: unknown): string {
  const record = (payload ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'AGENT_STARTED':
      return field(payload, 'task') ?? 'started';
    case 'STATUS':
    case 'ASSISTANT_MESSAGE':
      return field(payload, 'message') ?? field(payload, 'text') ?? '';
    case 'PLAN_CREATED':
      return field(payload, 'summary') ?? 'plan created';
    case 'SKILLS_SELECTED':
      return Array.isArray(record['skills']) ? (record['skills'] as string[]).join(', ') : '';
    case 'TOOL_CALLED':
      return `${field(payload, 'tool') ?? ''} ${field(payload, 'argsPreview') ?? ''}`.trim();
    case 'TOOL_COMPLETED':
      return record['ok'] === true
        ? `${field(payload, 'tool') ?? ''} ok`
        : `${field(payload, 'tool') ?? ''} failed`;
    case 'PATCH_CREATED':
      return `${countOf(record['files'])} file(s) proposed`;
    case 'PATCH_APPLIED':
      return `${countOf(record['files'])} file(s) written`;
    case 'VALIDATION_FAILED':
      return `failed at ${field(payload, 'failedStep') ?? 'validation'}`;
    case 'VALIDATION_PASSED':
      return 'all checks passed';
    case 'REPAIR_STARTED':
      return field(payload, 'rootCause') ?? 'repair attempt';
    case 'FINDING_REPORTED':
      return field(payload, 'title') ?? '';
    case 'APPROVAL_REQUESTED':
      return field(payload, 'subject') ?? 'approval requested';
    case 'AGENT_COMPLETED':
      return field(payload, 'summary') ?? 'done';
    case 'AGENT_FAILED':
      return field(record['error'], 'message') ?? 'failed';
    default:
      // An event this build has not been taught about is still part of the run.
      return '';
  }
}

function toneFor(type: string, payload: unknown): Entry['tone'] {
  if (type === 'AGENT_FAILED' || type === 'VALIDATION_FAILED') return 'error';
  if (type === 'TOOL_COMPLETED' && (payload as { ok?: boolean } | null)?.ok === false) {
    return 'error';
  }
  if (type === 'VALIDATION_PASSED' || type === 'AGENT_COMPLETED' || type === 'PATCH_APPLIED') {
    return 'success';
  }
  if (type === 'APPROVAL_REQUESTED' || type === 'REPAIR_STARTED' || type === 'FINDING_REPORTED') {
    return 'warning';
  }
  return 'info';
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
