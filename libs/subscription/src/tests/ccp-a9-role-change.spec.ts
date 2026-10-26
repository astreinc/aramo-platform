import { describe, expect, it } from 'vitest';

import {
  COMMERCIAL_ACTIONS,
  COMMERCIAL_A3_TRANSITIONS,
  COMMERCIAL_CHANGE_REQUEST_STATES,
  COMMERCIAL_ROLE_CHANGE_ROLE_KEYS,
  CommercialPayloadError,
  canTransitionFor,
  resolveRequiredChain,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import {
  BOOTSTRAP_CLI_FLAGS,
  BOOTSTRAP_TARGET_EMAIL,
  PlatformOwnerBootstrapRefusedError,
  parseBootstrapArgs,
} from '../lib/commercial/commercial-platform-owner-bootstrap.js';
import { parseCommercialPolicyContent } from '../lib/commercial/commercial-policy.js';
import { deterministicMembershipRoleId, isPlatformLastOwnerViolation, RoleChangeApplyError } from '../lib/commercial/commercial-role-change.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';

// CCP-A9 (PBD §5.1 row A9) — the pure parts: governance requester authority (TD-A3-5), the
// role-change payload, the narrow apply transitions (TD-A9-1) and the bootstrap's argument
// contract (A1-2(2): no redirecting argument).

const U = '019a0000-0000-7000-8000-000000000001';
const H = 'a'.repeat(64);

describe('CCP-A9 governance requester authority (TD-A3-5, PO 2026-10-25)', () => {
  it('A9-U-1 POLICY_ACTIVATE is requested by finance_admin; ROLE_GRANT / ROLE_REVOKE by platform_owner; no governance request scope exists; every other action keeps its A1 scope and no role', () => {
    expect(COMMERCIAL_ACTIONS.POLICY_ACTIVATE).toMatchObject({ requester_scope: null, requester_role: 'finance_admin' });
    expect(COMMERCIAL_ACTIONS.ROLE_GRANT).toMatchObject({ requester_scope: null, requester_role: 'platform_owner' });
    expect(COMMERCIAL_ACTIONS.ROLE_REVOKE).toMatchObject({ requester_scope: null, requester_role: 'platform_owner' });
    for (const [action, def] of Object.entries(COMMERCIAL_ACTIONS)) {
      if (def.domain === 'governance') continue;
      expect(def.requester_role, action).toBeNull();
      expect(def.requester_scope, action).not.toBeNull();
    }
    // Nothing is left without a requester authority.
    expect(Object.values(COMMERCIAL_ACTIONS).filter((d) => d.requester_scope === null && d.requester_role === null)).toHaveLength(0);
  });

  it('A9-U-2 every role change resolves the distinct-platform_owner chain (Q2: role changes that are not owner or finance as well; D6 owner/finance)', () => {
    const policy = parseCommercialPolicyContent(seededPolicyV1().content);
    for (const role_key of COMMERCIAL_ROLE_CHANGE_ROLE_KEYS) {
      for (const action of ['ROLE_GRANT', 'ROLE_REVOKE'] as const) {
        const c = resolveRequiredChain(action, { subject_user_id: U, role_key }, policy);
        expect(c.rule, `${action} ${role_key}`).toBe('DISTINCT_PLATFORM_OWNER');
        expect(c.steps.map((s) => s.role_key)).toEqual(['platform_owner']);
      }
    }
  });
});

describe('CCP-A9 role-change payload', () => {
  const bad = (action: 'ROLE_GRANT' | 'ROLE_REVOKE', p: Record<string, unknown>): string[] => {
    try {
      validatePayload(action, p);
    } catch (e) {
      return (e as CommercialPayloadError).errors as string[];
    }
    return [];
  };
  it('A9-U-3 only the 6 CCP roles may be named (never super_admin); the key set is closed; human_ref_hash is a grant-only SHA-256 hex', () => {
    expect([...COMMERCIAL_ROLE_CHANGE_ROLE_KEYS]).toEqual(['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor']);
    for (const role_key of COMMERCIAL_ROLE_CHANGE_ROLE_KEYS) expect(bad('ROLE_GRANT', { subject_user_id: U, role_key })).toEqual([]);
    expect(bad('ROLE_GRANT', { subject_user_id: U, role_key: 'super_admin' })).toHaveLength(1);
    expect(bad('ROLE_REVOKE', { subject_user_id: U, role_key: 'super_admin' })).toHaveLength(1);
    expect(bad('ROLE_GRANT', { subject_user_id: U, role_key: 'tenant_owner' })).toHaveLength(1);
    expect(bad('ROLE_GRANT', { subject_user_id: U, role_key: 'finance_admin', human_ref_hash: H })).toEqual([]);
    expect(bad('ROLE_GRANT', { subject_user_id: U, role_key: 'finance_admin', human_ref_hash: 'A'.repeat(64) })).toHaveLength(1);
    expect(bad('ROLE_REVOKE', { subject_user_id: U, role_key: 'finance_admin', human_ref_hash: H })).toHaveLength(1);
    expect(bad('ROLE_GRANT', { subject_user_id: U, role_key: 'finance_admin', email: 'x@aramo.ai' })).toHaveLength(1);
    expect(bad('ROLE_GRANT', { subject_user_id: 'nope', role_key: 'finance_admin' })).toHaveLength(1);
  });
});

describe('CCP-A9 narrow apply transitions (TD-A9-1)', () => {
  it('A9-U-4 the A3 table is unchanged (exactly 6 allowed pairs); role actions add exactly APPROVED → APPLYING and APPLYING → APPLIED plus the AD-4 expiry; every other applyable action (A6, CCP-B2-backend, POLICY_ACTIVATE, CONVERSION, ENTITLEMENT_REVOKE, the NORMAL SUPPORT_EXTENSION) adds the A6 apply set with APPLY_EXPIRED (CCP-B5-R); a bounded EXCEPTION SUPPORT_EXTENSION makes exactly its two moves; no other action reaches APPLYING; APPLY_FAILED unreachable for role actions', () => {
    const states = COMMERCIAL_CHANGE_REQUEST_STATES;
    const a3 = (f: (typeof states)[number], t: (typeof states)[number]) => COMMERCIAL_A3_TRANSITIONS[f].includes(t);
    let base = 0;
    for (const f of states) for (const t of states) if (a3(f, t)) base += 1;
    expect(base).toBe(6);
    expect(Object.values(COMMERCIAL_A3_TRANSITIONS).flat()).not.toContain('APPLYING');
    // CCP-B5-R (TD-B5-1; Charter Amendment A1 AD-4 for every applyable type).
    const APPLY_SET = ['SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', 'PLAN_VERSION_PUBLISH', 'PLAN_RETIRE', 'POLICY_ACTIVATE', 'CONVERSION', 'ENTITLEMENT_REVOKE', 'SUPPORT_EXTENSION', 'CREDIT', 'DISCOUNT', 'REFUND', 'PAYMENT_RECORD']; // CCP-C4 adds the billing adjustments; CCP-C8-PR adds PAYMENT_RECORD (PR-4)
    const EXPIRY = ['APPLY_FAILED->APPLY_EXPIRED', 'APPROVED->APPLY_EXPIRED'];
    const A6_SET = ['APPLYING->APPLIED', 'APPLYING->APPLY_FAILED', 'APPLY_FAILED->APPLYING', 'APPROVED->APPLYING'];
    for (const action of Object.keys(COMMERCIAL_ACTIONS)) {
      const extra: string[] = [];
      for (const f of states) for (const t of states) if (canTransitionFor(action, f, t) && !a3(f, t)) extra.push(`${f}->${t}`);
      const role = action === 'ROLE_GRANT' || action === 'ROLE_REVOKE';
      const applySet = APPLY_SET.includes(action);
      // CCP-C4-R: a REFUND also has the governed resolution APPLYING -> WITHDRAWN (TD-C4-12).
      const resolution = action === 'REFUND' ? ['APPLYING->WITHDRAWN'] : [];
      expect(extra.sort(), action).toEqual(
        // CCP-ACC-1: POLICY_ACTIVATE alone adds APPLY_FAILED → WITHDRAWN (TD-ACC-1 Option B).
        role ? ['APPLYING->APPLIED', ...EXPIRY, 'APPROVED->APPLYING'].sort() : applySet ? [...A6_SET, ...EXPIRY, ...resolution, ...(action === 'POLICY_ACTIVATE' ? ['APPLY_FAILED->WITHDRAWN'] : [])].sort() : [],
      );
      if (!applySet) for (const f of states) expect(canTransitionFor(action, f, 'APPLY_FAILED'), `${action} ${f}`).toBe(false);
      // AD-4: never from APPLYING, for any action.
      expect(canTransitionFor(action, 'APPLYING', 'APPLY_EXPIRED'), action).toBe(false);
    }
    // CCP-A8 — kind EXCEPTION: exactly the two bounded moves (no A3 base move, no APPLY_FAILED).
    const exception: string[] = [];
    for (const f of states) for (const t of states) if (canTransitionFor('SUPPORT_EXTENSION', f, t, 'EXCEPTION')) exception.push(`${f}->${t}`);
    expect(exception.sort()).toEqual(['APPLYING->APPLIED', 'DRAFT->APPLYING']);
    // kind EXCEPTION on any other action adds nothing beyond its NORMAL table.
    for (const action of Object.keys(COMMERCIAL_ACTIONS).filter((a) => a !== 'SUPPORT_EXTENSION')) {
      for (const f of states) for (const t of states) expect(canTransitionFor(action, f, t, 'EXCEPTION'), `${action} ${f}->${t}`).toBe(canTransitionFor(action, f, t));
    }
  });
});

describe('CCP-ACC-1 withdrawal of a failed policy activation (TD-ACC-1 Option B)', () => {
  it('ACC-U-1 only POLICY_ACTIVATE admits APPLY_FAILED → WITHDRAWN (any kind); WITHDRAWN stays terminal; no action withdraws from APPROVED; only a REFUND (C4-R resolution) from APPLYING', () => {
    for (const action of Object.keys(COMMERCIAL_ACTIONS)) {
      for (const kind of ['NORMAL', 'EXCEPTION', 'MIGRATION']) {
        const k = action === 'SUPPORT_EXTENSION' && kind !== 'NORMAL' ? false : action === 'POLICY_ACTIVATE';
        expect(canTransitionFor(action, 'APPLY_FAILED', 'WITHDRAWN', kind), `${action}/${kind}`).toBe(k);
        expect(canTransitionFor(action, 'APPROVED', 'WITHDRAWN', kind), `${action}/${kind}`).toBe(false);
        // Merge train (ACC-1 × C4-R): REFUND alone has APPLYING → WITHDRAWN, the governed resolution of a
        // refund proven not executed (Architect C4 disposition, TD-C4-12); every other action never.
        expect(canTransitionFor(action, 'APPLYING', 'WITHDRAWN', kind), `${action}/${kind}`).toBe(action === 'REFUND');
        for (const t of COMMERCIAL_CHANGE_REQUEST_STATES) expect(canTransitionFor(action, 'WITHDRAWN', t, kind), `${action} WITHDRAWN->${t}`).toBe(false);
      }
    }
  });
});

describe('CCP-A9 bootstrap argument contract (A1-2(2))', () => {
  const refusal = (argv: string[]): Record<string, unknown> | null => {
    try {
      parseBootstrapArgs(argv);
    } catch (e) {
      expect(e).toBeInstanceOf(PlatformOwnerBootstrapRefusedError);
      return { refusal: (e as PlatformOwnerBootstrapRefusedError).refusal, ...(e as PlatformOwnerBootstrapRefusedError).detail };
    }
    return null;
  };
  it('A9-U-5 exactly two flags are accepted (the PO authorization reference and the D9 human reference); the target is a constant', () => {
    expect([...BOOTSTRAP_CLI_FLAGS]).toEqual(['--po-authorization-ref', '--human-ref-hash']);
    expect(BOOTSTRAP_TARGET_EMAIL).toBe('purush@aramo.ai');
    expect(parseBootstrapArgs(['--po-authorization-ref', 'PO-1', `--human-ref-hash=${H}`])).toEqual({ po_authorization_ref: 'PO-1', human_ref_hash: H });
  });
  it.each([['--email=other@aramo.ai'], ['--user-id=019a0000-0000-7000-8000-000000000001'], ['--role=finance_admin'], ['--tenant=t'], ['--target', 'x'], ['purush@aramo.ai']])(
    'A9-U-6 a redirecting argument (%s) is refused (INVALID_ARGUMENT) before any database access',
    (...extra) => {
      expect(refusal(['--po-authorization-ref=PO-1', `--human-ref-hash=${H}`, ...extra])).toMatchObject({ refusal: 'INVALID_ARGUMENT', unknown_argument: extra[0]?.split('=')[0] });
    },
  );
  it('A9-U-7 both flags are required, once each, with a value', () => {
    expect(refusal([`--human-ref-hash=${H}`])).toMatchObject({ missing_argument: '--po-authorization-ref' });
    expect(refusal(['--po-authorization-ref=PO-1'])).toMatchObject({ missing_argument: '--human-ref-hash' });
    expect(refusal(['--po-authorization-ref=PO-1', '--po-authorization-ref=PO-2', `--human-ref-hash=${H}`])).toMatchObject({ duplicate_argument: '--po-authorization-ref' });
    expect(refusal(['--po-authorization-ref'])).toMatchObject({ missing_value: '--po-authorization-ref' });
  });
});

describe('CCP-A9 role-change helpers', () => {
  it('A9-U-8 the bootstrap membership-role id is deterministic and a valid uuid; the last-owner DB marker is recognized, a typed refusal is not', () => {
    const a = deterministicMembershipRoleId('ccp-a9:bootstrap:m1:platform_owner');
    expect(a).toBe(deterministicMembershipRoleId('ccp-a9:bootstrap:m1:platform_owner'));
    expect(a).not.toBe(deterministicMembershipRoleId('ccp-a9:bootstrap:m2:platform_owner'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isPlatformLastOwnerViolation(new Error('platform_last_owner: the platform must keep at least one active platform_owner'))).toBe(true);
    expect(isPlatformLastOwnerViolation(new Error('tenant_last_owner: x'))).toBe(false);
    expect(isPlatformLastOwnerViolation(new RoleChangeApplyError('PLATFORM_LAST_OWNER'))).toBe(false);
  });
});
