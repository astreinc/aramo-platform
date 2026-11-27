import { describe, expect, it } from 'vitest';

import { DisabledSmsAdapter } from '../lib/personal/sms-verification.port.js';
import { PersonalRiskService } from '../lib/personal/personal-risk.service.js';

// SIGN-FREE-PARITY-1 S2 — the sender's own step-up phone code (identity stores the hash;
// sign-service texts it). Personal code rules: 6 digits, 10 minutes, 5 attempts, 60 s gap,
// 5 sends a day. A correct code is the only way the step records phone assurance.

type Row = Record<string, unknown> & { tenant_id: string };

function fakePrisma(rows: Row[]) {
  const audits: Record<string, unknown>[] = [];
  const match = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && !(v instanceof Date) && 'not' in (v as object)) return r[k] !== (v as { not: unknown }).not;
      return r[k] === v;
    });
  const tenantRiskState = {
    findUnique: async ({ where }: { where: { tenant_id: string } }) => {
      const r = rows.find((x) => x.tenant_id === where.tenant_id);
      return r === undefined ? null : { ...r };
    },
    count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where)).length,
    update: async ({ where, data }: { where: { tenant_id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.tenant_id === where.tenant_id) as Row;
      for (const [k, v] of Object.entries(data)) {
        if (v !== null && typeof v === 'object' && 'increment' in (v as object)) r[k] = (r[k] as number) + (v as { increment: number }).increment;
        else r[k] = v;
      }
      return { ...r };
    },
  };
  const identityAuditEvent = { create: async ({ data }: { data: Record<string, unknown> }) => audits.push(data) };
  const tx = { tenantRiskState, identityAuditEvent };
  return { prisma: { ...tx, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) }, audits };
}

const base = (over: Partial<Row> = {}): Row => ({
  tenant_id: 't-1',
  state: 'clear',
  step_up_required: true,
  review_pending: false,
  phone_e164: '+14155550167',
  phone_verified_at: null,
  restricted_until: null,
  reason: null,
  decided_by: null,
  step_up_cleared_by: null,
  created_at: new Date('2026-11-01T00:00:00Z'),
  updated_at: new Date('2026-11-01T00:00:00Z'),
  step_up_code_hash: null,
  step_up_code_phone_e164: null,
  step_up_code_expires_at: null,
  step_up_code_attempts: 0,
  step_up_code_last_sent_at: null,
  step_up_code_window_start: null,
  step_up_code_sends: 0,
  ...over,
});

