import { apiClient } from '@aramo/fe-foundation';

import type { AssignmentPipelineReport } from './assignment-pipeline-types';

// T9-B3 — GET /v1/reports/assignment-pipeline (report:read). Current snapshot,
// no query parameters. Counts only; visibility is server-side (tenant/site/A3).
// No commercial data is returned.
export async function getAssignmentPipeline(): Promise<AssignmentPipelineReport> {
  return apiClient.get<AssignmentPipelineReport>('/v1/reports/assignment-pipeline');
}
