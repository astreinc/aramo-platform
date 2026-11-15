// Aramo-Sign-Catalog-v2-Pricing-and-Features-Directive-v1_0-LOCKED (SHA fc755040…) §3, §4.4.
// The backend catalog (GET /v1/sign/billing/plans, /account) stays the authority for prices,
// limits and what a plan includes; these constants cover only copy that has no catalog field:
// the Personal upgrade offer when the backend does not describe it, the signup cards, and the
// "Coming soon" list (features not built, shown but never sold, P-1). No strikethrough (P-2).

export const FREE_PERSONAL_PLAN_KEY = 'aramo-sign-free-personal-v1';
export const STANDARD_PERSONAL_PLAN_KEY = 'aramo-sign-standard-personal-v1';

/** Fallback for the Personal upgrade offer (directive §3) if /account carries no `upgrade`. */
export const STANDARD_PERSONAL_OFFER = {
  plan_key: STANDARD_PERSONAL_PLAN_KEY,
  name: 'Standard',
  price_minor: 1000,
  monthly_documents: 25,
  storage: '1 GB',
  commitment_months: 12,
} as const;

/** The lowest Business price, for the signup card (Standard Business, directive §3). */
export const BUSINESS_FROM_PRICE = '$15/month';

/** Directive §3 "Coming soon" — shown, marked not included, never sold. */
export const COMING_SOON: readonly string[] = [
  'Templates',
  'Forms',
  'Bulk send & bulk sign',
  'Signer groups & signer attachments',
  'Conditional & formula fields',
  'SMS & WhatsApp delivery',
  'Recipient verification (SMS, ID, knowledge-based)',
  'Branding',
  'Custom domain & white label',
  'AI summary & assistant',
  'Reports',
  'Payment collection',
  'Advanced, qualified & witness signatures',
  'Delegate signing',
  'Timestamping',
  'Stamp duty payment',
  'SDKs',
  'Custom roles',
  'Priority support',
];

/**
 * India Billing Regions + Razorpay (directive v1.0 §4.11) — a price in minor units, in the currency the
 * backend reports (USD shows $, INR shows ₹). Whole amounts show no decimals ("$10", "₹899").
 */
export function formatMinor(minor: number, currency = 'USD'): string {
  const code = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minor / 100);
}

/** A US-dollar price (catalog constants with no currency field: the signup cards, the Free allowance copy). */
export function usd(minor: number): string {
  return formatMinor(minor, 'USD');
}

/** India Billing §4.11 — the web gateway of the caller's billing region (GET plans / the upgrade offer). */
export type BillingGateway = 'STRIPE' | 'RAZORPAY';

/**
 * India Billing §4.11 — what the payer approves on Razorpay's page, shown BEFORE the redirect (Razorpay's
 * hosted page carries no Aramo renewal text).
 */
export const RAZORPAY_MANDATE_TEXT = 'You’ll approve a monthly auto-pay mandate (UPI, card or net banking) on Razorpay’s secure page.';

/** The line under a checkout button: where payment details are entered. */
export function checkoutPageText(gateway: BillingGateway | null | undefined): string {
  return gateway === 'RAZORPAY' ? RAZORPAY_MANDATE_TEXT : 'Enter payment details on the secure checkout page.';
}

/** Per-seat directive §3.5 — the most seats one organization buys online (the API's bound). */
export const MAX_SEATS = 1000;

/** "3 of 5 seats used". */
export function seatsUsedText(used: number, purchased: number): string {
  return `${used} of ${purchased} seat${purchased === 1 ? '' : 's'} used`;
}

// ── Billing terms (Sign Monthly and Annual-Commitment Pricing Directive v1.0) ──────────────────────────
// Both terms are billed monthly: MONTHLY has no commitment (cancel anytime, it ends at the end of the paid
// month); ANNUAL_COMMIT has a 12-month commitment at its own price, then continues month to month at the
// Monthly price. A plan from an older backend (no billing_terms) reads as one term from its price fields.

