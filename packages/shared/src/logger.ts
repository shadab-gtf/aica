/**
 * Structured logging (specification section 65).
 *
 * The logger accepts a `sanitize` hook rather than importing the redaction
 * implementation, because `shared` sits below `security-engine` in the
 * dependency order. The server wires the real redactor in at startup; the
 * default is a no-op used only by tests that log no sensitive data.
 */
export const LogLevel = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
} as const;

export type LogLevelName = Exclude<keyof typeof LogLevel, 'silent'> | 'silent';

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface LogRecord {
  readonly at: string;
  readonly level: Exclude<LogLevelName, 'silent'>;
  readonly scope: string;
  readonly message: string;
  readonly fields?: LogFields;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that prefixes a sub-scope and inherits bound fields. */
  child(scope: string, fields?: LogFields): Logger;
}

export type LogSink = (record: LogRecord) => void;

/** Removes secret material from anything about to be written out. */
export type Sanitizer = <T>(value: T) => T;

export interface LoggerOptions {
  readonly level?: LogLevelName;
  readonly scope?: string;
  readonly sink?: LogSink;
  readonly sanitize?: Sanitizer;
  readonly fields?: LogFields;
}

const identitySanitizer: Sanitizer = (value) => value;

/** Newline-delimited JSON to stderr, so stdout stays free for JSON-RPC. */
export const ndjsonSink: LogSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

export const nullSink: LogSink = () => undefined;

/** Collects records in memory. For tests and for the in-app log viewer. */
export class MemorySink {
  readonly records: LogRecord[] = [];

  readonly write: LogSink = (record) => {
    this.records.push(record);
  };

  clear(): void {
    this.records.length = 0;
  }

  find(predicate: (record: LogRecord) => boolean): LogRecord | undefined {
    return this.records.find(predicate);
  }
}

class StructuredLogger implements Logger {
  private readonly threshold: number;
  private readonly scope: string;
  private readonly sink: LogSink;
  private readonly sanitize: Sanitizer;
  private readonly bound: LogFields;

  constructor(options: LoggerOptions = {}) {
    this.threshold = LogLevel[options.level ?? 'info'];
    this.scope = options.scope ?? 'aica';
    this.sink = options.sink ?? ndjsonSink;
    this.sanitize = options.sanitize ?? identitySanitizer;
    this.bound = options.fields ?? {};
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  child(scope: string, fields?: LogFields): Logger {
    return new StructuredLogger({
      level: levelName(this.threshold),
      scope: `${this.scope}:${scope}`,
      sink: this.sink,
      sanitize: this.sanitize,
      fields: { ...this.bound, ...fields },
    });
  }

  private write(level: Exclude<LogLevelName, 'silent'>, message: string, fields?: LogFields): void {
    if (LogLevel[level] < this.threshold) return;
    const merged = { ...this.bound, ...fields };
    const record: LogRecord = {
      at: new Date().toISOString(),
      level,
      scope: this.scope,
      message: this.sanitize(message),
      ...(Object.keys(merged).length > 0 ? { fields: this.sanitize(merged) } : {}),
    };
    this.sink(record);
  }
}

function levelName(threshold: number): LogLevelName {
  for (const [name, value] of Object.entries(LogLevel)) {
    if (value === threshold) return name as LogLevelName;
  }
  return 'info';
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

/** Discards everything. Default in libraries so they never log unbidden. */
export const silentLogger: Logger = createLogger({ level: 'silent', sink: nullSink });

export function parseLogLevel(
  value: string | undefined,
  fallback: LogLevelName = 'info',
): LogLevelName {
  if (value && value in LogLevel) return value as LogLevelName;
  return fallback;
}
