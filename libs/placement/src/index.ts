// Public barrel — libs/placement (Track 3 / E1-a, PlacementProcess Spine).

// Persistence.
export { PrismaService } from './lib/prisma/prisma.service.js';
export { PlacementRepository } from './lib/placement.repository.js';
export { PlacementProcessEventRepository } from './lib/placement-process-event.repository.js';

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

// Repository I/O types (not HTTP DTOs — §7).
export type {
  CreatePlacementInput,
  TransitionPlacementInput,
  PlacementProcessView,
  PlacementProcessEventView,
  StateTransitionPayload,
} from './lib/placement-process.types.js';
