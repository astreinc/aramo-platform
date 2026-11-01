// Aramo Sign 1.14 (Feature-Parity directive §1.14; Amendment A1 A1.1) — the vendor-neutral
// payment port. The default adapter is Stripe Connect (D-3); tests use stubs only.
//
// R-6: Aramo never holds subscriber funds. Every money movement this port starts is a
// DIRECT charge (or refund) on the subscriber's own connected account: the adapter acts
// "on behalf of" that account, the funds settle to its balance, and the provider hosts the
// payment page (no card data ever reaches Aramo — PCI scope stays with the provider).
// The only amount Aramo can receive is the optional application fee (default 0).

export const SIGN_PAYMENT_PROVIDER_PORT = 'SIGN_PAYMENT_PROVIDER_PORT';

export interface PaymentAccountState {
  account_ref: string;
  charges_enabled: boolean;
  details_submitted: boolean;
  payouts_enabled: boolean;
  live: boolean;
}

export interface PaymentCheckoutRequest {
  account_ref: string;
  amount_minor: number;
  currency: 'USD';
  // What the payer sees on the provider's page (the envelope subject; never PII).
  description: string;
  application_fee_minor: number;
  success_url: string;
  cancel_url: string;
  // Aramo references echoed back by the provider (webhook + read-through).
  references: { tenant_id: string; envelope_id: string; payment_id: string; field_id: string };
  idempotency_key: string;
}

export interface PaymentCheckoutState {
  checkout_ref: string;
  // The provider-hosted page the payer is sent to (null once the checkout is closed).
  url: string | null;
  // OPEN: not yet paid · COMPLETE: closed · EXPIRED: abandoned.
  status: 'OPEN' | 'COMPLETE' | 'EXPIRED';
  paid: boolean;
  payment_ref: string | null;
  amount_minor: number;
  currency: string | null;
  payment_id: string | null; // the Aramo payment id from the references
  live: boolean;
}

export interface PaymentRefundRequest {
  account_ref: string;
  payment_ref: string;
  amount_minor: number;
  // Return the proportional application fee to the payer's refund (true when one was taken).
  refund_application_fee: boolean;
  references: { tenant_id: string; payment_id: string; refund_id: string };
  idempotency_key: string;
}

export interface PaymentRefundState {
  refund_ref: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  amount_minor: number;
  refund_id: string | null; // the Aramo refund id from the references
}

export interface PaymentChargeState {
  payment_ref: string;
  amount_minor: number;
  amount_refunded_minor: number;
}

// A verified provider event, translated to Aramo's own kinds.
export type VerifiedPaymentEvent =
  | { event_ref: string; event_type: string; account_ref: string | null; kind: 'ACCOUNT_UPDATED'; account: PaymentAccountState }
  | { event_ref: string; event_type: string; account_ref: string | null; kind: 'CHECKOUT_COMPLETED' | 'CHECKOUT_EXPIRED' | 'CHECKOUT_PAYMENT_FAILED'; checkout: PaymentCheckoutState }
  | { event_ref: string; event_type: string; account_ref: string | null; kind: 'CHARGE_REFUNDED'; charge: PaymentChargeState }
  | { event_ref: string; event_type: string; account_ref: string | null; kind: 'REFUND_UPDATED'; refund: PaymentRefundState & { payment_ref: string | null } }
  | { event_ref: string; event_type: string; account_ref: string | null; kind: 'ACCOUNT_DEAUTHORIZED' }
  | { event_ref: string; event_type: string; account_ref: string | null; kind: 'OTHER' };

/** The provider answered with a refusal (4xx): not retryable. */
export class PaymentProviderRefusedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PaymentProviderRefusedError';
  }
}

/** The provider is not configured, unreachable, rate-limited or failing (retryable). */
export class PaymentProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderUnavailableError';
  }
}

/** A webhook whose signature is missing, stale or invalid. */
export class PaymentWebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentWebhookSignatureError';
  }
}

export interface PaymentProviderPort {
  /** True when the adapter has the settings it needs (keys present). */
  configured(): boolean;
  createAccount(input: { tenant_id: string; email: string | null; idempotency_key: string }): Promise<PaymentAccountState>;
  getAccount(account_ref: string): Promise<PaymentAccountState>;
  createOnboardingLink(input: { account_ref: string; refresh_url: string; return_url: string }): Promise<{ url: string; expires_at: Date }>;
  createCheckout(input: PaymentCheckoutRequest): Promise<PaymentCheckoutState>;
  getCheckout(account_ref: string, checkout_ref: string): Promise<PaymentCheckoutState>;
  createRefund(input: PaymentRefundRequest): Promise<PaymentRefundState>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, now?: Date): VerifiedPaymentEvent;
}
