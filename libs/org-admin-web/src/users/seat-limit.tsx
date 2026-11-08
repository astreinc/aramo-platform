import { ApiError, productByKey, ssoEntryHref, type ProductAvailabilityView } from '@aramo/fe-foundation';

// Sign Business per-seat directive (v1.0 LOCKED) §3.7 — on a per-seat Aramo Sign plan, giving one more
// person Sign send access (invite, role change, re-enable) beyond the purchased seats is refused with
// 409 `seat_limit_reached` ({ used, purchased }). The invite and role editors show the owner's words
// with a link to Aramo Sign → Billing, where the owner or an admin adds seats.

export const SEAT_LIMIT_REASON = 'seat_limit_reached';

export interface SeatLimit {
  /** The purchased seats, when the server says (null: unknown). */
  readonly purchased: number | null;
}

/** The seat cap refusal, or null for any other error. */
export function seatLimitOf(err: unknown): SeatLimit | null {
  if (!(err instanceof ApiError) || err.details?.['reason'] !== SEAT_LIMIT_REASON) return null;
  const purchased = err.details['purchased'];
  return { purchased: typeof purchased === 'number' ? purchased : null };
}

export function seatLimitText(purchased: number | null): string {
  return `All ${purchased !== null ? `${purchased} ` : ''}seats are in use. Add a seat to invite more people.`;
}

/** Fallback when the Sign host is unknown (no link). */
export const SEAT_LIMIT_WHERE = 'Add seats in Aramo Sign → Billing.';

/** Aramo Sign Settings › Plan & billing, through Sign's sign-in route (it may be on its own host). */
export function signBillingHref(products: ProductAvailabilityView | null | undefined): string | null {
  const sign = productByKey(products ?? null, 'sign');
  if (sign === null || !sign.available || sign.entry_path === null) return null;
  const entry = sign.entry_path;
  if (/^https?:\/\//i.test(entry)) return ssoEntryHref(`${new URL(entry).origin}/sign/settings/billing`, 'sign');
  if (entry.startsWith('/') && !entry.startsWith('//')) return ssoEntryHref('/sign/settings/billing', 'sign');
  return null;
}

export function SeatLimitAlert({ limit, billingHref }: { readonly limit: SeatLimit; readonly billingHref: string | null }) {
  return (
    <div className="ox-alert ox-alert--error" role="alert" data-testid="seat-limit-alert">
      {seatLimitText(limit.purchased)}{' '}
      {billingHref !== null ? (
        <a className="ox-link" href={billingHref} data-testid="seat-limit-billing-link">
          Go to Aramo Sign → Billing
        </a>
      ) : (
        SEAT_LIMIT_WHERE
      )}
    </div>
  );
}
