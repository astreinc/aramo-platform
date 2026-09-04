// COMM-C1 — communications provider CONFIGURATION admin client (ats-web, Settings
// → Integrations → Communications). Uses the shared cookie/session apiClient.
// Authorized by integration:read (list) / integration:write (configure/test/map).
// The credential configure is WRITE-ONLY: the bundle is posted and never read
// back; no GET here ever returns secret material.

import { apiClient } from '@aramo/fe-foundation';

import { COMMUNICATIONS_PATH } from './communications-api';
import type {
  CommunicationConnectionTestResult,
  CommunicationProviderConfig,
  ZoomCredentialInput,
} from './provider-config-types';
import type { CommunicationProviderIdentity } from './types';

/** List the tenant's communication provider configurations (tolerant of un-provisioned). */
export async function listCommunicationProviders(): Promise<readonly CommunicationProviderConfig[]> {
  const res = await apiClient.get<{ items: CommunicationProviderConfig[] }>(
    `${COMMUNICATIONS_PATH}/providers`,
  );
  return res.items;
}

/** Configure/update the tenant's Zoom credential. Returns the refreshed config. */
export async function configureZoomCredential(
  bundle: ZoomCredentialInput,
): Promise<CommunicationProviderConfig> {
  const res = await apiClient.post<{ items: CommunicationProviderConfig[] }>(
    `${COMMUNICATIONS_PATH}/providers/zoom/credential`,
    bundle,
  );
  const [item] = res.items;
  if (item === undefined) {
    throw new Error('configure returned no provider configuration');
  }
  return item;
}

/** Structural connection test (no live external ping; B8-deferred). */
export async function testZoomConnection(): Promise<CommunicationConnectionTestResult> {
  return apiClient.post<CommunicationConnectionTestResult>(
    `${COMMUNICATIONS_PATH}/providers/zoom/test`,
  );
}

/** Admin: list the tenant's recruiter↔provider identity mappings. */
export async function listCommunicationProviderIdentities(): Promise<
  readonly CommunicationProviderIdentity[]
> {
  const res = await apiClient.get<{ items: CommunicationProviderIdentity[] }>(
    `${COMMUNICATIONS_PATH}/provider-identities`,
  );
  return res.items;
}

export interface UpsertProviderIdentityInput {
  readonly provider_user_id: string;
  readonly provider_extension_id?: string | null;
  readonly display_phone_number?: string | null;
  readonly extension?: string | null;
  readonly voice_enabled?: boolean;
  readonly sms_enabled?: boolean;
}

/** Admin: map/rebind a recruiter to a provider user/extension. */
export async function upsertCommunicationProviderIdentity(
  recruiterId: string,
  input: UpsertProviderIdentityInput,
): Promise<CommunicationProviderIdentity> {
  return apiClient.put<CommunicationProviderIdentity>(
    `${COMMUNICATIONS_PATH}/provider-identities/${encodeURIComponent(recruiterId)}`,
    input,
  );
}
