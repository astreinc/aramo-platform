import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMERCIAL_A3_TRANSITIONS,
  COMMERCIAL_CHANGE_REQUEST_STATES,
  type CommercialChangeRequestState,
  canTransitionFor,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import {
  CONVERSION_RELEASE_STATES,
  CONVERSION_RELEASE_TRANSITIONS,
  conversionPayloadErrors,
  effectiveReleaseState,
  releaseConsumable,
} from '../lib/commercial/commercial-conversion.js';
import { applyActionable } from '../lib/commercial/commercial-change-request.service.js';
import { COMMERCIAL_POLICY_OPTIONAL_KEYS, parseCommercialPolicyContent } from '../lib/commercial/commercial-policy.js';

// CCP-C2 — the pure half of the conversion: the TS mirrors of the DB guard (CONVERSION apply pairs)
// and the release trigger, the closed payload schema per direction, the half-open release window,
// the apply-deadline reader (Charter Amendment A1-Apply-Deadline) and the module binding. Test IDs
// are cited by doc/ccp/slices/CCP-C2-acceptance.md.

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

describe('CCP-C2 conversion (pure)', () => {
  it('C2-U-1 CONVERSION adds exactly the four apply pairs plus the Amendment A1 AD-4 expiry from APPROVED / APPLY_FAILED (CCP-B5-R; never from APPLYING) to the A3 table (DB guard mirror); APPLIED stays terminal', () => {
    const extra: string[] = [];
    for (const f of COMMERCIAL_CHANGE_REQUEST_STATES) {
      for (const t of COMMERCIAL_CHANGE_REQUEST_STATES) {
        if (canTransitionFor('CONVERSION', f as CommercialChangeRequestState, t as CommercialChangeRequestState) && !COMMERCIAL_A3_TRANSITIONS[f as CommercialChangeRequestState].includes(t as CommercialChangeRequestState)) extra.push(`${f}->${t}`);
      }
    }
    expect(extra.sort()).toEqual(['APPLYING->APPLIED', 'APPLYING->APPLY_FAILED', 'APPLY_FAILED->APPLYING', 'APPLY_FAILED->APPLY_EXPIRED', 'APPROVED->APPLYING', 'APPROVED->APPLY_EXPIRED']);
    expect(canTransitionFor('CONVERSION', 'APPLYING', 'APPLY_EXPIRED')).toBe(false);
    for (const t of COMMERCIAL_CHANGE_REQUEST_STATES) expect(canTransitionFor('CONVERSION', 'APPLIED', t as CommercialChangeRequestState)).toBe(false);
  });

  it('C2-U-2 the release state machine is exactly 4 of the 16 pairs (trigger mirror); CONVERTED and EXPIRED are terminal', () => {
    let n = 0;
    for (const f of CONVERSION_RELEASE_STATES) for (const t of CONVERSION_RELEASE_STATES) if (CONVERSION_RELEASE_TRANSITIONS[f].includes(t)) n += 1;
    expect(n).toBe(4);
    expect(CONVERSION_RELEASE_TRANSITIONS.CONVERTED).toEqual([]);
    expect(CONVERSION_RELEASE_TRANSITIONS.EXPIRED).toEqual([]);
    expect(CONVERSION_RELEASE_TRANSITIONS.CONSUMED).toEqual(['CONVERTED']);
  });

  it('C2-U-3 the payload is a closed schema per direction (validated through validatePayload at create and apply)', () => {
    const u = () => randomUUID();
    const ok = [
      { direction: 'TO_SELF_SERVICE', governed_subscription_id: u(), plan_key: 'aramo-sign-standard-business-v1', plan_version_id: u(), release_expires_at: '2026-10-26T12:00:00.000Z' },
      { direction: 'TO_SELF_SERVICE', governed_subscription_id: u(), plan_key: 'aramo-sign-standard-business-v1', plan_version_id: u(), release_expires_at: '2026-10-26T12:00:00Z', held_subscription_ref: 'sub_123' },
      { direction: 'TO_GOVERNED', subscription_id: u(), plan_key: 'aramo-sign-enterprise-v1', plan_version_id: u() },
      { direction: 'TO_GOVERNED', held_subscription_ref: 'sub_123', governed_subscription_id: u() },
    ];
    for (const p of ok) expect(conversionPayloadErrors(p), JSON.stringify(p)).toEqual([]);
    for (const p of ok) expect(() => validatePayload('CONVERSION', p)).not.toThrow();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{}, 'direction must be one of'],
      [{ direction: 'TO_SELF_SERVICE', governed_subscription_id: u(), plan_key: 'aramo-sign-standard-business-v1', plan_version_id: u() }, 'release_expires_at'],
      [{ direction: 'TO_SELF_SERVICE', governed_subscription_id: u(), plan_key: 'aramo-sign-standard-business-v1', plan_version_id: u(), release_expires_at: '2026-10-26 12:00' }, 'release_expires_at'],
      [{ direction: 'TO_SELF_SERVICE', governed_subscription_id: 'x', plan_key: 'aramo-sign-standard-business-v1', plan_version_id: u(), release_expires_at: '2026-10-26T12:00:00Z' }, 'governed_subscription_id must be a uuid'],
      [{ direction: 'TO_GOVERNED', subscription_id: u(), plan_key: 'p-1', plan_version_id: u(), mode: 'AT_PERIOD_END' }, 'mode is not a field'],
      [{ direction: 'TO_GOVERNED', subscription_id: u(), plan_key: 'p-1', plan_version_id: u(), proration: 'none' }, 'proration is not a field'],
      [{ direction: 'TO_GOVERNED', held_subscription_ref: 'sub 1', governed_subscription_id: u() }, 'held_subscription_ref'],
      [{ direction: 'TO_GOVERNED', held_subscription_ref: 'sub_1', subscription_id: u() }, 'subscription_id is not a field'],
    ];
    for (const [p, msg] of bad) expect(conversionPayloadErrors(p).join('; '), JSON.stringify(p)).toContain(msg);
    expect(() => validatePayload('CONVERSION', {})).toThrow(/direction/);
  });

  it('C2-U-4 the release window is half-open (TD-A2-1): consumable strictly before expires_at; a RELEASED row reads EXPIRED at the instant', () => {
    const expires_at = new Date('2026-10-25T13:00:00.000Z');
    expect(releaseConsumable({ state: 'RELEASED', expires_at }, new Date(expires_at.getTime() - 1))).toBe(true);
    expect(releaseConsumable({ state: 'RELEASED', expires_at }, expires_at)).toBe(false);
    expect(releaseConsumable({ state: 'CONSUMED', expires_at }, new Date(0))).toBe(false);
    expect(effectiveReleaseState({ state: 'RELEASED', expires_at }, expires_at)).toBe('EXPIRED');
    expect(effectiveReleaseState({ state: 'CONSUMED', expires_at }, new Date(expires_at.getTime() + 1e9))).toBe('CONSUMED');
  });

  it('C2-U-5 apply deadline (AD-1…AD-3; merge train TD-MERGE-21): one policy key, apply_expiry_hours (A6-R), validated by the A2 parser (the conversion deadline refusal is the A6-R one, CCP-FIX1 O-D4-2)', () => {
    expect(COMMERCIAL_POLICY_OPTIONAL_KEYS).toEqual(['apply_expiry_hours']);
    expect(parseCommercialPolicyContent(V1_CONTENT).apply_expiry_hours).toBeUndefined();
    expect(parseCommercialPolicyContent({ ...V1_CONTENT, apply_expiry_hours: 72 }).apply_expiry_hours).toBe(72);
    for (const v of [0, -1, 1.5, '72', null]) expect(() => parseCommercialPolicyContent({ ...V1_CONTENT, apply_expiry_hours: v }), String(v)).toThrow();
    expect(() => parseCommercialPolicyContent({ ...V1_CONTENT, apply_deadline_hours: 72 })).toThrow();
  });

  it('C2-U-6 SubscriptionModule binds the conversion ledger into the lifecycle (so checkout, webhook and confirmed-end paths honour releases and complete conversions) and provides the conversion service', async () => {
    await import('reflect-metadata');
    const { Test } = await import('@nestjs/testing');
    const { SubscriptionModule } = await import('../lib/subscription.module.js');
    const { SubscriptionLifecycleService } = await import('../lib/billing/subscription-lifecycle.service.js');
    const { CommercialConversionLedger } = await import('../lib/commercial/commercial-conversion.ledger.js');
    const { CommercialConversionService } = await import('../lib/commercial/commercial-conversion.service.js');
    for (const mod of [SubscriptionModule, SubscriptionModule.forRoot()]) {
      const ref = await Test.createTestingModule({ imports: [mod] }).compile();
      const lifecycle = ref.get(SubscriptionLifecycleService) as unknown as { conversions?: unknown };
      expect(lifecycle.conversions).toBeInstanceOf(CommercialConversionLedger);
      expect(ref.get(CommercialConversionService)).toBeInstanceOf(CommercialConversionService);
      await ref.close();
    }
  });

  it('B3-U-1 (CCP-B3 C-2) apply_actionable covers CONVERSION under the A6-R rule: the requester holding platform:subscription:request on an APPROVED / APPLY_FAILED conversion reads true; another user, a DRAFT and a scope-less session read false', () => {
    const requester = randomUUID();
    const req = (state: string) => ({ action_type: 'CONVERSION', state, requested_by: requester });
    const user = (user_id: string, scopes: readonly string[] = ['platform:subscription:request']) => ({ user_id, actor_kind: 'user', scopes });
    expect(applyActionable(user(requester), req('APPROVED'))).toBe(true);
    expect(applyActionable(user(requester), req('APPLY_FAILED'))).toBe(true);
    expect(applyActionable(user(randomUUID()), req('APPROVED'))).toBe(false);
    expect(applyActionable(user(requester), req('DRAFT'))).toBe(false);
    expect(applyActionable(user(requester), req('PENDING_APPROVAL'))).toBe(false);
    expect(applyActionable(user(requester), req('APPLIED'))).toBe(false);
    expect(applyActionable(user(requester, ['platform:subscription:read']), req('APPROVED'))).toBe(false);
    expect(applyActionable({ ...user(requester), actor_kind: 'service' }, req('APPROVED'))).toBe(false);
  });
});
