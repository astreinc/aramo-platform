import { Injectable } from '@nestjs/common';

import { ORG_ADMIN_SCOPE_KEYS, ORG_ROLE_KEYS } from '../dto/role.dto.js';
import { RoleService } from '../role.service.js';
import { TenantEntitlementReader } from '../tenant-entitlement-reader.service.js';

import {
  ESIGN_SCOPE_PREFIX,
  ORG_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS,
  filterScopesForConsumer,
} from './consumer-scope-policy.js';

// D-ORG (Lead disposition 2026-10-17, R5 / §3.D) — the backend-AUTHORITATIVE
// product-availability projection App Home renders from. For the calling
// principal in its ONE tenant it answers, per product, three DISTINCT questions:
//
//   subscribed  — does the TENANT hold the product capability (TenantEntitlement,
//                 read live — never a front-end mirror)?
//   authorized  — does the USER hold at least one scope in that product's
//                 namespace, exactly as the product's own consumer would resolve it
//                 (the same filterScopesForConsumer the resolver applies — IC-0 rule 4),
//                 AND does the tenant hold the product capability? ROLES-1 PR-2
//                 (§3.5): the organization roles' static bundles carry ATS and Sign
//                 scopes in every tenant, so a held scope alone no longer means the
//                 user can work in the product.
//   available   — may App Home navigate there now = subscribed AND authorized AND
//                 the product entry is activated in this deployment (Sign stays
//                 dark until PX-V1 activation; ATS and Organization are live).
//
// Nothing here grants anything: a purchased product with no role yields
// subscribed=true / authorized=false (no bulk grant), and the projection never
// exposes roles, scopes, other members or commercial data — only the three
// booleans, a reason and the entry path.
// ATI-SEP-1 T9 — `intelligence` (Talent Intelligence): subscribed = the tenant
// holds the `intelligence` capability (default OFF); its insights surface inside
// the ATS, so it is authorized / opened exactly like the ATS (entry /ats/). App
// Home shows its tile ONLY when subscribed (never as an "other product").
export const PRODUCT_KEYS = ['ats', 'sign', 'org', 'intelligence'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

export type ProductUnavailableReason = 'not_subscribed' | 'not_authorized' | 'not_activated';

// ORG-UX-1 (Directive v1.0 LOCKED §4.3, Lead Correction A) — what the Organization
// workspace shows this principal. Server-evaluated from the ADR-0035 role model:
//   admin     — holds tenant_owner or tenant_admin (the authoritative organization roles)
//   templates — not admin, but authors or approves templates (document_template:author /
//               :manage as the org session resolves them): Our templates + Template gallery
//   none      — App Home only
// Holding some tenant:admin:* scope (or the directory read) never confers organization
// administration. Navigation only: every organization command keeps its own scope guard.
export type OrgAccess = 'admin' | 'templates' | 'none';
export const ORG_TEMPLATES_ENTRY_PATH = '/org/document-templates';

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
  // ORG-UX-1 §4.3 — present on the `org` entry only (additive field).
  readonly org_access?: OrgAccess;
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
    const [capabilities, held, roleKeys] = await Promise.all([
      this.entitlements.getCapabilities(args.tenant_id),
      this.heldScopesAsSessionWouldResolve(args),
      heldRoleKeys(this.roles, args),
    ]);
    const tenantHasEsign = capabilities.has('sign');
    const orgSubset = ORG_ADMIN_SCOPE_KEYS as readonly string[];

    // ATS — the recruiter consumer's view minus the product-neutral organization
    // subset: at least one genuine ATS product scope.
    const atsScopes = filterScopesForConsumer({ consumer: 'recruiter', scopes: held, tenantHasEsign }).filter(
      (s) => !orgSubset.includes(s),
    );
    // Sign — the esign consumer's view restricted to the esign namespace (read from
    // the HELD scopes; the capability half of "authorized" is applied below).
    const signScopes = held.filter((s) => s.startsWith(ESIGN_SCOPE_PREFIX));
    // Organization — ORG-UX-1 §4.3 (Lead Correction A): admin from the ROLE model
    // (tenant_owner / tenant_admin), templates from the template-authoring scopes the org
    // session would carry. A tenant:admin:* scope or the directory read alone is neither.
    const orgSession = filterScopesForConsumer({ consumer: 'org', scopes: held, tenantHasEsign });
    const orgAccess: OrgAccess = roleKeys.some((k) => (ORG_ROLE_KEYS as readonly string[]).includes(k))
      ? 'admin'
      : orgSession.some((s) => (ORG_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS as readonly string[]).includes(s))
        ? 'templates'
        : 'none';
    const orgEntry = orgAccess === 'templates' ? ORG_TEMPLATES_ENTRY_PATH : ORG_ENTRY_PATH;

    const signActivated = signEntryActivated();
    const products: ProductAvailability[] = [
      // ROLES-1 PR-2 (§3.5) — authorized = scope held AND the tenant holds the capability.
      product('ats', capabilities.has('ats'), capabilities.has('ats') && atsScopes.length > 0, true, ATS_ENTRY_PATH),
      product(
        'sign',
        tenantHasEsign,
        tenantHasEsign && signScopes.length > 0,
        signActivated,
        signActivated ? signEntryUrl() : null,
      ),
      { ...product('org', capabilities.has('core'), capabilities.has('core') && orgAccess !== 'none', true, orgEntry), org_access: capabilities.has('core') ? orgAccess : 'none' },
      product(
        'intelligence',
        capabilities.has('intelligence'),
        capabilities.has('intelligence') && capabilities.has('ats') && atsScopes.length > 0,
        true,
        ATS_ENTRY_PATH,
      ),
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
// ORG-UX-1 §4.3 — the held ROLE KEYS under the same membership rule as heldScopes.
async function heldRoleKeys(roles: RoleService, args: { user_id: string; tenant_id: string }): Promise<string[]> {
  const site_id = await roles.findActiveMembershipSite(args);
  return roles.getRoleKeysByUserTenantAndSite(site_id === null ? args : { ...args, site_id });
}

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
