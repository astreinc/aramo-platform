import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
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
  EMAIL_OTP_METHOD,
  OTP_MAX_LOCKED_CHALLENGES,
  RECIPIENT_OTP_FAILED_EVENT,
  RECIPIENT_OTP_LOCKED_EVENT,
  RECIPIENT_OTP_SENT_EVENT,
  RECIPIENT_OTP_VERIFIED_EVENT,
  SIGNING_NOTIFICATION_PORT,
  SMS_OTP_METHOD,
  SignMessagingRepository,
  maskOtpEmail,
  maskPhone,
  phoneHash,
  type LedgerAppend,
  type RecipientOtpMethod,
  type SessionContext,
  type SigningNotificationPort,
} from '@aramo/sign';

import { SignMessagingService } from './sign-messaging.service.js';
import { SmsConsentFacts } from './sms-consent-rules.js';

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
//
// SIGN-FREE-PARITY-1 S3 — the same check with a code sent to the recipient's email
// (Signer.email_otp_required, feature sign.email_otp, all plans): the same limits, its own
// challenges (method EMAIL_OTP, bound with hashPersonalOtp(id, 'email', code)), the masked
// address only (j***@example.com). Rule: a recipient who must enter both codes enters the
// SMS code first, then the email code; the session is verified only when both are.
//
// SMS-CONSENT-1 R-5 / R-6 — the SMS code goes to the signer's own consented number when the
// signer's email belongs to an Aramo user with active consent (else the sender-typed number), with
// the signer code text (ends with STOP). The signer is shown the number the code goes to; the
// ledger and the certificate (sender-visible) keep the sender-typed number's mask, so the sender
// is never told whether such an account or number exists.

export interface OtpStatus {
  required: boolean;
  /** The code still to enter (SMS before email), or the first required one once all are verified. */
  method: RecipientOtpMethod | null;
  verified: boolean;
  locked: boolean;
  phone: string | null;
  /** SIGN-FREE-PARITY-1 S3 — the masked email an email code goes to. */
  email: string | null;
}

type RefusalCode = 'VALIDATION_ERROR' | 'INSUFFICIENT_PERMISSIONS' | 'INVALID_REQUEST' | 'ESIGN_SEND_UNAVAILABLE';

function refuse(code: RefusalCode, status: number, message: string, requestId: string, details: Record<string, unknown>): AramoError {
  return new AramoError(code, message, status, { requestId, details });
}

const LOCKED_MESSAGE = 'Too many incorrect codes. Ask the sender to send the document again.';

type Delivered = { ok: true; delivery_id?: string } | { ok: false; status: number; reason: string };

// One required code: where it goes (masked) and how it is delivered.
interface RequiredCode {
  method: RecipientOtpMethod;
  /** Shown to the signer: where the code goes. */
  masked: string;
  /** Written to the ledger (sender-visible): for an SMS code, the sender-typed number's mask. */
  ledgerMasked: string;
  /** The hashPersonalOtp channel the code hash is bound to. */
  channel: 'phone' | 'email';
  challengeFields: { phone_hash?: string; phone_masked?: string; email_masked?: string };
  deliver: (code: string, ttl_minutes: number) => Promise<Delivered>;
}

@Injectable()
export class RecipientOtpService {
  constructor(
    private readonly repo: SignMessagingRepository,
    private readonly messaging: SignMessagingService,
    // SIGN-FREE-PARITY-1 S3 — the email code goes out through the signing-notification mailer.
    // Unbound ⇒ an email code cannot be sent (503), never skipped.
    @Optional() @Inject(SIGNING_NOTIFICATION_PORT) private readonly notifier?: SigningNotificationPort,
    // SMS-CONSENT-1 R-5 — the signer's own consented number (absent ⇒ the sender-typed number).
    @Optional() private readonly consent?: SmsConsentFacts,
  ) {}

