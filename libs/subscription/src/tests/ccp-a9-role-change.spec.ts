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
  it('A9-U-4 the A3 table is unchanged (exactly 6 allowed pairs); role actions add exactly APPROVED → APPLYING and APPLYING → APPLIED; the A6 and CCP-B2-backend actions add the A6 apply set with A6-R APPLY_EXPIRED; CONVERSION (C2), ENTITLEMENT_REVOKE (A7) and the NORMAL SUPPORT_EXTENSION (A8) add the apply set without it; a bounded EXCEPTION SUPPORT_EXTENSION makes exactly its two moves; no other action reaches APPLYING; APPLY_FAILED unreachable for role actions (merge train)', () => {
    const states = COMMERCIAL_CHANGE_REQUEST_STATES;
    const a3 = (f: (typeof states)[number], t: (typeof states)[number]) => COMMERCIAL_A3_TRANSITIONS[f].includes(t);
    let base = 0;
    for (const f of states) for (const t of states) if (a3(f, t)) base += 1;
    expect(base).toBe(6);
    expect(Object.values(COMMERCIAL_A3_TRANSITIONS).flat()).not.toContain('APPLYING');
    const A6 = ['SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT'];
    // CCP-B2-backend — the catalog publish / retire apply carries the A6 apply set too.
    const B2 = ['PLAN_VERSION_PUBLISH', 'PLAN_RETIRE'];
    const A6_SET = ['APPLYING->APPLIED', 'APPLYING->APPLY_FAILED', 'APPLY_FAILED->APPLYING', 'APPROVED->APPLYING'];
    const APPLY_SET = ['SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', 'SUPPORT_EXTENSION'];
    for (const action of Object.keys(COMMERCIAL_ACTIONS)) {
      const extra: string[] = [];
      for (const f of states) for (const t of states) if (canTransitionFor(action, f, t) && !a3(f, t)) extra.push(`${f}->${t}`);
      const role = action === 'ROLE_GRANT' || action === 'ROLE_REVOKE';
      // Merge train: CONVERSION (C2), ENTITLEMENT_REVOKE (A7) and the NORMAL SUPPORT_EXTENSION (A8) add the
      // apply set without A6-R's APPLY_EXPIRED (the guard names only the A6 + B2-backend types).
      const applySet = APPLY_SET.includes(action) || action === 'CONVERSION' || action === 'ENTITLEMENT_REVOKE';
      expect(extra.sort(), action).toEqual(
        role ? ['APPLYING->APPLIED', 'APPROVED->APPLYING'] : A6.includes(action) || B2.includes(action) ? ['APPLYING->APPLIED', 'APPLYING->APPLY_FAILED', 'APPLY_FAILED->APPLYING', 'APPLY_FAILED->APPLY_EXPIRED', 'APPROVED->APPLYING', 'APPROVED->APPLY_EXPIRED'] : applySet ? A6_SET : [],
      );
      if (!applySet && !A6.includes(action) && !B2.includes(action)) for (const f of states) expect(canTransitionFor(action, f, 'APPLY_FAILED'), `${action} ${f}`).toBe(false);
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
