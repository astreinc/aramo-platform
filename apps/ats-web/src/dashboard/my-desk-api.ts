import { apiClient } from '@aramo/fe-foundation';

import type { MyDeskView } from './my-desk-types';

// GET /v1/my-desk — the recruiter command-center READ composition. One endpoint,
// one visibility-scoped payload; the FE derives every card/tab count from the
// returned arrays (no N-round-trip, no drift). Visibility + tenancy are
// server-side (the FE never sends a tenant/user/requisition id).
export async function getMyDesk(): Promise<MyDeskView> {
  return apiClient.get<MyDeskView>('/v1/my-desk');
}
