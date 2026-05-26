export { SubmittalModule } from './lib/submittal.module.js';
export { SubmittalRepository } from './lib/submittal.repository.js';
export { SubmittalController } from './lib/submittal.controller.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type {
  CreateSubmittalInput,
  CreateSubmittalRequestDto,
  CreateSubmittalResponseDto,
  FailedCriterionAcknowledgment,
  SubmittalStateValue,
  TalentSubmittalRecordView,
} from './lib/dto/index.js';

// M4 PR-4 — confirm endpoint surfaces.
export {
  ConfirmSubmittalRequestDto,
  RecruiterAttestationsDto,
} from './lib/dto/index.js';
export type {
  ConfirmSubmittalResponseDto,
} from './lib/dto/index.js';
export type { ConfirmSubmittalInput } from './lib/submittal.repository.js';

// M4 PR-7 — revoke endpoint surfaces.
export { RevokeSubmittalRequestDto } from './lib/dto/index.js';
export type { RevokeSubmittalResponseDto } from './lib/dto/index.js';
export type { RevokeSubmittalInput } from './lib/submittal.repository.js';

// M5 PR-8b1 — TalentSubmittalEvent event-log substrate.
export { TalentSubmittalEventRepository } from './lib/talent-submittal-event.repository.js';
export type {
  TalentSubmittalEventView,
  SubmittalEventTypeValue,
  AppendSubmittalEventInput,
} from './lib/dto/index.js';

// M5 PR-8b1 — SubmittalState closed-list substrate. `canTransition`
// re-exported as `canTransitionSubmittal` at the workspace barrel per
// Lead-Q-PR-8b1-A7 + Process Lesson 53 (defensive disambiguation —
// engagement-side also exports `canTransition`; the unqualified name
// surfaces in two libs and the rename guards consumers that import
// from `@aramo/submittal` against shadowing).
export { SUBMITTAL_STATE_VALUES, canTransition as canTransitionSubmittal } from './lib/submittal-state.js';
