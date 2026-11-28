import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { OUTBOUND_MESSAGING_PORT, type OutboundMessagingPort } from '@aramo/sign';
import { SMS_CONSENT_NOT_CERTIFIED_REASON, SMS_NOT_IN_PLAN_REASON, type SenderSmsCertification } from '@aramo/sign-client';

import { SIGN_SMS_DELIVERY_FEATURE, SIGN_SMS_OTP_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

import { SignSmsPlanGate } from './sms-plan.gate.js';
import { SmsConsentFacts } from './sms-consent-rules.js';

// SMS-CONSENT-1 (LOCKED 2026-11-28) — the one rule for signer SMS options (sender context, the
// recipient messaging write, the certification read):
//
//   available   an SMS provider can send AND sign.sms_delivery or sign.sms_otp is AVAILABLE
//               (false today: both launch keys NOT_AVAILABLE and no provider configured — R-8);
//   a feature   (sign.sms_delivery / sign.sms_otp) is on only when it is launched AND the plan
//               includes it (R-4: BUSINESS on, PERSONAL off; an explicit plan setting wins) AND
//               the organization is certified (R-2);
//   required    certification would unlock something: a text feature is launched and in the plan.
//
// Refusal order for a write: not launched (feature_not_available, today's refusal) → not in the
// plan (sms_not_in_plan) → not certified (sms_consent_not_certified). All 403
// ESIGN_FEATURE_NOT_AVAILABLE with details.feature_key and details.reason.

export type SmsFeatureKey = typeof SIGN_SMS_DELIVERY_FEATURE | typeof SIGN_SMS_OTP_FEATURE;
export type SmsRefusal = 'feature_not_available' | typeof SMS_NOT_IN_PLAN_REASON | typeof SMS_CONSENT_NOT_CERTIFIED_REASON;

export interface SmsFeatureState {
  sms_delivery: boolean;
  sms_otp: boolean;
  sms_certification: SenderSmsCertification;
}

const REFUSAL_MESSAGE: Record<SmsRefusal, string> = {
  feature_not_available: 'This feature is not available in Aramo Sign yet',
  sms_not_in_plan: 'Text messages to signers are not included in your plan',
  sms_consent_not_certified: 'An administrator must confirm SMS consent in Settings before texts can be sent',
};

@Injectable()
export class SignSmsPolicy {
  private readonly features: SignFeatureGate;

  constructor(
    private readonly plan: SignSmsPlanGate,
    private readonly facts: SmsConsentFacts,
    @Optional() features?: SignFeatureGate,
    @Optional() @Inject(OUTBOUND_MESSAGING_PORT) private readonly outbound?: OutboundMessagingPort,
  ) {
    this.features = features ?? new SignFeatureGate();
  }

  launched(key: SmsFeatureKey): boolean {
    return this.features.isAvailable(key);
  }

  /** An SMS provider is configured (any number). */
  providerConfigured(): boolean {
    return this.outbound !== undefined && this.outbound.channels.has('SMS');
  }

  /** The `available` of both consent APIs. */
  available(): boolean {
    return this.providerConfigured() && (this.launched(SIGN_SMS_DELIVERY_FEATURE) || this.launched(SIGN_SMS_OTP_FEATURE));
  }

  async certified(tenant_id: string): Promise<boolean> {
    return this.facts.organizationCertified(tenant_id);
  }

  /** Launched AND in the plan, per feature (certification not considered). */
  async offeredByPlan(tenant_id: string): Promise<{ sms_delivery: boolean; sms_otp: boolean }> {
    const delivery = this.launched(SIGN_SMS_DELIVERY_FEATURE) && (await this.plan.entitled(tenant_id, SIGN_SMS_DELIVERY_FEATURE));
    const otp = this.launched(SIGN_SMS_OTP_FEATURE) && (await this.plan.entitled(tenant_id, SIGN_SMS_OTP_FEATURE));
    return { sms_delivery: delivery, sms_otp: otp };
  }

  /** The sender context's sms_delivery / sms_otp and sms_certification. */
  async featureState(tenant_id: string): Promise<SmsFeatureState> {
    const byPlan = await this.offeredByPlan(tenant_id);
    const required = byPlan.sms_delivery || byPlan.sms_otp;
    const certified = await this.certified(tenant_id);
    return {
      sms_delivery: byPlan.sms_delivery && certified,
      sms_otp: byPlan.sms_otp && certified,
      sms_certification: { required, certified },
    };
  }

  async refusalFor(tenant_id: string, key: SmsFeatureKey): Promise<SmsRefusal | null> {
    if (!this.launched(key)) return 'feature_not_available';
    if (!(await this.plan.entitled(tenant_id, key))) return SMS_NOT_IN_PLAN_REASON;
    if (!(await this.certified(tenant_id))) return SMS_CONSENT_NOT_CERTIFIED_REASON;
    return null;
  }

  /** Throws the 403 for a refused SMS feature. */
  async assertAllowed(tenant_id: string, key: SmsFeatureKey, requestId: string): Promise<void> {
    const refused = await this.refusalFor(tenant_id, key);
    if (refused === null) return;
    throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', REFUSAL_MESSAGE[refused], 403, {
      requestId,
      details: { feature_key: key, ...(refused === 'feature_not_available' ? {} : { reason: refused }) },
    });
  }
}
