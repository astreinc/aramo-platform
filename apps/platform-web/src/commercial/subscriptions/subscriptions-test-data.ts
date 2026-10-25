import { vi } from 'vitest';

import type { Catalog } from '../catalog/catalog-api';
import type { SupportExtensionList } from '../support-extensions/support-extension-api';

import type { EntitlementFacts, HeldFlag, OpenRequestRef, ProductCommercial, SubscriptionFacts, TenantCommercial, WorkbenchRow } from './subscriptions-api';

// CCP-B3 — TEST-ONLY fixtures for the Subscriptions workbench and Tenant › Commercial unit specs:
// the six commercial role bundles (CCP A1 §4.1, libs/identity/prisma/seed.ts:3240-3297) and
// super_admin's 10 platform scopes, the CCP-B3 read shapes, and a fetch router that answers
// every platform-admin route the screens (and the App shell) call, recording each call.

export const NOW = new Date('2026-10-24T14:00:00.000Z');
export const ME = '0190b300-0000-7000-8000-0000000b3c01';
export const OTHER = '0190b300-0000-7000-8000-0000000b3c02';
export const T_MERIDIAN = '0190b300-0000-7000-8000-0000000b3a01';
export const T_NORTHWIND = '0190b300-0000-7000-8000-0000000b3a02';
export const SUB_MERIDIAN = '0190b300-0000-7000-8000-0000000b3501';
export const SUB_NORTHWIND = '0190b300-0000-7000-8000-0000000b3502';
export const CONTRACT = '0190b300-0000-7000-8000-0000000b3d01';
export const FLAG = '0190b300-0000-7000-8000-0000000b3f01';
export const CR_OPEN = '0190b300-0000-7000-8000-0000000b3e01';
export const CR_NEW = '0190b300-0000-7000-8000-0000000b3e77';
export const PV_SCALE_1 = '0190b300-0000-7000-8000-0000000b3701';
export const PV_TEAM_2 = '0190b300-0000-7000-8000-0000000b3702';
export const PV_TEAM_1 = '0190b300-0000-7000-8000-0000000b3703';

export const ROLE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  platform_owner: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:read', 'platform:tenant:provision', 'platform:tenant:lifecycle:manage', 'platform:admin:invite', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
export const SEVEN = Object.keys(ROLE_SCOPES);
export const READERS = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
export const NON_READERS = ['catalog_manager', 'super_admin'] as const;

export function sessionFor(role: string) {
  return { sub: ME, consumer_type: 'platform', tenant_id: '01900000-0000-7000-8000-000000000100', scopes: [...(ROLE_SCOPES[role] ?? [])], iat: 0, exp: 0 };
}

export function facts(over: Partial<SubscriptionFacts> = {}): SubscriptionFacts {
  return {
    subscription_id: SUB_MERIDIAN,
    product_key: 'sign',
    plan: { id: '0190b300-0000-7000-8000-0000000b3601', key: 'aramo-sign-scale-v1', name: 'Scale', sales_model: 'OPERATOR' },
    plan_version: { id: PV_SCALE_1, version_number: 1, status: 'PUBLISHED' },
    source: 'MANUAL',
    status: 'ACTIVE',
    started_at: '2025-03-15T00:00:00.000Z',
    ended_at: null,
    period_anchor: '2025-03-15T00:00:00.000Z',
    current_period: { start: '2026-10-15T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z' },
    current_period_end: null,
    grace_until: null,
    commitment_end: '2027-03-14T00:00:00.000Z',
    contract: { id: CONTRACT, contract_ref: 'CT-2025-014' },
    provider_linked: false,
    open_flags: [],
    active_extensions: { count: 0, exception: false },
    ...over,
  };
}

export const STRIPE_ROW = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts =>
  facts({
    subscription_id: SUB_NORTHWIND,
    plan: { id: '0190b300-0000-7000-8000-0000000b3602', key: 'aramo-sign-team-v1', name: 'Team', sales_model: 'SELF_SERVICE' },
    plan_version: { id: PV_TEAM_2, version_number: 2, status: 'PUBLISHED' },
    source: 'SELF_SERVICE',
    period_anchor: '2026-02-10T00:00:00.000Z',
    current_period: { start: '2026-10-10T00:00:00.000Z', end: '2026-11-10T00:00:00.000Z' },
    commitment_end: null,
    contract: null,
    provider_linked: true,
    ...over,
  });

export function row(over: Partial<WorkbenchRow> = {}): WorkbenchRow {
  return { tenant: { id: T_MERIDIAN, name: 'Meridian Partners', slug: 'meridian' }, ...facts(), ...over };
}

export function entitlement(over: Partial<EntitlementFacts> = {}): EntitlementFacts {
  return { capability: 'sign', state: 'ACTIVE', granted_source: 'PROVISIONING', granted_at: '2025-03-15T00:00:00.000Z', granted_by: null, change_request_id: null, revoked_at: null, revoked_by: null, revoke_change_request_id: null, ...over };
}

