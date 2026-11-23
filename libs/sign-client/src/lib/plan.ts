// Client Rule Consolidation C3 (audit rows 14–17) — plan and feature gating read ONLY from
// what the server sends (GET /v1/sign/sender/context, /v1/sign/billing/plans, /account). No
// plan fact (price, document count, storage) is written into a client: the CCP console is the
// one source of plans and prices, and a screen without server data shows no number at all.

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

// ── templates (row 14) ───────────────────────────────────────────────────────

export type TemplateAccess = 'unavailable' | 'upgrade' | 'no-permission' | 'ok';

/**
 * Row 14 — may the caller use templates (`need: 'use'`) or author them in the Template Studio
 * (`need: 'studio'`)? In the server's order (sender-context.service.ts templateView):
 * sign.templates available, then the plan (template_plan INCLUDED; null / absent = not read),
 * then the caller's template permission, then (studio only) template_studio.
 */
export function templateAccess(context: unknown, need: 'use' | 'studio' = 'use'): TemplateAccess {
  const c = rec(context);
  if (rec(c['features'])['templates'] !== true) return 'unavailable';
  const plan = c['template_plan'];
  if (typeof plan === 'string' && plan !== 'INCLUDED') return 'upgrade';
  if (rec(c['permissions'])['templates'] !== true) return 'no-permission';
  if (need === 'studio' && c['template_studio'] !== true) return 'no-permission';
  return 'ok';
}

// ── per-recipient send options (row 15) ──────────────────────────────────────

export interface SendFeatures {
  readonly witness: boolean;
  readonly delegation: boolean;
  readonly accessCode: boolean;
  readonly sms: boolean;
  readonly whatsapp: boolean;
  readonly smsCode: boolean;
  readonly idCheck: boolean;
  readonly kba: boolean;
}

export const NO_SEND_FEATURES: SendFeatures = {
  witness: false,
  delegation: false,
  accessCode: false,
  sms: false,
  whatsapp: false,
  smsCode: false,
  idCheck: false,
  kba: false,
};

/** Row 15 — each option only while the sender context reports it (`features.<key> === true`). */
export function sendFeaturesOf(context: unknown): SendFeatures {
  const f = rec(rec(context)['features']);
  const on = (k: string): boolean => f[k] === true;
  return {
    witness: on('witness_signing'),
    delegation: on('delegate_signing'),
    accessCode: on('access_code'),
    sms: on('sms_delivery'),
    whatsapp: on('whatsapp_delivery'),
    smsCode: on('sms_otp'),
    idCheck: on('id_verification'),
    kba: on('kba'),
  };
}

/** Any text option is offered (GET …/messaging is refused otherwise). */
export function messagingOffered(f: SendFeatures): boolean {
  return f.sms || f.whatsapp || f.smsCode;
}

// ── plan facts (row 16) ──────────────────────────────────────────────────────

export const ENVELOPE_ALLOWANCE_KEY = 'sign.envelopes';
export const STORAGE_CAPACITY_KEY = 'sign.storage_bytes';
export const TEMPLATES_CAPACITY_KEY = 'sign.templates';

/** A catalog plan as GET /v1/sign/billing/plans reports it (the fields read here). */
export interface CatalogPlanLike {
  readonly name?: string;
  readonly allowances?: readonly { allowance_key: string; included_quantity: number | null; unlimited: boolean; available?: boolean }[];
  readonly capacities?: readonly { capacity_key: string; limit: number | null; unlimited: boolean; available?: boolean }[];
}

export interface PlanFacts {
  /** Documents a month: a number, 'unlimited', or null when the server did not say. */
  readonly monthlyDocuments: number | 'unlimited' | null;
  /** Storage in bytes, 'unlimited', or null when the server did not say. */
  readonly storageBytes: number | 'unlimited' | null;
  /** Templates: true / false when the catalog lists the capacity, else null. */
  readonly templates: boolean | null;
}

/** Row 16 — what a catalog plan includes, from its allowances and capacities only. */
export function planFacts(plan: CatalogPlanLike | null | undefined): PlanFacts {
  const env = plan?.allowances?.find((a) => a.allowance_key === ENVELOPE_ALLOWANCE_KEY && a.available !== false);
  const storage = plan?.capacities?.find((c) => c.capacity_key === STORAGE_CAPACITY_KEY && c.available !== false);
  const tpl = plan?.capacities?.find((c) => c.capacity_key === TEMPLATES_CAPACITY_KEY && c.available !== false);
  return {
    monthlyDocuments: env === undefined ? null : env.unlimited ? 'unlimited' : env.included_quantity,
    storageBytes: storage === undefined ? null : storage.unlimited ? 'unlimited' : storage.limit,
    templates: plan?.capacities === undefined ? null : tpl !== undefined && (tpl.unlimited || (tpl.limit ?? 0) > 0),
  };
}

