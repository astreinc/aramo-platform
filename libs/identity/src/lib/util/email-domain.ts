// Domain-Enforcement P1 — email normalization + the personal/disposable
// domain check that the tenant-creation invariant (reject-personal) and the
// invite domain-lock both consume.
//
// PLACEMENT: this is a leaf util in libs/identity so the two consumers in
// this lib (TenantService.provisionTenant and TenantUserLifecycleService.
// inviteTenantUser) share ONE implementation. `normalizeEmail` is the same
// trim+lowercase the reconcile spine (session-orchestrator) applies to the
// IdP login email — folding it into the invite store closes the latent
// mixed-case reconcile bug (a `Divya@…` invite stored verbatim never matched
// the lowercased login lookup). The reconcile spine itself is NOT rewired in
// P1 (out of scope); this just makes the STORED side agree with it.
//
// DATASETS (PO Q3 ruling — consume, don't curate):
//   - free-email-domains — the consumer/free providers (gmail, yahoo,
//     outlook, …) + a large set of throwaway domains. Fresh on npm
//     (published the week of install, ~180k weekly downloads). The primary
//     "personal" check.
//   - disposable-email-domains-js — the actively-maintained (monthly
//     publishes) successor to the directive-named `disposable-email-domains`,
//     which was last published in 2022 and is stale. Per the directive's
//     "if either is stale/unmaintained, pick the current equivalent and note
//     it" clause we swapped to the -js fork; it ships a typed
//     `isDisposableEmailDomain` helper over a JSON blocklist.
//
// Both lists are loaded ONCE at module load (the free set is materialized
// here; the disposable lookup is the package's own preloaded Set behind
// isDisposableEmailDomain) — never per-request.

import { AramoError } from '@aramo/common';
import freeEmailDomains from 'free-email-domains';
import { isDisposableEmailDomain } from 'disposable-email-domains-js';

// Materialize the free-provider list into a lowercased Set once. The package
// ships lowercase already, but we normalize defensively so the membership
// test is case-exact against our normalized input.
const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set(
  freeEmailDomains.map((d) => d.toLowerCase()),
);

// Normalize an email the same way the login/reconcile path does: trim
// surrounding whitespace + lowercase. The single source of the normalization
// rule for the invite store + the domain extraction.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Extract the domain part of an email (normalized first). Uses the LAST '@'
// so a quoted local-part containing '@' still yields the routing domain.
// Returns '' when there is no domain (malformed input) — callers decide how
// to treat an empty domain (provision rejects it; the invite lock never sees
// it because the email is @IsEmail-validated upstream).
export function extractEmailDomain(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  return at === -1 ? '' : normalized.slice(at + 1);
}

// TRUE when the domain is a personal/free provider OR a disposable/throwaway
// provider — the union of both maintained datasets. Used ONLY at tenant
// creation (§2); the invite path relies transitively on the domain-lock
// equality and never calls this.
export function isPersonalOrDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return FREE_EMAIL_DOMAINS.has(d) || isDisposableEmailDomain(d);
}

// Domain-Enforcement P1 — the SINGLE-SOURCE reject-personal gate at tenant
// creation. Given the owner's email, returns the derived (normalized) domain
// to lock the tenant to, or throws a 4xx VALIDATION_ERROR:
//   - empty domain (malformed email)            → reason 'invalid_owner_email'
//   - personal/free or disposable provider      → reason 'personal_email_not_allowed'
//
// Called from BOTH the authoritative service spine (TenantService.
// provisionTenant — where the invariant lives so every creation path inherits
// it) AND the platform-admin pre-check that runs BEFORE Cognito AdminCreateUser
// (so a personal owner email is rejected without Cognito ever emailing a
// temp-password to that address). One implementation → the error code, reason,
// and message can never drift between the two call sites.
export function deriveAllowedDomainOrThrow(
  ownerEmail: string,
  requestId: string,
): string {
  const domain = extractEmailDomain(ownerEmail);
  if (domain.length === 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'A valid owner email is required to provision a tenant',
      400,
      { requestId, details: { reason: 'invalid_owner_email' } },
    );
  }
  if (isPersonalOrDisposableDomain(domain)) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'Tenant owner must use a business email, not a personal provider',
      400,
      {
        requestId,
        details: { reason: 'personal_email_not_allowed', domain },
      },
    );
  }
  return domain;
}
