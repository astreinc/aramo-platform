// Public barrel — libs/submittal-eligibility (Lane L8-B1).
export { SubmittalEligibilityModule } from './lib/submittal-eligibility.module.js';
export { SubmittalPolicyRepository } from './lib/submittal-policy.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

// L8-B2 — requisition-grain Client Status reader (DI-injected into libs/requisition,
// following the CapacityProjectionRepository precedent).
export { RequisitionSubmittalEligibilityReader } from './lib/requisition-eligibility-reader.js';
export type {
  ClientSubmittalStatus,
  ClientSubmittalReason,
  RequisitionClientSubmittalView,
} from './lib/requisition-eligibility-reader.js';

export type {
  SetPolicyInput,
  PolicyRow,
} from './lib/submittal-policy.repository.js';

// The neutral, versioned eligibility PORT (pure decision logic + types).
export {
  SUBMITTAL_ELIGIBILITY_PORT_VERSION,
  deriveWindowStatus,
  evaluateEligibility,
} from './lib/submittal-eligibility.port.js';
export type {
  EligibilityDenyCode,
  SubmittalPolicyInputs,
  EligibilityContext,
  WindowStatusDerivation,
  SubmittalEligibilityDecision,
} from './lib/submittal-eligibility.port.js';

// Serialized slot consumption (§6 Approach A) — the connection-agnostic raw-SQL
// the apps/api orchestrator reuses inside its one interactive transaction.
export { consumeSlot } from './lib/submittal-consumption.js';
export type {
  RawTx,
  ConsumeResult,
  ConsumeSlotInput,
} from './lib/submittal-consumption.js';

export {
  SUBMITTAL_AUTHORITY_VALUES,
  SUBMITTAL_WINDOW_STATUS_VALUES,
  SUBMITTAL_POLICY_REASON_VALUES,
  isSubmittalAuthority,
  isSubmittalWindowStatus,
  isSubmittalPolicyReason,
} from './lib/submittal-eligibility-vocab.js';
export type {
  SubmittalAuthorityValue,
  SubmittalWindowStatusValue,
  SubmittalPolicyReasonValue,
} from './lib/submittal-eligibility-vocab.js';
