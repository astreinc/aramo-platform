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

export function usd(minor: number): string {
  const amount = minor / 100;
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/** Per-seat directive §3.5 — the most seats one organization buys online (the API's bound). */
export const MAX_SEATS = 1000;

/** "3 of 5 seats used". */
export function seatsUsedText(used: number, purchased: number): string {
  return `${used} of ${purchased} seat${purchased === 1 ? '' : 's'} used`;
}

/** A seat count typed by the owner: a whole number between `min` and MAX_SEATS, else null. */
export function parseSeats(raw: string, min: number): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= Math.max(1, min) && n <= MAX_SEATS ? n : null;
}