  // The codes the sender asked for, in the order the signer enters them: SMS, then email.
  private async requiredCodes(ctx: SessionContext): Promise<RequiredCode[]> {
    const [sms, email] = await Promise.all([this.repo.settingFor(ctx.tenant_id, ctx.signer_id), this.repo.emailOtpSetting(ctx.tenant_id, ctx.signer_id)]);
    const out: RequiredCode[] = [];
    if (sms !== null && sms.sms_otp_required && sms.envelope_id === ctx.envelope_id) {
      const to = (await this.consent?.consentedNumberOfSigner(ctx.tenant_id, ctx.signer_id)) ?? sms.phone_e164;
      const shown = maskPhone(sms.phone_e164);
      out.push({
        method: SMS_OTP_METHOD,
        masked: maskPhone(to),
        ledgerMasked: shown,
        channel: 'phone',
        challengeFields: { phone_hash: phoneHash(to), phone_masked: shown },
        deliver: async (code, ttl_minutes) => {
          const r = await this.messaging.sendOneTimeCode({
            tenant_id: ctx.tenant_id,
            envelope_id: ctx.envelope_id,
            signer_id: ctx.signer_id,
            to_e164: to,
            ...(to !== sms.phone_e164 ? { shown_e164: sms.phone_e164 } : {}),
            code,
            ttl_minutes,
          });
          if (r.status === 'SENT') return { ok: true, delivery_id: r.delivery_id };
          return {
            ok: false,
            reason: r.status === 'SUPPRESSED' ? `otp_${r.reason}` : 'otp_delivery_failed',
            status: r.status === 'SUPPRESSED' && r.reason === 'opted_out' ? 409 : 503,
          };
        },
      });
    }
    if (email !== null && email.email_otp_required && email.email !== null && email.envelope_id === ctx.envelope_id) {
      const to = email.email;
      const masked = maskOtpEmail(to);
      out.push({
        method: EMAIL_OTP_METHOD,
        masked,
        ledgerMasked: masked,
        channel: 'email',
        challengeFields: { email_masked: masked },
        deliver: async (code, ttl_minutes) => {
          if (this.notifier === undefined) return { ok: false, status: 503, reason: 'otp_delivery_failed' };
          try {
            // Only the email body carries the code; it is never logged or returned.
            await this.notifier.notify({
              kind: 'SIGNER_EMAIL_CODE',
              to_email: to,
              to_name: email.name,
              envelope_subject: email.envelope_subject,
              tenant_id: ctx.tenant_id,
              one_time_code: code,
              code_ttl_minutes: ttl_minutes,
            });
            return { ok: true };
          } catch {
            return { ok: false, status: 503, reason: 'otp_delivery_failed' };
          }
        },
      });
    }
    return out;
  }

  async status(ctx: SessionContext): Promise<OtpStatus> {
    const codes = await this.requiredCodes(ctx);
    if (codes.length === 0) return { required: false, method: null, verified: false, locked: false, phone: null, email: null };
    const states = await Promise.all(
      codes.map(async (c) => ({
        method: c.method,
        verified: await this.repo.isSessionVerified(ctx.tenant_id, ctx.session_id, c.method),
        locked: await this.repo.lockedChallengeCount(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, c.method),
      })),
    );
    const pending = states.find((s) => !s.verified);
    return {
      required: true,
      method: pending?.method ?? (codes[0] as RequiredCode).method,
      verified: pending === undefined,
      locked: pending !== undefined && pending.locked >= OTP_MAX_LOCKED_CHALLENGES,
      phone: codes.find((c) => c.method === SMS_OTP_METHOD)?.masked ?? null,
      email: codes.find((c) => c.method === EMAIL_OTP_METHOD)?.masked ?? null,
    };
  }

  /** The gate in front of every signer action. Throws 403 recipient_verification_required. */
  async assertVerified(ctx: SessionContext, requestId: string): Promise<void> {
    const s = await this.status(ctx);
    if (!s.required || s.verified) return;
    const byEmail = s.method === EMAIL_OTP_METHOD;
    throw refuse('INSUFFICIENT_PERMISSIONS', 403, byEmail ? 'Enter the code sent to your email to continue' : 'Enter the code sent to your phone to continue', requestId, {
      reason: s.locked ? 'recipient_verification_locked' : 'recipient_verification_required',
      method: s.method,
      ...(byEmail ? { email: s.email } : { phone: s.phone }),
    });
  }

  private async requiredCode(ctx: SessionContext, method: RecipientOtpMethod, requestId: string): Promise<RequiredCode> {
    const c = (await this.requiredCodes(ctx)).find((x) => x.method === method);
    if (c === undefined) {
      const message = method === EMAIL_OTP_METHOD ? 'This recipient does not use an email code' : 'This recipient does not use a phone code';
      throw refuse('VALIDATION_ERROR', 400, message, requestId, { reason: 'otp_not_required' });
    }
    return c;
  }

