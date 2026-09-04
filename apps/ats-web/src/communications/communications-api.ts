// COMM-B4 — communications read client (ats-web). Uses the shared cookie/session
// apiClient. B4 consumes the B2/B3 READ routes only; call initiation
// (POST /v1/communications/calls) lands in COMM-B5 and is deliberately absent here.

import { apiClient } from '@aramo/fe-foundation';

import type {
  CommunicationCapabilities,
  CommunicationDispositionOutcome,
  CommunicationInteractionView,
  CommunicationProviderIdentity,
  VoiceEngagementEvidence,
} from './types';

export const COMMUNICATIONS_PATH = '/v1/communications';

/**
 * The tenant's provider capability descriptor. Throws ApiError(409,
 * COMMUNICATION_PROVIDER_NOT_CONFIGURED) when no provider connection is
 * configured — the runtime "is voice available?" gate.
 */
export async function getCommunicationCapabilities(): Promise<CommunicationCapabilities> {
  return apiClient.get<CommunicationCapabilities>(`${COMMUNICATIONS_PATH}/capabilities`);
}

/**
 * The calling recruiter's own provider-identity mapping. Throws ApiError(404,
 * COMMUNICATION_USER_NOT_MAPPED) when the caller has no mapping.
 */
export async function getMyCommunicationProviderIdentity(): Promise<CommunicationProviderIdentity> {
  return apiClient.get<CommunicationProviderIdentity>(
    `${COMMUNICATIONS_PATH}/me/provider-identity`,
  );
}

// COMM-C2A — initiate an outbound voice call. The server resolves the destination
// from the Talent's phone slot; the optional `regarding` binds the Talent ×
// Requisition (+ pipeline) context and lets a successful first attempt drive the
// governed no_contact→contacted transition. A fresh Idempotency-Key (UUID) makes
// a retry safe — the same key never dials twice.
export interface InitiateCallInput {
  readonly talent_id: string;
  readonly phone_slot: 'cell' | 'work' | 'home';
  readonly regarding?: { readonly requisition_id: string; readonly pipeline_id?: string };
}

export async function initiateCommunicationCall(
  input: InitiateCallInput,
): Promise<CommunicationInteractionView> {
  return apiClient.post<CommunicationInteractionView>(`${COMMUNICATIONS_PATH}/calls`, input, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
}

// COMM-C2A — record an append-only disposition on an interaction (existing
// taxonomy + endpoint; notes optional, governed by communication:notes:write).
export async function recordCommunicationDisposition(
  interactionId: string,
  input: { disposition: CommunicationDispositionOutcome; notes?: string | null },
): Promise<{ id: string }> {
  return apiClient.post<{ id: string }>(
    `${COMMUNICATIONS_PATH}/interactions/${encodeURIComponent(interactionId)}/disposition`,
    input,
  );
}

// COMM-C2A — derived provider-neutral voice engagement evidence for a
// Talent × Requisition (attempt vs recruiter/provider two-way conversation).
export async function getVoiceEngagementEvidence(
  talentId: string,
  requisitionId: string,
): Promise<VoiceEngagementEvidence> {
  const qs = new URLSearchParams({ talent_id: talentId, requisition_id: requisitionId });
  return apiClient.get<VoiceEngagementEvidence>(
    `${COMMUNICATIONS_PATH}/voice-evidence?${qs.toString()}`,
  );
}
