import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import type { LedgerAppend, RecipientMessagingRow, SessionContext, SignMessagingRepository, SigningNotification, SigningNotificationPort } from '@aramo/sign';

import { RecipientOtpService } from '../app/messaging/recipient-otp.service.js';
import type { SignMessagingService } from '../app/messaging/sign-messaging.service.js';
import { renderEmail, renderSigningNotification } from '../app/mailer-signing-notification.adapter.js';
import { SIGN_EMAIL_OTP_FEATURE } from '../app/sign-feature.gate.js';

// SIGN-FREE-PARITY-1 S3 — the email one-time code for signers (all plans): the SMS code's
// rules and limits, its own challenges (method EMAIL_OTP), the masked address only, and the
// code only in the email body. A signer asked for both codes enters SMS, then email.

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENVELOPE = '22222222-2222-7222-8222-222222222222';
const SIGNER = '33333333-3333-7333-8333-333333333333';
const SESSION = '44444444-4444-7444-8444-444444444444';
const ctx: SessionContext = { session_id: SESSION, tenant_id: TENANT, envelope_id: ENVELOPE, signer_id: SIGNER };

type Challenge = {
  id: string;
  signer_id: string;
  session_id: string;
  method: string;
  phone_masked: string | null;
  email_masked: string | null;
  code_hash: string;
  status: string;
  attempts: number;
  expires_at: Date;
  created_at: Date;
};

class FakeRepo {
  challenges: Challenge[] = [];
  ledger: LedgerAppend[] = [];
  sms: RecipientMessagingRow | null = null;
  email: { envelope_id: string; name: string; email: string | null; email_otp_required: boolean; envelope_subject: string } | null = {
    envelope_id: ENVELOPE,
    name: 'Jane Doe',
    email: 'jane@example.com',
    email_otp_required: true,
    envelope_subject: 'Please sign: Lease',
  };
  async settingFor() {
    return this.sms;
  }
  async emailOtpSetting() {
    return this.email;
  }
  async otpHistory(_t: string, signer_id: string, since: Date, method = 'SMS_OTP') {
    return this.challenges.filter((c) => c.signer_id === signer_id && c.method === method && c.created_at >= since).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }
  async lockedChallengeCount(_t: string, _e: string, _s: string, method = 'SMS_OTP') {
    return this.challenges.filter((c) => c.method === method && c.status === 'LOCKED').length;
  }
  async activeChallenge(_t: string, session_id: string, method = 'SMS_OTP') {
    return [...this.challenges].reverse().find((c) => c.session_id === session_id && c.method === method && c.status === 'ACTIVE') ?? null;
  }
  async isSessionVerified(_t: string, session_id: string, method = 'SMS_OTP') {
    return this.challenges.some((c) => c.session_id === session_id && c.method === method && c.status === 'VERIFIED');
  }
  async createChallenge(i: { id: string; signer_id: string; session_id: string; method?: string; phone_masked?: string | null; email_masked?: string | null; code_hash: string; expires_at: Date; now: Date }) {
    const method = i.method ?? 'SMS_OTP';
    for (const c of this.challenges) if (c.signer_id === i.signer_id && c.method === method && c.status === 'ACTIVE') c.status = 'SUPERSEDED';
    this.challenges.push({
      id: i.id,
      signer_id: i.signer_id,
      session_id: i.session_id,
      method,
      phone_masked: i.phone_masked ?? null,
      email_masked: i.email_masked ?? null,
      code_hash: i.code_hash,
      status: 'ACTIVE',
      attempts: 0,
      expires_at: i.expires_at,
      created_at: i.now,
    });
  }
  async withdrawChallenge(id: string) {
    const c = this.challenges.find((x) => x.id === id);
    if (c?.status === 'ACTIVE') c.status = 'SUPERSEDED';
  }
  async recordOtpAttempt(i: { challenge_id: string; expected_attempts: number; outcome: string; ledger: LedgerAppend[] }) {
    const c = this.challenges.find((x) => x.id === i.challenge_id);
    if (c === undefined || c.status !== 'ACTIVE') return false;
    if (i.outcome !== 'EXPIRED' && c.attempts !== i.expected_attempts) return false;
    if (i.outcome !== 'EXPIRED') c.attempts += 1;
    if (i.outcome === 'VERIFIED') c.status = 'VERIFIED';
    if (i.outcome === 'LOCKED') c.status = 'LOCKED';
    if (i.outcome === 'EXPIRED') c.status = 'EXPIRED';
    this.ledger.push(...i.ledger);
    return true;
  }
  async appendLedger(_t: string, _e: string, _s: string | null, events: LedgerAppend[]) {
    this.ledger.push(...events);
    return true;
  }
}

