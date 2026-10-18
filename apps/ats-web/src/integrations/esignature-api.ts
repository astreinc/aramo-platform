// Multi-Provider E-Sign directive §E/§H — Settings → Integrations → E-Signature.
// The server decides everything shown here (provider statuses, availability,
// allowance); the panel renders it and never re-derives entitlement.

import { apiClient } from '@aramo/fe-foundation';

export type ESignatureProvider = 'aramo_sign' | 'docusign' | 'adobe_sign';
export type ESignatureProviderStatus = 'BUILT_IN' | 'CONNECTED' | 'NOT_CONNECTED' | 'NOT_AVAILABLE';
export type SigningUnavailableReason =
  | 'NO_PROVIDER'
  | 'NOT_SUBSCRIBED'
  | 'NOT_AUTHORIZED'
  | 'LIMIT_REACHED'
  | 'PROVIDER_DISCONNECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REFUSED';

export interface SignatureAllowance {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly period_start: string;
  readonly period_end: string;
  readonly threshold: 'OK' | 'WARNING' | 'EXHAUSTED';
}

export interface SigningAvailability {
  readonly provider: ESignatureProvider | null;
  readonly available: boolean;
  readonly reason: SigningUnavailableReason | null;
  readonly allowance: SignatureAllowance | null;
}

export interface ESignatureOverview {
  readonly active_provider: ESignatureProvider;
  readonly providers: ReadonlyArray<{ provider: ESignatureProvider; status: ESignatureProviderStatus; selectable: boolean }>;
  readonly availability: SigningAvailability;
  readonly recent_changes: ReadonlyArray<{ from_provider: string; to_provider: string; actor_id: string; occurred_at: string }>;
}

export async function getESignatureOverview(): Promise<ESignatureOverview> {
  return apiClient.get<ESignatureOverview>('/v1/integrations/esignature/overview');
}

export async function selectESignatureProvider(provider: ESignatureProvider): Promise<ESignatureOverview> {
  return apiClient.put<ESignatureOverview>('/v1/integrations/esignature/active-provider', { provider });
}
