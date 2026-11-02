import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { IdentityRepository } from '@aramo/identity';
import {
  DEFAULT_SIGN_BASE_URL,
  EsignService,
  PaymentProviderRefusedError,
  PaymentProviderUnavailableError,
  PaymentWebhookSignatureError,
  SIGN_PAYMENT_PROVIDER_PORT,
  SignPaymentRepository,
  SignPaymentStateError,
  signBaseUrl,
  type PaymentCheckoutState,
  type PaymentProviderPort,
  type SessionContext,
  type SignPaymentAccountRow,
  type SignPaymentRefundRow,
  type SignPaymentRow,
} from '@aramo/sign';

import { logWebhookFailed, logWebhookRejected } from '../webhook-log.js';

import { applicationFeeFor, signStripeConnectConfig } from './sign-payments.config.js';
import { SignPaymentsGate, type PaymentsUnavailableReason } from './sign-payments.gate.js';

// Aramo Sign 1.14 — payment collection (Feature-Parity directive §1.14; R-6; A1). The
// orchestration between the signing engine, the payment records and the payment port.
//
//   Connect (sign_admin, sign:settings:manage): create the tenant's Stripe Standard account,
//     send the admin to Stripe's hosted onboarding, mirror charges_enabled, disconnect.
//   Signer: a PAYMENT field is paid on Stripe's hosted Checkout page, as a direct charge on
//     the tenant's connected account. The field fills (and the signer can complete) only
//     after Stripe reports the payment paid — by the Connect webhook or by the read-through
//     when the payer returns. Payment required to complete: there is no "pay after sign".
//   Refunds (sign:settings:manage): through Stripe, on the account that collected.
// Every state change is also a ledger event (evidence); the certificate prints the payment.

export const PAYMENT_RETURN_PATH = '/s/payment-return';

export interface PaymentAccountView {
  available: boolean;
  unavailable_reason: PaymentsUnavailableReason | null;
  account: {
    status: string;
    charges_enabled: boolean;
    details_submitted: boolean;
    payouts_enabled: boolean;
    live: boolean;
    connected_at: string;
    disconnected_at: string | null;
  } | null;
  application_fee_minor: number;
}

export interface PaymentView {
  id: string;
  signer_id: string;
  field_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  amount_refunded_minor: number;
  refundable_minor: number;
  payment_ref: string | null;
  paid_at: string | null;
  live: boolean;
  refunds: { id: string; amount_minor: number; status: string; refund_ref: string | null; reason: string | null; created_at: string }[];
}

function accountView(row: SignPaymentAccountRow | null) {
  if (row === null) return null;
  return {
    status: row.status,
    charges_enabled: row.charges_enabled,
    details_submitted: row.details_submitted,
    payouts_enabled: row.payouts_enabled,
    live: row.live,
    connected_at: row.created_at.toISOString(),
    disconnected_at: row.disconnected_at === null ? null : row.disconnected_at.toISOString(),
  };
}

export function paymentView(p: SignPaymentRow & { refunds: SignPaymentRefundRow[] }): PaymentView {
  const open = p.refunds.filter((r) => r.status === 'REQUESTED' || r.status === 'PENDING' || r.status === 'SUCCEEDED').reduce((n, r) => n + r.amount_minor, 0);
  const paid = p.status === 'PAID' || p.status === 'PARTIALLY_REFUNDED';
  return {
    id: p.id,
    signer_id: p.signer_id,
    field_id: p.field_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    status: p.status,
    amount_refunded_minor: p.amount_refunded_minor,
    refundable_minor: paid ? Math.max(0, p.amount_minor - Math.max(open, p.amount_refunded_minor)) : 0,
    payment_ref: p.payment_ref,
    paid_at: p.paid_at === null ? null : p.paid_at.toISOString(),
    live: p.live,
    refunds: p.refunds.map((r) => ({ id: r.id, amount_minor: r.amount_minor, status: r.status, refund_ref: r.refund_ref, reason: r.reason, created_at: r.created_at.toISOString() })),
  };
}

function providerError(e: unknown, requestId: string): AramoError {
  if (e instanceof PaymentProviderRefusedError) {
    return new AramoError('VALIDATION_ERROR', 'Stripe refused the request', 400, { requestId, details: { reason: 'payment_provider_refused' } });
  }
  if (e instanceof PaymentProviderUnavailableError) {
    return new AramoError('ESIGN_PAYMENTS_UNAVAILABLE', 'Stripe could not be reached. Try again shortly.', 503, { requestId });
  }
  if (e instanceof SignPaymentStateError) {
    return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', e.message, 409, { requestId, details: { reason: e.reason } });
  }
  return e instanceof AramoError ? e : new AramoError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), 500, { requestId });
}

