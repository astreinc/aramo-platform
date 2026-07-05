export { TalentRecordModule } from './lib/talent-record.module.js';
export { TalentRecordController } from './lib/talent-record.controller.js';
export { TalentRecordRepository } from './lib/talent-record.repository.js';
export {
  TalentRecordReconcileRepository,
  type EnrichmentPatch,
  type FieldProvenanceRow,
  type PendingContradictionRow,
  type PendingContradictionForResolution,
} from './lib/talent-record-reconcile.repository.js';
export { TalentRecordService } from './lib/talent-record.service.js';
export type { PortalProfileProjection } from './lib/dto/portal-profile-projection.dto.js';
export { TalentLinkService } from './lib/talent-link.service.js';
export { PrismaService as TalentRecordPrismaService } from './lib/prisma/prisma.service.js';

// Segment 4 — server-side faceted-search contract.
export type {
  TalentSearchQuery,
  TalentSearchPage,
  TalentSortKey,
  SortDir,
  SkillMatch,
  NativeFacets,
  NativeFacetBucket,
} from './lib/dto/talent-search.dto.js';
// Segment 4b — cross-schema facet-counts result shape (composed in apps/api).
export type { CrossFacets } from './lib/dto/talent-cross-facets.port.js';

// Search PR-2 — résumé full-text surfaces.
export { ResumeTextService } from './lib/resume-text/resume-text.service.js';
export type {
  EnqueueReindexInput,
  DrainResult,
} from './lib/resume-text/resume-text.service.js';
export { redactResumeText } from './lib/resume-text/redaction.js';
export { ResumeReindexModule } from './lib/resume-text/resume-reindex.module.js';
export { ResumeReindexProcessor } from './lib/resume-text/resume-reindex.processor.js';
export {
  RESUME_REINDEX_QUEUE_NAME,
  RESUME_REINDEX_BATCH_SIZE,
} from './lib/resume-text/resume-reindex.queue.constants.js';

export type {
  TalentRecordView,
  CreateTalentRecordRequestDto,
  UpdateTalentRecordRequestDto,
  TalentLinkView,
} from './lib/dto/index.js';
export { LinkTalentRecordRequestDto } from './lib/dto/link-talent-record-request.dto.js';
