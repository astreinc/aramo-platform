import { describe, expect, it, vi } from 'vitest';
import { SIGN_ID_VERIFICATION_ATTEMPT_METER, SIGN_KBA_ATTEMPT_METER, SIGN_USAGE_UNITS, type SignUsageRecord } from '@aramo/sign';
import { METERED_UNIT_KEYS, type UsageRecordInput, type UsageRecordResult, type UsageRecorder } from '@aramo/subscription';

import { SignMeteringUsageRecorder, usageSourceRef } from '../app/billing/sign-metering-usage-recorder.js';

// Sign usage metering (Amendment A3) — the ONE Sign usage port (SIGN_USAGE_RECORDER_PORT) bound to
// the metering ledger: dark while SIGN_USAGE_BILLING_ENABLED is unset, a pass-through with an
// opaque source reference when on, a refusal never thrown into the caller's flow.

const T = '0190dddd-0000-7000-8000-0000000000a1';
const AT = new Date('2026-11-10T12:00:00.000Z');
const SMS: SignUsageRecord = { tenant_id: T, unit: 'sign.sms_message', quantity: 1, idempotency_key: 'sign-message:d1', occurred_at: AT, envelope_id: 'env-1', provider: 'aws_sms' };

function ledger(result: UsageRecordResult = { ok: true, entry_id: 'e', replayed: false, unit: 'sign.sms_message', quantity: 1, unit_price_minor: 5, amount_minor: 5, currency: 'USD', period_start: AT, period_end: AT }) {
  const calls: UsageRecordInput[] = [];
  const l: UsageRecorder = {
    check: vi.fn(),
    record: vi.fn(async (i: UsageRecordInput) => {
      calls.push(i);
      return result;
    }),
  };
  return { l, calls };
}

describe('SignMeteringUsageRecorder', () => {
  it('USG-1 the Sign usage units equal the metering registry (one port, one unit set); the ID / KBA meters are registry units', () => {
    expect([...SIGN_USAGE_UNITS]).toEqual([...METERED_UNIT_KEYS]);
    expect(SIGN_ID_VERIFICATION_ATTEMPT_METER).toBe('sign.id_verification');
    expect(SIGN_KBA_ATTEMPT_METER).toBe('sign.kba');
  });

  it('USG-2 dark: with the flag unset (or not exactly 1) nothing reaches the ledger', async () => {
    for (const env of [{}, { SIGN_USAGE_BILLING_ENABLED: '0' }, { SIGN_USAGE_BILLING_ENABLED: 'true' }]) {
      const { l, calls } = ledger();
      await new SignMeteringUsageRecorder(l, env).record(SMS);
      expect(calls).toEqual([]);
    }
  });

  it('USG-3 on: one ledger record per usage record, keyed by the caller idempotency key, with an opaque source reference and no price', async () => {
    const { l, calls } = ledger();
    await new SignMeteringUsageRecorder(l, { SIGN_USAGE_BILLING_ENABLED: '1' }).record(SMS);
    expect(calls).toEqual([{ tenant_id: T, unit: 'sign.sms_message', quantity: 1, idempotency_key: 'sign-message:d1', source_ref: 'sign:envelope:env-1', occurred_at: AT }]);
    expect(usageSourceRef({ unit: 'sign.sms_otp' })).toBe('sign:unit:sign.sms_otp');
  });

  it('USG-4 a ledger refusal (e.g. UNIT_NOT_SOLD until a priced version is published) is logged, never thrown', async () => {
    const { l } = ledger({ ok: false, reason: 'UNIT_NOT_SOLD', message: 'not sold' });
    await expect(new SignMeteringUsageRecorder(l, { SIGN_USAGE_BILLING_ENABLED: '1' }).record({ ...SMS, unit: 'sign.id_verification' })).resolves.toBeUndefined();
  });
});
