import { apiClient } from '@aramo/fe-foundation';

import type { MarginReport } from './margin-types';

// T9-B4 — GET /v1/reports/margin (report:read AND assignment:commercials:read).
// Current snapshot, no query parameters. Aggregate-only; visibility is server-side
// (tenant/site/A3). No per-assignment rows, no pay/bill/spread — only the governed
// group_margin_percent aggregate and the coverage counts.
export async function getMargin(): Promise<MarginReport> {
  return apiClient.get<MarginReport>('/v1/reports/margin');
}
