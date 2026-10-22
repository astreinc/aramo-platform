// ORG-UX-1 (Directive v1.0 LOCKED §4.4, §8.3, §8.4; handoff §6.3/§6.4) — the single role
// model every Organization people screen renders: Users & invitations (app-access chips,
// Organization column), Edit access, Invite user and Roles & access.
//
// Groups come from the backend role catalog (GET /v1/tenant/roles-catalog), split by key
// and tier:
//   Organization = tenant_owner, tenant_admin
//   Aramo Sign   = keys starting `sign_`
//   Aramo ATS    = the remaining TENANT roles
// The portal-principal role is NOT a tenant role: it is filtered BY TIER (the catalog's
// `Portal` presentation tier), never by its key (vocabulary rule, §8.4).

import { ApiError, productByKey, safeErrorMessage, type ProductAvailabilityView } from '@aramo/fe-foundation';

import type { RoleCatalogView } from '../roles/roles-catalog-api';

export type RoleGroupKey = 'org' | 'ats' | 'sign';

export const OWNER_ROLE_KEY = 'tenant_owner';
export const ORG_ROLE_KEYS: readonly string[] = [OWNER_ROLE_KEY, 'tenant_admin'];

/** Catalog tiers that are not tenant-member roles (filtered by tier, never by key). */
const NON_TENANT_TIERS: readonly string[] = ['Portal', 'Platform'];

export const OWNER_ONLY_HINT = 'Only an owner can change owners.';
/** Roles & access — the FE pre-check before removing the last Tenant Owner (handoff §6.4). */
export const LAST_OWNER_BLOCK = 'An organization needs at least one Tenant Owner.';
/** Directive §4.4 — the 409 TENANT_LAST_OWNER mapping. */
export const LAST_OWNER_409 = 'Your organization must keep at least one owner.';
export const KEEP_ONE_ROLE_HINT = 'To remove all access, disable the user in Users & invitations.';

export function groupOfRole(role: Pick<RoleCatalogView, 'key' | 'tier'>): RoleGroupKey | null {
  if (NON_TENANT_TIERS.includes(role.tier)) return null;
  if (ORG_ROLE_KEYS.includes(role.key)) return 'org';
  if (role.key.startsWith('sign_')) return 'sign';
  return 'ats';
}

export interface SubscribedApps {
  readonly ats: boolean;
  readonly sign: boolean;
}

/** Subscribed apps from GET /v1/me/products (subscription, not the caller's own access). */
export function subscribedApps(products: ProductAvailabilityView | null | undefined): SubscribedApps {
  return {
    ats: productByKey(products ?? null, 'ats')?.subscribed === true,
    sign: productByKey(products ?? null, 'sign')?.subscribed === true,
  };
}

export interface RoleGroup {
  readonly key: RoleGroupKey;
  readonly title: string;
  readonly app: string;
  readonly note: string;
  readonly roles: readonly RoleCatalogView[];
}

const GROUP_META: Readonly<Record<RoleGroupKey, { title: string; app: string; note: string }>> = {
  org: { title: 'Organization', app: 'Organization', note: 'No role means Member' },
  ats: { title: 'Aramo ATS', app: 'Aramo ATS', note: 'App roles' },
  sign: { title: 'Aramo Sign', app: 'Aramo Sign', note: 'App roles' },
};

/** Organization first, then one group per SUBSCRIBED app (catalog order kept inside a group). */
export function buildRoleGroups(catalog: readonly RoleCatalogView[], subs: SubscribedApps): readonly RoleGroup[] {
  const keys: RoleGroupKey[] = ['org', ...(subs.ats ? (['ats'] as const) : []), ...(subs.sign ? (['sign'] as const) : [])];
  return keys
    .map((k) => ({ key: k, ...GROUP_META[k], roles: catalog.filter((r) => groupOfRole(r) === k) }))
    .filter((g) => g.roles.length > 0);
}

export interface UserRoleSplit {
  readonly org: readonly string[];
  readonly ats: readonly string[];
  readonly sign: readonly string[];
}

/** A user's role keys → display labels per group (unknown / non-tenant keys dropped). */
export function splitUserRoles(roleKeys: readonly string[], catalog: readonly RoleCatalogView[]): UserRoleSplit {
  const out: Record<RoleGroupKey, string[]> = { org: [], ats: [], sign: [] };
  for (const r of catalog) {
    if (!roleKeys.includes(r.key)) continue;
    const g = groupOfRole(r);
    if (g !== null) out[g].push(r.display);
  }
  return out;
}

/** Compact Sign role name in a chip ("Sign · Sender"), as the prototype renders it. */
export function shortSignLabel(label: string): string {
  return label.replace(/^Sign\s+/, '');
}

/** The error copy for a role write (PATCH roles) or an owner-guarded lifecycle action. */
export function roleWriteErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'TENANT_LAST_OWNER') return LAST_OWNER_409;
    const reason = typeof err.details?.['reason'] === 'string' ? err.details['reason'] : null;
    if (reason === 'owner_role_requires_owner') return OWNER_ONLY_HINT;
    if (reason === 'empty_role_keys') return 'Select at least one role.';
    if (reason === 'self_disable_forbidden') return 'You can’t disable yourself.';
    if (reason === 'invertible_role_union') return 'These roles can’t be combined. Choose roles that don’t overlap on compensation visibility.';
    if (reason === 'financials_audit_not_enabled') return 'Enable "Financial-auditor grant" in Settings before assigning the Auditor with Financials role.';
    if (err.status === 404) return 'This user is not part of your organization.';
  }
  return safeErrorMessage(err, 'Something went wrong. Please try again.');
}
