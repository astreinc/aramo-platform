// CCP-B5 — the test-only fixture for the governance screens (Policy, Audit, Platform admins ›
// commercial roles): the prototype's people (ccp-data.js PEOPLE / ROSTER), its policy versions
// (POL0 without the v0 pilot, handoff "Don't build") and a roster/chain state, served through
// the mock provider's `overrides` (fixtures/mock-api.ts). Nothing here ships.

import type { MockOptions, Reply } from './mock-api';
import { PLATFORM_TENANT_ID } from './session';

const ENTRY = 'platform:tenant:read';
const BUNDLE: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: [ENTRY, 'platform:tenant:provision', 'platform:tenant:lifecycle:manage', 'platform:admin:invite', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};

export type CcpPersona = 'maya' | 'daniel' | 'priya' | 'tomas' | 'lena' | 'kwame' | 'ines' | 'arjun';
const PEOPLE: Record<CcpPersona, { name: string; email: string; roles: string[] }> = {
  maya: { name: 'Maya Okafor', email: 'maya.okafor@aramo.ai', roles: ['super_admin'] },
  daniel: { name: 'Daniel Reyes', email: 'daniel.reyes@aramo.ai', roles: ['platform_owner'] },
  priya: { name: 'Priya Shah', email: 'priya.shah@aramo.ai', roles: ['finance_admin'] },
  tomas: { name: 'Tomás Silva', email: 'tomas.silva@aramo.ai', roles: ['commercial_ops'] },
  lena: { name: 'Lena Fischer', email: 'lena.fischer@aramo.ai', roles: ['catalog_manager'] },
  kwame: { name: 'Kwame Mensah', email: 'kwame.mensah@aramo.ai', roles: ['support_admin'] },
  ines: { name: 'Ines Duarte', email: 'ines.duarte@aramo.ai', roles: ['read_only_auditor'] },
  arjun: { name: 'Arjun Rao', email: 'arjun.rao@aramo.ai', roles: ['finance_admin', 'platform_owner'] },
};
const ROSTER: Record<'ready' | 'notBootstrapped', CcpPersona[]> = {
  ready: ['maya', 'daniel', 'priya', 'tomas', 'lena', 'kwame', 'ines', 'arjun'],
  notBootstrapped: ['maya', 'arjun', 'tomas', 'lena'],
};
const uid = (p: CcpPersona): string => `0190cc00-0000-7000-8000-0000000000${(Object.keys(PEOPLE).indexOf(p) + 10).toString(16).padStart(2, '0')}`;

const IAT = Math.floor(Date.parse('2026-10-24T14:00:00Z') / 1000);
const json = (body: unknown, status = 200): Reply => ({ status, body });

const V1 = '019a0000-0000-7000-8000-0000000cc201';
const V2 = '019a0000-0000-7000-8000-0000000cc2a2';
const V1_CONTENT = {
  format_version: 1,
  currency: 'USD',
  discount_escalation_threshold_bps: 2000,
  credit_escalation_threshold_minor: 50_000,
  support_extension_max_days: 14,
  support_extension_frequency_window_days: 90,
  support_extension_cumulative_max_days: 30,
  support_extension_cumulative_window_days: 365,
  approval_expiry_hours: 72,
  past_due_grace_days: 7,
};

function policyList(persona: CcpPersona) {
  const roles = PEOPLE[persona].roles;
  return {
    versions: [
      {
        id: V2,
        version_number: 2,
        status: 'DRAFT',
        content: { ...V1_CONTENT, credit_escalation_threshold_minor: 30_000, approval_expiry_hours: 48 },
        content_checksum: 'b'.repeat(64),
        note: 'Tighten the credit threshold and approval window after the Q3 review.',
        created_by: uid('priya'),
        created_at: '2026-10-24T09:00:00.000Z',
        activated_by: null,
        activated_at: null,
        retired_at: null,
        open_request: null,
      },
      {
        id: V1,
        version_number: 1,
        status: 'ACTIVE',
        content: V1_CONTENT,
        content_checksum: 'a'.repeat(64),
        note: 'First governed commercial policy.',
        created_by: uid('daniel'),
        created_at: '2026-10-20T10:00:00.000Z',
        activated_by: uid('daniel'),
        activated_at: '2026-10-23T10:00:00.000Z',
        retired_at: null,
        open_request: null,
      },
    ],
    active_version_id: V1,
    open_request: null,
    caller: { can_author: roles.includes('platform_owner') || roles.includes('finance_admin'), can_request_activation: roles.includes('finance_admin') },
  };
}

