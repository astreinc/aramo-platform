import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  PERSONAL_OTP_MAX_ATTEMPTS,
  PERSONAL_OTP_MAX_SENDS_PER_DAY,
  PERSONAL_OTP_RESEND_GAP_MS,
  PERSONAL_OTP_TTL_MS,
  checkPersonalOtp,
  generatePersonalOtp,
  hashPersonalOtp,
  mayResendPersonalOtp,
} from '@aramo/identity';
import {
  OTP_MAX_LOCKED_CHALLENGES,
  RECIPIENT_OTP_FAILED_EVENT,
  RECIPIENT_OTP_LOCKED_EVENT,
  RECIPIENT_OTP_SENT_EVENT,
  RECIPIENT_OTP_VERIFIED_EVENT,
  SMS_OTP_METHOD,
  SignMessagingRepository,
  maskPhone,
  phoneHash,
  type LedgerAppend,
  type SessionContext,
} from '@aramo/sign';

import { SignMessagingService } from './sign-messaging.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.9 — SMS one-time-code recipient
// verification (Amendment A1: dark). The sender sets SMS_OTP on a recipient
// (sms_otp_required, feature sign.sms_otp). Before the recipient can open, read, accept,
// fill, finish or decline, their signing session must hold a VERIFIED code:
//
//   - codes reuse the Personal OTP rules (@aramo/identity personal-otp): 6 digits, valid
//     10 minutes, 5 attempts per code, 60 s between sends, 5 sends a day. Aramo generates
//     the code and keeps only its SHA-256, bound to the challenge id;
//   - lockout: a code whose attempts are used up is LOCKED; after OTP_MAX_LOCKED_CHALLENGES
//     locked codes the recipient is locked out of the envelope (RECIPIENT_OTP_LOCKED);
//   - every send, failure, lockout and success is a ledger event, and the success is
//     printed on the certificate of completion (masked number only);
//   - verification is bound to the signing session: a new link (reminder) asks again.
//
// The requirement is enforced whenever the sender set it, even if the feature is later
// switched off (fail closed: the sender's protection is never silently dropped).

export interface OtpStatus {
  required: boolean;
  method: typeof SMS_OTP_METHOD | null;
  verified: boolean;
  locked: boolean;
  phone: string | null;
}

type RefusalCode = 'VALIDATION_ERROR' | 'INSUFFICIENT_PERMISSIONS' | 'INVALID_REQUEST' | 'ESIGN_SEND_UNAVAILABLE';

function refuse(code: RefusalCode, status: number, message: string, requestId: string, details: Record<string, unknown>): AramoError {
  return new AramoError(code, message, status, { requestId, details });
}

const LOCKED_MESSAGE = 'Too many incorrect codes. Ask the sender to send the document again.';

@Injectable()
export class RecipientOtpService {
  constructor(
    private readonly repo: SignMessagingRepository,
    private readonly messaging: SignMessagingService,
  ) {}

  async status(ctx: SessionContext): Promise<OtpStatus> {
    const setting = await this.repo.settingFor(ctx.tenant_id, ctx.signer_id);
    if (setting === null || !setting.sms_otp_required || setting.envelope_id !== ctx.envelope_id) {
      return { required: false, method: null, verified: false, locked: false, phone: null };
    }
    const [verified, locked] = await Promise.all([
      this.repo.isSessionVerified(ctx.tenant_id, ctx.session_id),
      this.repo.lockedChallengeCount(ctx.tenant_id, ctx.envelope_id, ctx.signer_id),
    ]);
    return { required: true, method: SMS_OTP_METHOD, verified, locked: !verified && locked >= OTP_MAX_LOCKED_CHALLENGES, phone: maskPhone(setting.phone_e164) };
  }

  /** The gate in front of every signer action. Throws 403 recipient_verification_required. */
  async assertVerified(ctx: SessionContext, requestId: string): Promise<void> {
    const s = await this.status(ctx);
    if (!s.required || s.verified) return;
    throw refuse('INSUFFICIENT_PERMISSIONS', 403, 'Enter the code sent to your phone to continue', requestId, {
      reason: s.locked ? 'recipient_verification_locked' : 'recipient_verification_required',
      method: SMS_OTP_METHOD,
      phone: s.phone,
    });
  }