  async send(ctx: SessionContext, requestId: string, now: Date = new Date(), method: RecipientOtpMethod = SMS_OTP_METHOD) {
    const c = await this.requiredCode(ctx, method, requestId);
    const dest = method === EMAIL_OTP_METHOD ? { email: c.masked } : { phone: c.masked };
    if (await this.repo.isSessionVerified(ctx.tenant_id, ctx.session_id, method)) return { sent: false, verified: true, ...dest, expires_at: null, resend_after_seconds: 0 };
    if ((await this.repo.lockedChallengeCount(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, method)) >= OTP_MAX_LOCKED_CHALLENGES) {
      throw refuse('INSUFFICIENT_PERMISSIONS', 403, LOCKED_MESSAGE, requestId, { reason: 'otp_locked' });
    }
    const history = await this.repo.otpHistory(ctx.tenant_id, ctx.signer_id, new Date(now.getTime() - 86_400_000), method);
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
      method,
      ...c.challengeFields,
      code_hash: hashPersonalOtp(id, c.channel, code),
      expires_at,
      now,
    });
    const out = await c.deliver(code, Math.round(PERSONAL_OTP_TTL_MS / 60_000));
    if (!out.ok) {
      await this.repo.withdrawChallenge(id);
      const message = method === EMAIL_OTP_METHOD ? 'The code could not be sent to your email' : 'The code could not be sent to your phone';
      throw refuse('ESIGN_SEND_UNAVAILABLE', out.status, message, requestId, { reason: out.reason });
    }
    await this.repo.appendLedger(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, [
      {
        event_type: RECIPIENT_OTP_SENT_EVENT,
        actor_type: 'SIGNER',
        actor_ref: ctx.signer_id,
        payload: { method, ...(method === EMAIL_OTP_METHOD ? { email: c.ledgerMasked } : { phone: c.ledgerMasked }), challenge_id: id, ...(out.delivery_id !== undefined ? { delivery_id: out.delivery_id } : {}) },
      },
    ]);
    return { sent: true, verified: false, ...dest, expires_at: expires_at.toISOString(), resend_after_seconds: Math.round(PERSONAL_OTP_RESEND_GAP_MS / 1000) };
  }

  async verify(ctx: SessionContext, code: unknown, requestId: string, now: Date = new Date(), method: RecipientOtpMethod = SMS_OTP_METHOD): Promise<{ verified: true }> {
    if (await this.repo.isSessionVerified(ctx.tenant_id, ctx.session_id, method)) return { verified: true };
    const challenge = await this.repo.activeChallenge(ctx.tenant_id, ctx.session_id, method);
    if (challenge === null) throw refuse('VALIDATION_ERROR', 400, 'Ask for a code first', requestId, { reason: 'otp_not_requested' });
    const byEmail = method === EMAIL_OTP_METHOD;
    const check = checkPersonalOtp({ hash: challenge.code_hash, expires_at: challenge.expires_at, attempts: challenge.attempts }, challenge.id, byEmail ? 'email' : 'phone', code, now);
    const base = byEmail ? { method, email: challenge.email_masked ?? null, challenge_id: challenge.id } : { method, phone: challenge.phone_masked, challenge_id: challenge.id };
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
      const lockedAfter = (await this.repo.lockedChallengeCount(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, method)) + 1;
      const lockedOut = lockedAfter >= OTP_MAX_LOCKED_CHALLENGES;
      if (lockedOut) ledger.push({ event_type: RECIPIENT_OTP_LOCKED_EVENT, ...actor, payload: { method, locked_codes: lockedAfter } });
      if (!(await record('LOCKED', ledger))) throw conflict();
      throw refuse('INSUFFICIENT_PERMISSIONS', 403, lockedOut ? LOCKED_MESSAGE : 'Too many incorrect codes. Ask for a new one.', requestId, {
        reason: lockedOut ? 'otp_locked' : 'otp_code_locked',
      });
    }
    if (!(await record('MISMATCH', ledger))) throw conflict();
    throw refuse('VALIDATION_ERROR', 400, 'That code is not correct', requestId, { reason: 'otp_mismatch', attempts_remaining: PERSONAL_OTP_MAX_ATTEMPTS - attempts });
  }
}
