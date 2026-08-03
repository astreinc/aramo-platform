// Public barrel — libs/client-talent-restriction (Track 3 / E7).
export { ClientTalentRestrictionModule } from './lib/client-talent-restriction.module.js';
export { ClientTalentRestrictionController } from './lib/client-talent-restriction.controller.js';
export { ClientTalentRestrictionRepository } from './lib/client-talent-restriction.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type {
  ClientTalentRestrictionView,
  CreateRestrictionInput,
  CloseRestrictionInput,
  CreateRestrictionResponseDto,
  CloseRestrictionResponseDto,
  CurrentRestrictionsResponseDto,
  RestrictionHistoryResponseDto,
} from './lib/dto/client-talent-restriction.view.js';
export type { CreateRestrictionRequestDto } from './lib/dto/create-restriction-request.dto.js';
export type { CloseRestrictionRequestDto } from './lib/dto/close-restriction-request.dto.js';

export {
  RESTRICTION_TYPE_VALUES,
  ASSERTED_BY_TYPE_VALUES,
  SOURCE_SYSTEM_VALUES,
  CLOSE_REASON_CODE_VALUES,
  isRestrictionType,
  isAssertedByType,
  isSourceSystem,
  isCloseReasonCode,
  isGovernedSourceReference,
} from './lib/client-talent-restriction-vocab.js';
export type {
  RestrictionTypeValue,
  AssertedByTypeValue,
  SourceSystemValue,
  CloseReasonCodeValue,
} from './lib/client-talent-restriction-vocab.js';