export function heldFlag(over: Partial<HeldFlag> = {}): HeldFlag {
  return { id: FLAG, reason: 'governed_subscription_open', provider: 'STRIPE', subscription_ref: 'sub_held_1', intent_id: null, detected_at: '2026-10-21T09:12:00.000Z', conversion: null, ...over };
}

export function openRequest(over: Partial<OpenRequestRef> = {}): OpenRequestRef {
  return { id: CR_OPEN, action_type: 'SUBSCRIPTION_CHANGE', kind: 'NORMAL', state: 'PENDING_APPROVAL', requested_by: ME, created_at: '2026-10-24T10:00:00.000Z', ...over };
}

export function product(over: Partial<ProductCommercial> = {}): ProductCommercial {
  return { product_key: 'sign', registered: true, entitlement: entitlement(), subscription: facts(), flags: [], open_request: null, ...over };
}

function other(key: string, state: EntitlementFacts['state'] = 'NONE'): ProductCommercial {
  return { product_key: key, registered: false, entitlement: entitlement({ capability: key, state, granted_source: state === 'NONE' ? null : 'PROVISIONING', granted_at: state === 'NONE' ? null : '2025-01-10T00:00:00.000Z' }), subscription: null, flags: [], open_request: null };
}

export function commercial(sign: Partial<ProductCommercial> = {}, tenant = T_MERIDIAN, name = 'Meridian Partners'): TenantCommercial {
  return { as_of: NOW.toISOString(), tenant: { id: tenant, name, slug: 'meridian', kind: 'BUSINESS' }, products: [product(sign), other('ats'), other('portal'), other('intelligence')] };
}

