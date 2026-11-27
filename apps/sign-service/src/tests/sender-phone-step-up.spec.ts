import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantDto } from '@aramo/identity';

import { PersonalSendGate } from '../app/personal/personal-send.gate.js';
import { SenderPhoneStepUpService, senderPhoneStepUpEnabled } from '../app/personal/sender-phone-step-up.service.js';

// SIGN-FREE-PARITY-1 S2 (FP-R2) — the new-account send check, self-serve via SMS. Dark
// behind SIGN_SENDER_PHONE_STEP_UP: unset keeps today's routing of the step-up to review.

const AUTH = { sub: 'u-1', tenant_id: 't-1' };
const tenant = (over: Partial<TenantDto> = {}): TenantDto =>
  ({ id: 't-1', name: 'n', is_active: true, created_at: new Date().toISOString(), updated_at: '', identity_provider: null, status: 'ACTIVE', kind: 'PERSONAL', ...over }) as TenantDto;

function port(over: { channels?: string[]; canSend?: (to: string) => boolean; outcome?: string } = {}) {
  return {
    channels: new Set(over.channels ?? ['SMS']),
    canSend: vi.fn((_c: string, to: string) => (over.canSend ?? ((n: string) => !n.startsWith('+91')))(to)),
    send: vi.fn(async () => (over.outcome === 'failed' ? { outcome: 'failed', provider: 'aws', error_code: 'x' } : over.outcome === 'opted_out' ? { outcome: 'opted_out', provider: 'aws' } : { outcome: 'sent', provider: 'aws', provider_message_id: 'm' })),
  };
}

function service(over: { state?: unknown; owner?: boolean; kind?: string; start?: unknown; check?: unknown; sms?: ReturnType<typeof port> | null } = {}) {
  const state = over.state === undefined ? { step_up_required: true, phone_verified_at: null, phone_e164: '+14155550167' } : over.state;
  const risk = {
    riskStateOf: vi.fn(async () => state),
    startPhoneStepUpCode: vi.fn(async (_t: string, phone: string) => over.start ?? { ok: true, code: '123456', phone_e164: phone }),
    verifyPhoneStepUpCode: vi.fn(async () => over.check ?? { outcome: 'ok', view: {} }),
    flagForReview: vi.fn(async () => ({})),
  };
  const tenants = { findById: vi.fn(async () => ({ id: 't-1', kind: over.kind ?? 'PERSONAL' })) };
  const repo = { findMembership: vi.fn(async () => ({ id: 'm-1', is_active: true })) };
  const identity = { findRoleKeysForMembership: vi.fn(async () => (over.owner === false ? ['member'] : ['tenant_owner'])) };
  const sms = over.sms === null ? undefined : (over.sms ?? port());
  const svc = new SenderPhoneStepUpService(risk as never, tenants as never, repo as never, identity as never, sms as never);
  return { svc, risk, sms };
}

describe('SIGN-FREE-PARITY-1 S2 — self-serve phone step-up', () => {
  beforeEach(() => {
    process.env['SIGN_SENDER_PHONE_STEP_UP'] = '1';
  });
  afterEach(() => {
    delete process.env['SIGN_SENDER_PHONE_STEP_UP'];
  });

  it('the switch is on only when exactly 1', () => {
    expect(senderPhoneStepUpEnabled({})).toBe(false);
    expect(senderPhoneStepUpEnabled({ SIGN_SENDER_PHONE_STEP_UP: 'true' })).toBe(false);
    expect(senderPhoneStepUpEnabled({ SIGN_SENDER_PHONE_STEP_UP: '1' })).toBe(true);
  });

  it('availability: switch on, an SMS provider, and one that serves the number', () => {
    const { svc } = service();
    expect(svc.smsAvailable('+14155550167')).toBe(true);
    expect(svc.smsAvailable(null)).toBe(true);
    expect(svc.smsAvailable('+919876543210')).toBe(false); // no MSG91 in this port
    expect(svc.smsAvailable('+14155550167', {})).toBe(false); // switch off
    expect(service({ sms: port({ channels: [] }) }).svc.smsAvailable('+14155550167')).toBe(false);
    expect(service({ sms: null }).svc.smsAvailable('+14155550167')).toBe(false);
  });

  it('status masks the number and reports the outstanding step', async () => {
    await expect(service().svc.status(AUTH)).resolves.toEqual({ available: true, required: true, phone_masked: '+1••••••••67' });
    delete process.env['SIGN_SENDER_PHONE_STEP_UP'];
    await expect(service().svc.status(AUTH)).resolves.toMatchObject({ available: false });
    await expect(service({ kind: 'BUSINESS' }).svc.status(AUTH)).resolves.toEqual({ available: false, required: false, phone_masked: null });
  });

  it('send texts the code (purpose OTP) to the number on file and never returns it', async () => {
    const { svc, sms, risk } = service();
    const r = await svc.send(AUTH, {}, 'r');
    expect(r).toEqual({ sent: true, phone_masked: '+1••••••••67', expires_in_seconds: 600, resend_after_seconds: 60 });
    expect(JSON.stringify(r)).not.toContain('123456');
    expect(risk.startPhoneStepUpCode).toHaveBeenCalledWith('t-1', '+14155550167', expect.any(Date));
    expect(sms?.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'SMS', purpose: 'OTP', to_e164: '+14155550167', variables: { code: '123456', ttl_minutes: 10 } }));
  });

  it('send: an entered number follows the signup country rules; none on file needs one', async () => {
    await expect(service().svc.send(AUTH, { phone: '+1 (415) 555-0199' }, 'r')).resolves.toMatchObject({ phone_masked: '+1••••••••99' });
    await expect(service().svc.send(AUTH, { phone: '+44 20 7946 0958' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'personal_location_not_supported' } } });
    await expect(service().svc.send(AUTH, { phone: 'abc' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'invalid_phone' } } });
    await expect(service({ state: { step_up_required: true, phone_verified_at: null, phone_e164: null } }).svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ context: { details: { reason: 'phone_required' } } });
  });

  it('send: no provider for the number falls back to manual review', async () => {
    const { svc, risk } = service();
    await expect(svc.send(AUTH, { phone: '+919876543210' }, 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'personal_review_pending' } } });
    expect(risk.flagForReview).toHaveBeenCalledWith('t-1', 'step_up_phone_unavailable', expect.any(Date), { step_up_self_serve: true });
  });

  it('send refusals: rate limit, number in use, opted out, provider failure, switch off, not owner, nothing owed', async () => {
    await expect(service({ start: { ok: false, reason: 'personal_code_rate_limited' } }).svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ context: { details: { reason: 'personal_code_rate_limited' } } });
    await expect(service({ start: { ok: false, reason: 'phone_in_use' } }).svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ context: { details: { reason: 'phone_in_use' } } });
    await expect(service({ sms: port({ outcome: 'opted_out' }) }).svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ context: { details: { reason: 'phone_opted_out' } } });
    await expect(service({ sms: port({ outcome: 'failed' }) }).svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ statusCode: 503, context: { details: { reason: 'step_up_sms_not_sent' } } });
    await expect(service({ owner: false }).svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'step_up_owner_only' } } });
    await expect(service({ state: { step_up_required: true, phone_verified_at: new Date(), phone_e164: '+14155550167' } }).svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ context: { details: { reason: 'step_up_not_required' } } });
    delete process.env['SIGN_SENDER_PHONE_STEP_UP'];
    await expect(service().svc.send(AUTH, {}, 'r')).rejects.toMatchObject({ statusCode: 404, context: { details: { reason: 'step_up_not_available' } } });
  });

  it('verify maps the code check outcomes', async () => {
    await expect(service().svc.verify(AUTH, { code: '123456' }, 'r')).resolves.toEqual({ verified: true });
    await expect(service({ check: { outcome: 'mismatch', attempts_remaining: 3 } }).svc.verify(AUTH, { code: '000000' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'code_invalid', attempts_remaining: 3 } } });
    await expect(service({ check: { outcome: 'exhausted' } }).svc.verify(AUTH, { code: '000000' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'code_attempts_exceeded' } } });
    await expect(service({ check: { outcome: 'expired' } }).svc.verify(AUTH, { code: '000000' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'code_expired' } } });
  });
});

