export { ConsentModule } from './lib/consent.module.js';
export { ConsentController } from './lib/consent.controller.js';
export { ConsentService } from './lib/consent.service.js';
export { ConsentRepository } from './lib/consent.repository.js';
export { StaleConsentRepository } from './lib/stale-consent.repository.js';
export type {
  StaleContactingGrant,
  MarkExpiredInput,
} from './lib/stale-consent.repository.js';
export { OutboxPublisherRepository } from './lib/outbox-publisher.repository.js';
export type { UnpublishedOutboxEvent } from './lib/outbox-publisher.repository.js';
export { StaleConsentProcessor } from './lib/stale-consent.processor.js';
export type { StaleConsentScanInput } from './lib/stale-consent.processor.js';
export { STALE_CONSENT_QUEUE_NAME } from './lib/stale-consent.queue.constants.js';
export { OutboxPublisherProcessor } from './lib/outbox-publisher.processor.js';
export type { OutboxPublisherTickInput } from './lib/outbox-publisher.processor.js';
export {
  OUTBOX_PUBLISHER_QUEUE_NAME,
  OUTBOX_PUBLISHER_BATCH_SIZE,
} from './lib/outbox-publisher.queue.constants.js';
export { IdempotencyService } from './lib/idempotency.service.js';
export type {
  IdempotencyLookupInput,
  IdempotencyLookupResult,
  IdempotencyReplay,
  IdempotencyProceed,
  IdempotencyPersistInput,
} from './lib/idempotency.service.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
export { SourceConsentService } from './lib/source-consent.service.js';
export type { RegisterSourceDerivedConsentInput } from './lib/source-consent.service.js';
export { CONSENT_SOURCE_TYPES } from './lib/dto/source-consent-source.js';
export type { ConsentSourceType } from './lib/dto/source-consent-source.js';
export {
  ConsentGrantRequestDto,
  ConsentRevokeRequestDto,
  ConsentCheckRequestDto,
  CONSENT_SCOPES,
  CONSENT_CAPTURED_METHODS,
  CONSENT_CHECK_OPERATIONS,
  OPERATION_SCOPE_MAP,
  CONSENT_DECISION_LOG_EVENT_TYPES,
} from './lib/dto/index.js';
export type {
  ConsentScopeValue,
  ConsentCapturedMethodValue,
  ConsentGrantResponseDto,
  ConsentRevokeResponseDto,
  ConsentDecisionDto,
  ConsentCheckOperation,
  TalentConsentScopeStateDto,
  TalentConsentStateResponseDto,
  ConsentHistoryEventDto,
  ConsentHistoryResponseDto,
  ConsentDecisionLogEntryDto,
  ConsentDecisionLogEventType,
  ConsentDecisionLogActorType,
  ConsentDecisionLogResponseDto,
} from './lib/dto/index.js';
