export { ConsentModule } from './lib/consent.module.js';
// Portal P2 P2a — the default consent term + the versioned consent-text registry
// (the D7 hash preimage). Consumed by the portal consent routes + P2b UI.
export { CONSENT_DEFAULT_TERM_MONTHS } from './lib/consent.service.js';
export {
  CONSENT_TEXT_CURRENT_VERSION,
  renderPortalConsentText,
  hashPortalConsentText,
  type ConsentTextContext,
} from './lib/consent-texts.js';
export {
  NOTICE_TEXT_CURRENT_VERSION,
  renderPlatformNotice,
  hashPlatformNotice,
  renderPlatformNoticeEmail,
} from './lib/notice-texts.js';
export { ConsentController } from './lib/consent.controller.js';
export { ConsentService } from './lib/consent.service.js';
export {
  ConsentRepository,
  type ConsentSummary,
} from './lib/consent.repository.js';
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
// M6 PR-2 §4 — OutboxPublisherProcessor, OutboxPublisherTickInput,
// OUTBOX_PUBLISHER_QUEUE_NAME, and OUTBOX_PUBLISHER_BATCH_SIZE have
// RELOCATED to @aramo/outbox-publisher per Amendment §2.4. The
// consent-side OutboxPublisherRepository (above) STAYS here — consent
// emission/behavior unchanged (Ruling 3) — and is now consumed by the
// new leaf lib libs/outbox-publisher via this barrel export.
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
  PortalConsentTextEntryDto,
  PortalConsentTextResponseDto,
  ConsentDecisionLogEntryDto,
  ConsentDecisionLogEventType,
  ConsentDecisionLogActorType,
  ConsentDecisionLogResponseDto,
} from './lib/dto/index.js';
