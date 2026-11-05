// M-A12 W1-G (A1 rulings) — the Plans screen model. Pure; everything comes from the
// server (GET /v1/sign/billing/plans, already filtered to the caller's tenant kind, and
// GET /v1/sign/billing/account) and from the store (localized prices):
//   - plan names, descriptions and features are the server's (never hard-coded, R-1/R-5;
//     only features that are enabled AND available, never an AI feature, D-4);
//   - the price shown is the STORE's localized price of the mapped product id (A1-3);
//   - the interval toggle appears only when the plan maps both MONTH and YEAR (A1-1);
//   - purchase controls appear only while the server reports store billing as available
//     (`store_purchase_eligible`, or plans with `store_products`); otherwise the screen
//     shows the plan and usage and "Manage your plan at sign.aramo.ai", with no price and
//     no link;
//   - a refusal reason maps to copy ("Ask your admin", "Manage your plan at sign.aramo.ai").
import type {
  BillingAccountStoreFields,
  BillingPlanStoreFields,
  StoreInterval,
  StorePlatform,
  StoreProduct,
  StorePurchaseBlockReason,
} from '../../api/m-a12-contract-types';
import type { components } from '../../api/generated/sign';
import type { PlansEntry } from '../../navigation/types';

export type Plan = components['schemas']['BillingPlan'] & BillingPlanStoreFields;
export type Account = components['schemas']['BillingAccount'] & BillingAccountStoreFields;

export const MANAGE_ON_WEB = 'Manage your plan at sign.aramo.ai';

export const PLANS_COPY = {
  askAdmin: 'Ask your admin to change the plan.',
  manageOnWeb: MANAGE_ON_WEB,
  teamOnWeb: `Plans for teams are bought on the web. ${MANAGE_ON_WEB}`,
  billedOnWeb: `Your plan is billed on the web. ${MANAGE_ON_WEB}`,
  billedInOtherStore: 'Your plan is billed through another app store. Manage it there.',
  unavailable: `In-app purchase isn’t available right now. ${MANAGE_ON_WEB}`,
  boundElsewhere: 'This store subscription belongs to another Aramo Sign account.',
  pending: 'Your purchase is pending. Your plan updates when the store confirms it.',
  failed: 'The purchase didn’t go through. You haven’t been charged.',
  verifyFailed: 'We couldn’t confirm the purchase yet. Use Restore purchases in a moment.',
  restored: 'Your purchases were restored.',
  nothingToRestore: 'No purchases to restore for this account.',
  current: 'Current plan',
  priceUnavailable: 'Price unavailable',
  signingFree: 'Signing is always free. Upgrade when you need to send more.',
} as const;

/** The store renewal disclosure (prototype storeNote), per platform. */
export const STORE_NOTE: Record<StorePlatform, string> = {
  ios: 'Payment is charged to your Apple Account when you confirm. The subscription renews automatically unless you turn it off at least 24 hours before the period ends.',
  android:
    'Payment is charged to your Google Play account. The subscription renews automatically; cancel anytime in Google Play › Subscriptions.',
};

export function blockCopy(reason: StorePurchaseBlockReason | string | null | undefined, account?: Account | null): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case 'not_billing_manager':
      return PLANS_COPY.askAdmin;
    case 'store_purchase_seats_unsupported':
      return PLANS_COPY.teamOnWeb;
    case 'billing_managed_elsewhere':
      return account?.managed_by === 'APP_STORE' || account?.managed_by === 'GOOGLE_PLAY'
        ? PLANS_COPY.billedInOtherStore
        : PLANS_COPY.billedOnWeb;
    case 'store_purchase_bound_elsewhere':
      return PLANS_COPY.boundElsewhere;
    case 'store_billing_disabled':
      return PLANS_COPY.unavailable;
    default:
      return PLANS_COPY.unavailable;
  }
}

/** Plans the app can show: active, self-service or free (never contact-sales or operator). */
export function visiblePlans(plans: readonly Plan[]): Plan[] {
  return plans.filter((p) => p.status === 'ACTIVE' && (p.sales_model === 'SELF_SERVICE' || p.sales_model === 'FREE'));
}

export function storeProducts(plan: Plan, platform: StorePlatform): StoreProduct[] {
  return (plan.store_products ?? []).filter((x) => x.platform === platform && typeof x.product_id === 'string');
}

/** The intervals the server maps for the plan on this platform (MONTH before YEAR). */
export function intervals(plan: Plan, platform: StorePlatform): StoreInterval[] {
  const set = new Set(storeProducts(plan, platform).map((x) => x.interval));
  return (['MONTH', 'YEAR'] as const).filter((i) => set.has(i));
}

export function showIntervalToggle(plan: Plan, platform: StorePlatform): boolean {
  return intervals(plan, platform).length === 2;
}

export function productFor(plan: Plan, platform: StorePlatform, interval: StoreInterval): StoreProduct | null {
  return storeProducts(plan, platform).find((x) => x.interval === interval) ?? null;
}

