export { ReportingModule } from './lib/reporting.module.js';
export { ReportingController } from './lib/reporting.controller.js';
export { DashboardController } from './lib/dashboard.controller.js';
export { ReportingService } from './lib/reporting.service.js';

// Lane 2 / L2-E (SB-5) — the reporting-owned submitted-history port. The
// @aramo/submittal-backed adapter (apps/api composition root) implements this;
// libs/reporting imports NO submittal domain/repo/schema (seam-exclusion preserved).
export {
  SUBMITTED_HISTORY_PORT,
  type SubmittedHistoryPort,
  type SubmittedHistoryGrain,
  type SubmittedHistoryQuery,
} from './lib/ports/submitted-history.port.js';

export type {
  TenantCountsReportView,
  RequisitionStatusRollupView,
  PipelineStageRollupView,
  PlacementCountReportView,
  FillPerformanceReportView,
  FallthroughReportView,
  FallthroughReasonView,
  AssignmentPipelineReportView,
  AssignmentPipelineStateCount,
  DashboardView,
} from './lib/dto/index.js';