export const SUPPORT: SupportExtensionList = {
  extensions: [],
  subscriptions: [{ id: SUB_MERIDIAN, product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', grace_until: null, current_period_end: null }],
  policy: { version_id: '019a0000-0000-7000-8000-0000000cc201', version_number: 1, clause: { support_extension_max_days: 14, support_extension_frequency_window_days: 90, support_extension_cumulative_max_days: 30, support_extension_cumulative_window_days: 365 }, approval_expiry_hours: 72 },
};

const terms = (price: number | null, env: number) => ({
  list_price_minor: price === null ? null : price * 100,
  currency: price === null ? null : 'USD',
  billing_interval: 'MONTH',
  sales_model: price === null ? 'CONTACT_SALES' : 'OPERATOR',
  contract_priced: price === null,
  envelopes_per_month: env,
  envelopes_unlimited: false,
  envelopes_present: true,
  storage_bytes: null,
  storage_unlimited: false,
  storage_present: false,
});
const version = (id: string, plan: string, n: number, status: 'PUBLISHED' | 'RETIRED' | 'DRAFT', price: number | null, env: number) => ({
  id,
  plan_id: plan,
  version_number: n,
  status,
  content_checksum: 'c'.repeat(64),
  note: null,
  created_by: OTHER,
  created_at: '2026-01-15T00:00:00.000Z',
  published_at: '2026-01-15T00:00:00.000Z',
  retired_at: null,
  terms: terms(price, env),
  pinned_subscriptions: 1,
  open_requests: [],
});

export const CATALOG: Catalog = {
  products: [
    {
      product_key: 'sign',
      plans: [
        { id: '0190b300-0000-7000-8000-0000000b3602', key: 'aramo-sign-team-v1', product_key: 'sign', name: 'Team', status: 'ACTIVE', sales_model: 'SELF_SERVICE', sellable: true, display_order: 2, versions: [version(PV_TEAM_2, 'team', 2, 'PUBLISHED', 59, 750), version(PV_TEAM_1, 'team', 1, 'RETIRED', 49, 500)] },
        { id: '0190b300-0000-7000-8000-0000000b3601', key: 'aramo-sign-scale-v1', product_key: 'sign', name: 'Scale', status: 'ACTIVE', sales_model: 'OPERATOR', sellable: false, display_order: 4, versions: [version(PV_SCALE_1, 'scale', 1, 'PUBLISHED', 299, 10000)] },
        { id: '0190b300-0000-7000-8000-0000000b3605', key: 'aramo-sign-enterprise-v1', product_key: 'sign', name: 'Enterprise', status: 'ACTIVE', sales_model: 'CONTACT_SALES', sellable: false, display_order: 5, versions: [version('0190b300-0000-7000-8000-0000000b3705', 'enterprise', 1, 'PUBLISHED', null, 25000)] },
      ],
    },
  ],
  publish_chain: null,
};

export interface World {
  workbench: WorkbenchRow[];
  tenant: TenantCommercial;
  support: SupportExtensionList;
  actionable: Record<string, boolean>;
  pendingProvider: Record<string, boolean>;
  /** Answer for POST …/{id}/apply and …/{id}/convert (default 200 APPLIED). */
  onApply?: (id: string, kind: 'apply' | 'convert') => { status: number; body: unknown };
  calls: { method: string; path: string; body: unknown }[];
}

export function world(over: Partial<World> = {}): World {
  return { workbench: [row()], tenant: commercial(), support: SUPPORT, actionable: {}, pendingProvider: {}, calls: [], ...over };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const tenantDetail = (id: string, name: string) => ({
  tenant: { id, name, kind: 'BUSINESS', slug: 'meridian', status: 'ACTIVE', status_reason_code: null, status_changed_at: NOW.toISOString(), is_active: true, identity_provider: 'microsoft', created_at: '2025-03-15T00:00:00.000Z', updated_at: NOW.toISOString(), activated_at: null, suspended_at: null },
});

const signRead = {
  tenant_id: T_MERIDIAN,
  tenant_kind: 'BUSINESS',
  capabilities: ['core', 'sign'],
  sign_entitled: true,
  subscription: null,
  allowance: { subscribed: true, limit: 10000, used: 4410, remaining: 5590, period_start: '2026-10-15T00:00:00.000Z', period_end: '2026-11-15T00:00:00.000Z' },
  storage: null,
  billing_available: false,
  billing_events: [],
};

function requestRef(id: string, body: Record<string, unknown> | undefined, state: string) {
  return {
    id,
    action_type: (body?.['action_type'] as string | undefined) ?? 'SUBSCRIPTION_CHANGE',
    kind: 'NORMAL',
    state,
    tenant_id: (body?.['tenant_id'] as string | undefined) ?? T_MERIDIAN,
    product_key: 'sign',
    payload: (body?.['payload'] as Record<string, unknown> | undefined) ?? {},
    requested_by: ME,
    reason: (body?.['reason'] as string | undefined) ?? 'r',
    created_at: NOW.toISOString(),
  };
}

/** Installs a fetch mock answering the routes the screens (and the App shell) call. */
export function installFetch(w: World, role: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = url.pathname;
    w.calls.push({ method, path: `${path}${url.search}`, body });
    const scopes = ROLE_SCOPES[role] ?? [];
    const deny = (scope: string) => json({ error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'no', details: { missing_scopes: [scope] } } }, 403);
    if (path === '/auth/platform/session') return json(sessionFor(role));
    if (path === '/platform/me') return json({ user_id: ME, email: 'tomas.berg@aramo.ai', display_name: 'Tomás Berg', tenant_id: 't0', tenant_name: 'Aramo Platform', role_keys: [role] });
    if (path === '/platform/tenants') return json({ tenants: [] });
    if (path === '/platform/dashboard') return json({ status_counts: [], onboarding: [], recent_activity: [] });
    const t = /^\/platform\/tenants\/([^/]+)(\/audit|\/sign|\/domain)?$/.exec(path);
    if (t) {
      if (t[2] === '/audit') return json({ events: [] });
      if (t[2] === '/sign') return json(signRead);
      if (t[2] === '/domain') return json({ tenant_id: t[1], domain_claim: null, exceptions: [] });
      return json(tenantDetail(t[1]!, w.tenant.tenant.name));
    }
    if (path === '/platform/commercial/subscriptions') return scopes.includes('platform:subscription:read') ? json({ as_of: NOW.toISOString(), rows: w.workbench }) : deny('platform:subscription:read');
    if (/^\/platform\/commercial\/tenants\/[^/]+\/commercial$/.test(path)) return scopes.includes('platform:subscription:read') ? json(w.tenant) : deny('platform:subscription:read');
    if (/^\/platform\/commercial\/tenants\/[^/]+\/billing-status$/.test(path)) return json({ availability: 'BILLING_UNAVAILABLE', invoices: [] });
    if (path === '/platform/commercial/support-extensions') return json(w.support);
    if (path === '/platform/commercial/catalog') return json(CATALOG);
    if (path === '/platform/commercial/change-requests') {
      if (method === 'POST') return json({ request: requestRef(CR_NEW, body, 'DRAFT'), replayed: false }, 201);
      return json({ requests: [], next_cursor: null });
    }
    const m = /^\/platform\/commercial\/change-requests\/([^/]+)(?:\/(submit|apply|convert|conversion))?$/.exec(path);
    if (m) {
      const id = m[1]!;
      if (m[2] === 'submit') return json({ request: requestRef(id, undefined, 'PENDING_APPROVAL') });
      if (m[2] === 'apply' || m[2] === 'convert') {
        const out = w.onApply?.(id, m[2]) ?? { status: 200, body: { request: requestRef(id, undefined, 'APPLIED'), conversion: { direction: 'TO_GOVERNED', status: 'COMPLETED', pending_provider: false }, replayed: false } };
        return json(out.body, out.status);
      }
      if (m[2] === 'conversion') return json({ request: requestRef(id, undefined, 'APPLYING'), conversion: { direction: 'TO_GOVERNED', status: 'PENDING_PROVIDER', pending_provider: w.pendingProvider[id] ?? false } });
      const open = w.tenant.products.find((p) => p.open_request?.id === id)?.open_request;
      return json({ request: { ...requestRef(id, undefined, open?.state ?? 'PENDING_APPROVAL'), action_type: open?.action_type ?? 'SUBSCRIPTION_CHANGE' }, approvals: [], is_expired: false, chain_satisfiable: true, steps: [], apply_actionable: w.actionable[id] ?? false });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'no' } }, 404);
  });
}

/** Every non-GET call the screen made (the "no direct mutation" trace). */
export function writes(w: World): string[] {
  return w.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
}
