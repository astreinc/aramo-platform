// CCP-B6 — the deterministic support-extension dataset for the visual, a11y, keyboard and 900px
// suites: a port of the CCP prototype's Fernhill Studio (Sign starter, SELF_SERVICE, PAST_DUE,
// grace 29 Oct, no extension) and Oakridge Dental (EXT-0042: +10 days, 3 Oct 16:40 UTC, by Kwame
// Mensah holding Support admin + Finance admin at the time; the escalated CR-1052 pending
// Finance) from doc/design-reference/ccp/CCP-UI-v1_0/ccp-data.js, in the REAL CCP-A8 / CCP-B6
// DTO shapes (apps/platform-web/src/commercial/support-extensions/support-extension-api.ts), at
// the prototype's frozen clock (NOW = 2026-10-24 14:00 UTC). Oakridge's row is PAST_DUE here
// (the prototype shows it ACTIVE): an overlay exists only on a PAST_DUE row (TD-A8-1). The
// retired pilot policy v0 is not ported (handoff "Don't build"): the overlay names policy v1.
// TEST-ONLY: src/ never imports it.

import type { Handler, MockOptions } from './mock-api';
import { PERSONAS, type Persona } from './session';

export const SX_NOW = '2026-10-24T14:00:00Z';
const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';

export const SX_TENANTS = {
  fernhill: 'cc7e0000-0000-7000-8000-0000000000a5',
  oakridge: 'cc7e0000-0000-7000-8000-0000000000a6',
} as const;
const SUB = {
  fernhill: 'cc7e0000-0000-7000-8000-0000000005a5',
  oakridge: 'cc7e0000-0000-7000-8000-0000000005a6',
} as const;
export const SX_EXT_0042 = 'cc7e0000-0000-7000-8000-000000000042';
export const SX_CR_1052 = 'cc7e0000-0000-7000-8000-000000001052';

const CLAUSE = {
  support_extension_max_days: 14,
  support_extension_frequency_window_days: 90,
  support_extension_cumulative_max_days: 30,
  support_extension_cumulative_window_days: 365,
};
const POLICY = { version_id: POLICY_V1, version_number: 1, clause: CLAUSE, approval_expiry_hours: 72 };

const tenantRow = (id: string, name: string, slug: string) => ({
  id,
  name,
  kind: 'BUSINESS',
  slug,
  status: 'ACTIVE',
  status_reason_code: null,
  status_changed_at: '2026-03-22T10:00:00Z',
  is_active: true,
  created_at: '2026-03-22T10:00:00Z',
  activated_at: '2026-03-22T10:00:00Z',
  suspended_at: null,
});

function list(tenant: string): unknown {
  if (tenant === SX_TENANTS.fernhill) {
    return {
      extensions: [],
      subscriptions: [{ id: SUB.fernhill, product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: '2026-10-29T00:00:00Z', current_period_end: '2026-10-22T00:00:00Z' }],
      policy: POLICY,
    };
  }
  if (tenant === SX_TENANTS.oakridge) {
    return {
      extensions: [
        {
          id: SX_EXT_0042,
          tenant_id: SX_TENANTS.oakridge,
          product_key: 'sign',
          subscription_id: SUB.oakridge,
          change_request_id: 'cc7e0000-0000-7000-8000-00000000e042',
          is_exception: true,
          days: 10,
          grace_until_at_apply: '2026-10-03T16:40:00Z',
          base_until: '2026-10-03T16:40:00Z',
          extends_until: '2026-11-04T00:00:00Z',
          policy_version_id: POLICY_V1,
          applied_by: PERSONAS.ccpSupport.sub,
          applied_at: '2026-10-03T16:40:00Z',
          removed_at: null,
          removed_by: null,
          remove_change_request_id: null,
          active: true,
          context: {
            policy_version_number: 1,
            clause: CLAUSE,
            counters: { requested_days: 10, extensions_in_frequency_window: 0, cumulative_days_before: 0, cumulative_days_after: 10 },
            roles_at_apply: ['support_admin', 'finance_admin'],
          },
        },
      ],
      subscriptions: [{ id: SUB.oakridge, product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: '2026-10-29T00:00:00Z', current_period_end: '2026-11-04T00:00:00Z' }],
      policy: POLICY,
    };
  }
  return { extensions: [], subscriptions: [], policy: POLICY };
}

const CR_1052 = {
  id: SX_CR_1052,
  action_type: 'SUPPORT_EXTENSION',
  kind: 'NORMAL',
  state: 'PENDING_APPROVAL',
  tenant_id: SX_TENANTS.oakridge,
  product_key: 'sign',
  payload: { operation: 'EXTEND', subscription_id: SUB.oakridge, requested_days: 14 },
  payload_checksum: 'a'.repeat(64),
  required_chain: { rule: 'FINANCE_ONLY', basis: { ruling: 'Q7 escalated support extension' }, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:subscription:approve'] }] },
  policy_version_id: POLICY_V1,
  policy_checksum: 'b'.repeat(64),
  requested_by: PERSONAS.ccpSupport.sub,
  reason: 'The practice moved offices and paperwork was delayed.',
  created_at: '2026-10-24T10:00:00Z',
  submitted_at: '2026-10-24T10:00:00Z',
  expires_at: '2026-10-27T10:00:00Z',
  approved_at: null,
  rejected_at: null,
  rejected_by: null,
  rejection_reason: null,
  withdrawn_at: null,
  expired_at: null,
  applied_at: null,
};

const json = (body: unknown, status = 200) => ({ status, body });

/** The mock options for a persona on the support-extension screen. */
export function sxMock(persona: Persona = 'ccpSupport'): MockOptions & { clock: string } {
  const handlers: { method?: string; path: RegExp; reply: Handler }[] = [
    { path: /^\/platform\/tenants$/, reply: () => json({ tenants: [tenantRow(SX_TENANTS.fernhill, 'Fernhill Studio', 'fernhill'), tenantRow(SX_TENANTS.oakridge, 'Oakridge Dental', 'oakridge')] }) },
    { path: /^\/platform\/commercial\/support-extensions$/, reply: ({ query }) => json(list(query.get('tenant_id') ?? '')) },
    { path: /^\/platform\/commercial\/change-requests$/, reply: () => json({ requests: [CR_1052], next_cursor: null }) },
    { path: /^\/platform\/commercial\/change-requests\/[^/]+$/, reply: () => json({ request: CR_1052, approvals: [], is_expired: false, chain_satisfiable: true, steps: [], apply_actionable: false }) },
  ];
  return { persona, overrides: handlers, clock: SX_NOW };
}

export const sxPath = (tenant: keyof typeof SX_TENANTS): string => `/commercial/support-extensions?tenant=${SX_TENANTS[tenant]}`;
