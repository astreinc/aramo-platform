// Public barrel — libs/placement (Track 3 / E1-a, PlacementProcess Spine).

// Persistence.
export { PrismaService } from './lib/prisma/prisma.service.js';
export { PlacementRepository } from './lib/placement.repository.js';
export { PlacementProcessEventRepository } from './lib/placement-process-event.repository.js';
// E1-c — placement outbox drain surface + its module (consumed by outbox-publisher).
export { PlacementOutboxRepository } from './lib/placement-outbox.repository.js';
export type { UnpublishedOutboxEvent } from './lib/placement-outbox.repository.js';
export { PlacementOutboxModule } from './lib/placement-outbox.module.js';

// Typed lifecycle registry — the single source of truth for the state machine
// (the migration SQL is generated from it).
export {
  PLACEMENT_STATES,
  INITIAL_STATE,
  LIFECYCLE_POSITIONS,
  STATE_POSITION,
  TRANSITIONS,
  LEGAL_TRANSITIONS,
  TRANSITION_TERMINAL,
  DUPLICATE_GUARD_INACTIVE,
  canTransition,
  canTransitionTyped,
  lifecyclePositionOf,
  PLACEMENT_AUTHORITY_CLASSES,
  edgeAuthorityClass,
} from './lib/lifecycle/placement-lifecycle.js';
export type {
  PlacementState,
  LifecyclePosition,
  LegalTarget,
  PlacementTransition,
  PlacementAuthorityClass,
} from './lib/lifecycle/placement-lifecycle.js';

// SQL generator (§5c/§5d) — registry → typed AST → migration SQL.
export {
  generatePlacementMigrationSql,
  buildPlacementMigrationModel,
} from './lib/generator/placement-sql-generator.js';

// E3 — the fallthrough/terminal reason registry (code-backed, PO-ratified) and
// its taxonomy-neutral classifier.
export {
  PLACEMENT_REASONS,
  REASON_DETAIL_POLICIES,
  REASON_STATUSES,
  REASON_DETAIL_MAX,
  REASON_REJECTION_REASONS,
  GOVERNED_TERMINAL_TARGETS,
  isGovernedTerminalTarget,
  getReason,
  activeReasonsForTarget,
  normalizeReasonDetail,
  classifyTransitionReason,
} from './lib/reasons/placement-reason-registry.js';
export type {
  PlacementReasonDefinition,
  ReasonDetailPolicy,
  ReasonStatus,
  ReasonEvidence,
  ReasonRejectionReason,
  ReasonClassification,
  ClassifyReasonInput,
} from './lib/reasons/placement-reason-registry.js';

// Repository I/O types (not HTTP DTOs — §7).
export type {
  CreatePlacementInput,
  TransitionPlacementInput,
  AssignmentContext,
  PlacementProcessView,
  PlacementProcessEventView,
  StateTransitionPayload,
  ContractAssignmentEndReason,
} from './lib/placement-process.types.js';

// Track 4 / T4-B — the placement-owned capacity projection (§4: consumers pull).
export { PlacementCapacityModule } from './lib/placement-capacity.module.js';
export { CapacityProjectionRepository } from './lib/capacity/capacity-projection.repository.js';
export { deriveCapacity, CAPACITY_STATUSES } from './lib/capacity/capacity-derivation.js';
export type { CapacityInput, CapacityProjection, CapacityStatus } from './lib/capacity/capacity-derivation.js';
