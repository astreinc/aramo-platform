import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  IdentityRepository,
  IdentityService,
  PERSONAL_ALLOWED_COUNTRIES,
  PERSONAL_OTP_RESEND_GAP_MS,
  PERSONAL_OTP_TTL_MS,
  PersonalRiskService,
  TENANT_OWNER_ROLE_KEY,
  TenantRepository,
  normalizeE164,
  phoneRegion,
  stepUpOutstanding,
} from '@aramo/identity';
import { OUTBOUND_MESSAGING_PORT, maskPhone, type OutboundMessagingPort } from '@aramo/sign';

// SIGN-FREE-PARITY-1 S2 (FP-R2) — the new-account send check, self-serve. A young Personal
// account whose first send has more than one recipient is asked for phone assurance
// (PersonalSendGate). With this switch ON the sender clears it themselves: Aramo texts a
// code (identity generates and stores its hash; this service delivers it through the
// sign-service SMS port — AWS End User Messaging outside India, MSG91 for +91) and a
// correct code records phone assurance; the next send passes.
//
//   SIGN_SENDER_PHONE_STEP_UP  exactly `1` = on. Unset (the shipped default) = today's
//                              behaviour, unchanged: the step-up routes the account to
//                              review and these routes answer 404 step_up_not_available.
//
// Manual review stays the fallback: switch off, no SMS provider, or no provider for the
// sender's number (e.g. +91 without MSG91) ⇒ the step-up goes to review as before.
//
// Refusals (stable details.reason):
//   step_up_not_available        404  switch off / no SMS provider / not a Personal account
//   step_up_owner_only           403  the caller does not hold tenant_owner
//   step_up_not_required         400  no phone step is outstanding (already verified)
//   phone_required               400  no number on file and none entered
//   invalid_phone                400  not a valid mobile number
//   personal_location_not_supported 400  the number is outside the allowed countries
//   phone_in_use                 400  the number already verifies another Personal account
//   personal_code_rate_limited   400  inside the 60 s gap or past 5 codes in 24 h
//   phone_opted_out              400  the number replied STOP to Aramo texts
//   step_up_sms_not_sent         503  the provider did not take the text
//   personal_review_pending      403  no provider serves this number: sent to review instead
//   code_invalid / code_expired / code_attempts_exceeded  400  (verify)

export const SENDER_PHONE_STEP_UP_ENV = 'SIGN_SENDER_PHONE_STEP_UP';

/** The dark switch: on only when exactly `1`. */
export function senderPhoneStepUpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SENDER_PHONE_STEP_UP_ENV]?.trim() === '1';
}

export interface SenderStepUpStatus {
  /** Self-serve phone verification is on for this account. */
  available: boolean;
  /** A phone step is outstanding (sending waits for it). */
  required: boolean;
  /** The number a code goes to (masked), or null when the sender must enter one. */
  phone_masked: string | null;
}

export interface SenderStepUpSent {
  sent: true;
  phone_masked: string;
  expires_in_seconds: number;
  resend_after_seconds: number;
}

function refusal(requestId: string, reason: string, message: string, status = 400, extra: Record<string, unknown> = {}): AramoError {
  const code = status === 403 ? 'INSUFFICIENT_PERMISSIONS' : status === 404 ? 'NOT_FOUND' : status === 503 ? 'ESIGN_SEND_UNAVAILABLE' : 'VALIDATION_ERROR';
  return new AramoError(code, message, status, { requestId, details: { reason, ...extra } });
}

@Injectable()
export class SenderPhoneStepUpService {
  private readonly log = new Logger(SenderPhoneStepUpService.name);

  constructor(
    private readonly risk: PersonalRiskService,
    private readonly tenants: TenantRepository,
    private readonly repo: IdentityRepository,
    private readonly identity: IdentityService,
    @Optional() @Inject(OUTBOUND_MESSAGING_PORT) private readonly sms?: OutboundMessagingPort,
  ) {}