function roster(boot: 'ready' | 'notBootstrapped') {
  const ids = ROSTER[boot];
  const owners = ids.filter((p) => PEOPLE[p].roles.includes('platform_owner'));
  const commercial = (p: CcpPersona) => PEOPLE[p].roles.filter((r) => r !== 'super_admin');
  const operators = ids.map((p) => ({
    user_id: uid(p),
    email: PEOPLE[p].email,
    display_name: PEOPLE[p].name,
    role_keys: [...PEOPLE[p].roles],
    commercial_role_keys: commercial(p),
    attested: p !== 'maya',
    is_last_owner: owners.length === 1 && owners[0] === p,
    // CR-1045 (pending): grant Finance admin to Ines Duarte.
    pending_role_requests: p === 'ines' && boot === 'ready' ? [{ id: '019a0000-0000-7000-8000-00000000c045', action_type: 'ROLE_GRANT', role_key: 'finance_admin', state: 'PENDING_APPROVAL' }] : [],
  }));
  const ready = boot === 'ready';
  // The chain panel renders the maker roles the API returns. The fixture carries the
  // prototype's maker sets so the UI is compared on the same data; the API's real sets
  // (commercial_ops only above threshold; finance_admin only for a policy change) are
  // divergence DV-B5-04, proven by libs/subscription B5-U-7.
  const chain = (key: string, rule: string, maker_roles: string[], step_roles: string[], ok: boolean) => ({ key, rule, maker_roles, step_roles, fulfillable: ok, missing: ok ? null : 'steps', unfillable_steps: ok ? [] : [step_roles.length - 1] });
  return {
    operators,
    chains: [
      chain('ABOVE_THRESHOLD', 'FINANCE_THEN_OWNER', ['commercial_ops', 'support_admin'], ['finance_admin', 'platform_owner'], ready),
      chain('BELOW_THRESHOLD', 'FINANCE_ONLY', ['commercial_ops', 'support_admin'], ['finance_admin'], true),
      chain('CATALOG_PUBLISH', 'FINANCE_THEN_OWNER', ['catalog_manager'], ['finance_admin', 'platform_owner'], ready),
      chain('ROLE_CHANGE', 'DISTINCT_PLATFORM_OWNER', ['platform_owner'], ['platform_owner'], ready),
      chain('POLICY_CHANGE', 'FINANCE_THEN_OWNER', ['platform_owner', 'finance_admin'], ['finance_admin', 'platform_owner'], ready),
    ],
    all_fulfillable: ready,
  };
}

/** 16 events — the prototype's audit stream without the v0 requests (handoff "Don't build"). */
function auditEvents() {
  const at = (h: number) => new Date(Date.parse('2026-10-24T14:00:00Z') - h * 3_600_000).toISOString();
  const ev = (i: number, h: number, actor: CcpPersona | null, event_type: string, extra: Record<string, unknown> = {}) => ({
    id: `019a0000-0000-7000-8000-0000000e${(4700 + i).toString(16).padStart(4, '0')}`,
    created_at: at(h),
    actor_id: actor === null ? null : uid(actor),
    actor_type: actor === null ? 'system' : 'user',
    actor_role_keys: actor === null ? [] : PEOPLE[actor].roles.filter((r) => r !== 'super_admin'),
    event_type,
    is_exception: event_type === 'SUPPORT_EXTENSION_APPLIED',
    tenant_id: null,
    subject: `commercial_change_request:${i}`,
    change_request_id: null,
    policy_version_id: V1,
    payload: { product_key: 'sign' },
    correlation_id: 'fixture',
    ...extra,
  });
  return [
    ev(0, 1, 'tomas', 'COMMERCIAL_CHANGE_REQUEST_CREATED'),
    ev(1, 3, 'lena', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED'),
    ev(2, 4, 'kwame', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED'),
    ev(3, 5, 'tomas', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED'),
    ev(4, 8, 'daniel', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED'),
    ev(5, 20, 'priya', 'COMMERCIAL_APPROVAL_RECORDED', { payload: { step_role_key: 'finance_admin' } }),
    ev(6, 20, 'daniel', 'COMMERCIAL_CHANGE_REQUEST_APPLIED'),
    ev(7, 22, 'arjun', 'COMMERCIAL_APPROVAL_RECORDED', { payload: { step_role_key: 'finance_admin' } }),
    ev(8, 24, 'priya', 'COMMERCIAL_APPROVAL_RECORDED', { payload: { step_role_key: 'finance_admin' } }),
    ev(9, 24, null, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED'),
    ev(10, 26, 'tomas', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED'),
    ev(11, 26, 'tomas', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED'),
    ev(12, 31, 'tomas', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED'),
    ev(13, 77, null, 'RECONCILIATION_FLAG_RAISED'),
    ev(14, 502, 'kwame', 'SUPPORT_EXTENSION_APPLIED'),
    ev(15, 8291, null, 'SUBSCRIPTION_MIGRATED'),
  ];
}

export interface CcpMockOptions {
  persona: CcpPersona;
  bootstrap?: 'ready' | 'notBootstrapped';
}

/** The mock-api options for a CCP persona (session, /platform/me, the B5 routes). */
export function ccpMock(o: CcpMockOptions): MockOptions {
  const p = PEOPLE[o.persona];
  const scopes = [...new Set(p.roles.flatMap((r) => BUNDLE[r] ?? []))];
  return {
    overrides: [
      { path: /^\/auth\/platform\/session$/, reply: json({ sub: uid(o.persona), consumer_type: 'platform', tenant_id: PLATFORM_TENANT_ID, scopes, iat: IAT, exp: IAT + 8 * 3600 }) },
      { path: /^\/platform\/me$/, reply: json({ user_id: uid(o.persona), email: p.email, display_name: p.name, tenant_id: PLATFORM_TENANT_ID, tenant_name: 'Aramo Platform', role_keys: p.roles }) },
      { path: /^\/platform\/commercial\/policy-versions$/, reply: json(policyList(o.persona)) },
      { path: /^\/platform\/commercial\/operators$/, reply: json(roster(o.bootstrap ?? 'ready')) },
      { path: /^\/platform\/commercial\/audit-events$/, reply: json({ events: auditEvents(), next_cursor: null }) },
    ],
  };
}

/** The fixture DRAFT (v2) with `content` merged in — the answer to a PATCH of the draft. */
export function ccpEditedDraft(content: Record<string, unknown>) {
  const draft = policyList('priya').versions[0] as { content: Record<string, unknown> };
  return { ...draft, content: { ...draft.content, ...content } };
}