class FakeMailer implements SigningNotificationPort {
  sent: SigningNotification[] = [];
  fail = false;
  async notify(n: SigningNotification) {
    if (this.fail) throw new Error('ses down');
    this.sent.push(n);
    return { delivered: true };
  }
}

function setup() {
  const repo = new FakeRepo();
  const mailer = new FakeMailer();
  const sms = { sendOneTimeCode: vi.fn(async () => ({ status: 'SENT', delivery_id: 'd1' })) };
  const otp = new RecipientOtpService(repo as unknown as SignMessagingRepository, sms as unknown as SignMessagingService, mailer);
  const lastCode = () => mailer.sent.at(-1)?.one_time_code ?? '';
  return { repo, mailer, sms, otp, lastCode };
}

async function reason(p: Promise<unknown>): Promise<{ status: number; reason: unknown; details: Record<string, unknown>; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as AramoError;
    const details = (err.context?.details ?? {}) as Record<string, unknown>;
    return { status: err.statusCode, reason: details['reason'], details, message: err.message };
  }
  throw new Error('expected a refusal');
}

describe('sign.email_otp — launch switch', () => {
  it('is AVAILABLE on every plan (FP-R4)', () => {
    expect(SIGN_EMAIL_OTP_FEATURE).toBe('sign.email_otp');
    expect(FEATURE_AVAILABILITY['sign.email_otp']).toBe('AVAILABLE');
  });
});