const NOW = new Date('2026-11-27T12:00:00Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);

function svc(rows: Row[]) {
  const f = fakePrisma(rows);
  return { risk: new PersonalRiskService(f.prisma as never, new DisabledSmsAdapter()), ...f };
}

describe('step-up code — start', () => {
  it('issues a 6-digit code, stores only its hash, and never in the risk-state view', async () => {
    const rows = [base()];
    const { risk } = svc(rows);
    const r = await risk.startPhoneStepUpCode('t-1', '+14155550167', NOW);
    expect(r).toMatchObject({ ok: true, phone_e164: '+14155550167' });
    const code = (r as { code: string }).code;
    expect(code).toMatch(/^\d{6}$/);
    expect(rows[0]?.['step_up_code_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.['step_up_code_hash']).not.toContain(code);
    expect(rows[0]?.['step_up_code_sends']).toBe(1);
    const view = await risk.riskStateOf('t-1');
    expect(Object.keys(view ?? {}).some((k) => k.startsWith('step_up_code'))).toBe(false);
  });

  it('60 s gap and 5 sends in 24 h; the window resets after a day', async () => {
    const rows = [base()];
    const { risk } = svc(rows);
    expect((await risk.startPhoneStepUpCode('t-1', '+14155550167', NOW)).ok).toBe(true);
    expect(await risk.startPhoneStepUpCode('t-1', '+14155550167', at(30))).toEqual({ ok: false, reason: 'personal_code_rate_limited' });
    for (let i = 1; i <= 4; i += 1) expect((await risk.startPhoneStepUpCode('t-1', '+14155550167', at(i * 61))).ok).toBe(true);
    expect(await risk.startPhoneStepUpCode('t-1', '+14155550167', at(6 * 61))).toEqual({ ok: false, reason: 'personal_code_rate_limited' });
    expect((await risk.startPhoneStepUpCode('t-1', '+14155550167', at(86_401))).ok).toBe(true);
    expect(rows[0]?.['step_up_code_sends']).toBe(1);
  });

  it('refuses when nothing is owed, and a number that already verifies another account', async () => {
    const { risk } = svc([base({ phone_verified_at: NOW }), base({ tenant_id: 't-2', phone_e164: '+14155550199', phone_verified_at: NOW })]);
    expect(await risk.startPhoneStepUpCode('t-1', '+14155550167', NOW)).toEqual({ ok: false, reason: 'step_up_not_required' });
    const other = svc([base(), base({ tenant_id: 't-2', phone_e164: '+14155550199', phone_verified_at: NOW })]);
    expect(await other.risk.startPhoneStepUpCode('t-1', '+14155550199', NOW)).toEqual({ ok: false, reason: 'phone_in_use' });
  });
});

describe('step-up code — verify', () => {
  it('a correct code records phone assurance for the number it went to (audited), and clears the code', async () => {
    const rows = [base()];
    const { risk, audits } = svc(rows);
    const { code } = (await risk.startPhoneStepUpCode('t-1', '+14155550188', NOW)) as { code: string };
    const r = await risk.verifyPhoneStepUpCode('t-1', code, at(10));
    expect(r.outcome).toBe('ok');
    expect(rows[0]?.['phone_verified_at']).toEqual(at(10));
    expect(rows[0]?.['phone_e164']).toBe('+14155550188');
    expect(rows[0]?.['step_up_code_hash']).toBeNull();
    expect(audits).toEqual([expect.objectContaining({ event_type: 'identity.personal.risk.phone_verified', event_payload: { step_up_satisfied: true, via: 'sender_step_up_code', phone_changed: true } })]);
  });

  it('a wrong code counts an attempt; 5 wrong codes exhaust it; an old code expires', async () => {
    const rows = [base()];
    const { risk } = svc(rows);
    await risk.startPhoneStepUpCode('t-1', '+14155550167', NOW);
    expect(await risk.verifyPhoneStepUpCode('t-1', 'abcdef', at(1))).toEqual({ outcome: 'mismatch', attempts_remaining: 4 });
    for (let i = 0; i < 4; i += 1) await risk.verifyPhoneStepUpCode('t-1', '999999x', at(2));
    expect(await risk.verifyPhoneStepUpCode('t-1', '000000', at(3))).toEqual({ outcome: 'exhausted' });
    expect(rows[0]?.['phone_verified_at']).toBeNull();
    const fresh = svc([base()]);
    const { code } = (await fresh.risk.startPhoneStepUpCode('t-1', '+14155550167', NOW)) as { code: string };
    expect(await fresh.risk.verifyPhoneStepUpCode('t-1', code, at(601))).toEqual({ outcome: 'expired' });
  });

  it('no code sent yet answers none', async () => {
    expect(await svc([base()]).risk.verifyPhoneStepUpCode('t-1', '123456', NOW)).toEqual({ outcome: 'none' });
  });
});

describe('requireStepUp — the caller may say SMS is available', () => {
  it('sms_available: true keeps the step with the sender (no review); omitted = this service’s port (review)', async () => {
    const rows = [base({ step_up_required: false })];
    const { risk } = svc(rows);
    const v = await risk.requireStepUp('t-1', 'young_account_first_send_several_recipients', NOW, {}, { sms_available: true });
    expect(v).toMatchObject({ state: 'clear', step_up_required: true });
    const rows2 = [base({ step_up_required: false })];
    const two = svc(rows2);
    const w = await two.risk.requireStepUp('t-1', 'young_account_first_send_several_recipients', NOW);
    expect(w).toMatchObject({ state: 'review' });
  });
});
