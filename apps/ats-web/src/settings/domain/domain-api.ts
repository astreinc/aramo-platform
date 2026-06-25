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

export interface DomainVerificationView {
  readonly status: DomainVerificationStatus;
  readonly allowed_domain: string | null;
  readonly record_name: string | null;
  readonly record_value: string | null;
  readonly verified_at: string | null;
  readonly token_issued_at: string | null;
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
