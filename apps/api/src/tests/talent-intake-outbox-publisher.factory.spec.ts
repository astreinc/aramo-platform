import { describe, expect, it, vi } from 'vitest';
import type { AramoLogger } from '@aramo/common';
import { StructuredLogOutboxPublisher } from '@aramo/outbox-publisher';
import type { TalentIntakeMessageHandler } from '@aramo/talent-record';

import { selectTalentIntakeOutboxPublisher } from '../talent-intake-consumer/talent-intake-outbox-publisher.factory.js';
import { SingleBoxTalentIntakePublisher } from '../talent-intake-consumer/singlebox-talent-intake-publisher.js';
import { LazyEventBridgeOutboxPublisher } from '../talent-intake-consumer/lazy-eventbridge-outbox-publisher.js';
import type {
  TalentIntakeEventsConfig,
  TalentIntakeTransport,
} from '../talent-intake-consumer/talent-intake-events.config.js';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AramoLogger;
const handler = { handle: vi.fn() } as unknown as TalentIntakeMessageHandler;

function cfg(transport: TalentIntakeTransport): TalentIntakeEventsConfig {
  // No AWS bus/region — proves singlebox needs none, and eventbridge binds lazily
  // (fail-closed only on first publish, not at construction).
  return {
    transport,
    busName: null,
    region: null,
    sourcePrefix: 'aramo',
    endpoint: null,
    leaseSeconds: 60,
    maxAttempts: 5,
    drainLimit: 50,
  };
}

describe('selectTalentIntakeOutboxPublisher — transport → adapter', () => {
  it('§2 eventbridge → LazyEventBridgeOutboxPublisher (unchanged)', () => {
    expect(selectTalentIntakeOutboxPublisher(cfg('eventbridge'), logger, handler)).toBeInstanceOf(
      LazyEventBridgeOutboxPublisher,
    );
  });

  it('§1 singlebox → SingleBoxTalentIntakePublisher', () => {
    expect(selectTalentIntakeOutboxPublisher(cfg('singlebox'), logger, handler)).toBeInstanceOf(
      SingleBoxTalentIntakePublisher,
    );
  });

  it('§3 structured-log → StructuredLogOutboxPublisher (unchanged)', () => {
    expect(selectTalentIntakeOutboxPublisher(cfg('structured-log'), logger, handler)).toBeInstanceOf(
      StructuredLogOutboxPublisher,
    );
  });

  // §9 — singlebox requires NO EventBridge/SQS configuration: it is constructed
  // with busName/region null and only the in-process handler, without throwing.
  it('§9 singlebox requires no EventBridge/SQS configuration', () => {
    const pub = selectTalentIntakeOutboxPublisher(cfg('singlebox'), logger, handler);
    expect(pub).toBeInstanceOf(SingleBoxTalentIntakePublisher);
  });
});
