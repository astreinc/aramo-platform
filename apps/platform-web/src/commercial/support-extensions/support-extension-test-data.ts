import { vi } from 'vitest';

import type { SupportChangeRequest, SupportExtension, SupportExtensionList, SupportPolicy, SupportSubscription } from './support-extension-api';

// CCP-B6 — TEST-ONLY fixtures for the support-extension unit specs: the six commercial role
// bundles (CCP A1 §4.1) + super_admin, a PAST_DUE Stripe-owned Sign row, the v1 policy clause,
// and a fetch router that answers the platform-admin routes the screen calls.

export const NOW = new Date('2026-10-24T14:00:00.000Z');
export const TENANT = '0190c000-0000-7000-8000-0000000b6f01';
export const SUB = '0190c000-0000-7000-8000-0000000b6501';
export const POLICY_ID = '019a0000-0000-7000-8000-0000000cc201';
export const ME = '0190c000-0000-7000-8000-0000000b6c01';
export const OTHER = '0190c000-0000-7000-8000-0000000b6c02';

export const ROLE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  platform_owner: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  // The 10 PLATFORM-UX-1 scopes: no commercial scope (INV-1).
  super_admin: ['platform:tenant:read', 'platform:tenant:provision', 'platform:tenant:lifecycle:manage', 'platform:admin:invite', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};

export function sessionFor(role: string) {
  return { sub: ME, consumer_type: 'platform', tenant_id: '01900000-0000-7000-8000-000000000100', scopes: [...(ROLE_SCOPES[role] ?? [])], iat: 0, exp: 0 };
}

export const POLICY: SupportPolicy = {
  version_id: POLICY_ID,
  version_number: 1,
  clause: { support_extension_max_days: 14, support_extension_frequency_window_days: 90, support_extension_cumulative_max_days: 30, support_extension_cumulative_window_days: 365 },
  approval_expiry_hours: 72,
};

export const PAST_DUE: SupportSubscription = { id: SUB, product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: '2026-10-29T00:00:00.000Z', current_period_end: '2026-10-22T00:00:00.000Z' };

export function extension(over: Partial<SupportExtension> = {}): SupportExtension {
  return {
    id: '0190c000-0000-7000-8000-0000000b6e42',
    tenant_id: TENANT,
    product_key: 'sign',
    subscription_id: SUB,
    change_request_id: '0190c000-0000-7000-8000-0000000b6a01',
    is_exception: true,
    days: 10,
    grace_until_at_apply: '2026-10-05T00:00:00.000Z',
    base_until: '2026-10-05T00:00:00.000Z',
    extends_until: '2026-10-30T00:00:00.000Z',
    policy_version_id: POLICY_ID,
    applied_by: ME,
    applied_at: '2026-10-03T16:40:00.000Z',
    removed_at: null,
    removed_by: null,
    remove_change_request_id: null,
    active: true,
    context: { policy_version_number: 1, clause: POLICY.clause, counters: { requested_days: 10, extensions_in_frequency_window: 0, cumulative_days_before: 0, cumulative_days_after: 10 }, roles_at_apply: ['support_admin'] },
    ...over,
  };
}

export function request(over: Partial<SupportChangeRequest> = {}): SupportChangeRequest {
  return {
    id: '0190c000-0000-7000-8000-0000000b6a52',
    action_type: 'SUPPORT_EXTENSION',
    kind: 'NORMAL',
    state: 'PENDING_APPROVAL',
    tenant_id: TENANT,
    product_key: 'sign',
    payload: { operation: 'EXTEND', subscription_id: SUB, requested_days: 20 },
    required_chain: { rule: 'FINANCE_ONLY', basis: {}, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:subscription:approve'] }] },
    policy_version_id: POLICY_ID,
    requested_by: ME,
    reason: 'The practice moved offices',
    created_at: '2026-10-24T10:00:00.000Z',
    submitted_at: '2026-10-24T10:00:00.000Z',
    expires_at: '2026-10-27T10:00:00.000Z',
    approved_at: null,
    ...over,
  };
}

export interface World {
  list: SupportExtensionList;
  requests: SupportChangeRequest[];
  actionable: Record<string, boolean>;
  /** Answer for POST /support-extensions. */
  onExtend?: (body: Record<string, unknown>) => { status: number; body: unknown };
  calls: { method: string; path: string; body: unknown }[];
}

export function world(over: Partial<World> = {}): World {
  return { list: { extensions: [], subscriptions: [PAST_DUE], policy: POLICY }, requests: [], actionable: {}, calls: [], ...over };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Installs a fetch mock answering the routes the screen (and the App shell) calls. */
export function installFetch(w: World, role: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const path = url.pathname;
    w.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/platform/session') return json(sessionFor(role));
    if (path === '/platform/me') return json({ user_id: ME, email: 'kwame.mensah@aramo.ai', display_name: 'Kwame Mensah', tenant_id: 't0', tenant_name: 'Aramo Platform', role_keys: [role] });
    if (path === '/platform/tenants') return json({ tenants: [{ id: TENANT, name: 'Fernhill Studio', kind: 'BUSINESS', slug: 'fernhill', status: 'ACTIVE', status_reason_code: null, status_changed_at: NOW.toISOString(), is_active: true, created_at: NOW.toISOString(), activated_at: null, suspended_at: null }] });
    const scopes = ROLE_SCOPES[role] ?? [];
    const deny = (scope: string) => json({ error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'no', details: { missing_scopes: [scope] } } }, 403);
    if (path === '/platform/commercial/support-extensions') {
      if (method === 'GET') return scopes.includes('platform:subscription:read') ? json(w.list) : deny('platform:subscription:read');
      if (!scopes.includes('platform:subscription:support')) return deny('platform:subscription:support');
      const out = w.onExtend?.(body as Record<string, unknown>) ?? { status: 500, body: {} };
      return json(out.body, out.status);
    }
    if (path === '/platform/commercial/change-requests') {
      if (method === 'GET') return json({ requests: w.requests, next_cursor: null });
      const created = request({ id: '0190c000-0000-7000-8000-0000000b6a77', state: 'DRAFT', payload: (body as { payload: Record<string, unknown> }).payload, submitted_at: null });
      w.requests.push(created);
      return json({ request: created, replayed: false }, 201);
    }
    const m = /^\/platform\/commercial\/change-requests\/([^/]+)(?:\/(submit|apply))?$/.exec(path);
    if (m) {
      const r = w.requests.find((x) => x.id === m[1]);
      if (!r) return json({ error: { code: 'NOT_FOUND', message: 'no' } }, 404);
      if (m[2] === 'submit') {
        r.state = 'PENDING_APPROVAL';
        return json({ request: r });
      }
      if (m[2] === 'apply') {
        r.state = 'APPLIED';
        return json({ request: r, application: {}, replayed: false });
      }
      return json({ request: r, approvals: [], is_expired: false, chain_satisfiable: true, steps: [], apply_actionable: w.actionable[r.id] ?? false });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'no' } }, 404);
  });
}
