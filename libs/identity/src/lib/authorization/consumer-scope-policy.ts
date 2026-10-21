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
//      `esign:*` or `platform:*`; `sign` carries ONLY `esign:*` and ONLY while
//      the tenant holds the `sign` capability (read live, never cached) PLUS
//      the product-neutral organization subset (ORG_ADMIN_SCOPE_KEYS — IC-3
//      PR-7 / N-2) so a Sign-only organization can be administered, PLUS
//      document_template:read (DOC-TEMPLATE-LIB-1 T-4 §6.2);
//      `platform` carries ONLY `platform:*`; `portal` is the fixed set handled
//      before this filter; an unknown consumer resolves NOTHING (fail closed).
//
// Namespaces are the existing documented scope keys (`<namespace>:<action>`);
// nothing is renamed. "core" is NOT a product: holding `core` grants no ATS or
// Sign authorization. The org-admin subset for Sign-only owners (IC-0 N-2) is
// the ORG_ADMIN_SCOPE_KEYS set (IC-3 PR-7; ROLES-1 PR-2: the organization part of the
// tenant_owner / tenant_admin bundles).

import { ORG_ADMIN_SCOPE_KEYS } from '../dto/role.dto.js';

// DOC-TEMPLATE-LIB-1 T-4 (Directive v1.0 LOCKED §6.2; conforming amendment row 8) — the
// Documents template scopes each non-product credential additionally carries. Template
// administration lives in Org Home (the `org` consumer: read + manage); Sign starts
// envelopes from templates (the `sign` consumer: read only). Never platform:* — the
// platform tier is `platform:document_template:*`, a different namespace.
export const ORG_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS = [
  'document_template:read',
  'document_template:manage',
] as const;
export const SIGN_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS = ['document_template:read'] as const;

const ORG_SESSION_SCOPES: ReadonlySet<string> = new Set<string>([
  ...ORG_ADMIN_SCOPE_KEYS,
  ...ORG_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS,
]);
const SIGN_SESSION_NON_SIGN_SCOPES: ReadonlySet<string> = new Set<string>([
  ...ORG_ADMIN_SCOPE_KEYS,
  ...SIGN_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS,
]);

export type ProductConsumer = 'recruiter' | 'portal' | 'ingestion' | 'platform' | 'sign' | 'org';

export type ConsumerCapabilityRequirement =
  | { kind: 'capability'; capability: 'ats' | 'sign' | 'core' }
  | { kind: 'exempt' }
  | { kind: 'unsupported' };

// Rule 3 — the product capability a consumer credential requires at mint/refresh.
export function requiredCapabilityForConsumer(consumer: string | undefined): ConsumerCapabilityRequirement {
  switch (consumer) {
    case 'recruiter':
    case 'ingestion':
      return { kind: 'capability', capability: 'ats' };
    case 'sign':
      return { kind: 'capability', capability: 'sign' };
    // D-ORG (R2) — the organization credential needs the tenant to BE an Aramo
    // organization (`core`), never a product subscription: a Sign-only, ATS-only,
    // ATS+Sign or PERSONAL tenant all mint it.
    case 'org':
      return { kind: 'capability', capability: 'core' };
    case 'platform':
      return { kind: 'exempt' };
    default:
      // `portal` (passwordless path only), undefined, or any unknown value.
      return { kind: 'unsupported' };
  }
}

export const ESIGN_SCOPE_PREFIX = 'sign:';
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
    case 'sign':
      return args.tenantHasEsign
        ? args.scopes.filter((s) => s.startsWith(ESIGN_SCOPE_PREFIX) || SIGN_SESSION_NON_SIGN_SCOPES.has(s))
        : [];
    case 'platform':
      return args.scopes.filter((s) => s.startsWith(PLATFORM_SCOPE_PREFIX));
    // D-ORG (R2 / §3.C) — the organization credential carries EXACTLY the
    // organization-administration subset the principal holds (ORG_ADMIN_SCOPE_KEYS
    // ∩ held): never an ATS product scope, never esign:*, never platform:*.
    // Possession of `core` is NOT organization administration — an ordinary member
    // resolves only the baseline marker(s) its roles carry (e.g. auth:session:read),
    // which is enough for App Home (/v1/me needs no scope) and nothing else.
    // DOC-TEMPLATE-LIB-1 T-4 (§6.2) — plus document_template:{read,manage} (Org Home
    // template administration), still only what the principal holds.
    case 'org':
      return args.scopes.filter((s) => ORG_SESSION_SCOPES.has(s));
    default:
      // portal (fixed set, handled upstream) and unknown consumers: nothing.
      return [];
  }
}
