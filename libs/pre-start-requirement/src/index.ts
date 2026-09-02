// Public barrel — libs/pre-start-requirement (Track 3 / E2). FIRST-WRITE of the
// canonical E2 bounded context (the lib does not exist on main).
//
// The guarded HTTP and cross-domain orchestration surface for
// pre-start-requirement lives in apps/api by design. This library is a near-leaf
// domain module and intentionally contains no controllers.
//
// It imports no placement code, performs no PlacementProcess transition, stores
// no placement lifecycle state and no placement-level is_blocked flag; it exposes
// readiness / blocking assessment only. `placement_process_id` is an opaque UUID
// reference to placement.PlacementProcess — no FK, no Prisma relation, no import
// dependency (Architecture §7.3).

// Persistence.
export { PrismaService } from './lib/prisma/prisma.service.js';

// Repositories (the domain surface apps/api orchestrates over).
export { DefinitionSetRepository } from './lib/definition-set.repository.js';
export { RequirementInstanceRepository } from './lib/requirement-instance.repository.js';
export { MaterializationIntentRepository } from './lib/materialization-intent.repository.js';
export { ReadinessDecisionRepository } from './lib/readiness-decision.repository.js';

// Closed registries + guards + checksum (directive §4c / §14 A2).
export {
  REQUIREMENT_TYPE_VALUES,
  SCOPE_TYPE_VALUES,
  REQUIREMENT_STATUS_VALUES,
  WAIVER_MODE_VALUES,
  WAIVER_AUTHORITY_VALUES,
  AUDIT_ACTION_VALUES,
  SET_STATE_VALUES,
  isRequirementType,
  isScopeType,
  isRequirementStatus,
  isWaiverMode,
  isWaiverAuthority,
  isAuditAction,
  isSetState,
  isResolvedStatus,
  isUnresolvedStatus,
  canMoveStatus,
  isReopen,
  requiredAuthorityFor,
  isWaiverPermitted,
  isRequirementDefinitionInput,
  canonicalizeDefinitions,
  checksumDefinitions,
} from './lib/pre-start-requirement-vocab.js';
export type {
  RequirementTypeValue,
  ScopeTypeValue,
  RequirementStatusValue,
  WaiverModeValue,
  WaiverAuthorityValue,
  AuditActionValue,
  SetStateValue,
  RequirementDefinitionInput,
} from './lib/pre-start-requirement-vocab.js';

// Repository I/O types (internal signatures, not HTTP DTOs).
export type {
  ScopeSelector,
  CreateDraftSetInput,
  EditDraftSetInput,
  PublishSetInput,
  DefinitionView,
  SetView,
  MaterializeInput,
  InstanceView,
  StatusMoveInput,
  WaiveInput,
  AuditView,
  BlockingAssessment,
  BlockerProjection,
  IntentStatus,
  IntentView,
  ReadinessDecisionResult,
  ReadinessRefusalReason,
  RecordReadinessDecisionInput,
  ReadinessDecisionView,
} from './lib/pre-start-requirement.types.js';
