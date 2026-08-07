import type { AuditEvent, AuditLogger } from '@omxterm/core/audit';
import { sanitizeAuditMetadata } from '@omxterm/core/audit';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// A sink performs the raw byte write for one already-formatted JSONL line. It
// may throw synchronously (disk full, path became unwritable); JsonlAuditLogger
// contains that so a failing sink never escapes a request/upgrade/WebSocket/SSH
// handler and takes down the broker (#79).
export type AuditSink = (line: string) => void;

// Diagnostics channel used to surface a runtime sink failure. It MUST be a
// distinct channel from the audit sink itself, otherwise reporting a failure
// could recurse straight back into the failing sink (#79). Defaults to stderr.
export type AuditFailureReporter = (event: string, cause: unknown) => void;

// The subset of node:fs the file sink needs, injected so the "directory created
// once, not per event" and fail-fast contracts are testable without real IO.
export type AuditFileSystem = {
  mkdirSync: (dir: string, options: { recursive: true }) => void;
  appendFileSync: (
    path: string,
    data: string,
    options?: { mode: number },
  ) => void;
};

const nodeAuditFileSystem: AuditFileSystem = { mkdirSync, appendFileSync };

export class AuditSinkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuditSinkError';
  }
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    // node:fs errors carry a code (EACCES, ENOTDIR, ENOSPC, EEXIST...) worth
    // surfacing so an operator can tell why the sink is unwritable. The fs
    // message already begins with the code, so only prepend it when missing to
    // avoid a doubled "ENOENT: ENOENT: ..." string.
    const code = (cause as NodeJS.ErrnoException).code;
    return code && !cause.message.startsWith(code)
      ? `${code}: ${cause.message}`
      : cause.message;
  }
  return String(cause);
}

export function reportAuditFailureToStderr(
  event: string,
  cause: unknown,
): void {
  const diagnostic = {
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'audit_sink_write_failed',
    event,
    error: describeError(cause),
  };
  // stderr is a separate channel from the audit sink, so reporting a sink
  // failure here cannot loop back into the failing sink (#79).
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
}

// Create a file sink and prove it is writable ONCE, at startup: the parent
// directory is created here (not per event) and an empty append confirms the
// path is writable without emitting a log line. A misconfigured sink fails fast
// here with a useful boot error instead of throwing out of a handler at runtime
// (#79), mirroring the fail-fast style of resolveWebRoot in config.ts.
export function createFileAuditSink(
  logPath: string,
  fileSystem: AuditFileSystem = nodeAuditFileSystem,
): AuditSink {
  try {
    fileSystem.mkdirSync(dirname(logPath), { recursive: true });
    // Audit metadata includes target and session timing. Restrict newly created
    // files even when the host process has a permissive default umask.
    fileSystem.appendFileSync(logPath, '', { mode: 0o600 });
  } catch (cause) {
    throw new AuditSinkError(
      `OMXTERM_AUDIT_LOG points at "${logPath}", which is not writable ` +
        `(${describeError(cause)}). Set it to a writable file path or leave it ` +
        'unset to write audit events to stdout.',
      { cause },
    );
  }
  // Synchronous append is the MVP's bounded backpressure: there is no in-memory
  // queue to grow without limit, and the OS write buffer paces the writer. The
  // inbound guard (#77) already caps event frequency, so the sink cannot be
  // amplified. A durable/async audit pipeline is out of scope for this MVP.
  return (line) => {
    fileSystem.appendFileSync(logPath, line);
  };
}

// The subset of a Node Writable stream the stdout sink needs, injected so the
// backpressure/drain contract is testable without monkeypatching the global
// process.stdout (#79).
export type AuditWritableStream = {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): void;
};

// stdout is an ASYNCHRONOUS Writable, unlike the synchronous file sink: when
// write() returns false the chunk was accepted but the internal buffer is over
// its highWaterMark, and every further write() keeps growing that buffer with no
// bound. Not every audit call site is frequency-capped by the inbound guard
// (#77) — request/access-rejection paths are not — so a stalled stdout (piped
// into a slow or blocked reader) could accumulate unbounded memory. To stay
// bounded we stop feeding the buffer while congested: the write() === false
// chunk is the last one handed off, then subsequent events are DROPPED (each
// surfaced by throwing, so JsonlAuditLogger contains it and reports once per
// streak) until the stream emits 'drain'. This trades a bounded window of lost
// audit lines for a hard memory bound — the right call for an MVP whose audit
// sink must never become an amplification vector.
export function createStdoutAuditSink(
  stream: AuditWritableStream = process.stdout,
): AuditSink {
  let congested = false;
  return (line) => {
    if (congested) {
      throw new AuditSinkError(
        'stdout audit sink is congested (backpressure); dropped an audit event until drain.',
      );
    }
    const flushed = stream.write(line);
    if (!flushed) {
      // Only one 'drain' listener per streak: while congested we never call
      // write() again, so this registers exactly once until it fires.
      congested = true;
      stream.once('drain', () => {
        congested = false;
      });
    }
  };
}

export function createAuditSink(logPath: string | undefined): AuditSink {
  return logPath ? createFileAuditSink(logPath) : createStdoutAuditSink();
}

export class JsonlAuditLogger implements AuditLogger {
  #sinkFailing = false;

  constructor(
    private readonly writeLine: AuditSink,
    private readonly reportFailure: AuditFailureReporter = reportAuditFailureToStderr,
  ) {}

  write(event: Omit<AuditEvent, 'ts'>): void {
    const payload = sanitizeAuditMetadata({
      ts: new Date().toISOString(),
      ...event,
    });
    const line = `${JSON.stringify(payload)}\n`;
    try {
      this.writeLine(line);
      this.#sinkFailing = false;
    } catch (cause) {
      this.#reportSinkFailure(event.event, cause);
    }
  }

  // Surface the onset of a sink outage (and the first failure after any
  // recovery) once, then suppress repeats so a persistently broken sink cannot
  // turn every audited event into a stderr storm — the storm would itself be an
  // amplification vector. This never rethrows, so a runtime write failure cannot
  // escape the caller's handler, and never writes through the audit sink, so
  // there is no recursion (#79). Dropped events are reported, not silently
  // pretended successful.
  #reportSinkFailure(event: string, cause: unknown): void {
    if (this.#sinkFailing) return;
    this.#sinkFailing = true;
    try {
      this.reportFailure(event, cause);
    } catch {
      // Last resort: if even the diagnostics channel fails there is nowhere left
      // to report, so drop it rather than let auditing crash a security handler.
    }
  }
}