  async send(ctx: SessionContext, requestId: string, now: Date = new Date()) {
    const setting = await this.repo.settingFor(ctx.tenant_id, ctx.signer_id);
    if (setting === null || !setting.sms_otp_required || setting.envelope_id !== ctx.envelope_id) {
      throw refuse('VALIDATION_ERROR', 400, 'This recipient does not use a phone code', requestId, { reason: 'otp_not_required' });
    }
    const phone = maskPhone(setting.phone_e164);
    if (await this.repo.isSessionVerified(ctx.tenant_id, ctx.session_id)) return { sent: false, verified: true, phone, expires_at: null, resend_after_seconds: 0 };
    if ((await this.repo.lockedChallengeCount(ctx.tenant_id, ctx.envelope_id, ctx.signer_id)) >= OTP_MAX_LOCKED_CHALLENGES) {
      throw refuse('INSUFFICIENT_PERMISSIONS', 403, LOCKED_MESSAGE, requestId, { reason: 'otp_locked' });
    }
    const history = await this.repo.otpHistory(ctx.tenant_id, ctx.signer_id, new Date(now.getTime() - 86_400_000));
    const last = history[0]?.created_at ?? null;
    if (!mayResendPersonalOtp({ last_sent_at: last, sends_last_24h: history.length, now })) {
      const cooldown = last !== null && history.length < PERSONAL_OTP_MAX_SENDS_PER_DAY;
      const retryAt = cooldown && last !== null ? new Date(last.getTime() + PERSONAL_OTP_RESEND_GAP_MS) : null;
      throw refuse('INVALID_REQUEST', 429, 'Please wait before asking for another code', requestId, {
        reason: retryAt !== null ? 'otp_resend_cooldown' : 'otp_daily_limit',
        ...(retryAt !== null ? { retry_after_seconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)), retry_at: retryAt.toISOString() } : {}),
      });
    }

    const id = randomUUID();
    const code = generatePersonalOtp();
    const expires_at = new Date(now.getTime() + PERSONAL_OTP_TTL_MS);
    await this.repo.createChallenge({
      id,
      tenant_id: ctx.tenant_id,
      envelope_id: ctx.envelope_id,
      signer_id: ctx.signer_id,
      session_id: ctx.session_id,
      phone_hash: phoneHash(setting.phone_e164),
      phone_masked: phone,
      code_hash: hashPersonalOtp(id, 'phone', code),
      expires_at,
      now,
    });
    const out = await this.messaging.sendOneTimeCode({
      tenant_id: ctx.tenant_id,
      envelope_id: ctx.envelope_id,
      signer_id: ctx.signer_id,
      to_e164: setting.phone_e164,
      code,
      ttl_minutes: Math.round(PERSONAL_OTP_TTL_MS / 60_000),
    });
    if (out.status !== 'SENT') {
      await this.repo.withdrawChallenge(id);
      const reason = out.status === 'SUPPRESSED' ? `otp_${out.reason}` : 'otp_delivery_failed';
      const status = out.status === 'SUPPRESSED' && out.reason === 'opted_out' ? 409 : 503;
      throw refuse('ESIGN_SEND_UNAVAILABLE', status, 'The code could not be sent to your phone', requestId, { reason });
    }
    await this.repo.appendLedger(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, [
      { event_type: RECIPIENT_OTP_SENT_EVENT, actor_type: 'SIGNER', actor_ref: ctx.signer_id, payload: { method: SMS_OTP_METHOD, phone, challenge_id: id, delivery_id: out.delivery_id } },
    ]);
    return { sent: true, verified: false, phone, expires_at: expires_at.toISOString(), resend_after_seconds: Math.round(PERSONAL_OTP_RESEND_GAP_MS / 1000) };
  }

  async verify(ctx: SessionContext, code: unknown, requestId: string, now: Date = new Date()): Promise<{ verified: true }> {
    if (await this.repo.isSessionVerified(ctx.tenant_id, ctx.session_id)) return { verified: true };
    const challenge = await this.repo.activeChallenge(ctx.tenant_id, ctx.session_id);
    if (challenge === null) throw refuse('VALIDATION_ERROR', 400, 'Ask for a code first', requestId, { reason: 'otp_not_requested' });
    const check = checkPersonalOtp({ hash: challenge.code_hash, expires_at: challenge.expires_at, attempts: challenge.attempts }, challenge.id, 'phone', code, now);
    const base = { method: SMS_OTP_METHOD, phone: challenge.phone_masked, challenge_id: challenge.id };
    const actor = { actor_type: 'SIGNER' as const, actor_ref: ctx.signer_id };
    const record = (outcome: 'VERIFIED' | 'MISMATCH' | 'LOCKED' | 'EXPIRED', ledger: LedgerAppend[]) =>
      this.repo.recordOtpAttempt({
        challenge_id: challenge.id,
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        expected_attempts: challenge.attempts,
        outcome,
        now,
        ledger,
      });
    const conflict = () => refuse('VALIDATION_ERROR', 409, 'Please try again', requestId, { reason: 'otp_retry' });

    if (check === 'ok') {
      if (!(await record('VERIFIED', [{ event_type: RECIPIENT_OTP_VERIFIED_EVENT, ...actor, payload: base }]))) throw conflict();
      return { verified: true };
    }
    if (check === 'expired' || check === 'none') {
      if (check === 'expired') await record('EXPIRED', []);
      throw refuse('VALIDATION_ERROR', 400, 'This code has expired. Ask for a new one.', requestId, { reason: 'otp_expired' });
    }
    // mismatch (an ACTIVE challenge is never 'exhausted': it is LOCKED on the last attempt)
    const attempts = challenge.attempts + 1;
    const exhausted = attempts >= PERSONAL_OTP_MAX_ATTEMPTS;
    const ledger: LedgerAppend[] = [{ event_type: RECIPIENT_OTP_FAILED_EVENT, ...actor, payload: { ...base, attempts, code_locked: exhausted } }];
    if (exhausted) {
      const lockedAfter = (await this.repo.lockedChallengeCount(ctx.tenant_id, ctx.envelope_id, ctx.signer_id)) + 1;
      const lockedOut = lockedAfter >= OTP_MAX_LOCKED_CHALLENGES;
      if (lockedOut) ledger.push({ event_type: RECIPIENT_OTP_LOCKED_EVENT, ...actor, payload: { method: SMS_OTP_METHOD, locked_codes: lockedAfter } });
      if (!(await record('LOCKED', ledger))) throw conflict();
      throw refuse('INSUFFICIENT_PERMISSIONS', 403, lockedOut ? LOCKED_MESSAGE : 'Too many incorrect codes. Ask for a new one.', requestId, {
        reason: lockedOut ? 'otp_locked' : 'otp_code_locked',
      });
    }
    if (!(await record('MISMATCH', ledger))) throw conflict();
    throw refuse('VALIDATION_ERROR', 400, 'That code is not correct', requestId, { reason: 'otp_mismatch', attempts_remaining: PERSONAL_OTP_MAX_ATTEMPTS - attempts });
  }
}
