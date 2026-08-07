import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  AuditSinkError,
  createFileAuditSink,
  createStdoutAuditSink,
  JsonlAuditLogger,
  type AuditFileSystem,
  type AuditWritableStream,
} from './audit-logger';

// A fake file system that records calls so the "create the directory once, not
// per event" and fail-fast contracts can be asserted without touching real IO.
class RecordingAuditFileSystem implements AuditFileSystem {
  mkdirCalls: string[] = [];
  appendCalls: Array<{
    path: string;
    data: string;
    options?: { mode: number };
  }> = [];
  mkdirError?: Error;
  appendError?: Error;

  mkdirSync(dir: string): void {
    this.mkdirCalls.push(dir);
    if (this.mkdirError) throw this.mkdirError;
  }

  appendFileSync(path: string, data: string, options?: { mode: number }): void {
    this.appendCalls.push({ path, data, ...(options ? { options } : {}) });
    if (this.appendError) throw this.appendError;
  }
}

describe('createFileAuditSink', () => {
  test('creates the log directory once at startup, never per event', () => {
    const fs = new RecordingAuditFileSystem();
    const sink = createFileAuditSink('/var/log/omxterm/audit.jsonl', fs);

    sink('{"event":"a"}\n');
    sink('{"event":"b"}\n');

    // The directory is created once, at construction — never per event.
    expect(fs.mkdirCalls).toEqual(['/var/log/omxterm']);
    // One writability probe at boot + one append per event, and no extra mkdir.
    expect(fs.appendCalls.map((call) => call.data)).toEqual([
      '',
      '{"event":"a"}\n',
      '{"event":"b"}\n',
    ]);
    expect(fs.appendCalls[0]?.options).toEqual({ mode: 0o600 });
  });

  test('creates new audit files with owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omxterm-audit-mode-'));
    const logPath = join(dir, 'audit.jsonl');
    try {
      createFileAuditSink(logPath);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails fast with a useful boot error when the sink is not writable', () => {
    const fs = new RecordingAuditFileSystem();
    fs.mkdirError = Object.assign(new Error('not a directory'), {
      code: 'ENOTDIR',
    });

    expect(() => createFileAuditSink('/etc/hostname/audit.jsonl', fs)).toThrow(
      AuditSinkError,
    );
    expect(() => createFileAuditSink('/etc/hostname/audit.jsonl', fs)).toThrow(
      /OMXTERM_AUDIT_LOG/,
    );
    expect(() => createFileAuditSink('/etc/hostname/audit.jsonl', fs)).toThrow(
      /ENOTDIR/,
    );
  });
});

describe('JsonlAuditLogger runtime failure containment', () => {
  test('writes a single JSONL line with a timestamp on success', () => {
    const lines: string[] = [];
    const logger = new JsonlAuditLogger((line) => lines.push(line));

    logger.write({ event: 'access_granted', severity: 'info', origin: 'o' });

    expect(lines).toHaveLength(1);
    const [line] = lines;
    const payload = JSON.parse(line ?? '{}');
    expect(payload.event).toBe('access_granted');
    expect(typeof payload.ts).toBe('string');
  });

  test('does not throw when the sink fails, so callers never crash', () => {
    const logger = new JsonlAuditLogger(
      () => {
        throw new Error('disk full');
      },
      () => {},
    );

    expect(() =>
      logger.write({ event: 'ws_upgrade_rejected', severity: 'warn' }),
    ).not.toThrow();
  });

  test('reports a sink failure once per failure streak, then suppresses repeats', () => {
    const reported: string[] = [];
    let failing = true;
    const logger = new JsonlAuditLogger(
      () => {
        if (failing) throw new Error('disk full');
      },
      (event) => reported.push(event),
    );

    logger.write({ event: 'resize', severity: 'info' });
    logger.write({ event: 'resize', severity: 'info' });
    logger.write({ event: 'resize', severity: 'info' });
    expect(reported).toEqual(['resize']);

    // After recovery a new failure surfaces again, so a later outage is not silent.
    failing = false;
    logger.write({ event: 'session_started', severity: 'info' });
    failing = true;
    logger.write({ event: 'session_ended', severity: 'info' });
    expect(reported).toEqual(['resize', 'session_ended']);
  });

  test('reports failures on a channel separate from the sink, without recursion', () => {
    let sinkCalls = 0;
    let reporterCalls = 0;
    const logger = new JsonlAuditLogger(
      () => {
        sinkCalls += 1;
        throw new Error('disk full');
      },
      () => {
        reporterCalls += 1;
        // A reporter that itself fails must not crash the caller either.
        throw new Error('stderr broken');
      },
    );

    expect(() =>
      logger.write({ event: 'session_started', severity: 'info' }),
    ).not.toThrow();
    // The sink is attempted exactly once; reporting never loops back into it.
    expect(sinkCalls).toBe(1);
    expect(reporterCalls).toBe(1);
  });
});

