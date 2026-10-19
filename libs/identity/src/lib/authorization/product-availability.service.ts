import { Injectable } from '@nestjs/common';

import { ORG_ADMIN_SCOPE_KEYS } from '../dto/role.dto.js';
import { RoleService } from '../role.service.js';
import { TenantEntitlementReader } from '../tenant-entitlement-reader.service.js';

import { ESIGN_SCOPE_PREFIX, filterScopesForConsumer } from './consumer-scope-policy.js';

// D-ORG (Lead disposition 2026-10-17, R5 / §3.D) — the backend-AUTHORITATIVE
// product-availability projection App Home renders from. For the calling
// principal in its ONE tenant it answers, per product, three DISTINCT questions:
//
//   subscribed  — does the TENANT hold the product capability (TenantEntitlement,
//                 read live — never a front-end mirror)?
//   authorized  — does the USER hold at least one scope in that product's
//                 namespace, exactly as the product's own consumer would resolve it
//                 (the same filterScopesForConsumer the resolver applies — IC-0 rule 4)?
//   available   — may App Home navigate there now = subscribed AND authorized AND
//                 the product entry is activated in this deployment (Sign stays
//                 dark until PX-V1 activation; ATS and Organization are live).
//
// Nothing here grants anything: a purchased product with no role yields
// subscribed=true / authorized=false (no bulk grant), and the projection never
// exposes roles, scopes, other members or commercial data — only the three
// booleans, a reason and the entry path.
export const PRODUCT_KEYS = ['ats', 'esign', 'org'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

export type ProductUnavailableReason = 'not_subscribed' | 'not_authorized' | 'not_activated';

export interface ProductAvailability {
  readonly key: ProductKey;
  readonly subscribed: boolean;
  readonly authorized: boolean;
  readonly available: boolean;
  // Where the product opens; null while dark. A path relative to the tenant host
  // (D-ORG topology T1: /ats/, /org/), or an ABSOLUTE URL for a product on its own
  // host (Sign: https://esign.aramo.ai/ — Lead Host & Workspace Ruling v1.0).
  readonly entry_path: string | null;
  readonly reason: ProductUnavailableReason | null;
}

export interface ProductAvailabilityView {
  readonly tenant_id: string;
  readonly products: readonly ProductAvailability[];
}

// T1 topology (§3.B): App Home at `/`, ATS at `/ats/`, Organization Administration
// at `/org/`. Sign is NOT on the tenant host: its sender application is
// apps/esign-web on its own product host, esign.aramo.ai, for business and
// personal accounts alike (Lead Host & Workspace Ruling v1.0 amends the earlier
// tenant-host `/sign/` assumption). The entry stays dark until
// ARAMO_SIGN_ENTRY_ENABLED=true; ARAMO_SIGN_ENTRY_URL overrides the host
// (e.g. http://localhost:4206/ locally). The Sign app resolves /sign/ vs
// /personal/ itself from the backend context.
export const ATS_ENTRY_PATH = '/ats/';
export const ORG_ENTRY_PATH = '/org/';
// Sign Unified Product S-2 — the one Aramo Sign host.
export const DEFAULT_SIGN_ENTRY_URL = 'https://sign.aramo.ai/';

export function signEntryActivated(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ARAMO_SIGN_ENTRY_ENABLED'] === 'true';
}

// The Sign entry URL: ARAMO_SIGN_ENTRY_URL when it is an absolute http(s) URL,
// else the production product host. Never a tenant-host path.
export function signEntryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['ARAMO_SIGN_ENTRY_URL'];
  if (v !== undefined && /^https?:\/\/[^/\s]+/i.test(v)) return v.endsWith('/') ? v : `${v}/`;
  return DEFAULT_SIGN_ENTRY_URL;
}

// The organization scope(s) every tenant role carries as a session marker; holding
// ONLY these does not make a member an organization administrator.
const ORG_BASELINE_SCOPES: ReadonlySet<string> = new Set(['auth:session:read']);

@Injectable()
export class ProductAvailabilityService {
  constructor(
    private readonly roles: RoleService,
    private readonly entitlements: TenantEntitlementReader,
  ) {}

  private heldScopesAsSessionWouldResolve(args: { user_id: string; tenant_id: string }): Promise<string[]> {
    return heldScopes(this.roles, args);
  }

  async forPrincipal(args: { user_id: string; tenant_id: string }): Promise<ProductAvailabilityView> {
    const [capabilities, held] = await Promise.all([
      this.entitlements.getCapabilities(args.tenant_id),
      this.heldScopesAsSessionWouldResolve(args),
    ]);
    const tenantHasEsign = capabilities.has('esign');
    const orgSubset = ORG_ADMIN_SCOPE_KEYS as readonly string[];

    // ATS — the recruiter consumer's view minus the product-neutral organization
    // subset: at least one genuine ATS product scope.
    const atsScopes = filterScopesForConsumer({ consumer: 'recruiter', scopes: held, tenantHasEsign }).filter(
      (s) => !orgSubset.includes(s),
    );
    // Sign — the esign consumer's view restricted to the esign namespace. Evaluated
    // against the Sign namespace of the HELD scopes directly so "authorized" is
    // reported even when the tenant is not (yet) subscribed (subscribed=false,
    // authorized=true is a meaningful state for the operator).
    const signScopes = held.filter((s) => s.startsWith(ESIGN_SCOPE_PREFIX));
    // Organization — the org consumer's view minus the baseline session marker.
    const orgScopes = filterScopesForConsumer({ consumer: 'org', scopes: held, tenantHasEsign }).filter(
      (s) => !ORG_BASELINE_SCOPES.has(s),
    );

    const signActivated = signEntryActivated();
    const products: ProductAvailability[] = [
      product('ats', capabilities.has('ats'), atsScopes.length > 0, true, ATS_ENTRY_PATH),
      product('esign', tenantHasEsign, signScopes.length > 0, signActivated, signActivated ? signEntryUrl() : null),
      product('org', capabilities.has('core'), orgScopes.length > 0, true, ORG_ENTRY_PATH),
    ];
    return { tenant_id: args.tenant_id, products };
  }
}

// D-ORG Gate-6 V1 (parity) — the HELD scope set is read exactly the way a
// session mint resolves it (auth-service adapter `resolveScopesInternal`, PR-4
// §2.4 invariant 6): the principal's single active membership decides the
// reader — tenant-wide when `site_id` is null, the site-aware union
// (tenant-wide ∪ site-X) when the membership is site-scoped. The per-request
// resolver applies the same union under the token's site claim, so "authorized"
// here can never differ from the access the product session actually receives.
// Not a second authorization authority: the readers are the RoleService's own.
async function heldScopes(roles: RoleService, args: { user_id: string; tenant_id: string }): Promise<string[]> {
  const site_id = await roles.findActiveMembershipSite(args);
  return site_id === null
    ? roles.getScopesByUserAndTenant(args)
    : roles.getScopesByUserTenantAndSite({ ...args, site_id });
}

function product(
  key: ProductKey,
  subscribed: boolean,
  authorized: boolean,
  activated: boolean,
  entry_path: string | null,
): ProductAvailability {
  const reason: ProductUnavailableReason | null = !subscribed
    ? 'not_subscribed'
    : !authorized
      ? 'not_authorized'
      : !activated
        ? 'not_activated'
        : null;
  return { key, subscribed, authorized, available: reason === null, entry_path: reason === null ? entry_path : null, reason };
}