  /**
   * Can a code be texted now? Switch on and an SMS provider configured; with a known
   * number, a provider that serves it. Null phone = the sender will enter one.
   */
  smsAvailable(phone_e164: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!senderPhoneStepUpEnabled(env) || this.sms === undefined || !this.sms.channels.has('SMS')) return false;
    return phone_e164 === null || this.sms.canSend('SMS', phone_e164);
  }

  async status(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>): Promise<SenderStepUpStatus> {
    const state = await this.risk.riskStateOf(auth.tenant_id);
    const tenant = await this.tenants.findById(auth.tenant_id);
    if (state === null || tenant?.kind !== 'PERSONAL') return { available: false, required: false, phone_masked: null };
    const phone = state.phone_e164;
    return {
      available: this.smsAvailable(phone) && (await this.isOwner(auth.tenant_id, auth.sub)),
      required: stepUpOutstanding(state),
      phone_masked: phone === null ? null : maskPhone(phone),
    };
  }

  async send(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, body: { phone?: unknown } | undefined, requestId: string, now: Date = new Date()): Promise<SenderStepUpSent> {
    const state = await this.guard(auth, requestId);
    const phone = this.phoneFor(state.phone_e164, body?.phone, requestId);
    const sms = this.sms;
    if (sms === undefined || !this.smsAvailable(phone)) {
      // No provider serves this number: manual review stays the fallback.
      await this.risk.flagForReview(auth.tenant_id, 'step_up_phone_unavailable', now, { step_up_self_serve: true });
      throw refusal(requestId, 'personal_review_pending', 'Your account is being reviewed. Sending is paused until the review is complete.', 403);
    }
    const started = await this.risk.startPhoneStepUpCode(auth.tenant_id, phone, now);
    if (!started.ok) {
      if (started.reason === 'step_up_not_required') throw refusal(requestId, 'step_up_not_required', 'Your phone number is already verified.');
      if (started.reason === 'phone_in_use') throw refusal(requestId, 'phone_in_use', 'This number is already used by another account.');
      throw refusal(requestId, 'personal_code_rate_limited', 'Wait a minute before asking for another code.');
    }
    const res = await sms
      .send({
        channel: 'SMS',
        purpose: 'OTP',
        to_e164: phone,
        variables: { code: started.code, ttl_minutes: PERSONAL_OTP_TTL_MS / 60_000 },
        reference: `step-up:${auth.tenant_id}`,
      })
      .catch((err: unknown) => {
        this.log.warn(`step-up code delivery failed: ${(err as Error).message}`);
        return { outcome: 'failed' as const, provider: 'unknown', error_code: 'exception' };
      });
    if (res.outcome === 'opted_out') throw refusal(requestId, 'phone_opted_out', 'This number has turned off texts from Aramo. Use another number.');
    if (res.outcome !== 'sent') {
      this.log.warn(`step-up code not sent to ${maskPhone(phone)} (${res.provider}: ${res.error_code})`);
      throw refusal(requestId, 'step_up_sms_not_sent', 'We couldn’t send the text. Try again in a few minutes.', 503);
    }
    return { sent: true, phone_masked: maskPhone(phone), expires_in_seconds: PERSONAL_OTP_TTL_MS / 1000, resend_after_seconds: PERSONAL_OTP_RESEND_GAP_MS / 1000 };
  }

  async verify(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, body: { code?: unknown } | undefined, requestId: string, now: Date = new Date()): Promise<{ verified: true }> {
    await this.guard(auth, requestId);
    const r = await this.risk.verifyPhoneStepUpCode(auth.tenant_id, body?.code, now);
    switch (r.outcome) {
      case 'ok':
        return { verified: true };
      case 'step_up_not_required':
        throw refusal(requestId, 'step_up_not_required', 'Your phone number is already verified.');
      case 'mismatch':
        throw refusal(requestId, 'code_invalid', 'This code is not correct.', 400, { attempts_remaining: r.attempts_remaining });
      case 'exhausted':
        throw refusal(requestId, 'code_attempts_exceeded', 'Too many attempts. Ask for a new code.');
      default:
        throw refusal(requestId, 'code_expired', 'This code has expired. Ask for a new one.');
    }
  }

  /** Switch on, a PERSONAL account with a risk state, the owner, and a step outstanding. */
  private async guard(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, requestId: string) {
    const notAvailable = () => refusal(requestId, 'step_up_not_available', 'Phone verification isn’t available.', 404);
    if (!senderPhoneStepUpEnabled() || this.sms === undefined || !this.sms.channels.has('SMS')) throw notAvailable();
    const tenant = await this.tenants.findById(auth.tenant_id);
    const state = await this.risk.riskStateOf(auth.tenant_id);
    if (tenant?.kind !== 'PERSONAL' || state === null) throw notAvailable();
    if (!(await this.isOwner(auth.tenant_id, auth.sub))) throw refusal(requestId, 'step_up_owner_only', 'Only the account owner can verify the phone number.', 403);
    if (!stepUpOutstanding(state)) throw refusal(requestId, 'step_up_not_required', 'Your phone number is already verified.');
    return state;
  }

  /** The entered number (same country rules as signup), else the number from signup. */
  private phoneFor(onFile: string | null, entered: unknown, requestId: string): string {
    if (entered === undefined || entered === null || (typeof entered === 'string' && entered.trim() === '')) {
      if (onFile === null) throw refusal(requestId, 'phone_required', 'Enter your mobile number.', 400, { field: 'phone' });
      return onFile;
    }
    const phone = typeof entered === 'string' ? normalizeE164(entered) : null;
    if (phone === null) throw refusal(requestId, 'invalid_phone', 'Enter a valid mobile number', 400, { field: 'phone' });
    const region = phoneRegion(phone);
    if (region === null || !PERSONAL_ALLOWED_COUNTRIES().includes(region)) {
      throw refusal(requestId, 'personal_location_not_supported', 'Aramo Sign Personal is currently available in the United States and India.');
    }
    return phone;
  }

  private async isOwner(tenant_id: string, user_id: string): Promise<boolean> {
    const membership = await this.repo.findMembership({ user_id, tenant_id });
    if (membership === null || membership.is_active === false) return false;
    const keys = await this.identity.findRoleKeysForMembership(membership.id);
    return keys.includes(TENANT_OWNER_ROLE_KEY);
  }
}
