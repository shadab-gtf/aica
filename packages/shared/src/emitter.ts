import type { AgentEvent, AgentEventPayload, AgentEventType, EventBus } from './events.js';
import type { Id } from './ids.js';
import { newId } from './ids.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Sanitizer } from './logger.js';

/**
 * Binds an event bus to one run so call sites emit a type plus a payload and
 * never hand-build an envelope. Sequence numbers, IDs, and timestamps are
 * assigned centrally, and every payload passes through the sanitizer, which is
 * what makes "no secrets in events" enforceable at a single point rather than
 * relied upon at each of the several dozen emit sites.
 */
export class RunEmitter {
  private readonly bus: EventBus;
  private readonly runId: Id<'run'>;
  private readonly projectId: Id<'proj'>;
  private readonly clock: Clock;
  private readonly sanitize: Sanitizer;

  constructor(options: {
    bus: EventBus;
    runId: Id<'run'>;
    projectId: Id<'proj'>;
    clock?: Clock;
    sanitize?: Sanitizer;
  }) {
    this.bus = options.bus;
    this.runId = options.runId;
    this.projectId = options.projectId;
    this.clock = options.clock ?? systemClock;
    this.sanitize = options.sanitize ?? (<T>(value: T): T => value);
  }

  emit<T extends AgentEventType>(type: T, payload: AgentEventPayload<T>): AgentEvent {
    const event = {
      id: newId('evt'),
      runId: this.runId,
      projectId: this.projectId,
      seq: this.bus.nextSeq(this.runId),
      at: this.clock.isoNow(),
      type,
      payload: this.sanitize(payload),
    } as AgentEvent;
    this.bus.emit(event);
    return event;
  }

  /** Shorthand for the most common event, a human-readable progress line. */
  status(message: string): void {
    this.emit('STATUS', { message });
  }

  close(): void {
    this.bus.closeRun(this.runId);
  }
}