describe('RecipientOtpService — email one-time code (S3)', () => {
  it('the gate names the email code and the masked address until it is verified', async () => {
    const { repo, otp, mailer, lastCode } = setup();
    expect(await otp.status(ctx)).toEqual({ required: true, method: 'EMAIL_OTP', verified: false, locked: false, phone: null, email: 'j***@example.com' });
    const gate = await reason(otp.assertVerified(ctx, 'r'));
    expect(gate).toMatchObject({ status: 403, reason: 'recipient_verification_required', message: 'Enter the code sent to your email to continue' });
    expect(gate.details).toMatchObject({ method: 'EMAIL_OTP', email: 'j***@example.com' });

    const sent = await otp.send(ctx, 'r', new Date(), 'EMAIL_OTP');
    expect(sent).toMatchObject({ sent: true, verified: false, email: 'j***@example.com' });
    expect(mailer.sent[0]).toMatchObject({ kind: 'SIGNER_EMAIL_CODE', to_email: 'jane@example.com', to_name: 'Jane Doe', code_ttl_minutes: 10 });
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(repo.challenges[0]).toMatchObject({ method: 'EMAIL_OTP', email_masked: 'j***@example.com', phone_masked: null });
    expect(repo.challenges[0]?.code_hash).not.toContain(lastCode());
    expect(JSON.stringify(repo.ledger)).not.toContain(lastCode());
    expect(JSON.stringify(sent)).not.toContain(lastCode());

    const wrong = lastCode() === '000000' ? '111111' : '000000';
    expect((await reason(otp.verify(ctx, wrong, 'r', new Date(), 'EMAIL_OTP'))).details).toMatchObject({ reason: 'otp_mismatch', attempts_remaining: 4 });
    expect(await otp.verify(ctx, lastCode(), 'r', new Date(), 'EMAIL_OTP')).toEqual({ verified: true });
    await expect(otp.assertVerified(ctx, 'r')).resolves.toBeUndefined();
    expect(repo.ledger.map((e) => e.event_type)).toEqual(['RECIPIENT_OTP_SENT', 'RECIPIENT_OTP_FAILED', 'RECIPIENT_OTP_VERIFIED']);
    expect(repo.ledger[2]?.payload).toMatchObject({ method: 'EMAIL_OTP', email: 'j***@example.com' });
  });

  it('a phone code never verifies the email requirement (codes are bound to their method)', async () => {
    const { otp, lastCode } = setup();
    await otp.send(ctx, 'r', new Date(), 'EMAIL_OTP');
    // Checked as an SMS code, the email code finds no SMS challenge.
    expect((await reason(otp.verify(ctx, lastCode(), 'r', new Date(), 'SMS_OTP'))).reason).toBe('otp_not_requested');
    expect((await reason(otp.send(ctx, 'r', new Date(), 'SMS_OTP'))).reason).toBe('otp_not_required');
  });

  it('reuses the limits: resend gap, five wrong codes lock a code, three locked codes lock the recipient out', async () => {
    const { repo, otp, lastCode } = setup();
    await otp.send(ctx, 'r', new Date(), 'EMAIL_OTP');
    expect((await reason(otp.send(ctx, 'r', new Date(), 'EMAIL_OTP'))).reason).toBe('otp_resend_cooldown');
    for (let round = 1; round <= 3; round += 1) {
      for (const c of repo.challenges) c.created_at = new Date(c.created_at.getTime() - 120_000);
      if (round > 1) await otp.send(ctx, 'r', new Date(), 'EMAIL_OTP');
      const wrong = lastCode() === '000000' ? '111111' : '000000';
      for (let i = 1; i <= 4; i += 1) expect((await reason(otp.verify(ctx, wrong, 'r', new Date(), 'EMAIL_OTP'))).reason).toBe('otp_mismatch');
      expect((await reason(otp.verify(ctx, wrong, 'r', new Date(), 'EMAIL_OTP'))).reason).toBe(round < 3 ? 'otp_code_locked' : 'otp_locked');
    }
    expect(repo.ledger.filter((e) => e.event_type === 'RECIPIENT_OTP_LOCKED')).toHaveLength(1);
    expect((await reason(otp.assertVerified(ctx, 'r'))).reason).toBe('recipient_verification_locked');
  });

  it('an email that cannot be sent is withdrawn and refused (503 otp_delivery_failed)', async () => {
    const { repo, otp, mailer } = setup();
    mailer.fail = true;
    const r = await reason(otp.send(ctx, 'r', new Date(), 'EMAIL_OTP'));
    expect(r).toMatchObject({ status: 503, reason: 'otp_delivery_failed', message: 'The code could not be sent to your email' });
    expect(repo.challenges[0]?.status).toBe('SUPERSEDED');
    expect(repo.ledger).toHaveLength(0);
  });

  it('no email code without the sender asking, or without an email', async () => {
    const { repo, otp } = setup();
    repo.email = { ...repo.email!, email_otp_required: false };
    expect(await otp.status(ctx)).toMatchObject({ required: false });
    repo.email = { ...repo.email!, email_otp_required: true, email: null };
    expect(await otp.status(ctx)).toMatchObject({ required: false });
  });

  it('both codes asked: SMS first, then email; the session is verified only when both are', async () => {
    const { repo, otp, sms, lastCode } = setup();
    const now = new Date();
    repo.sms = { signer_id: SIGNER, tenant_id: TENANT, envelope_id: ENVELOPE, delivery_channel: null, phone_e164: '+14155550123', timezone: null, sms_otp_required: true, updated_by: SIGNER, created_at: now, updated_at: now };
    expect(await otp.status(ctx)).toMatchObject({ method: 'SMS_OTP', verified: false, phone: `+1${'•'.repeat(8)}23`, email: 'j***@example.com' });
    await otp.send(ctx, 'r');
    const smsCode = (sms.sendOneTimeCode.mock.calls[0] as unknown as [{ code: string }])[0].code;
    expect(await otp.verify(ctx, smsCode, 'r')).toEqual({ verified: true });
    // The SMS code alone does not open the document.
    const gate = await reason(otp.assertVerified(ctx, 'r'));
    expect(gate.details).toMatchObject({ reason: 'recipient_verification_required', method: 'EMAIL_OTP' });
    await otp.send(ctx, 'r', new Date(), 'EMAIL_OTP');
    expect(await otp.verify(ctx, lastCode(), 'r', new Date(), 'EMAIL_OTP')).toEqual({ verified: true });
    expect(await otp.status(ctx)).toMatchObject({ required: true, verified: true });
    await expect(otp.assertVerified(ctx, 'r')).resolves.toBeUndefined();
  });

  it('no mailer bound ⇒ the code cannot be sent (never skipped)', async () => {
    const repo = new FakeRepo();
    const otp = new RecipientOtpService(repo as unknown as SignMessagingRepository, {} as SignMessagingService);
    expect((await reason(otp.send(ctx, 'r', new Date(), 'EMAIL_OTP'))).reason).toBe('otp_delivery_failed');
    expect((await reason(otp.assertVerified(ctx, 'r'))).reason).toBe('recipient_verification_required');
  });
});

describe('SIGNER_EMAIL_CODE email', () => {
  it('carries the code in the body only, never in the subject (mailers log the subject)', () => {
    const n: SigningNotification = { kind: 'SIGNER_EMAIL_CODE', to_email: 'jane@example.com', to_name: 'Jane', envelope_subject: 'Please sign: Lease', one_time_code: '482913', code_ttl_minutes: 10 };
    const r = renderSigningNotification(n, { report_url: 'https://sign.example/report#token=x' });
    expect(r.subject).toBe('Your code to sign Lease');
    expect(r.subject).not.toContain('482913');
    expect(r.report).toBeUndefined();
    const { html, text } = renderEmail(n, r);
    expect(text).toContain('Your code to open "Lease" is 482913.');
    expect(text).toContain('It works for 10 minutes.');
    expect(html).toContain('482913');
  });
});