@Injectable()
export class SignPaymentService {
  private readonly logger = new Logger('SignPaymentService');

  constructor(
    private readonly gate: SignPaymentsGate,
    private readonly payments: SignPaymentRepository,
    private readonly esign: EsignService,
    @Inject(SIGN_PAYMENT_PROVIDER_PORT) private readonly provider: PaymentProviderPort,
    private readonly identity: IdentityRepository,
  ) {}

  private base(): string {
    return signBaseUrl() ?? DEFAULT_SIGN_BASE_URL;
  }

  // ── Connect (sender console) ─────────────────────────────────────────────────

  async account(auth: AuthContextType): Promise<PaymentAccountView> {
    const reason = await this.gate.unavailableReason(auth.tenant_id);
    return {
      available: reason === null,
      unavailable_reason: reason,
      account: accountView(await this.payments.getAccount(auth.tenant_id)),
      application_fee_minor: signStripeConnectConfig().application_fee_minor,
    };
  }

  /** Stripe-hosted onboarding for the tenant's Standard account (created on first use). */
  async onboardingLink(auth: AuthContextType, requestId: string): Promise<{ url: string; expires_at: string }> {
    await this.gate.assertAvailable(auth.tenant_id, requestId);
    try {
      let account = await this.payments.connectedAccount(auth.tenant_id);
      if (account === null) {
        const prior = await this.payments.getAccount(auth.tenant_id);
        const user = await this.identity.findUserById(auth.sub);
        const created = await this.provider.createAccount({
          tenant_id: auth.tenant_id,
          email: user?.email ?? null,
          // One account per tenant per connection: a retried request never makes a second one.
          idempotency_key: `aramo-sign-connect:${auth.tenant_id}:${prior?.disconnected_at?.getTime() ?? 'first'}`,
        });
        account = await this.payments.connect(auth.tenant_id, created, auth.sub);
      }
      const page = `${this.base()}/sign/settings/payments`;
      const link = await this.provider.createOnboardingLink({ account_ref: account.account_ref, refresh_url: `${page}?onboarding=refresh`, return_url: `${page}?onboarding=return` });
      return { url: link.url, expires_at: link.expires_at.toISOString() };
    } catch (e) {
      throw providerError(e, requestId);
    }
  }

  /** Re-read the account from Stripe (after onboarding returns). */
  async refreshAccount(auth: AuthContextType, requestId: string): Promise<PaymentAccountView> {
    this.gate.assertConfigured(requestId);
    const account = await this.payments.connectedAccount(auth.tenant_id);
    if (account !== null) {
      try {
        await this.payments.applyAccountState(await this.provider.getAccount(account.account_ref));
      } catch (e) {
        throw providerError(e, requestId);
      }
    }
    return this.account(auth);
  }