// A stdout-like async Writable whose buffer can be marked full so write()
// returns false, exercising the sink's drop-while-congested backpressure without
// monkeypatching the real process.stdout.
class FakeCongestibleStream implements AuditWritableStream {
  writes: string[] = [];
  bufferFull = false;
  #drainListeners: Array<() => void> = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    // When the buffer is full the chunk is still accepted, but Node signals
    // backpressure by returning false.
    return !this.bufferFull;
  }

  once(_event: 'drain', listener: () => void): void {
    this.#drainListeners.push(listener);
  }

  emitDrain(): void {
    const listeners = this.#drainListeners;
    this.#drainListeners = [];
    for (const listener of listeners) listener();
  }
}

describe('createStdoutAuditSink backpressure', () => {
  test('writes straight through while the stream drains normally', () => {
    const stream = new FakeCongestibleStream();
    const sink = createStdoutAuditSink(stream);

    sink('{"event":"a"}\n');
    sink('{"event":"b"}\n');

    expect(stream.writes).toEqual(['{"event":"a"}\n', '{"event":"b"}\n']);
  });

  test('drops events while congested instead of growing the buffer, then recovers on drain', () => {
    const stream = new FakeCongestibleStream();
    const sink = createStdoutAuditSink(stream);

    // The stream signals backpressure: this chunk is accepted but write() is false.
    stream.bufferFull = true;
    sink('{"event":"congests"}\n');
    expect(stream.writes).toEqual(['{"event":"congests"}\n']);

    // While congested, further events are dropped and never reach the stream, so
    // the internal buffer cannot grow without bound.
    expect(() => sink('{"event":"dropped-1"}\n')).toThrow(AuditSinkError);
    expect(() => sink('{"event":"dropped-2"}\n')).toThrow(AuditSinkError);
    expect(stream.writes).toEqual(['{"event":"congests"}\n']);

    // Once the consumer catches up the stream drains and writes resume.
    stream.bufferFull = false;
    stream.emitDrain();
    sink('{"event":"after-drain"}\n');
    expect(stream.writes).toEqual([
      '{"event":"congests"}\n',
      '{"event":"after-drain"}\n',
    ]);
  });

  test('surfaces congestion drops once per streak via JsonlAuditLogger, without recursion or a storm', () => {
    const stream = new FakeCongestibleStream();
    const reported: string[] = [];
    const logger = new JsonlAuditLogger(
      createStdoutAuditSink(stream),
      (event) => reported.push(event),
    );

    stream.bufferFull = true;
    // The first event is written (write() === false only marks the onset of
    // congestion; the chunk itself was accepted), so nothing is reported yet.
    logger.write({ event: 'session_started', severity: 'info' });
    expect(reported).toEqual([]);
    // Subsequent events are dropped; only the onset of the streak is reported.
    logger.write({ event: 'resize', severity: 'info' });
    logger.write({ event: 'resize', severity: 'info' });
    expect(reported).toEqual(['resize']);
    // Exactly one line reached the stream — congested drops never buffer.
    expect(stream.writes).toHaveLength(1);

    // A fresh outage after drain reports again, so drops are never silent.
    stream.bufferFull = false;
    stream.emitDrain();
    logger.write({ event: 'session_ended', severity: 'info' });
    stream.bufferFull = true;
    logger.write({ event: 'terminal_flood', severity: 'warn' });
    logger.write({ event: 'terminal_flood', severity: 'warn' });
    expect(reported).toEqual(['resize', 'terminal_flood']);
  });
});

describe('createFileAuditSink against the real file system', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omxterm-audit-sink-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('appends events to a real file and creates missing parent directories', () => {
    const logPath = join(dir, 'nested', 'audit.jsonl');
    const sink = createFileAuditSink(logPath);

    sink('{"event":"session_started"}\n');

    expect(readFileSync(logPath, 'utf8')).toBe('{"event":"session_started"}\n');
  });

  test('throws AuditSinkError when the parent path is a file', () => {
    const notADirectory = join(dir, 'occupied');
    writeFileSync(notADirectory, 'x');
    const logPath = join(notADirectory, 'audit.jsonl');

    expect(() => createFileAuditSink(logPath)).toThrow(AuditSinkError);
  });
});
