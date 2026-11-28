import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
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
import { OUTBOUND_MESSAGING_PORT, SignMessagingRepository, SignSmsConsentRepository, isE164, maskPhone, phoneHash, type OutboundMessagingPort, type OutboundSendResult } from '@aramo/sign';
import { SMS_CONSENT_WORDING, SMS_CONSENT_WORDING_VERSION, isSmsConsentChannel, type UserSmsCodeSent, type UserSmsConsentView } from '@aramo/sign-client';

import { SmsConsentFacts, isConsentActive } from './sms-consent-rules.js';
import { SignSmsPolicy } from './sms-policy.service.js';

// SMS-CONSENT-1 R-3 (LOCKED 2026-11-28) — Settings → Text messages: a registered user's own
// number and their separate, unticked consent (v1/sign/me/sms-consent). Per person: keyed by the
// token's user only. Revocable here or by replying STOP.
//
//   GET     { available, phone_masked, phone_verified, consented, consented_at, wording_version, wording }
//   POST    phone  { phone_e164 } → texts a 6-digit code (valid 10 minutes; a new code after 60 s,
//                                   at most 5 a day — the Personal OTP rules)
//   POST    verify { code }       → the number is verified
//   PUT     { consented, wording_version, channel }  → consent given (verified number, current
//                                   wording, WEB | APP | SIGNUP) or turned off
//   DELETE  → the number, the consent and every pending code are removed
//
// Turning off and removing are always accepted. Everything else is refused while dark (403
// sms_not_available). Refusals (details.reason): sms_phone_invalid, sms_phone_not_supported,
// sms_phone_opted_out, sms_code_not_requested, sms_code_invalid (attempts_remaining),
// sms_code_expired, sms_code_attempts_exceeded, sms_wording_outdated, sms_channel_invalid,
// sms_consent_invalid (400); sms_phone_not_verified, sms_code_retry (409); sms_code_rate_limited
// (429); sms_code_not_sent (503). The code is never returned or logged.

type Refusal = { code: 'VALIDATION_ERROR' | 'INVALID_REQUEST' | 'ESIGN_FEATURE_NOT_AVAILABLE' | 'ESIGN_SEND_UNAVAILABLE'; status: number };
const BAD: Refusal = { code: 'VALIDATION_ERROR', status: 400 };

function refuse(requestId: string, kind: Refusal, reason: string, message: string, extra: Record<string, unknown> = {}): AramoError {
  return new AramoError(kind.code, message, kind.status, { requestId, details: { reason, ...extra } });
}

@Injectable()
export class UserSmsConsentService {
  private readonly log = new Logger(UserSmsConsentService.name);

  constructor(
    private readonly policy: SignSmsPolicy,
    private readonly repo: SignSmsConsentRepository,
    private readonly messaging: SignMessagingRepository,
    private readonly facts: SmsConsentFacts,
    @Optional() @Inject(OUTBOUND_MESSAGING_PORT) private readonly sms?: OutboundMessagingPort,
  ) {}

  async view(user_id: string): Promise<UserSmsConsentView> {
    const row = await this.repo.consentOf(user_id);
    const consented = isConsentActive(row);
    return {
      available: this.policy.available(),
      phone_masked: row === null ? null : maskPhone(row.phone_e164),
      phone_verified: row?.phone_verified_at != null,
      consented,
      consented_at: consented && row?.consented_at != null ? row.consented_at.toISOString() : null,
      wording_version: SMS_CONSENT_WORDING_VERSION,
      wording: SMS_CONSENT_WORDING,
    };
  }

  private assertAvailable(requestId: string): OutboundMessagingPort {
    if (!this.policy.available() || this.sms === undefined) {
      throw refuse(requestId, { code: 'ESIGN_FEATURE_NOT_AVAILABLE', status: 403 }, 'sms_not_available', 'Text messages are not available in Aramo Sign yet');
    }
    return this.sms;
  }