  /** Stop using the connected account. The Stripe account (and its funds) stays the subscriber's. */
  async disconnect(auth: AuthContextType, requestId: string): Promise<PaymentAccountView> {
    const done = await this.payments.disconnect(auth.tenant_id, auth.sub);
    if (!done) throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'No payment account is connected', 409, { requestId, details: { reason: 'payments_account_not_connected' } });
    return this.account(auth);
  }

  // ── Payments and refunds (sender console) ────────────────────────────────────

  async envelopePayments(tenant_id: string, envelope_id: string): Promise<PaymentView[]> {
    return (await this.payments.listForEnvelope(tenant_id, envelope_id)).map(paymentView);
  }

  async refund(auth: AuthContextType, envelope_id: string, payment_id: string, input: { amount_minor: number | null; reason: string | null }, requestId: string): Promise<PaymentView> {
    // Returning money stays possible while Connect is configured, even if the plan or
    // launch availability later changes.
    this.gate.assertConfigured(requestId);
    const payment = await this.payments.getPayment(auth.tenant_id, payment_id);
    if (payment === null || payment.envelope_id !== envelope_id) throw new AramoError('NOT_FOUND', 'Payment not found', 404, { requestId });
    let requested: Awaited<ReturnType<SignPaymentRepository['requestRefund']>>;
    try {
      requested = await this.payments.requestRefund({ tenant_id: auth.tenant_id, payment_id, amount_minor: input.amount_minor, reason: input.reason, requested_by: auth.sub });
    } catch (e) {
      throw providerError(e, requestId);
    }
    const { refund } = requested;
    if (payment.payment_ref === null) throw new AramoError('INTERNAL_ERROR', 'paid payment without a payment reference', 500, { requestId });
    try {
      const state = await this.provider.createRefund({
        account_ref: payment.account_ref,
        payment_ref: payment.payment_ref,
        amount_minor: refund.amount_minor,
        refund_application_fee: payment.application_fee_minor > 0,
        references: { tenant_id: auth.tenant_id, payment_id, refund_id: refund.id },
        idempotency_key: `aramo-sign-refund:${refund.id}`,
      });
      await this.payments.applyRefundState(state, refund.id);
    } catch (e) {
      // A refusal releases the amount; an outage leaves the request open (the webhook or a
      // retry by the admin settles it — the provider call is idempotent per refund).
      if (e instanceof PaymentProviderRefusedError) await this.payments.refundRefused(refund.id, e.message);
      throw providerError(e, requestId);
    }
    const after = (await this.payments.listForEnvelope(auth.tenant_id, envelope_id)).find((p) => p.id === payment_id);
    if (after === undefined) throw new AramoError('NOT_FOUND', 'Payment not found', 404, { requestId });
    return paymentView(after);
  }

  // ── Signer ───────────────────────────────────────────────────────────────────

  /**
   * Start (or resume) the payment of the signer's PAYMENT field: the URL of Stripe's hosted
   * Checkout page on the tenant's connected account. The signing token never leaves Aramo:
   * Stripe returns the payer to a fixed page, which picks the token up from the same tab.
   */
  async startCheckout(ctx: SessionContext, field_id: string, requestId: string): Promise<{ status: 'PAID' } | { status: 'CHECKOUT'; checkout_url: string }> {
    await this.gate.assertAvailable(ctx.tenant_id, requestId);
    try {
      const field = await this.esign.signerPaymentField(ctx, field_id);
      if (field.filled) return { status: 'PAID' };
      const account = await this.payments.connectedAccount(ctx.tenant_id);
      if (account === null || !account.charges_enabled) {
        throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'The sender cannot take payments right now', 409, { requestId, details: { reason: 'payments_account_not_ready' } });
      }
      const payment = await this.payments.preparePayment({
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        field_id: field.field_id,
        account_ref: account.account_ref,
        amount_minor: field.amount_minor,
        currency: field.currency,
        application_fee_minor: applicationFeeFor(field.amount_minor, signStripeConnectConfig().application_fee_minor),
      });
      // Resume an open checkout on the same account instead of starting a second one.
      if (payment.checkout_ref !== null && payment.account_ref === account.account_ref) {
        const prior = await this.provider.getCheckout(account.account_ref, payment.checkout_ref);
        if (prior.paid) {
          await this.payments.recordPaid(prior, account.account_ref);
          return { status: 'PAID' };
        }
        if (prior.status === 'OPEN' && prior.url !== null && prior.amount_minor === payment.amount_minor) return { status: 'CHECKOUT', checkout_url: prior.url };
      }
      const back = `${this.base()}${PAYMENT_RETURN_PATH}?field=${encodeURIComponent(field.field_id)}`;
      const checkout = await this.provider.createCheckout({
        account_ref: account.account_ref,
        amount_minor: payment.amount_minor,
        currency: 'USD',
        description: field.subject,
        application_fee_minor: payment.application_fee_minor,
        success_url: `${back}&payment=success`,
        cancel_url: `${back}&payment=cancel`,
        references: { tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, payment_id: payment.id, field_id: field.field_id },
        idempotency_key: `aramo-sign-checkout:${payment.id}:${payment.updated_at.getTime()}`,
      });
      await this.payments.recordCheckoutStarted(payment, checkout);
      if (checkout.url === null) throw new PaymentProviderUnavailableError('checkout without url');
      return { status: 'CHECKOUT', checkout_url: checkout.url };
    } catch (e) {
      if (e instanceof AramoError) throw e;
      if (e instanceof PaymentProviderRefusedError || e instanceof PaymentProviderUnavailableError || e instanceof SignPaymentStateError) throw providerError(e, requestId);
      throw e;
    }
  }

  /**
   * The payer came back from Stripe: read the checkout through (the webhook may not have
   * arrived yet) and record it if Stripe reports it paid. The browser never asserts a payment.
   */
  async confirm(ctx: SessionContext, field_id: string, requestId: string): Promise<{ status: string }> {
    this.gate.assertConfigured(requestId);
    const payment = await this.payments.paymentForField(ctx.tenant_id, field_id);
    if (payment === null || payment.signer_id !== ctx.signer_id || payment.envelope_id !== ctx.envelope_id) {
      throw new AramoError('NOT_FOUND', 'Payment not found', 404, { requestId });
    }
    if (payment.status !== 'PENDING' || payment.checkout_ref === null) return { status: payment.status };
    try {
      const state = await this.provider.getCheckout(payment.account_ref, payment.checkout_ref);
      if (state.paid) {
        await this.payments.recordPaid(state, payment.account_ref);
        return { status: 'PAID' };
      }
      return { status: state.status === 'EXPIRED' ? 'EXPIRED' : 'PENDING' };
    } catch (e) {
      throw providerError(e, requestId);
    }
  }

  // ── Connect webhook ──────────────────────────────────────────────────────────

  /**
   * A Connect webhook. Dark (404) unless payments are configured. Authenticity is the
   * Stripe-Signature over the raw body only. Each event is processed at most once; a
   * processing failure answers 5xx so Stripe redelivers.
   */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined, requestId: string): Promise<{ received: true; outcome: 'APPLIED' | 'IGNORED' | 'DUPLICATE' | 'FAILED' }> {
    if (!this.gate.configured()) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
    if (rawBody === undefined) throw new AramoError('VALIDATION_ERROR', 'raw body required', 400, { requestId });
    let event;
    try {
      event = this.provider.verifyWebhook(rawBody, signature);
    } catch (e) {
      if (e instanceof PaymentWebhookSignatureError) {
        logWebhookRejected(this.logger, 'stripe_connect', e.message);
        throw new AramoError('AUTH_REQUIRED', 'Webhook signature verification failed', 401, { requestId, details: { reason: e.message } });
      }
      throw e;
    }
    if (!(await this.payments.receiveWebhookEvent(event.event_ref, event.event_type, event.account_ref))) return { received: true, outcome: 'DUPLICATE' };
    let outcome: 'APPLIED' | 'IGNORED' | 'FAILED';
    try {
      outcome = await this.apply(event);
    } catch (e) {
      if (e instanceof SignPaymentStateError) {
        this.logger.warn(`payment webhook ${event.event_ref} (${event.event_type}) refused: ${e.reason}`);
        outcome = 'FAILED';
      } else {
        logWebhookFailed(this.logger, 'stripe_connect', e);
        await this.payments.finishWebhookEvent(event.event_ref, 'FAILED').catch(() => undefined);
        throw e;
      }
    }
    await this.payments.finishWebhookEvent(event.event_ref, outcome);
    return { received: true, outcome };
  }

  private async apply(event: ReturnType<PaymentProviderPort['verifyWebhook']>): Promise<'APPLIED' | 'IGNORED'> {
    switch (event.kind) {
      case 'ACCOUNT_UPDATED':
        return (await this.payments.applyAccountState(event.account)) === null ? 'IGNORED' : 'APPLIED';
      case 'ACCOUNT_DEAUTHORIZED':
        return event.account_ref !== null && (await this.payments.disconnectByAccountRef(event.account_ref)) ? 'APPLIED' : 'IGNORED';
      case 'CHECKOUT_COMPLETED':
        return this.paid(event.checkout, event.account_ref);
      case 'CHECKOUT_PAYMENT_FAILED':
        return this.payments.recordFailed(event.checkout);
      case 'CHARGE_REFUNDED':
        return this.payments.applyChargeRefunds(event.charge, event.account_ref);
      case 'REFUND_UPDATED': {
        const r = await this.payments.applyRefundState(event.refund);
        return r === 'APPLIED' ? 'APPLIED' : 'IGNORED';
      }
      default:
        return 'IGNORED';
    }
  }

  private async paid(checkout: PaymentCheckoutState, account_ref: string | null): Promise<'APPLIED' | 'IGNORED'> {
    if (!checkout.paid) return 'IGNORED';
    const r = await this.payments.recordPaid(checkout, account_ref);
    return r === 'APPLIED' ? 'APPLIED' : 'IGNORED';
  }
}
