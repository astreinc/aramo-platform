import { ApiError } from '@aramo/fe-foundation';

import type { DomainClaim, DomainVerificationStatus } from './domain-api';

// ORG-UX-1 (Directive v1.0 LOCKED §8.6) — the Domain page's status vocabulary and the
// refusal → message map (the P3 backend reasons, as sign-web's DomainCard reads them).

/** Status pill: UNVERIFIED → Not verified · PENDING → Checking… · VERIFIED → Verified. */
export const DOMAIN_STATUS_PILL: Readonly<Record<DomainVerificationStatus, { readonly label: string; readonly className: string }>> = {
  UNVERIFIED: { label: 'Not verified', className: 'ox-pill--warn' },
  PENDING: { label: 'Checking…', className: 'ox-pill--invited' },
  VERIFIED: { label: 'Verified', className: 'ox-pill--active' },
};

export const DOMAIN_CLAIM_LABEL: Readonly<Record<DomainClaim, string>> = {
  PROVISIONAL: 'Provisional',
  AUTHORITATIVE: 'Authoritative',
  LAPSED: 'Lapsed',
  RELEASED: 'Released',
};

export const DOMAIN_NOTE =
  'DNS changes can take minutes to hours. Verification proves domain ownership and is required before self-service Sign activation; it doesn’t change who can sign in.';

export const DOMAIN_CONFLICT_MESSAGE = 'Another Aramo organization holds this domain. Contact Aramo support.';

export function domainErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = typeof e.details?.['reason'] === 'string' ? (e.details['reason'] as string) : '';
    if (e.status === 403) return 'Only an organization owner or admin can verify the domain.';
    if (reason === 'no_allowed_domain') return 'Your organization has no email domain to verify.';
    if (reason === 'already_verified') return 'This domain is already verified.';
    if (reason === 'no_token_issued') return 'Get the TXT record first.';
    if (reason === 'invalid_delegate_email') return 'Enter a valid email address.';
    if (reason === 'too_many_active_delegations') return 'Too many verification links are active. Revoke one first.';
  }
  return 'Something went wrong. Try again.';
}
