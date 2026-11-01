import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { SIGN_PAYMENT_PROVIDER_PORT, type PaymentProviderPort } from '@aramo/sign';
import { ESIGN_ENVELOPE_ALLOWANCE, SIGN_PRODUCT_KEY, SubscriptionLifecycleService } from '@aramo/subscription';

import { SignFeatureGate } from '../sign-feature.gate.js';

import { signStripeConnectConfig } from './sign-payments.config.js';

// Aramo Sign 1.14 — payments are offered only when ALL of these hold (server-side; the UI
// only reflects the answer):
//   1. launch availability: the plan capability `sign.payments` is AVAILABLE
//      (libs/subscription feature-availability — NOT_AVAILABLE until the PO flips it, R-8);
//   2. configuration: SIGN_STRIPE_CONNECT_ENABLED=1 and both Connect keys are set;
//   3. plan placement (directive §1.14 / D-1): the tenant's open Sign subscription is on
//      Standard Professional or Enterprise (or a plan whose terms enable `sign.payments`).
// The first refusal is reported as details.reason.

export const SIGN_PAYMENTS_FEATURE = 'sign.payments';
// Directive §1.14 "Plans: P, E".
export const SIGN_PAYMENTS_PLAN_KEYS: ReadonlySet<string> = new Set(['aramo-sign-standard-professional-v1', 'aramo-sign-enterprise-v1']);

export type PaymentsUnavailableReason = 'feature_not_available' | 'payments_not_configured' | 'plan_not_entitled';

// The plan lookup the gate needs (the subscription lifecycle in production).
export const SIGN_PAYMENTS_PLAN_SOURCE = 'SIGN_PAYMENTS_PLAN_SOURCE';
export interface SignPaymentsPlanSource {
  openPlan(tenant_id: string): Promise<{ plan_key: string; features: { feature_key: string; enabled: boolean }[] } | null>;
}

@Injectable()
export class SubscriptionPlanSource implements SignPaymentsPlanSource {
  constructor(private readonly lifecycle: SubscriptionLifecycleService) {}

  async openPlan(tenant_id: string): Promise<{ plan_key: string; features: { feature_key: string; enabled: boolean }[] } | null> {
    const account = await this.lifecycle.account(tenant_id, SIGN_PRODUCT_KEY, ESIGN_ENVELOPE_ALLOWANCE);
    const s = account.subscription;
    if (s === null || s.ended_at !== null || s.status === 'CANCELED') return null;
    return { plan_key: s.plan_key, features: s.features };
  }
}

export function planEntitled(plan: { plan_key: string; features: { feature_key: string; enabled: boolean }[] } | null): boolean {
  if (plan === null) return false;
  return SIGN_PAYMENTS_PLAN_KEYS.has(plan.plan_key) || plan.features.some((f) => f.feature_key === SIGN_PAYMENTS_FEATURE && f.enabled);
}

@Injectable()
export class SignPaymentsGate {
  constructor(
    private readonly features: SignFeatureGate,
    @Inject(SIGN_PAYMENT_PROVIDER_PORT) private readonly provider: PaymentProviderPort,
    @Optional() @Inject(SIGN_PAYMENTS_PLAN_SOURCE) private readonly plans?: SignPaymentsPlanSource,
  ) {}

  /** Connect is switched on and has its keys (refunds of earlier payments need only this). */
  configured(): boolean {
    return signStripeConnectConfig().enabled && this.provider.configured();
  }

  async unavailableReason(tenant_id: string): Promise<PaymentsUnavailableReason | null> {
    if (!this.features.isAvailable(SIGN_PAYMENTS_FEATURE)) return 'feature_not_available';
    if (!this.configured()) return 'payments_not_configured';
    const plan = this.plans === undefined ? null : await this.plans.openPlan(tenant_id).catch(() => null);
    if (!planEntitled(plan)) return 'plan_not_entitled';
    return null;
  }

  async available(tenant_id: string): Promise<boolean> {
    return (await this.unavailableReason(tenant_id)) === null;
  }

  async assertAvailable(tenant_id: string, requestId: string): Promise<void> {
    const reason = await this.unavailableReason(tenant_id);
    if (reason !== null) throw paymentsNotAvailable(requestId, reason);
  }

  assertConfigured(requestId: string): void {
    if (!this.configured()) throw paymentsNotAvailable(requestId, 'payments_not_configured');
  }
}

export function paymentsNotAvailable(requestId: string, reason: PaymentsUnavailableReason): AramoError {
  return new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Payment collection is not available in Aramo Sign yet', 403, {
    requestId,
    details: { feature_key: SIGN_PAYMENTS_FEATURE, reason },
  });
}
