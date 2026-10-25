import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { type AllowanceReadResult, AllowanceService, subscriptionSends } from '../allowance.service.js';
import { addMonthsClamped } from '../billing-period.js';
import { CapacityService, type CapacityStatus } from '../capacity.service.js';
import { isFeatureAvailable } from '../feature-availability.js';
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_REGISTRY, approvedLegalDocument, type LegalDocumentVersion } from '../legal/legal-documents.js';
import { PIN_REASON_PROVIDER_PLAN_CHANGE, planVersionTerms } from '../plan-version.js';
import { currentPublishedVersion } from '../plan-version.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, assertProductKey, openBaseSubscription, type ProductKey } from '../product-registry.js';

import {
  BILLING_PROVIDER_COMMAND_PORT,
  BILLING_PROVIDER_PORT,
  type BillingProviderCommandPort,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  type ProviderSubscriptionState,
  type VerifiedBillingEvent,
} from './billing-provider.port.js';
import {
  type BillingCommandConfirmation,
  REFETCH_CONFIRMATION,
  confirmSessionCommandsInTx,
  confirmSubscriptionCommandsInTx,
} from './billing-provider-command.js';
import { ORGANIZATION_BILLING_PROFILE_PORT, type OrganizationBillingProfile, type OrganizationBillingProfilePort } from './organization-billing-profile.port.js';
import { PLAN_ELIGIBILITY_PORT, type PlanEligibilityPort, type PlanEligibilityRule } from './plan-eligibility.port.js';
import { type PriceResolution, effectiveProviderPrice, parsePlanPrices, resolvePriceToVersion } from './provider-price.js';
import { GOVERNED_SUBSCRIPTION_OPEN, isGovernedSubscription, takeBillingLock } from './governed-subscription.js';

export { parsePlanPrices } from './provider-price.js';

// Aramo Sign launch — the subscription lifecycle (Final Implementation
// Authorization: commercial authority). Stripe is authoritative for payment
// events; Aramo is authoritative for the effective entitlement.
//
//   checkout  → a CheckoutIntent records WHO (tenant, user, plan) started it;
//               the browser never asserts payment.
//   webhook   → signature verified by the provider adapter; each event is
//               processed at most once (BillingEvent); the subscription is
//               RE-FETCHED from the provider under a per-tenant lock, so a late
//               or reordered event can never apply an older state.
//   activate  → the first sending state opens a SELF_SERVICE subscription and
//               ends an open DEVELOPMENT one in the same tx. It NEVER ends an open
//               governed (MANUAL) subscription: that activation is held (CCP-A6,
//               Conversion Rule C-6/C-7). The caller grants the subscribing-owner
//               role (identity lives in the service layer, not here).
//   reconcile → open provider-linked subscriptions are re-fetched periodically
//               (missed webhooks heal).
// In-flight signing is never gated by any of this: only NEW sends read the
// subscription (AllowanceService.reserve).
//
// Commercial Plans Amendment A1 — the four-plan catalog (Free Personal INACTIVE,
// Standard Business, Standard Professional eligibility-bound to ATS, Enterprise
// contact-sales and unconfigured); the commitment term is tracked apart from the
// monthly invoice period (a cancellation inside it is flagged, never treated as
// month-to-month); eligibility lapses are surfaced, never auto-downgraded;
// checkout records accepted terms, and LIVE-mode checkout needs APPROVED terms.
//
// Sign Signup Amendment A1 (Organization Details, US only) §2.6 — checkout needs
// an ELIGIBLE organization profile (OrganizationBillingProfilePort; unbound →
// refused) and locks the tenant's profile to the US; Aramo creates / updates the
// provider billing account from that profile (TenantBillingAccount) and Checkout
// runs on it. Activation guard: every sync re-reads the provider's billing
// country; anything but US never opens or (re)activates a subscription — the
// event is kept as IGNORED evidence and a BillingReconciliationFlag is raised
// (resolved by a later US sync).
//
// Domain-Enforcement P3 §4 (sending gate, ruling 5) — a NEW self-service
// subscription needs the tenant's email-domain claim to be AUTHORITATIVE: checked
// at checkout start (DOMAIN_VERIFICATION_REQUIRED) and at activation, beside the
// A1 country guard (hold + a 'domain_not_authoritative' reconciliation flag,
// resolved by a later sync once authoritative). MANUAL subscriptions and the
// shared send path are not gated here.
//
// CCP-A4 (MP-A2 N-9, N-11, N-12) — product context is explicit on every operation that
// resolves or mutates a subscription (a required ProductKey, no defaulting overload):
// catalog, account, subscribing-owner lookup, checkout, portal, webhook application,
// eligibility refresh and reconciliation. Only the product's open BASE subscription is
// read, ended or replaced; a provider subscription or checkout of another product is
// IGNORED and left untouched; a provider price resolves only to a plan of the same
// product (the composite FK refuses a cross-product plan at the DB as well).
//
// CCP-A5 (MP-A2 N-17, N-18; Charter D3) — every subscription is pinned to a plan VERSION
// (plan_version_id). Terms (commitment, eligibility, list price, features) are read from the
// pinned version; the catalog and checkout read the plan's current PUBLISHED version. The
// provider price is pinned to the version (PlanVersionPrice) with STRIPE_PLAN_PRICES as the
// cutover fallback (provider-price.ts). planForPrice resolves a VERSION. A provider-side plan
// change re-pins plan_version_id under a named reason, and the DB trigger records it
// (SubscriptionVersionPinEvent); an env-mapped price of the SAME plan keeps the row's version
// (grandfathering: the env cannot tell versions apart).
//
// CCP-A6 (Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED, rulings D2/H5)
// — a self-service checkout never ends a governed (MANUAL) subscription, at both points:
//   checkout  C-1/C-2: refused (GOVERNED_SUBSCRIPTION_OPEN) while the tenant holds an open
//             governed row of the product. The decision is taken UNDER the shared billing lock in
//             the transaction that creates the CheckoutIntent (an early read only fails fast before
//             any provider side effect). The checkout session stays outside it (C-3). The
//             open self-service refusal (ALREADY_SUBSCRIBED) is preserved (C-5).
//   webhook   C-6/C-7: an activation that would end an open governed row is HELD — no
//             SELF_SERVICE row, the governed row unchanged, a 'governed_subscription_open'
//             reconciliation flag, the event recorded IGNORED, the CheckoutIntent kept CREATED —
//             also for a CheckoutIntent created before this rule. C-9: a later sync resolves the
//             flag only when the conflict is gone. C-10: the hold composes with the country and
//             domain holds; each reason keeps its own open flag.
//   No release exists until CCP-C2 (C-11/C-12): every such checkout is refused or held.
//
// CCP-C1 (PBD §5.2 row C1; Conversion Rule C-22, C-23) — the transaction that applies a provider
// state (webhook or re-fetch) also CONFIRMS the Stripe commands whose effect that state shows
// (billing-provider-command.ts), so a command is pending-provider until the confirming state is
// APPLIED, never on its own local commit. A checkout.session.expired event re-fetches the session:
// an expired session moves its CREATED CheckoutIntent to EXPIRED and confirms an expire command.
// The A6 hold above is unchanged (the confirmation runs after it, in the same transaction).

