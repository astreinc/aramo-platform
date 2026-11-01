// Aramo Sign 1.14 — the payment settings (platform secrets in the box .env, never in code
// or data). SEPARATE from Aramo's own billing keys (STRIPE_*): these belong to the Stripe
// Connect PLATFORM account that collects for subscribers.
//
//   SIGN_STRIPE_CONNECT_ENABLED                 1 turns payments on. Unset = off (dark).
//   SIGN_STRIPE_CONNECT_SECRET_KEY              the Connect platform API key (sk_test_… until
//                                               live payments are separately authorized)
//   SIGN_STRIPE_CONNECT_WEBHOOK_SECRET          the Connect webhook endpoint signing secret
//   SIGN_STRIPE_CONNECT_APPLICATION_FEE_AMOUNT  Aramo's fee per payment, in cents. Default 0
//                                               (no fee). Never more than the payment less 1.
//   SIGN_STRIPE_CONNECT_API_BASE                optional override (tests only)
//
// Payments run only when ENABLED=1 AND both keys are set; anything else is off.

export interface SignStripeConnectConfig {
  enabled: boolean;
  secret_key: string | null;
  webhook_secret: string | null;
  application_fee_minor: number;
  api_base: string;
}

const val = (env: NodeJS.ProcessEnv, k: string): string | null => {
  const v = env[k];
  return v === undefined || v.trim() === '' ? null : v.trim();
};

export function signStripeConnectConfig(env: NodeJS.ProcessEnv = process.env): SignStripeConnectConfig {
  const fee = val(env, 'SIGN_STRIPE_CONNECT_APPLICATION_FEE_AMOUNT');
  const n = fee === null ? 0 : Number(fee);
  return {
    enabled: env['SIGN_STRIPE_CONNECT_ENABLED'] === '1',
    secret_key: val(env, 'SIGN_STRIPE_CONNECT_SECRET_KEY'),
    webhook_secret: val(env, 'SIGN_STRIPE_CONNECT_WEBHOOK_SECRET'),
    // A malformed or negative fee is treated as 0 (never charge a fee by mistake).
    application_fee_minor: Number.isInteger(n) && n > 0 ? n : 0,
    api_base: (val(env, 'SIGN_STRIPE_CONNECT_API_BASE') ?? 'https://api.stripe.com').replace(/\/+$/, ''),
  };
}

/** The fee for one payment: the configured fee, capped so the subscriber always receives at least 1 cent. */
export function applicationFeeFor(amount_minor: number, configured_fee_minor: number): number {
  if (configured_fee_minor <= 0) return 0;
  return Math.min(configured_fee_minor, amount_minor - 1);
}
