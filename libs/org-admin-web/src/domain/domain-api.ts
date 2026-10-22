// Domain-Enforcement P2b §7 — tenant domain-verification client.
//
//   GET  /v1/tenant/domain-verification        -> DomainVerificationView (status + record)
//   POST /v1/tenant/domain-verification         -> mint token → PENDING
//   POST /v1/tenant/domain-verification/check   -> resolve+match → VERIFIED or stay PENDING
//
// Gates on tenant:admin:domain (covered by the AdminGate's tenant:admin:* family,
// so no FE scope reference changes). Hand-mirror of the libs/identity
// DomainVerificationView (leaf consumer of the HTTP surface — the no-@aramo/* rule).

import { apiClient } from '@aramo/fe-foundation';

export const DOMAIN_VERIFICATION_PATH = '/v1/tenant/domain-verification';

export type DomainVerificationStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED';
export type DomainClaim = 'PROVISIONAL' | 'AUTHORITATIVE' | 'LAPSED' | 'RELEASED';

export interface DomainVerificationView {
  readonly status: DomainVerificationStatus;
  readonly allowed_domain: string | null;
  readonly record_name: string | null;
  readonly record_value: string | null;
  readonly verified_at: string | null;
  readonly token_issued_at: string | null;
  // Domain-Enforcement P3 (additive; absent on an older backend) — the tenant's
  // claim on its domain, and whether another organization holds it.
  readonly domain_claim?: DomainClaim | null;
  readonly domain_claim_conflict?: boolean;
}

export function fetchDomainVerification(): Promise<DomainVerificationView> {
  return apiClient.get<DomainVerificationView>(DOMAIN_VERIFICATION_PATH);
}

export function requestDomainVerification(): Promise<DomainVerificationView> {
  return apiClient.post<DomainVerificationView>(DOMAIN_VERIFICATION_PATH, {});
}

export function checkDomainVerification(): Promise<DomainVerificationView> {
  return apiClient.post<DomainVerificationView>(
    `${DOMAIN_VERIFICATION_PATH}/check`,
    {},
  );
}

// Domain-Enforcement P3 (LOCKED) §5; ORG-UX-1 §8.6 (G16) — delegation of the DNS work
// to an IT / domain administrator (a 7-day link; same tenant:admin:domain scope).
//   GET    /v1/tenant/domain-verification/delegations      -> { items: DomainDelegation[] }
//   POST   /v1/tenant/domain-verification/delegations      -> DomainDelegation (201)
//   DELETE /v1/tenant/domain-verification/delegations/:id  -> DomainDelegation
// Hand-mirror of libs/identity DelegationView.
export interface DomainDelegation {
  readonly id: string;
  readonly delegate_email: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export function fetchDomainDelegations(): Promise<{ readonly items: readonly DomainDelegation[] }> {
  return apiClient.get<{ readonly items: readonly DomainDelegation[] }>(`${DOMAIN_VERIFICATION_PATH}/delegations`);
}

export function issueDomainDelegation(delegate_email: string): Promise<DomainDelegation> {
  return apiClient.post<DomainDelegation>(`${DOMAIN_VERIFICATION_PATH}/delegations`, { delegate_email });
}

export function revokeDomainDelegation(id: string): Promise<DomainDelegation> {
  return apiClient.delete<DomainDelegation>(`${DOMAIN_VERIFICATION_PATH}/delegations/${encodeURIComponent(id)}`);
}
