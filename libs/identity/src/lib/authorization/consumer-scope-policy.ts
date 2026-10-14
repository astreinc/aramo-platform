// IC-2 PR-6 — Product entitlements, consumer capabilities and scope isolation
// (IC-0 §F.2 rules 3 and 4; §G; E-Sign PX-V1 §11 "three auth zones").
//
// ONE identity, MANY independently entitled products. Authentication proves WHO
// the User is and WHICH Tenant owns the identity; this policy decides WHICH
// product a consumer credential may be minted for and WHICH scope namespaces
// may ride it. Both halves are pure and consumer-keyed:
//
//  (A) Mint/refresh gate (rule 3) — the consumer's product capability must be
//      entitled to the tenant (`TenantEntitlement`), re-proven at every
//      issuance and refresh. `platform` (sentinel, no entitlements) is exempt;
//      `portal` is never minted through the Cognito path (passwordless only);
//      anything else is unsupported → denied.
//  (B) Scope-namespace filter (rule 4) — applied per request by the effective
//      authorization resolver AFTER the cached canonical set is read, so a cache
//      can never widen a token: recruiter/ingestion (ATS family) never carry
//      `esign:*` or `platform:*`; `esign` carries ONLY `esign:*` and ONLY while
//      the tenant holds the `esign` capability (read live, never cached);
//      `platform` carries ONLY `platform:*`; `portal` is the fixed set handled
//      before this filter; an unknown consumer resolves NOTHING (fail closed).
//
// Namespaces are the existing documented scope keys (`<namespace>:<action>`);
// nothing is renamed. "core" is NOT a product: holding `core` grants no ATS or
// Sign authorization. The org-admin subset for Sign-only owners (IC-0 N-2) is
// NOT decided here — an `esign` consumer today receives esign:* only.

export type ProductConsumer = 'recruiter' | 'portal' | 'ingestion' | 'platform' | 'esign';

export type ConsumerCapabilityRequirement =
  | { kind: 'capability'; capability: 'ats' | 'esign' }
  | { kind: 'exempt' }
  | { kind: 'unsupported' };

// Rule 3 — the product capability a consumer credential requires at mint/refresh.
export function requiredCapabilityForConsumer(consumer: string | undefined): ConsumerCapabilityRequirement {
  switch (consumer) {
    case 'recruiter':
    case 'ingestion':
      return { kind: 'capability', capability: 'ats' };
    case 'esign':
      return { kind: 'capability', capability: 'esign' };
    case 'platform':
      return { kind: 'exempt' };
    default:
      // `portal` (passwordless path only), undefined, or any unknown value.
      return { kind: 'unsupported' };
  }
}

export const ESIGN_SCOPE_PREFIX = 'esign:';
export const PLATFORM_SCOPE_PREFIX = 'platform:';

// Rule 4 — the scope namespaces a consumer may carry. `tenantHasEsign` is the
// LIVE entitlement read (only consulted for the esign consumer).
export function filterScopesForConsumer(args: {
  consumer: string;
  scopes: readonly string[];
  tenantHasEsign: boolean;
}): string[] {
  switch (args.consumer) {
    case 'recruiter':
    case 'ingestion':
      return args.scopes.filter(
        (s) => !s.startsWith(ESIGN_SCOPE_PREFIX) && !s.startsWith(PLATFORM_SCOPE_PREFIX),
      );
    case 'esign':
      return args.tenantHasEsign ? args.scopes.filter((s) => s.startsWith(ESIGN_SCOPE_PREFIX)) : [];
    case 'platform':
      return args.scopes.filter((s) => s.startsWith(PLATFORM_SCOPE_PREFIX));
    default:
      // portal (fixed set, handled upstream) and unknown consumers: nothing.
      return [];
  }
}
