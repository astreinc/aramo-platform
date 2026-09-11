# Backlog — B7: Talent identity-verification enhancement

Status: **BACKLOG** (deferred from the Talent Detail Backend Enablement Directive v1.0 LOCKED).
Raised: 2026-09-10. Owner: Product (PO).

## Context
Today, "identity verification" for a manually-created talent is the **email
round-trip** only (TR-3 B2): the recruiter fires "Verify identity" from the
Talent Detail header, which requests a verification email; a successful
round-trip mints a `PLATFORM_VERIFIED` EMAIL anchor and the header shows the
green "Verified identity" badge. This is the accepted behavior for now.

## The enhancement (to revisit)
A richer, multi-signal identity-verification process beyond a single email
round-trip. Possible signals / directions (to be specified by Product):
- Phone verification (SMS/voice round-trip → `PLATFORM_VERIFIED` PHONE anchor).
- Government-ID / document verification.
- Portable credential / third-party identity provider.
- A guided multi-step "verification" workflow surface (status, retries,
  provenance) rather than a single action button.

## Why deferred
- Net-new product scope; not specified. Owned by Identity Resolution (TM-L2).
- The current email round-trip satisfies the immediate need.

## When revisited
Product writes the signal set + UX; then it becomes its own directive/branch.
Relates to the "Verify identity" header action already shipped in the Talent
Detail FE convergence and the Identity Resolution surface.