export const PAST_DUE_GRACE_DAYS_DEFAULT = 7;

export type BillingRefusal =
  | 'BILLING_UNAVAILABLE'
  | 'PLAN_NOT_SELLABLE'
  | 'PLAN_NOT_ELIGIBLE'
  | 'TERMS_NOT_ACCEPTED'
  | 'TERMS_NOT_APPROVED'
  | 'PORTAL_NOT_CONFIGURED'
  | 'ALREADY_SUBSCRIBED'
  | 'NO_BILLING_ACCOUNT'
  | 'ORGANIZATION_PROFILE_REQUIRED'
  | 'DOMAIN_VERIFICATION_REQUIRED'
  // CCP-A6 (Conversion Rule C-1, C-4) — the tenant holds an open governed (MANUAL) subscription
  // of the product; self-service checkout is refused (a conversion is a governed change request).
  | 'GOVERNED_SUBSCRIPTION_OPEN';

/** A1 §2.6 — the activation-guard reason (BillingReconciliationFlag.reason). */
export const BILLING_COUNTRY_NOT_SUPPORTED = 'billing_country_not_supported';
const BILLING_COUNTRY_HELD = `${BILLING_COUNTRY_NOT_SUPPORTED}: held for reconciliation`;
const BILLING_COUNTRY_ALLOWED = 'US';

/** P3 §4 — the domain activation-guard reason (BillingReconciliationFlag.reason). */
export const DOMAIN_NOT_AUTHORITATIVE = 'domain_not_authoritative';
const DOMAIN_VERIFICATION_HELD = 'domain_verification_required: held for reconciliation';

/** CCP-A6 (Conversion Rule C-7(b)) — the governed-subscription hold reason. */
export { GOVERNED_SUBSCRIPTION_OPEN };
const GOVERNED_SUBSCRIPTION_HELD = `${GOVERNED_SUBSCRIPTION_OPEN}: held for reconciliation (an open governed subscription is never ended by a checkout)`;

type ActivationGuardReason = typeof BILLING_COUNTRY_NOT_SUPPORTED | typeof DOMAIN_NOT_AUTHORITATIVE | typeof GOVERNED_SUBSCRIPTION_OPEN;

/**
 * CCP-A6 — the checkout gate on the tenant's open BASE row of the product (C-1, C-5). Taken twice:
 * early (fail fast, before any provider side effect) and authoritatively under the billing lock (C-2).
 */
function assertCheckoutAllowed(open: { source: string; status: string; ended_at: Date | null } | null): void {
  if (open === null) return;
  // C-5 — a tenant already paying through the provider manages it in the portal.
  if (open.source === 'SELF_SERVICE' && open.status !== 'INCOMPLETE') throw new BillingRefusedError('ALREADY_SUBSCRIBED');
  // C-1 / C-4 — a governed subscription is converted only through a governed change request (C-11).
  if (isGovernedSubscription(open)) throw new BillingRefusedError('GOVERNED_SUBSCRIPTION_OPEN', GOVERNED_SUBSCRIPTION_OPEN);
}

/** Fail closed: only an explicit US billing country may activate. */
export function billingCountrySupported(account_country: string | null): boolean {
  return account_country?.trim().toUpperCase() === BILLING_COUNTRY_ALLOWED;
}

export const STORAGE_CAPACITY_KEY = 'sign.storage_bytes';
const OPERATOR_DISPLAY_ORDER_FLOOR = 900;

export class BillingRefusedError extends Error {
  constructor(public readonly reason: BillingRefusal, detail?: string) {
    super(detail ?? reason);
    this.name = 'BillingRefusedError';
  }
}

export interface CatalogPlanView {
  key: string;
  name: string;
  description: string | null;
  tenant_kind: string | null;
  sales_model: string;
  status: string;
  // The list price (display); the charge itself is the provider price.
  price: { amount_minor: number; currency: string; interval: string | null } | null;
  // Present only when the comparison price is substantiated (A1: no
  // unsubstantiated discount claims).
  reference_price: { amount_minor: number; currency: string } | null;
  commitment_months: number | null;
  eligibility: string | null;
  // For a tenant-scoped catalog: whether this tenant meets the eligibility rule.
  eligible: boolean;
  support_tier: string | null;
  activation_note: string | null;
  // `available` = the capability is built and operational (A1 review: an
  // entitlement that is not available is never advertised as delivered).
  allowances: { allowance_key: string; included_quantity: number | null; unlimited: boolean; period: string; available: boolean }[];
  capacities: { capacity_key: string; limit: number | null; unlimited: boolean; available: boolean }[];
  features: { feature_key: string; enabled: boolean; available: boolean }[];
  purchasable: boolean;
}

export interface SubscriptionView {
  plan_key: string;
  plan_name: string;
  source: string;
  status: string;
  sending: boolean;
  started_at: Date;
  ended_at: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  grace_until: Date | null;
  billing_managed: boolean;
  // A1 — the commitment term and its cancellation flag (separate from the
  // monthly invoice period), and the plan-eligibility state.
  commitment_months: number | null;
  commitment_end: Date | null;
  cancel_requested_within_commitment: boolean;
  eligibility_state: string | null;
  list_price: { amount_minor: number; currency: string; interval: string | null } | null;
  features: { feature_key: string; enabled: boolean; available: boolean }[];
  // Post-termination export access, only when the (legal-pending) window is configured.
  export_access_until: Date | null;
}

export interface AccountView {
  subscription: SubscriptionView | null;
  allowance: AllowanceReadResult;
  storage: CapacityStatus | null;
  billing_available: boolean;
}

export interface ApplyResult {
  outcome: 'APPLIED' | 'IGNORED';
  detail?: string;
  tenant_id: string | null;
  subscription_id?: string;
  // Set when this application opened the tenant's sending subscription: the
  // caller grants the subscribing-owner role to this user.
  activated_owner_user_id?: string;
}

export type WebhookResult = ApplyResult | { outcome: 'DUPLICATE'; tenant_id: null };

