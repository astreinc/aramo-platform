export type {
  TalentSubmittalRecordView,
  SubmittalStateValue,
  FailedCriterionAcknowledgment,
  CreateSubmittalInput,
} from './talent-submittal-record.view.js';

export type {
  CreateSubmittalRequestDto,
  CreateSubmittalResponseDto,
} from './create-submittal-request.dto.js';

// M4 PR-4 §4.4 — confirm endpoint DTOs.
export {
  ConfirmSubmittalRequestDto,
  RecruiterAttestationsDto,
} from './confirm-submittal-request.dto.js';
export type {
  ConfirmSubmittalResponseDto,
} from './confirm-submittal-request.dto.js';

// M4 PR-7 §4.5 — revoke endpoint DTOs.
export { RevokeSubmittalRequestDto } from './revoke-submittal-request.dto.js';
export type { RevokeSubmittalResponseDto } from './revoke-submittal-response.dto.js';

// M5 PR-8b1 §4.5 — TalentSubmittalEvent event-log DTOs.
export type {
  TalentSubmittalEventView,
  SubmittalEventTypeValue,
} from './talent-submittal-event.view.js';
export type { AppendSubmittalEventInput } from './append-submittal-event.input.js';
