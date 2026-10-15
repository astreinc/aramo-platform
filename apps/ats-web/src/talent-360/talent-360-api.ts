import { apiClient } from '@aramo/fe-foundation';

import type {
  CommunicationPreviewView,
  Talent360View,
  TalentDocumentContentView,
} from './talent-360-types';

// GET /v1/talent-360/:id — the person-centric recruiter workspace READ
// composition. ONE endpoint, ONE visibility-scoped payload; the FE renders what
// the backend composed and NEVER re-derives server-owned truth. Tenancy +
// visibility are server-side (the FE sends no tenant/user/requisition id) — only
// the Talent id, which is in the path.
export async function getTalent360(talentId: string): Promise<Talent360View> {
  return apiClient.get<Talent360View>(`/v1/talent-360/${talentId}`);
}

// GET /v1/talent-360/:talentId/communications/:interactionId — the full sent email
// behind a Recent-activity row (its preview_id). Loaded on demand, never inlined.
export async function getTalent360CommunicationPreview(
  talentId: string,
  interactionId: string,
): Promise<CommunicationPreviewView> {
  return apiClient.get<CommunicationPreviewView>(
    `/v1/talent-360/${talentId}/communications/${interactionId}`,
  );
}

// GET /v1/talent-360/:talentId/documents/:documentId/content — the document file
// for the READ-ONLY preview, loaded on click (never inlined in the 360 read).
export async function getTalent360DocumentContent(
  talentId: string,
  documentId: string,
): Promise<TalentDocumentContentView> {
  return apiClient.get<TalentDocumentContentView>(
    `/v1/talent-360/${talentId}/documents/${documentId}/content`,
  );
}