describe('SIGN-FREE-PARITY-1 S2 — the send gate', () => {
  function gate(stepUp: SenderPhoneStepUpService | undefined, phone_e164: string | null = '+14155550167') {
    process.env['SIGN_PERSONAL_SIGNUP_MODE'] = 'invite';
    const risk = {
      assertPersonalSendAllowed: vi.fn(async () => ({ ok: true })),
      riskStateOf: vi.fn(async () => ({ phone_verified_at: null, step_up_cleared_by: null, phone_e164 })),
      requireStepUp: vi.fn(async () => ({ state: 'clear', review_pending: false, step_up_required: true })),
      flagForReview: vi.fn(async () => ({})),
    };
    const free = { ensure: vi.fn(async () => ({ ok: true, opened: false })) };
    const allowance = { getStatus: vi.fn(async () => ({ subscribed: true, remaining: 5, daily: { remaining: 2 } })) };
    const geo = { lookup: vi.fn(async (_ip: string, now: Date = new Date()) => ({ country: 'US', network_kind: 'residential', looked_up_at: now.toISOString(), db_version: null })) };
    const repo = { countByStatus: vi.fn(async () => ({})) };
    const g = new PersonalSendGate(free as never, allowance as never, risk as never, geo as never, repo as never, undefined, stepUp);
    return { g, risk };
  }
  const input = { subject: 'Lease', document_titles: ['lease'], sender_name: 'Pat Example', recipient_count: 2, pdfs: async () => [] };

  afterEach(() => {
    delete process.env['SIGN_SENDER_PHONE_STEP_UP'];
  });

  it('switch off: the step-up call is exactly today’s (identity routes it to review without SMS)', async () => {
    const { g, risk } = gate(service().svc);
    await expect(g.assertMaySend(tenant(), '198.51.100.1', input, 'r')).rejects.toMatchObject({ context: { details: { reason: 'phone_verification_required' } } });
    expect(risk.requireStepUp).toHaveBeenCalledWith('t-1', 'young_account_first_send_several_recipients', expect.any(Date));
  });

  it('switch on with a provider for the number: the step stays with the sender (not review)', async () => {
    process.env['SIGN_SENDER_PHONE_STEP_UP'] = '1';
    const { g, risk } = gate(service().svc);
    await expect(g.assertMaySend(tenant(), '198.51.100.1', input, 'r')).rejects.toMatchObject({ context: { details: { reason: 'phone_verification_required' } } });
    expect(risk.requireStepUp).toHaveBeenCalledWith('t-1', 'young_account_first_send_several_recipients', expect.any(Date), { self_serve: true }, { sms_available: true });
  });

  it('switch on, no provider for the number (+91 without MSG91): today’s call, review fallback', async () => {
    process.env['SIGN_SENDER_PHONE_STEP_UP'] = '1';
    const { g, risk } = gate(service().svc, '+919876543210');
    await expect(g.assertMaySend(tenant(), '198.51.100.1', input, 'r')).rejects.toBeDefined();
    expect(risk.requireStepUp).toHaveBeenCalledWith('t-1', 'young_account_first_send_several_recipients', expect.any(Date));
  });
});