/** Store billing is on for this account (the server says so). */
export function storeBillingAvailable(account: Account | null | undefined, plans: readonly Plan[]): boolean {
  return account?.store_purchase_eligible === true || plans.some((p) => (p.store_products?.length ?? 0) > 0);
}

export function isCurrent(plan: Plan, account: Account | null | undefined): boolean {
  const sub = account?.subscription;
  return !!sub && sub.plan_key === plan.key && sub.ended_at == null;
}

/** The tab a screen opens on: the first plan above the current one, else the current. */
export function initialPlanKey(plans: readonly Plan[], account: Account | null | undefined): string | null {
  const i = plans.findIndex((p) => isCurrent(p, account));
  return plans[i + 1]?.key ?? plans[i]?.key ?? plans[0]?.key ?? null;
}

const FEATURE_LABEL: Record<string, string> = {
  'sign.team_collaboration': 'Team collaboration',
  'sign.advanced_analytics': 'Advanced analytics',
  'sign.custom_domain': 'Custom domain',
  'sign.in_person_signing': 'In-person signing',
  'sign.bulk_send': 'Bulk send',
  'sign.reminders': 'Reminders',
  'sign.branding': 'Your logo on signing emails',
};

function bytesLabel(n: number): string {
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`;
  if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function humanize(key: string): string {
  const s = key.replace(/^sign\./, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The plan's feature lines, from what the server says is included AND operational. */
export function featureLines(plan: Plan): string[] {
  const lines: string[] = ['Signing is always free'];
  const env = plan.allowances.find((a) => a.allowance_key === 'sign.envelopes' && a.available);
  if (env) lines.push(env.unlimited ? 'Unlimited sends' : `${env.included_quantity ?? 0} sends a month`);
  const tpl = plan.capacities.find((c) => c.capacity_key === 'sign.templates' && c.available);
  if (tpl && (tpl.unlimited || (tpl.limit ?? 0) > 0))
    lines.push(tpl.unlimited || tpl.limit === null ? 'Unlimited templates' : `${tpl.limit} templates`);
  const storage = plan.capacities.find((c) => c.capacity_key === 'sign.storage_bytes' && c.available);
  if (storage && !storage.unlimited && storage.limit !== null) lines.push(`${bytesLabel(storage.limit)} storage`);
  for (const f of plan.features) {
    // D-4 HOLD: no AI feature is ever advertised, whatever the server returns.
    if (!f.enabled || f.available !== true || /(^|\.)ai[_.]/.test(f.feature_key)) continue;
    lines.push(FEATURE_LABEL[f.feature_key] ?? humanize(f.feature_key));
  }
  return lines;
}

/** Plans whose catalog includes templates (for the Templates reason line). */
export function plansWithTemplates(plans: readonly Plan[]): string[] {
  return plans
    .filter((p) => p.capacities.some((c) => c.capacity_key === 'sign.templates' && c.available && (c.unlimited || (c.limit ?? 0) > 0)))
    .map((p) => p.name);
}

/** The line under the title, by where the screen was opened from. */
export function reasonLine(
  from: PlansEntry | undefined,
  plans: readonly Plan[],
  limitBody: string | null,
): string {
  if (from === 'templates') {
    const names = plansWithTemplates(plans);
    if (names.length > 0) return `Templates come with ${names.join(' and ')}.`;
  }
  if ((from === 'limit' || from === 'home') && limitBody) return limitBody;
  return PLANS_COPY.signingFree;
}

export function intervalLabel(i: StoreInterval): string {
  return i === 'YEAR' ? 'Yearly' : 'Monthly';
}

export function perInterval(i: StoreInterval): string {
  return i === 'YEAR' ? '/ year' : '/ month';
}

/** Account › Plan: the current plan's name, else "See plans". */
export function planRowLabel(account: Account | null | undefined): string {
  const sub = account?.subscription;
  return sub?.plan_name ?? 'See plans';
}

export interface PlanAction {
  readonly kind: 'current' | 'buy' | 'blocked' | 'none';
  readonly message: string | null;
}

/** What the plan card offers. */
export function planAction(input: {
  readonly plan: Plan;
  readonly account: Account | null | undefined;
  readonly storeOn: boolean;
  readonly product: StoreProduct | null;
  readonly priced: boolean;
}): PlanAction {
  const { plan, account } = input;
  if (isCurrent(plan, account)) return { kind: 'current', message: null };
  if (plan.sales_model === 'FREE') return { kind: 'none', message: null };
  if (!input.storeOn) return { kind: 'blocked', message: MANAGE_ON_WEB };
  const reason = account?.store_purchase_block_reason ?? null;
  if (reason) return { kind: 'blocked', message: blockCopy(reason, account) };
  if (account && account.can_manage_billing === false) return { kind: 'blocked', message: PLANS_COPY.askAdmin };
  if (account && account.store_purchase_eligible === false) return { kind: 'blocked', message: PLANS_COPY.unavailable };
  if (!input.product || !input.priced) return { kind: 'blocked', message: PLANS_COPY.priceUnavailable };
  return { kind: 'buy', message: null };
}
