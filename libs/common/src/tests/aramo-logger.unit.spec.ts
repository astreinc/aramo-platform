import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAramoLogger } from '../lib/logging/aramo-logger.js';

// M4 PR-9 §4.4 — 9 unit tests for the structured logger factory.
//
// Each test captures the JSON line emitted to console.log (the factory's
// only side effect), parses it, and asserts on the envelope shape +
// payload spread + context resolution + ISO-8601 timestamp.

describe('createAramoLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* swallow output during tests */
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function lastEmittedRecord(): Record<string, unknown> {
    expect(consoleSpy).toHaveBeenCalled();
    const lastCall = consoleSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const arg = lastCall?.[0];
    expect(typeof arg).toBe('string');
    return JSON.parse(arg as string) as Record<string, unknown>;
  }

  it('.log() emits JSON with level: "log" and structured payload', () => {
    const logger = createAramoLogger('TestContext');
    logger.log({ event: 'submittal_create_started' });

    const record = lastEmittedRecord();
    expect(record.level).toBe('log');
    expect(record.event).toBe('submittal_create_started');
  });

  it('.warn() emits JSON with level: "warn"', () => {
    const logger = createAramoLogger('TestContext');
    logger.warn({ event: 'cache_stale' });

    const record = lastEmittedRecord();
    expect(record.level).toBe('warn');
    expect(record.event).toBe('cache_stale');
  });

  it('.error() emits JSON with level: "error"', () => {
    const logger = createAramoLogger('TestContext');
    logger.error({ event: 'downstream_failed' });

    const record = lastEmittedRecord();
    expect(record.level).toBe('error');
    expect(record.event).toBe('downstream_failed');
  });

  it('.debug() emits JSON with level: "debug"', () => {
    const logger = createAramoLogger('TestContext');
    logger.debug({ event: 'pipeline_step' });

    const record = lastEmittedRecord();
    expect(record.level).toBe('debug');
    expect(record.event).toBe('pipeline_step');
  });

  it('timestamp field is ISO-8601 format', () => {
    const logger = createAramoLogger('TestContext');
    logger.log({ event: 'tick' });

    const record = lastEmittedRecord();
    expect(typeof record.timestamp).toBe('string');
    const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(record.timestamp).toMatch(iso8601);
    expect(() => new Date(record.timestamp as string).toISOString()).not.toThrow();
  });

  it('context field falls back to factory-level context if no override', () => {
    const logger = createAramoLogger('SubmittalController');
    logger.log({ event: 'request_received' });

    const record = lastEmittedRecord();
    expect(record.context).toBe('SubmittalController');
  });

  it('context field uses override if provided', () => {
    const logger = createAramoLogger('SubmittalController');
    logger.log({ event: 'cross_module_trace' }, 'EvidenceRepository');

    const record = lastEmittedRecord();
    expect(record.context).toBe('EvidenceRepository');
  });

  it('event field is included from payload', () => {
    const logger = createAramoLogger('TestContext');
    logger.log({ event: 'submittal_confirmed' });

    const record = lastEmittedRecord();
    expect(record.event).toBe('submittal_confirmed');
  });

  it('additional payload fields are spread into structured output', () => {
    const logger = createAramoLogger('SubmittalRepository');
    logger.log({
      event: 'submittal_created',
      tenant_id: 'tenant-abc',
      submittal_id: 'sub-123',
      latency_ms: 42,
    });

    const record = lastEmittedRecord();
    expect(record.event).toBe('submittal_created');
    expect(record.tenant_id).toBe('tenant-abc');
    expect(record.submittal_id).toBe('sub-123');
    expect(record.latency_ms).toBe(42);
  });
});