export type TermCode = 'MONTHLY' | 'ANNUAL_COMMIT';

export interface TermOption {
  term: TermCode;
  amount_minor: number;
  currency: string;
  commitment_months: number | null;
  purchasable: boolean;
  default: boolean;
}

interface TermSource {
  price?: { amount_minor: number; currency: string } | null;
  commitment_months: number | null;
  purchasable?: boolean;
  billing_terms?: { term: TermCode; price: { amount_minor: number; currency: string }; commitment_months: number | null; default: boolean; purchasable: boolean }[];
}

/** The terms of a plan: its billing_terms (MONTHLY first), else one derived from price / commitment. */
export function planTerms(p: TermSource): TermOption[] {
  if (p.billing_terms !== undefined) {
    return p.billing_terms.map((t) => ({ term: t.term, amount_minor: t.price.amount_minor, currency: t.price.currency, commitment_months: t.commitment_months, purchasable: t.purchasable, default: t.default }));
  }
  if (p.price == null) return [];
  return [{ term: p.commitment_months !== null ? 'ANNUAL_COMMIT' : 'MONTHLY', amount_minor: p.price.amount_minor, currency: p.price.currency, commitment_months: p.commitment_months, purchasable: p.purchasable ?? true, default: true }];
}

/** The term a choice starts on: MONTHLY when offered, else the default, else the first. */
export function initialTerm(terms: readonly TermOption[]): TermCode | null {
  return (terms.find((t) => t.term === 'MONTHLY') ?? terms.find((t) => t.default) ?? terms[0])?.term ?? null;
}

/** "No commitment, cancel anytime" / "12-month commitment, billed monthly". */
export function termCommitmentText(t: Pick<TermOption, 'commitment_months'>): string {
  return t.commitment_months !== null ? `${t.commitment_months}-month commitment, billed monthly` : 'No commitment, cancel anytime';
}

/** The option's name: "Monthly" / "Annual". */
export function termLabel(term: TermCode): string {
  return term === 'ANNUAL_COMMIT' ? 'Annual' : 'Monthly';
}

/** "Save $2/month (20%)" against the Monthly price; null when there is no saving. */
export function termSavingText(t: Pick<TermOption, 'amount_minor' | 'currency'>, monthly: Pick<TermOption, 'amount_minor'> | undefined): string | null {
  if (monthly === undefined || monthly.amount_minor <= t.amount_minor || monthly.amount_minor <= 0) return null;
  const diff = monthly.amount_minor - t.amount_minor;
  const pct = Math.round((diff / monthly.amount_minor) * 100);
  return `Save ${formatMinor(diff, t.currency)}/month${pct > 0 ? ` (${pct}%)` : ''}`;
}

/**
 * The disclosure of a chosen term on a plan that offers two, shown before the redirect. MONTHLY: no
 * commitment, cancel anytime, it ends at the end of the paid month. ANNUAL_COMMIT: the commitment billed
 * monthly, then month to month at the Monthly price.
 */
export function termDisclosureText(t: TermOption, monthly: TermOption | undefined): string {
  const price = `${formatMinor(t.amount_minor, t.currency)}/month`;
  if (t.commitment_months === null) return `${price}, billed monthly with no commitment. Cancel anytime; your plan ends at the end of the month you’ve paid for.`;
  const after = monthly !== undefined && monthly.term === 'MONTHLY' ? ` at the Monthly price (${formatMinor(monthly.amount_minor, monthly.currency)}/month)` : '';
  return `${price}, ${t.commitment_months}-month commitment billed monthly. After the commitment it continues month to month${after} until you cancel; a cancellation inside the commitment takes effect at its end.`;
}

/** A seat count typed by the owner: a whole number between `min` and MAX_SEATS, else null. */
export function parseSeats(raw: string, min: number): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= Math.max(1, min) && n <= MAX_SEATS ? n : null;
}
