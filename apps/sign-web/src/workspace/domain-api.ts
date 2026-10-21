import { apiClient } from '@aramo/fe-foundation';

// Domain-Enforcement P3 (LOCKED) §4/§5 — the organization's email-domain
// verification, served by apps/api and reached on the Sign host through the
// narrow nginx exception (/v1/tenant/domain-verification and
// /v1/domain-verification/delegate only).
//
// The tenant routes ride the workspace's `sign` session (apiClient: cookie +
// X-Aramo-Consumer: sign); the backend authorizes them by tenant:admin:domain
// (organization owner / admin). The delegate routes are session-less: the link's
// token is posted in the body with a plain fetch that sends no credentials.
// Hand-mirror of the libs/identity views (leaf consumer of the HTTP surface).

export const DOMAIN_VERIFICATION_PATH = '/v1/tenant/domain-verification';
export const DELEGATE_PATH = '/v1/domain-verification/delegate';

export type DomainStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED';
export type DomainClaim = 'PROVISIONAL' | 'AUTHORITATIVE' | 'LAPSED' | 'RELEASED';

export interface DomainView {
  status: DomainStatus;
  allowed_domain: string | null;
  record_name: string | null;
  record_value: string | null;
  verified_at: string | null;
  token_issued_at: string | null;
  // P3 additive fields (absent on an older backend).
  domain_claim?: DomainClaim | null;
  domain_claim_conflict?: boolean;
}

export interface DomainDelegation {
  id: string;
  delegate_email: string;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface DelegateView {
  domain: string;
  record: { name: string | null; value: string | null };
  status: DomainStatus;
  domain_claim_conflict: boolean;
}

export const domainApi = {
  status: () => apiClient.get<DomainView>(DOMAIN_VERIFICATION_PATH),
  request: () => apiClient.post<DomainView>(DOMAIN_VERIFICATION_PATH, {}),
  check: () => apiClient.post<DomainView>(`${DOMAIN_VERIFICATION_PATH}/check`, {}),
  delegations: () => apiClient.get<{ items: DomainDelegation[] }>(`${DOMAIN_VERIFICATION_PATH}/delegations`),
  delegate: (delegate_email: string) => apiClient.post<DomainDelegation>(`${DOMAIN_VERIFICATION_PATH}/delegations`, { delegate_email }),
  revoke: (id: string) => apiClient.delete<DomainDelegation>(`${DOMAIN_VERIFICATION_PATH}/delegations/${encodeURIComponent(id)}`),
};

export type DomainApi = typeof domainApi;

// The delegate page's two calls. Every failure is one answer (the backend returns
// the same 404 for unknown / expired / revoked links).
export class DelegateLinkError extends Error {}

async function postDelegate(path: string, token: string): Promise<DelegateView> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new DelegateLinkError(String(res.status));
  return (await res.json()) as DelegateView;
}

export const delegateApi = {
  view: (token: string) => postDelegate(DELEGATE_PATH, token),
  check: (token: string) => postDelegate(`${DELEGATE_PATH}/check`, token),
};

export type DelegateApi = typeof delegateApi;

// The token travels in the URL fragment (#token=…), never to a server.
export function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const t = params.get('token');
  return t !== null && t.trim().length > 0 ? t.trim() : null;
}
