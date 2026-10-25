// PLATFORM-UX-1 F-2 — the console navigation model (handoff §3.3, §4; directive
// R-12): the rail groups and items, the permission each item needs, which item a
// route highlights, and the breadcrumb trail a route starts with.

import { COMMERCIAL_PERMISSIONS as CP, PLATFORM_PERMISSIONS as P } from '../components/permissions';

export type NavIconKey =
  | 'dash'
  | 'tenants'
  | 'shield'
  | 'mail'
  | 'layers'
  | 'inbox'
  | 'spark'
  | 'sliders'
  | 'doc'
  | 'braces'
  | 'key'
  // CCP-B1 — the Commercial group's glyphs (Commercial Control Plane v1.0.dc.html IC).
  | 'check'
  | 'repeat'
  | 'tag'
  | 'contract'
  | 'scale'
  | 'audit';

export type NavKey =
  | 'dashboard'
  | 'tenants'
  | 'personal'
  | 'invites'
  | 'skills'
  | 'skillQueue'
  | 'proposals'
  | 'matching'
  | 'templates'
  | 'variables'
  | 'admins'
  // CCP-B1 — the Commercial group.
  | 'approvals'
  | 'subscriptions'
  | 'catalog'
  | 'contracts'
  | 'policy'
  | 'audit';

export interface NavItem {
  readonly key: NavKey;
  readonly label: string;
  readonly to: string;
  /** The permission the item (and its route) needs (handoff §2 + amendment 3). */
  readonly scope: string;
  /** Further permissions any one of which also shows the item (CCP-B5: Platform admins). */
  readonly orScopes?: readonly string[];
  readonly icon: NavIconKey;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Operations',
    items: [
      { key: 'dashboard', label: 'Dashboard', to: '/', scope: P.tenantRead, icon: 'dash' },
      { key: 'tenants', label: 'Tenants', to: '/tenants', scope: P.tenantRead, icon: 'tenants' },
    ],
  },
  {
    label: 'Sign Personal',
    items: [
      { key: 'personal', label: 'Review queue', to: '/personal-review', scope: P.tenantLifecycleManage, icon: 'shield' },
      { key: 'invites', label: 'Pilot invites', to: '/personal-invites', scope: P.tenantLifecycleManage, icon: 'mail' },
    ],
  },
  {
    label: 'Skills',
    items: [
      { key: 'skills', label: 'Registry', to: '/skills', scope: P.skillRead, icon: 'layers' },
      { key: 'skillQueue', label: 'Review queue', to: '/skills/review-queue', scope: P.skillRead, icon: 'inbox' },
      { key: 'proposals', label: 'Proposals', to: '/skills/proposals', scope: P.skillRead, icon: 'spark' },
    ],
  },
  {
    label: 'Matching',
    items: [{ key: 'matching', label: 'Matching policy', to: '/matching', scope: P.matchingPolicyRead, icon: 'sliders' }],
  },
  {
    label: 'Documents',
    items: [
      { key: 'templates', label: 'Document templates', to: '/document-templates', scope: P.documentTemplateRead, icon: 'doc' },
      { key: 'variables', label: 'Template variables', to: '/template-variables', scope: P.documentTemplateRead, icon: 'braces' },
    ],
  },
  // ── CCP-B1 — the Commercial group (CCP-UI v1.0 handoff §2), between Documents and
  // Platform. Each item needs its commercial READ scope (super_admin holds none, so
  // the group is hidden for it). Contracts and Policy have no scope of their own in
  // the A1 catalog: provisional subscription:read / approval:read (B4 / B5 own them).
  {
    label: 'Commercial',
    items: [
      { key: 'approvals', label: 'Approvals', to: '/commercial/approvals', scope: CP.approvalRead, icon: 'check' },
      { key: 'subscriptions', label: 'Subscriptions', to: '/commercial/subscriptions', scope: CP.subscriptionRead, icon: 'repeat' },
      { key: 'catalog', label: 'Catalog', to: '/commercial/catalog', scope: CP.catalogRead, icon: 'tag' },
      { key: 'contracts', label: 'Contracts', to: '/commercial/contracts', scope: CP.subscriptionRead, icon: 'contract' },
      { key: 'policy', label: 'Policy', to: '/commercial/policy', scope: CP.approvalRead, icon: 'scale' },
      { key: 'audit', label: 'Audit', to: '/commercial/audit', scope: CP.commercialAuditRead, icon: 'audit' },
    ],
  },
  // ── end CCP-B1
  {
    label: 'Platform',
    // CCP-B5 (handoff §5.8; merge train TD-MERGE-14): Platform admins also opens for the
    // commercial roles (their commercial-roles view), as its route does.
    items: [{ key: 'admins', label: 'Platform admins', to: '/admins', scope: P.adminInvite, orScopes: [CP.approvalRead], icon: 'key' }],
  },
];

