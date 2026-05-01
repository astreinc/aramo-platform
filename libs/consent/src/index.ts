export { ConsentModule } from './lib/consent.module.js';
export { ConsentController } from './lib/consent.controller.js';
export { ConsentService } from './lib/consent.service.js';
export { ConsentRepository } from './lib/consent.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
export {
  ConsentGrantRequestDto,
  ConsentRevokeRequestDto,
  ConsentCheckRequestDto,
  CONSENT_SCOPES,
  CONSENT_CAPTURED_METHODS,
  CONSENT_CHECK_OPERATIONS,
  OPERATION_SCOPE_MAP,
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
} from './lib/dto/index.js';