/** CCP-A6-R (C-8, TD-A6-12) — the only tenant-facing copy of a held activation. */
export const TENANT_ACTIVATION_PENDING_MESSAGE = 'Subscription activation pending — contact support';
export interface TenantActivationState {
  state: 'PENDING';
  message: typeof TENANT_ACTIVATION_PENDING_MESSAGE;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

const SENDING = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

/** Provider status → Aramo lifecycle status. */
export function mapProviderStatus(provider_status: string): { status: string; grace: boolean; ends: boolean } {
  switch (provider_status) {
    case 'trialing':
      return { status: 'TRIALING', grace: false, ends: false };
    case 'active':
      return { status: 'ACTIVE', grace: false, ends: false };
    case 'past_due':
      return { status: 'PAST_DUE', grace: true, ends: false };
    // Collection gave up, or the subscription is paused: not sending, not ended.
    case 'unpaid':
    case 'paused':
      return { status: 'PAST_DUE', grace: false, ends: false };
    case 'canceled':
    case 'incomplete_expired':
      return { status: 'CANCELED', grace: false, ends: true };
    default:
      return { status: 'INCOMPLETE', grace: false, ends: false };
  }
}

/** SIGN_POST_TERMINATION_EXPORT_DAYS — unset until the retention policy is approved. */
export function postTerminationExportDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['SIGN_POST_TERMINATION_EXPORT_DAYS']?.trim();
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 3650 ? n : null;
}

function graceDays(): number {
  const n = Number(process.env['BILLING_PAST_DUE_GRACE_DAYS'] ?? PAST_DUE_GRACE_DAYS_DEFAULT);
  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : PAST_DUE_GRACE_DAYS_DEFAULT;
}

@Injectable()
export class SubscriptionLifecycleService {
  private readonly log = new Logger(SubscriptionLifecycleService.name);

  private readonly legal: readonly LegalDocumentVersion[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
    private readonly capacity: CapacityService,
    @Optional() @Inject(PLAN_ELIGIBILITY_PORT) private readonly eligibility?: PlanEligibilityPort,
    @Optional() @Inject(LEGAL_DOCUMENT_REGISTRY) legal?: readonly LegalDocumentVersion[],
    @Optional() @Inject(ORGANIZATION_BILLING_PROFILE_PORT) private readonly orgProfile?: OrganizationBillingProfilePort,
    // CCP-C1 — the checkout-session read (checkout.session.expired events). Unbound: such an
    // event is IGNORED as before.
    @Optional() @Inject(BILLING_PROVIDER_COMMAND_PORT) private readonly providerCommands?: BillingProviderCommandPort,
  ) {
    this.legal = legal ?? LEGAL_DOCUMENTS;
  }

  private async eligible(tenant_id: string | null, rule: string | null): Promise<boolean> {
    if (rule === null) return true;
    if (tenant_id === null || this.eligibility === undefined) return false;
    try {
      return await this.eligibility.isEligible(tenant_id, rule as PlanEligibilityRule);
    } catch (err) {
      this.log.warn(`eligibility check failed (${rule}): ${(err as Error).message}`);
      return false;
    }
  }

  private prices(): Map<string, string> {
    return parsePlanPrices(process.env['STRIPE_PLAN_PRICES']);
  }

  /** CCP-A5 — configured, and a provider price exists (an env entry or a version pin). */
  async billingAvailable(): Promise<boolean> {
    if (!this.billing.isConfigured()) return false;
    if (this.prices().size > 0) return true;
    return (await this.prisma.planVersionPrice.count()) > 0;
  }

  /**
   * The public plan catalog (the pre-catalog operator plan is excluded).
   * With a tenant, eligibility and purchasability are evaluated for it.
   */
  async catalog(product_key: ProductKey, tenant_id: string | null = null): Promise<CatalogPlanView[]> {
    const prices = this.prices();
    const plans = await this.prisma.plan.findMany({
      // Public catalog only: operator / legacy plans are never presented.
      where: { product_key: assertProductKey(product_key), display_order: { lt: OPERATOR_DISPLAY_ORDER_FLOOR }, sales_model: { not: 'OPERATOR' } },
      // CCP-A5 — the plan's current (PUBLISHED) version carries the terms shown.
      include: { versions: { where: { status: 'PUBLISHED' } } },
      orderBy: [{ display_order: 'asc' }, { key: 'asc' }],
    });
    const out: CatalogPlanView[] = [];
    for (const plan of plans) {
      const version = plan.versions[0];
      // A plan with no PUBLISHED version has nothing to present or sell.
      if (version === undefined) continue;
      const terms = planVersionTerms(version);
      const p = terms.plan;
      const eligible = await this.eligible(tenant_id, p.eligibility);
      const price = await effectiveProviderPrice(this.prisma, version.id, plan.key, prices);
      out.push({
        key: plan.key,
        name: plan.name,
        description: plan.description,
        tenant_kind: plan.tenant_kind,
        sales_model: plan.sales_model,
        status: plan.status,
        price: p.list_price_minor !== null && p.currency !== null ? { amount_minor: p.list_price_minor, currency: p.currency, interval: p.billing_interval } : null,
        reference_price:
          p.reference_price_substantiated && p.reference_price_minor !== null && p.currency !== null ? { amount_minor: p.reference_price_minor, currency: p.currency } : null,
        commitment_months: p.commitment_months,
        eligibility: p.eligibility,
        eligible,
        support_tier: p.support_tier,
        activation_note: plan.activation_note,
        allowances: terms.allowances.map((a) => ({
          allowance_key: a.allowance_key,
          included_quantity: a.included_quantity,
          unlimited: a.unlimited,
          period: a.period,
          available: isFeatureAvailable(a.allowance_key),
        })),
        capacities: terms.capacities.map((c) => ({
          capacity_key: c.capacity_key,
          limit: c.limit_quantity,
          unlimited: c.unlimited,
          available: isFeatureAvailable(c.capacity_key),
        })),
        features: terms.features.map((f) => ({ feature_key: f.feature_key, enabled: f.enabled, available: isFeatureAvailable(f.feature_key) })),
        purchasable: plan.sellable && plan.status === 'ACTIVE' && this.billing.isConfigured() && price.ok && eligible,
      });
    }
    return out;
  }