  async sendCode(auth: Pick<AuthContextType, 'sub'>, body: { phone_e164?: unknown } | undefined, requestId: string, now: Date = new Date()): Promise<UserSmsCodeSent> {
    const sms = this.assertAvailable(requestId);
    const raw = body?.phone_e164;
    const phone = typeof raw === 'string' ? raw.trim() : raw;
    if (!isE164(phone)) throw refuse(requestId, BAD, 'sms_phone_invalid', 'phone_e164 must be an E.164 number such as +14155550123', { field: 'phone_e164' });
    if (!sms.canSend('SMS', phone)) throw refuse(requestId, BAD, 'sms_phone_not_supported', 'Aramo cannot text this number yet', { field: 'phone_e164' });
    const hash = phoneHash(phone);
    if (await this.messaging.isOptedOut(hash, 'SMS')) throw refuse(requestId, BAD, 'sms_phone_opted_out', 'This number has turned off texts from Aramo');

    const history = await this.repo.codeHistory(auth.sub, new Date(now.getTime() - 86_400_000));
    const last = history[0]?.created_at ?? null;
    if (!mayResendPersonalOtp({ last_sent_at: last, sends_last_24h: history.length, now })) {
      const cooldown = last !== null && history.length < PERSONAL_OTP_MAX_SENDS_PER_DAY;
      const retryAt = cooldown ? new Date(last.getTime() + PERSONAL_OTP_RESEND_GAP_MS) : null;
      throw refuse(requestId, { code: 'INVALID_REQUEST', status: 429 }, 'sms_code_rate_limited', 'Please wait before asking for another code', {
        ...(retryAt !== null ? { retry_after_seconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)), retry_at: retryAt.toISOString() } : {}),
      });
    }

    await this.repo.setPhone(auth.sub, phone, now);
    const id = randomUUID();
    const code = generatePersonalOtp();
    await this.repo.createCode({ id, user_id: auth.sub, phone_hash: hash, code_hash: hashPersonalOtp(id, 'phone', code), expires_at: new Date(now.getTime() + PERSONAL_OTP_TTL_MS), now });
    const res: OutboundSendResult = await sms
      .send({ channel: 'SMS', purpose: 'OTP', variant: 'SIGNER_CODE', to_e164: phone, variables: { code, ttl_minutes: PERSONAL_OTP_TTL_MS / 60_000 }, reference: `sms-consent:${id}` })
      .catch((err: unknown) => {
        this.log.warn(`consent code delivery failed: ${(err as Error).message}`);
        return { outcome: 'failed' as const, provider: 'unknown', error_code: 'exception' };
      });
    if (res.outcome === 'opted_out') {
      await this.repo.withdrawCode(id);
      await this.messaging.setOptOut(hash, 'SMS', true, 'PROVIDER', now);
      await this.facts.revokeByPhone(phone, now);
      throw refuse(requestId, BAD, 'sms_phone_opted_out', 'This number has turned off texts from Aramo');
    }
    if (res.outcome !== 'sent') {
      await this.repo.withdrawCode(id);
      this.log.warn(`consent code not sent to ${maskPhone(phone)} (${res.provider}: ${res.error_code})`);
      throw refuse(requestId, { code: 'ESIGN_SEND_UNAVAILABLE', status: 503 }, 'sms_code_not_sent', 'The text could not be sent. Try again in a few minutes.');
    }
    return { sent: true, phone_masked: maskPhone(phone), expires_in_seconds: PERSONAL_OTP_TTL_MS / 1000, resend_after_seconds: PERSONAL_OTP_RESEND_GAP_MS / 1000 };
  }

  async verify(auth: Pick<AuthContextType, 'sub'>, body: { code?: unknown } | undefined, requestId: string, now: Date = new Date()): Promise<UserSmsConsentView> {
    this.assertAvailable(requestId);
    const row = await this.repo.consentOf(auth.sub);
    const active = row === null ? null : await this.repo.activeCode(auth.sub);
    // A code for a number that is no longer on file does not verify the new one.
    if (row === null || active === null || active.phone_hash !== phoneHash(row.phone_e164)) {
      throw refuse(requestId, BAD, 'sms_code_not_requested', 'Ask for a code first');
    }
    const check = checkPersonalOtp({ hash: active.code_hash, expires_at: active.expires_at, attempts: active.attempts }, active.id, 'phone', body?.code, now);
    const retry = () => refuse(requestId, { code: 'VALIDATION_ERROR', status: 409 }, 'sms_code_retry', 'Please try again');
    if (check === 'ok') {
      if (!(await this.repo.recordCodeAttempt({ id: active.id, expected_attempts: active.attempts, outcome: 'VERIFIED', now }))) throw retry();
      if (!(await this.repo.markVerified(auth.sub, row.phone_e164, now))) throw refuse(requestId, BAD, 'sms_code_not_requested', 'Ask for a code first');
      return this.view(auth.sub);
    }
    if (check === 'expired' || check === 'none') {
      if (check === 'expired') await this.repo.recordCodeAttempt({ id: active.id, expected_attempts: active.attempts, outcome: 'EXPIRED', now });
      throw refuse(requestId, BAD, 'sms_code_expired', 'This code has expired. Ask for a new one.');
    }
    if (check === 'exhausted') {
      await this.repo.recordCodeAttempt({ id: active.id, expected_attempts: active.attempts, outcome: 'LOCKED', now });
      throw refuse(requestId, BAD, 'sms_code_attempts_exceeded', 'Too many attempts. Ask for a new code.');
    }
    const attempts = active.attempts + 1;
    if (attempts >= PERSONAL_OTP_MAX_ATTEMPTS) {
      if (!(await this.repo.recordCodeAttempt({ id: active.id, expected_attempts: active.attempts, outcome: 'LOCKED', now }))) throw retry();
      throw refuse(requestId, BAD, 'sms_code_attempts_exceeded', 'Too many attempts. Ask for a new code.');
    }
    if (!(await this.repo.recordCodeAttempt({ id: active.id, expected_attempts: active.attempts, outcome: 'MISMATCH', now }))) throw retry();
    throw refuse(requestId, BAD, 'sms_code_invalid', 'This code is not correct.', { attempts_remaining: PERSONAL_OTP_MAX_ATTEMPTS - attempts });
  }

  async setConsent(
    auth: Pick<AuthContextType, 'sub'>,
    body: { consented?: unknown; wording_version?: unknown; channel?: unknown } | undefined,
    requestId: string,
    now: Date = new Date(),
  ): Promise<UserSmsConsentView> {
    const consented = body?.consented;
    if (typeof consented !== 'boolean') throw refuse(requestId, BAD, 'sms_consent_invalid', 'consented must be true or false', { field: 'consented' });
    if (!consented) {
      await this.repo.revokeConsent(auth.sub, now);
      return this.view(auth.sub);
    }
    this.assertAvailable(requestId);
    if (body?.wording_version !== SMS_CONSENT_WORDING_VERSION) {
      throw refuse(requestId, BAD, 'sms_wording_outdated', 'The consent wording has changed; read it again', { field: 'wording_version', wording_version: SMS_CONSENT_WORDING_VERSION });
    }
    if (!isSmsConsentChannel(body?.channel)) throw refuse(requestId, BAD, 'sms_channel_invalid', 'channel must be WEB, APP or SIGNUP', { field: 'channel' });
    if (!(await this.repo.giveConsent(auth.sub, { wording_version: SMS_CONSENT_WORDING_VERSION, channel: body.channel, now }))) {
      throw refuse(requestId, { code: 'VALIDATION_ERROR', status: 409 }, 'sms_phone_not_verified', 'Verify your mobile number first');
    }
    return this.view(auth.sub);
  }

  async remove(auth: Pick<AuthContextType, 'sub'>): Promise<UserSmsConsentView> {
    await this.repo.removeConsent(auth.sub);
    return this.view(auth.sub);
  }
}