/** "15 MB", "1 GB" (binary units, as the server counts bytes). */
export function storageLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Row 16 — the plan line built from the account (GET /v1/sign/billing/account): the monthly
 * allowance, the daily window, the storage cap. Each part appears only when the server sent
 * it; with nothing known the line is empty.
 */
export function allowanceTermsLine(input: {
  readonly monthly?: number | null;
  readonly daily?: number | null;
  readonly storageBytes?: number | null;
  readonly templates?: boolean | null;
}): string {
  const usage: string[] = [];
  if (typeof input.monthly === 'number') usage.push(`${input.monthly} documents a month`);
  if (typeof input.daily === 'number') usage.push(`up to ${input.daily} a day`);
  const parts: string[] = [];
  if (usage.length > 0) parts.push(usage.join(', '));
  if (typeof input.storageBytes === 'number') parts.push(`${storageLabel(input.storageBytes)} storage`);
  if (input.templates === false) parts.push('templates aren’t included');
  return parts.join(' · ');
}

// ── limit reached (row 17) ───────────────────────────────────────────────────

export interface LimitCopy {
  readonly kind: 'daily' | 'monthly';
  readonly title: string;
  readonly body: string;
}

/**
 * Row 17 — the allowance-reached copy ("documents", the plan wording; Appendix A). `at` is
 * the time the next send is possible (daily) or the allowance resets (monthly), already
 * formatted by the screen in the user's locale; null when the server did not say.
 */
export function limitReachedCopy(kind: 'daily' | 'monthly', limit: number | null, at: string | null): LimitCopy {
  if (kind === 'monthly') {
    const used = limit === null ? 'You’ve used all your documents this month.' : `You’ve used all ${limit} documents this month.`;
    return { kind, title: 'Monthly limit reached', body: at === null ? used : `${used} Your allowance resets on ${at}.` };
  }
  const sent =
    limit === null
      ? 'You’ve sent the most documents your plan allows in 24 hours.'
      : `You’ve sent ${limit} documents in the last 24 hours, the most your plan allows.`;
  return { kind, title: 'Daily limit reached', body: at === null ? sent : `${sent} You can send again at ${at}.` };
}

/** Whether an allowance refusal's details name the daily window (Personal Free: any 24 hours). */
export function isDailyAllowance(details: Readonly<Record<string, unknown>> | null | undefined): boolean {
  const d = details ?? {};
  const tag = [d['reason'], d['window'], d['period']].filter((v): v is string => typeof v === 'string').join(' ').toUpperCase();
  return /DAY|DAILY/.test(tag);
}

// ── a plan arranged with Aramo (CCP-PERSONAL-ARRANGED-1 P-7; PO ruling D-8) ─────────────────
// The server decides (GET /v1/sign/billing/account `subscription.arranged`, sent with no price,
// commitment or term); sign-web and the app render it with this one copy.

/** The refusal copy for a store or web purchase while the plan is arranged with Aramo. */
export const ARRANGED_PURCHASE_BLOCKED = 'Your plan is arranged with Aramo. Contact support to change it.';

/**
 * The purchase refusals a plan arranged with Aramo answers with: `billing_managed_elsewhere`
 * (store intent / verify / restore and the account's store block) and
 * `governed_subscription_open` (web checkout).
 */
export const ARRANGED_PURCHASE_REFUSALS: readonly string[] = ['billing_managed_elsewhere', 'governed_subscription_open'];

/** The account's open plan is arranged with Aramo (the server's `subscription.arranged`). */
export function isArrangedPlan(account: unknown): boolean {
  const sub = rec(rec(account)['subscription']);
  return sub['arranged'] === true && (sub['ended_at'] === null || sub['ended_at'] === undefined);
}

/** "Standard · arranged with Aramo" — the plan's own name (the server's plan_name). */
export function arrangedPlanLabel(planName: string | null | undefined): string {
  const name = typeof planName === 'string' ? planName.trim() : '';
  return name === '' ? 'Arranged with Aramo' : `${name} · arranged with Aramo`;
}

/**
 * The copy for a purchase refusal on an account whose plan is arranged with Aramo; null when the
 * plan is not arranged or the refusal is not one a managed plan answers with (the caller then
 * shows its usual copy).
 */
export function arrangedPurchaseRefusal(account: unknown, reason: string | null | undefined): string | null {
  if (!isArrangedPlan(account) || typeof reason !== 'string') return null;
  return ARRANGED_PURCHASE_REFUSALS.includes(reason) ? ARRANGED_PURCHASE_BLOCKED : null;
}
