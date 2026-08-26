// COMM-B4 — communications read client (ats-web). Uses the shared cookie/session
// apiClient. B4 consumes the B2/B3 READ routes only; call initiation
// (POST /v1/communications/calls) lands in COMM-B5 and is deliberately absent here.

import { apiClient } from '@aramo/fe-foundation';

import type { CommunicationCapabilities, CommunicationProviderIdentity } from './types';

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
