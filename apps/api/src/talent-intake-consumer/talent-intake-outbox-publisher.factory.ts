import type { AramoLogger } from '@aramo/common';
import type { OutboxPublisherPort } from '@aramo/events';
import { StructuredLogOutboxPublisher } from '@aramo/outbox-publisher';
import type { TalentIntakeMessageHandler } from '@aramo/talent-record';

import type { TalentIntakeEventsConfig } from './talent-intake-events.config.js';
import { LazyEventBridgeOutboxPublisher } from './lazy-eventbridge-outbox-publisher.js';
import { SingleBoxTalentIntakePublisher } from './singlebox-talent-intake-publisher.js';

// ADR-0033 — the single place the Talent Intake OUTBOX_PUBLISHER_PORT adapter is
// selected from TALENT_INTAKE_TRANSPORT. Kept a pure function so the mapping is
// unit-testable without the Nest DI graph:
//   eventbridge    → EventBridge (lazy, fail-closed) — the distributed AWS path.
//   singlebox      → in-process delivery to TalentIntakeMessageHandler (no AWS).
//   structured-log → explicit non-prod/test selection only.
// singlebox is NEVER an automatic fallback from a broken EventBridge config — it
// is selected only on the explicit transport value.
export function selectTalentIntakeOutboxPublisher(
  config: TalentIntakeEventsConfig,
  logger: AramoLogger,
  handler: TalentIntakeMessageHandler,
): OutboxPublisherPort {
  switch (config.transport) {
    case 'eventbridge':
      return new LazyEventBridgeOutboxPublisher(config, logger);
    case 'singlebox':
      return new SingleBoxTalentIntakePublisher(handler, logger);
    case 'structured-log':
      return new StructuredLogOutboxPublisher(logger);
  }
  // Exhaustive over the validated union; defensive guard only.
  throw new Error(`unreachable TALENT_INTAKE_TRANSPORT: ${String(config.transport)}`);
}
