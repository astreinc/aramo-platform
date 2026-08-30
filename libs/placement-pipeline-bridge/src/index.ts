// Public barrel — libs/placement-pipeline-bridge (Lane 2 / L2-G, Part 3). The thin
// cross-domain orchestration-bookkeeping owner (idempotent-consumer inbox).
export { PlacementPipelineBridgeModule } from './lib/placement-pipeline-bridge.module.js';
export { PlacementPipelineInboxRepository } from './lib/placement-pipeline-inbox.repository.js';
export type {
  InboxRow,
  ReserveResult,
} from './lib/placement-pipeline-inbox.repository.js';
export { PrismaService as PlacementPipelineBridgePrismaService } from './lib/prisma/prisma.service.js';
export {
  INBOX_OUTCOME_CODES,
  PLACEMENT_STATE_CHANGED_EVENT_TYPE,
  type InboxOutcomeCode,
  type PlacementStateChangedPayload,
} from './lib/types.js';
