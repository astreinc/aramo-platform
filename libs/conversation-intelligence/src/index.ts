export { ConversationIntelligenceModule } from './lib/conversation-intelligence.module.js';
export { RequisitionAnalysisContextSnapshotService } from './lib/requisition-analysis-context-snapshot.service.js';
export { RequisitionAnalysisContextSnapshotRepository } from './lib/requisition-analysis-context-snapshot.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

// Reader port — a composition root (CI-B6 / apps/api) may rebind the
// REQUISITION_ANALYSIS_CONTEXT_READER token; the concrete adapter is
// exported so wiring specs can assert it.
export {
  REQUISITION_ANALYSIS_CONTEXT_READER,
  type RequisitionAnalysisContextReader,
} from './lib/reader/requisition-analysis-context-reader.js';
export { RequisitionGoldenProfileContextReader } from './lib/reader/requisition-golden-profile-context.reader.js';

export type { CaptureRequisitionAnalysisContextInput } from './lib/requisition-analysis-context-snapshot.service.js';
export type { CreateRequisitionAnalysisContextSnapshotInput } from './lib/requisition-analysis-context-snapshot.repository.js';
export type { RequisitionAnalysisContextSnapshotView } from './lib/dto/requisition-analysis-context-snapshot.view.js';

export {
  REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
  buildRequisitionAnalysisContext,
  isRequisitionAnalysisContextV1,
} from './lib/dto/requisition-analysis-context.js';
export type {
  RequisitionAnalysisContextV1,
  RequisitionAnalysisContextSchemaVersion,
  RequisitionAnalysisSource,
  RequisitionAnalysisRoleContext,
  RequisitionAnalysisLocation,
  RequisitionAnalysisWorkArrangement,
  RequisitionAnalysisEngagement,
  RequisitionAnalysisGoldenProfile,
} from './lib/dto/requisition-analysis-context.js';
