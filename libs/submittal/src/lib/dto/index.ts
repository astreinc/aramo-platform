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
