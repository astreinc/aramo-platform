import { apiClient } from '@aramo/fe-foundation';

import type { Talent360View } from './talent-360-types';

// GET /v1/talent-360/:id — the person-centric recruiter workspace READ
// composition. ONE endpoint, ONE visibility-scoped payload; the FE renders what
// the backend composed and NEVER re-derives server-owned truth. Tenancy +
// visibility are server-side (the FE sends no tenant/user/requisition id) — only
// the Talent id, which is in the path.
export async function getTalent360(talentId: string): Promise<Talent360View> {
  return apiClient.get<Talent360View>(`/v1/talent-360/${talentId}`);
}
