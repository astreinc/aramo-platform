import type { Session } from '@aramo/fe-foundation';

import type { ChangeRequest, ChangeRequestDetail } from './commercial-api';

// CCP-B1 unit-test fixtures (TEST-ONLY). The role bundles restate the CCP A1 §4.1
// matrix (libs/identity/prisma/seed.ts CCP_PLATFORM_ROLE_SEED_BUNDLES:3241-3297) and
// the super_admin bundle (the 10 platform scopes): platform-web cannot import the
// seed (nx boundary), as TD-A1-7 / TD-A3-19.

export const SUPER_ADMIN_SCOPES = [
  'platform:tenant:read',
  'platform:tenant:provision',
  'platform:tenant:lifecycle:manage',
  'platform:admin:invite',
  'platform:skill:read',
  'platform:skill:manage',
  'platform:document_template:read',
  'platform:document_template:manage',
  'platform:matching_policy:read',
  'platform:matching_policy:write',
] as const;

export const ROLE_SCOPES = {
  platform_owner: [
    'platform:tenant:read',
    'platform:catalog:read',
    'platform:catalog:approve',
    'platform:catalog:publish',
    'platform:subscription:read',
    'platform:subscription:approve',
    'platform:entitlement:approve',
    'platform:billing:read',
    'platform:billing:approve',
    'platform:approval:read',
    'platform:commercial:audit:read',
  ],
  finance_admin: [
    'platform:tenant:read',
    'platform:catalog:read',
    'platform:catalog:approve',
    'platform:subscription:read',
    'platform:subscription:approve',
    'platform:entitlement:approve',
    'platform:billing:read',
    'platform:billing:approve',
    'platform:approval:read',
    'platform:commercial:audit:read',
  ],
  commercial_ops: [
    'platform:tenant:read',
    'platform:catalog:read',
    'platform:subscription:read',
    'platform:subscription:request',
    'platform:entitlement:request',
    'platform:billing:read',
    'platform:billing:request',
    'platform:approval:read',
  ],
  catalog_manager: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [
    'platform:tenant:read',
    'platform:catalog:read',
    'platform:subscription:read',
    'platform:subscription:support',
    'platform:billing:read',
    'platform:approval:read',
  ],
  read_only_auditor: [
    'platform:tenant:read',
    'platform:catalog:read',
    'platform:subscription:read',
    'platform:billing:read',
    'platform:approval:read',
    'platform:commercial:audit:read',
  ],
  super_admin: [...SUPER_ADMIN_SCOPES],
} as const;

export type FixtureRole = keyof typeof ROLE_SCOPES;
export const SEVEN_ROLES = Object.keys(ROLE_SCOPES) as FixtureRole[];

export const ME_ID = '01900000-0000-7000-8000-0000000ac001';
export const OTHER_ID = '01900000-0000-7000-8000-0000000ac002';
export const POLICY_ID = '019a0000-0000-7000-8000-0000000cc201';
export const TENANT_ID = '01900000-0000-7000-8000-0000000b0001';
export const NOW = new Date('2026-10-24T14:00:00Z');

export function sessionFor(role: FixtureRole, sub = ME_ID): Session {
  return { sub, consumer_type: 'platform', tenant_id: '01900000-0000-7000-8000-000000000100', scopes: [...ROLE_SCOPES[role]], iat: 0, exp: 0 };
}

const FINANCE_STEP = { step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] };
const OWNER_STEP = { step_index: 1, role_key: 'platform_owner', scope_keys: ['platform:billing:approve'] };

export function request(o: Partial<ChangeRequest> & { id: string }): ChangeRequest {
  return {
    action_type: 'CREDIT',
    kind: 'NORMAL',
    state: 'PENDING_APPROVAL',
    tenant_id: TENANT_ID,
    product_key: 'sign',
    payload: { amount_minor: 35000, currency: 'USD' },
    payload_checksum: 'a'.repeat(64),
    required_chain: { rule: 'FINANCE_ONLY', basis: {}, steps: [FINANCE_STEP] },
    policy_version_id: POLICY_ID,
    policy_checksum: 'b'.repeat(64),
    requested_by: OTHER_ID,
    reason: 'Envelopes failed to send during the 18 Oct incident.',
    created_at: '2026-10-24T09:00:00.000Z',
    submitted_at: '2026-10-24T09:00:00.000Z',
    expires_at: '2026-10-27T09:00:00.000Z',
    approved_at: null,
    rejected_at: null,
    rejected_by: null,
    rejection_reason: null,
    withdrawn_at: null,
    expired_at: null,
    applied_at: null,
    ...o,
  };
}

export const TWO_STEP_CHAIN = { rule: 'FINANCE_THEN_OWNER', basis: {}, steps: [FINANCE_STEP, OWNER_STEP] };

/** A detail whose next step carries the given caller verdict. */
export function detail(r: ChangeRequest, o: { signed?: number; refusal?: string | null; expired?: boolean; satisfiable?: boolean | null; approver?: string } = {}): ChangeRequestDetail {
  const signed = o.signed ?? 0;
  const approvals = r.required_chain.steps.slice(0, signed).map((s) => ({
    id: `ap-${String(s.step_index)}`,
    step_index: s.step_index,
    approver_user_id: o.approver ?? '01900000-0000-7000-8000-0000000ac0f1',
    step_role_key: s.role_key,
    step_scope_keys: s.scope_keys,
    approver_role_keys: [s.role_key],
    comment: null,
    created_at: '2026-10-24T10:00:00.000Z',
  }));
  return {
    request: r,
    approvals,
    is_expired: o.expired ?? false,
    chain_satisfiable: o.satisfiable === undefined ? (r.state === 'PENDING_APPROVAL' ? true : null) : o.satisfiable,
    // CCP-A6-R (TD-B2-3): the request read's apply authority for the caller.
    apply_actionable: false,
    steps: r.required_chain.steps.map((s) => {
      const isSigned = s.step_index < signed;
      return {
        step_index: s.step_index,
        role_key: s.role_key,
        scope_keys: s.scope_keys,
        status: isSigned ? ('APPROVED' as const) : s.step_index === signed ? ('NEXT' as const) : ('WAITING' as const),
        approval_id: isSigned ? `ap-${String(s.step_index)}` : null,
        caller: isSigned ? null : o.refusal === undefined || o.refusal === null ? { eligible: true, refusal: null } : { eligible: false, refusal: o.refusal },
      };
    }),
  };
}