/** The groups the operator may see: items filtered by permission, empty groups hidden. */
export function visibleNavGroups(can: (scope: string) => boolean): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ label: g.label, items: g.items.filter((i) => can(i.scope) || (i.orScopes ?? []).some(can)) })).filter(
    (g) => g.items.length > 0,
  );
}

/**
 * The nav item a path highlights (handoff §3.3): tenant detail and Provision →
 * Tenants; skill detail → Registry; template detail / Studio → Document templates.
 */
export function navKeyFor(pathname: string): NavKey | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return 'dashboard';
  if (p === '/tenants' || p.startsWith('/tenants/')) return 'tenants';
  if (p.startsWith('/personal-review')) return 'personal';
  if (p.startsWith('/personal-invites')) return 'invites';
  if (p.startsWith('/skills/review-queue')) return 'skillQueue';
  if (p.startsWith('/skills/proposals')) return 'proposals';
  if (p === '/skills' || p.startsWith('/skills/')) return 'skills';
  if (p.startsWith('/matching')) return 'matching';
  if (p.startsWith('/document-templates')) return 'templates';
  if (p.startsWith('/template-variables')) return 'variables';
  if (p.startsWith('/admins')) return 'admins';
  // CCP-B1 — the Commercial group (/commercial → Approvals).
  if (p === '/commercial' || p.startsWith('/commercial/approvals')) return 'approvals';
  if (p.startsWith('/commercial/subscriptions')) return 'subscriptions';
  if (p.startsWith('/commercial/catalog')) return 'catalog';
  if (p.startsWith('/commercial/contracts')) return 'contracts';
  if (p.startsWith('/commercial/policy')) return 'policy';
  if (p.startsWith('/commercial/audit')) return 'audit';
  return null;
}

export interface Crumb {
  readonly label: string;
  /** A link target; the group crumb and the last crumb have none. */
  readonly to?: string;
}

/** Detail routes: [pattern, generic last crumb, whether the page names the entity]. */
const DETAIL_ROUTES: readonly (readonly [RegExp, string, boolean])[] = [
  [/^\/tenants\/new$/, 'Provision tenant', false],
  [/^\/tenants\/[^/]+$/, 'Tenant', true],
  [/^\/skills\/proposals\/[^/]+$/, 'Proposal', true],
  [/^\/skills\/(?!review-queue$|proposals$)[^/]+$/, 'Skill', true],
  [/^\/document-templates\/[^/]+$/, 'Template', true],
];

/**
 * The breadcrumb for a path (handoff §3.4): group / section [/ entity]. On a
 * detail route it ends in the entity name — `entity` is the name the page set
 * (useEntityCrumb); until then the generic label shows.
 */
export function crumbsFor(pathname: string, entity: string | null): Crumb[] {
  const p = pathname.replace(/\/+$/, '') || '/';
  const key = navKeyFor(p);
  const group = NAV_GROUPS.find((g) => g.items.some((i) => i.key === key));
  const item = group?.items.find((i) => i.key === key);
  if (!group || !item) return [{ label: 'Operations' }, { label: 'Dashboard' }];
  const detail = DETAIL_ROUTES.find(([re]) => re.test(p));
  if (detail === undefined) return [{ label: group.label }, { label: item.label }];
  const [, generic, named] = detail;
  const last = named && entity?.trim() ? entity.trim() : generic;
  return [{ label: group.label }, { label: item.label, to: item.to }, { label: last }];
}
