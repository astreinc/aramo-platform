import { Logger, type LoggerService } from '@nestjs/common';

// M4 PR-9 §4.3 — Aramo structured logger factory.
//
// Workspace-wide convention for emitting JSON-structured log records to
// stdout. Application surfaces (NestJS apps, libs) use createAramoLogger
// instead of `new Logger(...)` directly so log payloads end up on a
// single ingestion path (CloudWatch Logs via the runtime log driver per
// ADR-0013 Decision 1).
//
// Design constraints (per directive §4.3):
//   - Maintains NestJS-Logger API compatibility — the factory's return
//     value satisfies the NestJS `LoggerService` shape, so NestJS's
//     internal logger contract is preserved.
//   - Each .log/.warn/.error/.debug call accepts a structured
//     AramoLogPayload (mandatory `event` discriminator + arbitrary
//     additional fields) plus an optional contextOverride.
//   - Emits a single line of JSON via console.log with the locked
//     envelope shape: { timestamp, level, context, event, ...payload }.
//   - timestamp is ISO-8601 (Date#toISOString).
//   - context falls back to the factory-level context if no override
//     supplied at the call site.

export interface AramoLogPayload {
  event: string;
  [key: string]: unknown;
}

// AramoLogger is the typed surface returned by createAramoLogger. It
// extends LoggerService so DI containers (NestJS, vitest mocks) can
// accept it where a LoggerService is expected, but narrows the method
// signatures so callers pass an AramoLogPayload (not a raw string).
export interface AramoLogger extends LoggerService {
  log(payload: AramoLogPayload, contextOverride?: string): void;
  warn(payload: AramoLogPayload, contextOverride?: string): void;
  error(payload: AramoLogPayload, contextOverride?: string): void;
  debug(payload: AramoLogPayload, contextOverride?: string): void;
}

type AramoLogLevel = 'log' | 'warn' | 'error' | 'debug';

class AramoLoggerImpl extends Logger implements AramoLogger {
  constructor(private readonly factoryContext: string) {
    super(factoryContext);
  }

  override log(payload: AramoLogPayload, contextOverride?: string): void {
    this.emit('log', payload, contextOverride);
  }

  override warn(payload: AramoLogPayload, contextOverride?: string): void {
    this.emit('warn', payload, contextOverride);
  }

  override error(payload: AramoLogPayload, contextOverride?: string): void {
    this.emit('error', payload, contextOverride);
  }

  override debug(payload: AramoLogPayload, contextOverride?: string): void {
    this.emit('debug', payload, contextOverride);
  }

  private emit(
    level: AramoLogLevel,
    payload: AramoLogPayload,
    contextOverride?: string,
  ): void {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      context: contextOverride ?? this.factoryContext,
      ...payload,
    };
    console.log(JSON.stringify(record));
  }
}

// Factory entrypoint. Callers pass the symbolic context (typically the
// class name they're instantiating the logger for, e.g.
// SubmittalController.name) and receive an AramoLogger bound to that
// context. The instance is reusable across calls; emit-time
// contextOverride lets a caller temporarily override the context for
// a single log line.
export function createAramoLogger(context: string): AramoLogger {
  return new AramoLoggerImpl(context);
}
