export { ConsentModule } from './lib/consent.module.js';
export { ConsentController } from './lib/consent.controller.js';
export { ConsentService } from './lib/consent.service.js';
export { ConsentRepository } from './lib/consent.repository.js';
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
