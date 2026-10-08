export { EventsModule } from './lib/events.module.js';
export {
  type AramoEventEnvelope,
  type CanonicalOutboxRow,
  type EnvelopeDefaults,
  buildEventEnvelope,
} from './lib/event-envelope.js';
export {
  OUTBOX_PUBLISHER_PORT,
  type OutboxPublishResult,
  type OutboxPublisherPort,
} from './lib/outbox-publisher.port.js';
export {
  type LeaseSafeOutboxRepository,
  type LeasedOutboxRow,
  type OutboxDrainOutcome,
} from './lib/lease-safe-outbox.js';