  /** The tenant's open subscription of the product, else its most recent one (for display). */
  private async currentRow(tenant_id: string, product_key: ProductKey) {
    const include = { plan: true, plan_version: true } as const;
    const open = await this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key), include });
    if (open !== null) return open;
    return this.prisma.tenantSubscription.findFirst({
      where: { tenant_id, product_key, composition_role: BASE_COMPOSITION },
      include,
      orderBy: { started_at: 'desc' },
    });
  }

  async account(tenant_id: string, product_key: ProductKey, allowance_key: string, at: Date = new Date()): Promise<AccountView> {
    const row = await this.currentRow(tenant_id, assertProductKey(product_key));
    const allowance = await this.allowance.getStatus(tenant_id, product_key, allowance_key, at);
    const storage = await this.capacity.status(tenant_id, product_key, STORAGE_CAPACITY_KEY);
    const exportDays = postTerminationExportDays();
    // CCP-A5 — the subscription's terms come from its PINNED version (grandfathering).
    const terms = row === null ? null : planVersionTerms(row.plan_version).plan;
    const features = row === null ? [] : planVersionTerms(row.plan_version).features;
    return {
      subscription:
        row === null
          ? null
          : {
              plan_key: row.plan.key,
              plan_name: row.plan.name,
              source: row.source,
              status: row.ended_at !== null && row.status !== 'CANCELED' ? 'CANCELED' : row.status,
              sending: allowance.subscribed,
              started_at: row.started_at,
              ended_at: row.ended_at,
              current_period_end: row.current_period_end,
              cancel_at_period_end: row.cancel_at_period_end,
              grace_until: row.grace_until,
              billing_managed: row.billing_account_ref !== null,
              commitment_months: terms?.commitment_months ?? null,
              commitment_end: row.commitment_end,
              cancel_requested_within_commitment: row.cancel_requested_within_commitment,
              eligibility_state: row.eligibility_state,
              list_price:
                terms !== null && terms.list_price_minor !== null && terms.currency !== null
                  ? { amount_minor: terms.list_price_minor, currency: terms.currency, interval: terms.billing_interval }
                  : null,
              features: features.map((f) => ({ feature_key: f.feature_key, enabled: f.enabled, available: isFeatureAvailable(f.feature_key) })),
              export_access_until: row.ended_at !== null && exportDays !== null ? new Date(row.ended_at.getTime() + exportDays * 86_400_000) : null,
            },
      allowance,
      storage: storage.subscribed ? { capacity_key: storage.capacity_key, limit: storage.limit, unlimited: storage.unlimited, used: storage.used } : null,
      billing_available: await this.billingAvailable(),
    };
  }

  /**
   * CCP-A6-R (Conversion Rule C-8; Architect disposition TD-A6-12, 2026-10-25) — the TENANT-facing
   * state of a held self-service activation: a safe billing-support outcome only. It never reports
   * an activation, never exposes the reconciliation flag, its reason or any manual-contract detail,
   * and reads only (the MANUAL subscription is never touched). Operators keep the full detail.
   */
  async tenantActivationState(tenant_id: string, product_key: ProductKey): Promise<TenantActivationState | null> {
    const held = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n
         FROM subscription."BillingReconciliationFlag" f
         JOIN subscription."CheckoutIntent" ci ON ci.id = f.intent_id
         JOIN subscription."Plan" p ON p.id = ci.plan_id
        WHERE f.tenant_id = $1::uuid AND f.reason = $2 AND f.resolved_at IS NULL AND p.product_key = $3`,
      tenant_id,
      GOVERNED_SUBSCRIPTION_OPEN,
      assertProductKey(product_key),
    );
    return (held[0]?.n ?? 0) > 0 ? { state: 'PENDING', message: TENANT_ACTIVATION_PENDING_MESSAGE } : null;
  }

  /** Operator support view — the tenant's most recent provider events (no payloads). */
  async recentBillingEvents(tenant_id: string, limit = 20): Promise<{ event_type: string; outcome: string; detail: string | null; event_created_at: Date; received_at: Date }[]> {
    return this.prisma.billingEvent.findMany({
      where: { tenant_id },
      orderBy: { received_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: { event_type: true, outcome: true, detail: true, event_created_at: true, received_at: true },
    });
  }

  /** The subscribing owner of the tenant's open, sending SELF_SERVICE subscription of the product. */
  async sendingOwner(tenant_id: string, product_key: ProductKey, at: Date = new Date()): Promise<string | null> {
    const row = await this.prisma.tenantSubscription.findFirst({ where: { ...openBaseSubscription(tenant_id, product_key), source: 'SELF_SERVICE' } });
    if (row === null || row.activated_by === null) return null;
    return subscriptionSends(row, at) ? row.activated_by : null;
  }

  async startCheckout(input: {
    tenant_id: string;
    product_key: ProductKey;
    user_id: string;
    user_email: string;
    plan_key: string;
    success_url: string;
    cancel_url: string;
    accept_terms?: boolean;
    at?: Date;
  }): Promise<{ url: string }> {
    const at = input.at ?? new Date();
    const product_key = assertProductKey(input.product_key);
    if (!this.billing.isConfigured()) throw new BillingRefusedError('BILLING_UNAVAILABLE');
    const plan = await this.prisma.plan.findUnique({ where: { key: input.plan_key } });
    // CCP-A5 — what is sold is the plan's current (PUBLISHED) version.
    const version = plan === null ? null : await currentPublishedVersion(this.prisma, plan.id);
    // CCP-A4 — a plan of another product is never sold through this product's checkout.
    if (plan === null || version === null || plan.product_key !== product_key || !plan.sellable || plan.status !== 'ACTIVE' || plan.sales_model !== 'SELF_SERVICE') {
      throw new BillingRefusedError('PLAN_NOT_SELLABLE');
    }
    if (!(await this.eligible(input.tenant_id, planVersionTerms(version).plan.eligibility))) throw new BillingRefusedError('PLAN_NOT_ELIGIBLE');
    // CCP-A5 (D3) — the version's pinned price, else the env (cutover); a pin/env disagreement fails closed.
    const effective = await effectiveProviderPrice(this.prisma, version.id, plan.key, this.prices());
    if (!effective.ok) {
      throw new BillingRefusedError('BILLING_UNAVAILABLE', effective.reason === 'PARITY_MISMATCH' ? 'provider price parity mismatch for the plan version' : 'no provider price configured for the plan');
    }
    const price = effective.ref;
    // A1 — terms evidence. No live charging without approved terms; an approved
    // version must be affirmatively accepted.
    const terms = approvedLegalDocument('sign.terms_of_service', this.legal);
    if (terms === null && this.billing.mode() === 'live') throw new BillingRefusedError('TERMS_NOT_APPROVED');
    if (terms !== null && input.accept_terms !== true) throw new BillingRefusedError('TERMS_NOT_ACCEPTED');
    // CCP-A6 — early read, outside the lock: fail fast before any provider side effect. The
    // authoritative decision is re-taken under the billing lock below (C-2). A DEVELOPMENT row may
    // still be replaced by a self-service one; a governed (MANUAL) row never is (C-1).
    assertCheckoutAllowed(await this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(input.tenant_id, product_key) }));
    // A1 §2.6 — an eligible (US) organization profile is required; unbound → refused.
    // P3 §4 — then an AUTHORITATIVE domain claim; both before any side effect.
    const profile = await this.lockedBillingProfile(input.tenant_id);
    const account_ref = await this.ensureBillingAccount(input.tenant_id, product_key, profile);
    const intent_id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      // CCP-A6 (C-2) — the C-1 / C-5 decision under the shared billing lock, in the transaction
      // that creates the CheckoutIntent: a governed apply or a webhook for this tenant serializes
      // with it. The checkout session itself is created after commit, outside it (C-3).
      await takeBillingLock(tx, input.tenant_id);
      assertCheckoutAllowed(await tx.tenantSubscription.findFirst({ where: openBaseSubscription(input.tenant_id, product_key) }));
      await tx.checkoutIntent.create({
        data: {
          id: intent_id,
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          plan_id: plan.id,
          provider: this.billing.provider,
          terms_version: terms?.version ?? null,
          terms_sha256: terms?.sha256 ?? null,
        },
      });
      if (terms !== null) {
        await tx.legalAcceptance.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            user_id: input.user_id,
            subject_email: input.user_email,
            document_key: terms.key,
            version: terms.version,
            sha256: terms.sha256,
            context: 'CHECKOUT',
            context_ref: intent_id,
            accepted_at: at,
          },
        });
      }
    });
    const session = await this.billing.createCheckoutSession({
      intent_id,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      user_email: input.user_email,
      price_ref: price,
      account_ref,
      success_url: input.success_url,
      cancel_url: input.cancel_url,
    });
    await this.prisma.checkoutIntent.update({ where: { id: intent_id }, data: { provider_session_ref: session.session_ref } });
    return { url: session.url };
  }

  /** The eligible (US) organization billing profile; the tenant is then held to the US (§2.5). */
  private async lockedBillingProfile(tenant_id: string): Promise<OrganizationBillingProfile> {
    if (this.orgProfile === undefined) throw new BillingRefusedError('ORGANIZATION_PROFILE_REQUIRED', 'organization_profile_incomplete');
    const r = await this.orgProfile.eligibleProfile(tenant_id);
    if ('refused' in r) throw new BillingRefusedError('ORGANIZATION_PROFILE_REQUIRED', r.refused);
    if (!(await this.domainAuthoritative(tenant_id))) throw new BillingRefusedError('DOMAIN_VERIFICATION_REQUIRED');
    await this.orgProfile.lockRegion(tenant_id);
    return r.profile;
  }

  /** P3 §4 — fail closed: an unbound port or any lookup failure is not authoritative. */
  private async domainAuthoritative(tenant_id: string): Promise<boolean> {
    if (this.orgProfile === undefined) return false;
    try {
      return (await this.orgProfile.domainAuthoritative(tenant_id)) === true;
    } catch (e) {
      this.log.warn(`domain claim lookup failed for ${tenant_id}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * A1 §2.6 — the tenant's provider billing account, created from (or updated to)
   * the organization profile. Reuses the mapped account, else the latest
   * subscription's account; the mapping is persisted in TenantBillingAccount.
   */
  private async ensureBillingAccount(tenant_id: string, product_key: ProductKey, profile: OrganizationBillingProfile): Promise<string> {
    const provider = this.billing.provider;
    const mapped = await this.prisma.tenantBillingAccount.findUnique({ where: { tenant_id } });
    let existing: string | null = mapped !== null && mapped.provider === provider ? mapped.account_ref : null;
    if (existing === null) {
      const prior = await this.prisma.tenantSubscription.findFirst({
        where: { tenant_id, product_key, billing_provider: provider, billing_account_ref: { not: null } },
        orderBy: { started_at: 'desc' },
      });
      existing = prior?.billing_account_ref ?? null;
    }
    const account_ref = await this.billing.upsertBillingAccount(existing, {
      tenant_id,
      legal_name: profile.legal_name,
      billing_email: profile.billing_email,
      address: profile.address,
    });
    await this.prisma.tenantBillingAccount.upsert({
      where: { tenant_id },
      create: { tenant_id, provider, account_ref },
      update: { provider, account_ref },
    });
    return account_ref;
  }

  async portal(tenant_id: string, product_key: ProductKey, return_url: string): Promise<{ url: string }> {
    if (!this.billing.isConfigured()) throw new BillingRefusedError('BILLING_UNAVAILABLE');
    const row = await this.prisma.tenantSubscription.findFirst({
      where: { tenant_id, product_key: assertProductKey(product_key), billing_account_ref: { not: null } },
      orderBy: { started_at: 'desc' },
    });
    if (row?.billing_account_ref == null) throw new BillingRefusedError('NO_BILLING_ACCOUNT');
    // A1 review — a commitment plan must not reach the provider's DEFAULT portal,
    // whose cancellation settings could contradict the (pending) annual terms.
    // It needs an explicit portal configuration set up to match the approved
    // contract (STRIPE_PORTAL_CONFIGURATION); until then the portal is refused.
    // CCP-A5 — the commitment term of the subscription's pinned version.
    const version = await this.prisma.planVersion.findUniqueOrThrow({ where: { id: row.plan_version_id } });
    const configuration = process.env['STRIPE_PORTAL_CONFIGURATION']?.trim() || undefined;
    if (planVersionTerms(version).plan.commitment_months !== null && configuration === undefined) {
      throw new BillingRefusedError('PORTAL_NOT_CONFIGURED', 'the billing portal for commitment plans needs an approved portal configuration');
    }
    return this.billing.createPortalSession(row.billing_account_ref, return_url, configuration);
  }

  /** A verified provider event for the product's billing webhook. At most once per provider event id. */
  async handleEvent(evt: VerifiedBillingEvent, product_key: ProductKey, at: Date = new Date()): Promise<WebhookResult> {
    assertProductKey(product_key);
    const seen = await this.prisma.billingEvent.findUnique({
      where: { provider_provider_event_id: { provider: this.billing.provider, provider_event_id: evt.id } },
    });
    if (seen !== null) return { outcome: 'DUPLICATE', tenant_id: null };

    const ref = evt.subscription_ref;
    const confirmation: BillingCommandConfirmation = { source: 'WEBHOOK', event_id: evt.id };
    const session = evt.checkout_session_ref ?? null;
    // A provider failure throws here: nothing is recorded, the redelivery retries.
    const result: ApplyResult =
      ref !== null
        ? await this.syncSubscription(ref, product_key, at, confirmation)
        : evt.type === 'checkout.session.expired' && session !== null && this.providerCommands !== undefined
          ? await this.syncCheckoutSession(session, product_key, at, confirmation)
          : { outcome: 'IGNORED', detail: `event ${evt.type} carries no subscription`, tenant_id: null };

    await this.prisma.billingEvent.createMany({
      data: [
        {
          id: uuidv7(),
          provider: this.billing.provider,
          provider_event_id: evt.id,
          event_type: evt.type,
          event_created_at: evt.created,
          tenant_id: result.tenant_id,
          outcome: result.outcome,
          detail: result.detail?.slice(0, 500) ?? null,
        },
      ],
      skipDuplicates: true,
    });
    return result;
  }

  /** Re-fetch one provider subscription and apply its current state. */
  async syncSubscription(
    subscription_ref: string,
    product_key: ProductKey,
    at: Date = new Date(),
    confirmation: BillingCommandConfirmation = REFETCH_CONFIRMATION,
  ): Promise<ApplyResult> {
    assertProductKey(product_key);
    // The provider read runs before (outside) the local transaction.
    const state = await this.billing.retrieveSubscription(subscription_ref);
    return this.applyProviderState(state, product_key, at, confirmation);
  }

  /**
   * CCP-C1 — re-fetch one checkout session and apply it: an EXPIRED session moves its CREATED
   * CheckoutIntent (same tenant, same product) to EXPIRED and confirms the expire commands on it,
   * in one transaction under the billing lock. Any other session status changes nothing here (a
   * completed session is applied through its subscription).
   */
  async syncCheckoutSession(
    session_ref: string,
    product_key: ProductKey,
    at: Date = new Date(),
    confirmation: BillingCommandConfirmation = REFETCH_CONFIRMATION,
  ): Promise<ApplyResult> {
    assertProductKey(product_key);
    if (this.providerCommands === undefined) return { outcome: 'IGNORED', detail: 'checkout session reads are not configured', tenant_id: null };
    const session = await this.providerCommands.retrieveCheckoutSession(session_ref);
    const intent = await this.prisma.checkoutIntent.findFirst({
      where: { provider: session.provider, provider_session_ref: session.session_ref },
      include: { plan: true },
    });
    if (intent === null) return { outcome: 'IGNORED', detail: 'checkout session is not linked to an Aramo checkout', tenant_id: null };
    const tenant_id = intent.tenant_id;
    if (intent.plan.product_key !== product_key) return { outcome: 'IGNORED', detail: `checkout session belongs to another product than ${product_key}`, tenant_id };
    if ((session.tenant_id !== null && session.tenant_id !== tenant_id) || (session.intent_id !== null && session.intent_id !== intent.id)) {
      this.log.warn(`checkout session metadata mismatch for ${session.session_ref}`);
      return { outcome: 'IGNORED', detail: 'provider session metadata does not match the Aramo record', tenant_id };
    }
    if (session.status !== 'expired') return { outcome: 'IGNORED', detail: `checkout session ${session.status}`, tenant_id };
    return this.prisma.$transaction(async (tx) => {
      await takeBillingLock(tx, tenant_id);
      const expired = await tx.checkoutIntent.updateMany({ where: { id: intent.id, status: 'CREATED' }, data: { status: 'EXPIRED' } });
      const confirmed = await confirmSessionCommandsInTx(tx, { tenant_id, product_key, session, confirmation, at });
      const detail = `checkout session expired${expired.count > 0 ? '; intent EXPIRED' : ''}${confirmed.length > 0 ? `; ${confirmed.length} command(s) confirmed` : ''}`;
      return { outcome: expired.count > 0 || confirmed.length > 0 ? 'APPLIED' : 'IGNORED', detail, tenant_id } as ApplyResult;
    });
  }

  async applyProviderState(
    state: ProviderSubscriptionState,
    product_key: ProductKey,
    at: Date = new Date(),
    confirmation: BillingCommandConfirmation = REFETCH_CONFIRMATION,
  ): Promise<ApplyResult> {
    assertProductKey(product_key);
    const existing = await this.prisma.tenantSubscription.findFirst({
      where: { billing_provider: state.provider, billing_subscription_ref: state.subscription_ref },
    });
    const intent =
      state.intent_id === null ? null : await this.prisma.checkoutIntent.findUnique({ where: { id: state.intent_id }, include: { plan: true } });
    const tenant_id = existing?.tenant_id ?? intent?.tenant_id ?? null;
    if (tenant_id === null) return { outcome: 'IGNORED', detail: 'subscription is not linked to an Aramo checkout', tenant_id: null };
    // CCP-A4 (MP-A2 N-12) — another product's subscription or checkout is never read,
    // ended or re-pointed through this product's webhook.
    if ((existing !== null && existing.product_key !== product_key) || (existing === null && intent !== null && intent.plan.product_key !== product_key)) {
      return { outcome: 'IGNORED', detail: `subscription belongs to another product than ${product_key}`, tenant_id };
    }
    // The provider metadata must agree with Aramo's own record: never let one
    // tenant's payment move another tenant's entitlement.
    if (state.tenant_id !== null && state.tenant_id !== tenant_id) {
      this.log.warn(`billing tenant mismatch for ${state.subscription_ref}`);
      return { outcome: 'IGNORED', detail: 'provider metadata tenant does not match the Aramo record', tenant_id };
    }
    if (intent !== null && intent.tenant_id !== tenant_id) {
      return { outcome: 'IGNORED', detail: 'checkout intent tenant does not match', tenant_id };
    }
    // P3 §4 — the domain claim lives in identity; read it before the billing transaction.
    const domainOk = await this.domainAuthoritative(tenant_id);

    return this.prisma.$transaction(async (tx) => {
      await takeBillingLock(tx, tenant_id);
      const mapped = mapProviderStatus(state.provider_status);
      const result = await this.applyLocked(tx, tenant_id, product_key, state, mapped, intent, domainOk, at);
      // CCP-C1 (C-22, C-23) — the state is applied: confirm the cancel commands it proves, in the
      // same transaction (never before the state is applied, never on a command's own commit).
      // Only a lifecycle wired with the command port confirms (SubscriptionModule always binds it;
      // commands are dispatched only through it). Unwired, nothing is confirmed: fail-safe, a
      // command stays pending-provider (C-23), never reported committed.
      if (this.providerCommands !== undefined) {
        await confirmSubscriptionCommandsInTx(tx, { tenant_id, product_key, state, ends: mapped.ends, confirmation, at });
      }
      return result;
    });
  }

  /** The provider-state application under the billing lock (A1, P3 and A6 guards; unchanged). */
  private async applyLocked(
    tx: Tx,
    tenant_id: string,
    product_key: ProductKey,
    state: ProviderSubscriptionState,
    mapped: ReturnType<typeof mapProviderStatus>,
    intent: { id: string; tenant_id: string; user_id: string; plan_id: string; plan: { key: string; product_key: string } } | null,
    domainOk: boolean,
    at: Date,
  ): Promise<ApplyResult> {
    const row = await tx.tenantSubscription.findFirst({
      where: { billing_provider: state.provider, billing_subscription_ref: state.subscription_ref, product_key },
    });
    // A1 §2.6 — activation guard (fail closed: a missing country is not US).
    const countryOk = billingCountrySupported(state.account_country);
    // P3 §4 — and the domain guard (fail closed: not AUTHORITATIVE holds).
    const intent_id = intent?.id ?? null;
    await this.guardFlag(tx, tenant_id, state, intent_id, BILLING_COUNTRY_NOT_SUPPORTED, !countryOk, at);
    await this.guardFlag(tx, tenant_id, state, intent_id, DOMAIN_NOT_AUTHORITATIVE, !domainOk, at);
    const held = [...(countryOk ? [] : [BILLING_COUNTRY_HELD]), ...(domainOk ? [] : [DOMAIN_VERIFICATION_HELD])].join('; ');
    if (row !== null) return this.updateRow(tx, row, state, mapped, at, held);
    if (intent === null) return { outcome: 'IGNORED', detail: 'unknown subscription without a checkout intent', tenant_id } as ApplyResult;
    // CCP-A6 (C-6, C-7) — a NEW activation never ends an open governed subscription, in any
    // provider state and whenever its CheckoutIntent was created. Read under the billing lock.
    // A provider subscription that has ended no longer conflicts (C-9: a webhook-confirmed end
    // resolves the flag). Composed beside the country and domain holds (C-10).
    const governed = await tx.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key) });
    const governedConflict = governed !== null && isGovernedSubscription(governed) && !mapped.ends;
    await this.guardFlag(tx, tenant_id, state, intent_id, GOVERNED_SUBSCRIPTION_OPEN, governedConflict, at);
    const allHeld = [held, ...(governedConflict ? [GOVERNED_SUBSCRIPTION_HELD] : [])].filter((h) => h !== '').join('; ');
    if (allHeld !== '') {
      // C-7(c)/(d) — IGNORED with the hold named; openRow is not reached, so no SELF_SERVICE row
      // opens, the governed row is untouched and the CheckoutIntent stays CREATED.
      this.log.warn(
        `${state.subscription_ref} held for reconciliation (country ${state.account_country ?? 'none'}${countryOk ? '' : ' not supported'}${domainOk ? '' : '; domain not authoritative'}${governedConflict ? '; governed subscription open' : ''})`,
      );
      return { outcome: 'IGNORED', detail: allHeld, tenant_id } as ApplyResult;
    }
    return this.openRow(tx, tenant_id, product_key, intent, state, mapped, at);
  }

  /**
   * Raise (or keep) the open activation-guard flag for this provider
   * subscription and reason when the guard fails; resolve it when it passes.
   */
  private async guardFlag(
    tx: Tx,
    tenant_id: string,
    state: ProviderSubscriptionState,
    intent_id: string | null,
    reason: ActivationGuardReason,
    failing: boolean,
    at: Date,
  ): Promise<void> {
    if (!failing) {
      await tx.billingReconciliationFlag.updateMany({
        where: { provider: state.provider, subscription_ref: state.subscription_ref, reason, resolved_at: null },
        data: { resolved_at: at },
      });
      return;
    }
    // The partial unique index (provider, subscription_ref, reason) WHERE
    // resolved_at IS NULL makes a repeated sync a no-op.
    await tx.$executeRaw`
      INSERT INTO "subscription"."BillingReconciliationFlag"
        ("id", "tenant_id", "provider", "subscription_ref", "intent_id", "reason", "account_country")
      VALUES (${uuidv7()}::uuid, ${tenant_id}::uuid, ${state.provider}, ${state.subscription_ref},
              ${intent_id}::uuid, ${reason}, ${state.account_country})
      ON CONFLICT ("provider", "subscription_ref", "reason") WHERE "resolved_at" IS NULL DO NOTHING`;
  }

  private async updateRow(
    tx: Tx,
    row: {
      id: string;
      tenant_id: string;
      plan_id: string;
      plan_version_id: string;
      product_key: string;
      status: string;
      grace_until: Date | null;
      ended_at: Date | null;
      activated_by: string | null;
      commitment_end: Date | null;
    },
    state: ProviderSubscriptionState,
    provider: ReturnType<typeof mapProviderStatus>,
    at: Date,
    heldDetail = '',
  ): Promise<ApplyResult> {
    if (row.ended_at !== null) {
      // An ended subscription is never reopened; a resubscription is a new checkout.
      return { outcome: 'IGNORED', detail: 'subscription already ended', tenant_id: row.tenant_id, subscription_id: row.id };
    }
    // A1 §2.6 / P3 §4 — a non-US billing country or a non-AUTHORITATIVE domain
    // never moves a non-sending subscription to a sending status (no activation /
    // reactivation). Every other change (cancellation, past-due, period, plan)
    // still applies.
    // "Sending" is the effective state (a PAST_DUE row past its grace does not send).
    const guarded = heldDetail !== '';
    const held = guarded && !subscriptionSends(row, at) && SENDING.has(provider.status);
    const mapped = held ? { status: row.status, grace: false, ends: false } : provider;
    const grace_until = held
      ? row.grace_until
      : mapped.grace
        ? row.status === 'PAST_DUE' && row.grace_until !== null
          ? row.grace_until
          : new Date(at.getTime() + graceDays() * 86_400_000)
        : null;
    // A plan change made in the provider (its price maps to another catalog plan or version).
    // CCP-A5 (N-17) — re-pin plan_version_id under a named reason; the DB trigger records it.
    const pin = await this.repinTarget(tx, row, state.price_ref);
    if (pin !== null) {
      await tx.$executeRaw`SELECT set_config('aramo.subscription_pin_reason', ${PIN_REASON_PROVIDER_PLAN_CHANGE}, true), set_config('aramo.subscription_pin_price_ref', ${state.price_ref ?? ''}, true)`;
    }
    // A1 — a cancellation that would end the subscription before the commitment
    // term is flagged for the (pending) annual-commitment terms; it is never
    // silently treated as month-to-month and no fee is invented.
    const cancelWithin =
      state.cancel_at_period_end && row.commitment_end !== null && state.current_period_end.getTime() < row.commitment_end.getTime();
    await tx.tenantSubscription.update({
      where: { id: row.id },
      data: {
        status: mapped.status,
        grace_until,
        current_period_end: state.current_period_end,
        cancel_at_period_end: state.cancel_at_period_end,
        cancel_requested_within_commitment: cancelWithin,
        billing_account_ref: state.account_ref,
        provider_state_at: at,
        ended_at: mapped.ends ? at : null,
        ...(pin !== null ? { plan_id: pin.plan_id, plan_version_id: pin.plan_version_id } : {}),
      },
    });
    const reactivated = !SENDING.has(row.status) && SENDING.has(mapped.status);
    if (guarded) {
      return {
        outcome: 'IGNORED',
        detail: `${heldDetail} (${row.status} -> ${mapped.status}${held ? `, ${provider.status} withheld` : ''})`,
        tenant_id: row.tenant_id,
        subscription_id: row.id,
      };
    }
    return {
      outcome: 'APPLIED',
      detail: `${row.status} -> ${mapped.status}`,
      tenant_id: row.tenant_id,
      subscription_id: row.id,
      ...(reactivated && row.activated_by !== null ? { activated_owner_user_id: row.activated_by } : {}),
    };
  }

  private async openRow(
    tx: Tx,
    tenant_id: string,
    product_key: ProductKey,
    intent: { id: string; user_id: string; plan_id: string; plan: { key: string } },
    state: ProviderSubscriptionState,
    mapped: ReturnType<typeof mapProviderStatus>,
    at: Date,
  ): Promise<ApplyResult> {
    if (mapped.ends) return { outcome: 'IGNORED', detail: 'checkout subscription already ended', tenant_id };
    // The plan is the one the owner chose at checkout; a provider price that maps
    // to a different sellable plan wins (plan change made in the provider).
    // CCP-A5 — the price resolves to a VERSION; else the checkout plan's current version.
    const resolved = await this.planForPrice(tx, state.price_ref, product_key);
    const plan_id = resolved?.plan_id ?? intent.plan_id;
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: plan_id } });
    if (plan.product_key !== product_key) return { outcome: 'IGNORED', detail: `checkout plan belongs to another product than ${product_key}`, tenant_id };
    const version =
      resolved !== null && resolved.version_status === 'PUBLISHED'
        ? await tx.planVersion.findUniqueOrThrow({ where: { id: resolved.plan_version_id } })
        : await currentPublishedVersion(tx, plan_id);
    if (version === null) return { outcome: 'IGNORED', detail: `plan ${plan.key} has no published version`, tenant_id };
    const terms = planVersionTerms(version).plan;
    const open = await tx.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key) });
    // CCP-A6 (C-6) — defence in depth: applyProviderState holds a governed conflict before this
    // point; openRow itself never ends a governed row either.
    if (open !== null && isGovernedSubscription(open)) {
      return { outcome: 'IGNORED', detail: GOVERNED_SUBSCRIPTION_HELD, tenant_id };
    }
    const sends = SENDING.has(mapped.status);
    if (open !== null && !sends) {
      // Never end a working subscription for a payment that has not gone through.
      return { outcome: 'IGNORED', detail: `checkout ${mapped.status}; the open subscription is kept`, tenant_id };
    }
    if (open !== null) {
      await tx.tenantSubscription.update({ where: { id: open.id }, data: { ended_at: at, status: open.status === 'ACTIVE' ? 'CANCELED' : open.status } });
    }
    const id = uuidv7();
    const anchor = state.current_period_start.getTime() > 0 ? state.current_period_start : at;
    await tx.tenantSubscription.create({
      data: {
        id,
        tenant_id,
        plan_id,
        plan_version_id: version.id,
        product_key,
        composition_role: BASE_COMPOSITION,
        commitment_start: terms.commitment_months !== null ? anchor : null,
        commitment_end: terms.commitment_months !== null ? addMonthsClamped(anchor, terms.commitment_months) : null,
        eligibility_state: terms.eligibility !== null ? 'OK' : null,
        eligibility_checked_at: terms.eligibility !== null ? at : null,
        period_anchor: anchor,
        source: 'SELF_SERVICE',
        created_by: intent.user_id,
        activated_by: intent.user_id,
        status: mapped.status,
        grace_until: mapped.grace ? new Date(at.getTime() + graceDays() * 86_400_000) : null,
        billing_provider: state.provider,
        billing_account_ref: state.account_ref,
        billing_subscription_ref: state.subscription_ref,
        current_period_end: state.current_period_end,
        cancel_at_period_end: state.cancel_at_period_end,
        provider_state_at: at,
      },
    });
    await tx.checkoutIntent.update({ where: { id: intent.id }, data: { status: 'COMPLETED', completed_at: at } });
    return {
      outcome: 'APPLIED',
      detail: `opened ${mapped.status}${open !== null ? ` (ended ${open.source})` : ''}`,
      tenant_id,
      subscription_id: id,
      ...(sends ? { activated_owner_user_id: intent.user_id } : {}),
    };
  }

  /**
   * A provider price → a VERSION of a sellable plan of the SAME product (CCP-A4, CCP-A5 N-17),
   * else null: a version pin first, else the STRIPE_PLAN_PRICES cutover fallback onto the
   * plan's current (unpinned) PUBLISHED version.
   */
  private async planForPrice(tx: Tx, price_ref: string | null, product_key: ProductKey): Promise<PriceResolution | null> {
    if (price_ref === null) return null;
    return resolvePriceToVersion(tx, price_ref, product_key, this.prices());
  }

  /**
   * CCP-A5 — the version a provider update moves a subscription to, or null to keep its pin.
   * Kept: no resolution; the same version; an env-mapped price of the SAME plan (the env cannot
   * tell versions apart, so a grandfathered row stays on its version); a target that is not
   * PUBLISHED (a re-pin onto a RETIRED version is never made; the DB refuses it as well).
   */
  private async repinTarget(tx: Tx, row: { plan_id: string; plan_version_id: string; product_key: string }, price_ref: string | null): Promise<PriceResolution | null> {
    const r = await this.planForPrice(tx, price_ref, assertProductKey(row.product_key));
    if (r === null || r.plan_version_id === row.plan_version_id) return null;
    if (r.source === 'ENV' && r.plan_id === row.plan_id) return null;
    if (r.version_status !== 'PUBLISHED') {
      this.log.warn(`provider price ${price_ref ?? ''} maps to a ${r.version_status} version; subscription pin kept`);
      return null;
    }
    return r;
  }

  /**
   * A1 — re-check eligibility-bound plans (Standard Professional ⇐ ATS). A lapse
   * is RECORDED and surfaced to the tenant and the operator; sending and the
   * current commitment are kept (no automatic downgrade or price change — that
   * is a commercial decision). Recovery clears it.
   */
  async refreshEligibility(product_key: ProductKey, at: Date = new Date()): Promise<{ checked: number; lapsed: number; restored: number }> {
    // CCP-A5 — the eligibility rule is a term of the subscription's PINNED version.
    const open = await this.prisma.tenantSubscription.findMany({
      where: { product_key: assertProductKey(product_key), composition_role: BASE_COMPOSITION, ended_at: null },
      include: { plan: true, plan_version: true },
    });
    const rows = open.flatMap((r) => {
      const rule = planVersionTerms(r.plan_version).plan.eligibility;
      return rule === null ? [] : [{ ...r, rule }];
    });
    const tally = { checked: 0, lapsed: 0, restored: 0 };
    for (const r of rows) {
      tally.checked += 1;
      const ok = await this.eligible(r.tenant_id, r.rule);
      const next = ok ? 'OK' : 'LAPSED';
      if (next !== r.eligibility_state) {
        if (next === 'LAPSED') tally.lapsed += 1;
        else tally.restored += 1;
        this.log.warn(`plan eligibility ${r.eligibility_state ?? 'unknown'} -> ${next} for tenant ${r.tenant_id} (${r.plan.key})`);
      }
      await this.prisma.tenantSubscription.update({ where: { id: r.id }, data: { eligibility_state: next, eligibility_checked_at: at } });
    }
    return tally;
  }

  /** Re-fetch every open provider-linked subscription of the product (missed webhooks heal). */
  async reconcile(product_key: ProductKey, at: Date = new Date(), limit = 200): Promise<{ checked: number; applied: number; failed: number; results: ApplyResult[] }> {
    const rows = await this.prisma.tenantSubscription.findMany({
      where: { product_key: assertProductKey(product_key), ended_at: null, billing_subscription_ref: { not: null } },
      select: { billing_subscription_ref: true },
      orderBy: { provider_state_at: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
    const tally = { checked: 0, applied: 0, failed: 0, results: [] as ApplyResult[] };
    for (const r of rows) {
      tally.checked += 1;
      try {
        const res = await this.syncSubscription(r.billing_subscription_ref as string, product_key, at);
        if (res.outcome === 'APPLIED') tally.applied += 1;
        tally.results.push(res);
      } catch (err) {
        tally.failed += 1;
        if (!(err instanceof BillingProviderUnavailableError)) this.log.error(`reconcile failed: ${(err as Error).message}`);
      }
    }
    return tally;
  }
}
