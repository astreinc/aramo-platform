import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { type AllowanceReadResult, AllowanceService, subscriptionSends } from '../allowance.service.js';
import { addMonthsClamped } from '../billing-period.js';
import { CapacityService, type CapacityStatus } from '../capacity.service.js';
import { isFeatureAvailable } from '../feature-availability.js';
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_REGISTRY, approvedLegalDocument, type LegalDocumentVersion } from '../legal/legal-documents.js';
import { PrismaService } from '../prisma/prisma.service.js';

import {
  BILLING_PROVIDER_PORT,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  type ProviderSubscriptionState,
  type VerifiedBillingEvent,
} from './billing-provider.port.js';
import { PLAN_ELIGIBILITY_PORT, type PlanEligibilityPort, type PlanEligibilityRule } from './plan-eligibility.port.js';

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
//               ends any other open (MANUAL / DEVELOPMENT) one in the same tx.
//               The caller grants the subscribing-owner role (identity lives in
//               the service layer, not here).
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

export const PAST_DUE_GRACE_DAYS_DEFAULT = 7;

export type BillingRefusal =
  | 'BILLING_UNAVAILABLE'
  | 'PLAN_NOT_SELLABLE'
  | 'PLAN_NOT_ELIGIBLE'
  | 'TERMS_NOT_ACCEPTED'
  | 'TERMS_NOT_APPROVED'
  | 'PORTAL_NOT_CONFIGURED'
  | 'ALREADY_SUBSCRIBED'
  | 'NO_BILLING_ACCOUNT';

export const STORAGE_CAPACITY_KEY = 'esign.storage_bytes';
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

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

const SENDING = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

/** STRIPE_PLAN_PRICES = "plan-key=price_x,other-key=price_y" (operator config). */
export function parsePlanPrices(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k !== '' && v !== '') m.set(k, v);
  }
  return m;
}

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

  billingAvailable(): boolean {
    return this.billing.isConfigured() && this.prices().size > 0;
  }

  /**
   * The public plan catalog (the pre-catalog operator plan is excluded).
   * With a tenant, eligibility and purchasability are evaluated for it.
   */
  async catalog(tenant_id: string | null = null): Promise<CatalogPlanView[]> {
    const prices = this.prices();
    const plans = await this.prisma.plan.findMany({
      // Public catalog only: operator / legacy plans are never presented.
      where: { display_order: { lt: OPERATOR_DISPLAY_ORDER_FLOOR }, sales_model: { not: 'OPERATOR' } },
      include: { allowances: true, capacities: true, features: true },
      orderBy: [{ display_order: 'asc' }, { key: 'asc' }],
    });
    const out: CatalogPlanView[] = [];
    for (const p of plans) {
      const eligible = await this.eligible(tenant_id, p.eligibility);
      out.push({
        key: p.key,
        name: p.name,
        description: p.description,
        tenant_kind: p.tenant_kind,
        sales_model: p.sales_model,
        status: p.status,
        price: p.list_price_minor !== null && p.currency !== null ? { amount_minor: p.list_price_minor, currency: p.currency, interval: p.billing_interval } : null,
        reference_price:
          p.reference_price_substantiated && p.reference_price_minor !== null && p.currency !== null ? { amount_minor: p.reference_price_minor, currency: p.currency } : null,
        commitment_months: p.commitment_months,
        eligibility: p.eligibility,
        eligible,
        support_tier: p.support_tier,
        activation_note: p.activation_note,
        allowances: p.allowances.map((a) => ({
          allowance_key: a.allowance_key,
          included_quantity: a.included_quantity,
          unlimited: a.unlimited,
          period: a.period,
          available: isFeatureAvailable(a.allowance_key),
        })),
        capacities: p.capacities.map((c) => ({
          capacity_key: c.capacity_key,
          limit: c.limit_quantity === null ? null : Number(c.limit_quantity),
          unlimited: c.unlimited,
          available: isFeatureAvailable(c.capacity_key),
        })),
        features: p.features.map((f) => ({ feature_key: f.feature_key, enabled: f.enabled, available: isFeatureAvailable(f.feature_key) })),
        purchasable: p.sellable && p.status === 'ACTIVE' && this.billing.isConfigured() && prices.has(p.key) && eligible,
      });
    }
    return out;
  }

  /** The tenant's open subscription, else its most recent one (for display). */
  private async currentRow(tenant_id: string) {
    const include = { plan: { include: { features: true } } } as const;
    const open = await this.prisma.tenantSubscription.findFirst({ where: { tenant_id, ended_at: null }, include });
    if (open !== null) return open;
    return this.prisma.tenantSubscription.findFirst({ where: { tenant_id }, include, orderBy: { started_at: 'desc' } });
  }

  async account(tenant_id: string, allowance_key: string, at: Date = new Date()): Promise<AccountView> {
    const row = await this.currentRow(tenant_id);
    const allowance = await this.allowance.getStatus(tenant_id, allowance_key, at);
    const storage = await this.capacity.status(tenant_id, STORAGE_CAPACITY_KEY);
    const exportDays = postTerminationExportDays();
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
              commitment_months: row.plan.commitment_months,
              commitment_end: row.commitment_end,
              cancel_requested_within_commitment: row.cancel_requested_within_commitment,
              eligibility_state: row.eligibility_state,
              list_price:
                row.plan.list_price_minor !== null && row.plan.currency !== null
                  ? { amount_minor: row.plan.list_price_minor, currency: row.plan.currency, interval: row.plan.billing_interval }
                  : null,
              features: row.plan.features.map((f) => ({ feature_key: f.feature_key, enabled: f.enabled, available: isFeatureAvailable(f.feature_key) })),
              export_access_until: row.ended_at !== null && exportDays !== null ? new Date(row.ended_at.getTime() + exportDays * 86_400_000) : null,
            },
      allowance,
      storage: storage.subscribed ? { capacity_key: storage.capacity_key, limit: storage.limit, unlimited: storage.unlimited, used: storage.used } : null,
      billing_available: this.billingAvailable(),
    };
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

  /** The subscribing owner of the tenant's open, sending SELF_SERVICE subscription. */
  async sendingOwner(tenant_id: string, at: Date = new Date()): Promise<string | null> {
    const row = await this.prisma.tenantSubscription.findFirst({ where: { tenant_id, ended_at: null, source: 'SELF_SERVICE' } });
    if (row === null || row.activated_by === null) return null;
    return subscriptionSends(row, at) ? row.activated_by : null;
  }

  async startCheckout(input: {
    tenant_id: string;
    user_id: string;
    user_email: string;
    plan_key: string;
    success_url: string;
    cancel_url: string;
    accept_terms?: boolean;
    at?: Date;
  }): Promise<{ url: string }> {
    const at = input.at ?? new Date();
    if (!this.billing.isConfigured()) throw new BillingRefusedError('BILLING_UNAVAILABLE');
    const plan = await this.prisma.plan.findUnique({ where: { key: input.plan_key } });
    const price = this.prices().get(input.plan_key);
    if (plan === null || !plan.sellable || plan.status !== 'ACTIVE' || plan.sales_model !== 'SELF_SERVICE') throw new BillingRefusedError('PLAN_NOT_SELLABLE');
    if (!(await this.eligible(input.tenant_id, plan.eligibility))) throw new BillingRefusedError('PLAN_NOT_ELIGIBLE');
    if (price === undefined) throw new BillingRefusedError('BILLING_UNAVAILABLE', 'no provider price configured for the plan');
    // A1 — terms evidence. No live charging without approved terms; an approved
    // version must be affirmatively accepted.
    const terms = approvedLegalDocument('sign.terms_of_service', this.legal);
    if (terms === null && this.billing.mode() === 'live') throw new BillingRefusedError('TERMS_NOT_APPROVED');
    if (terms !== null && input.accept_terms !== true) throw new BillingRefusedError('TERMS_NOT_ACCEPTED');
    const open = await this.prisma.tenantSubscription.findFirst({ where: { tenant_id: input.tenant_id, ended_at: null } });
    // A tenant already paying through the provider manages it in the portal; a
    // MANUAL / DEVELOPMENT subscription may be replaced by a self-service one.
    if (open !== null && open.source === 'SELF_SERVICE' && open.status !== 'INCOMPLETE') {
      throw new BillingRefusedError('ALREADY_SUBSCRIBED');
    }
    const prior = await this.prisma.tenantSubscription.findFirst({
      where: { tenant_id: input.tenant_id, billing_account_ref: { not: null } },
      orderBy: { started_at: 'desc' },
    });
    const intent_id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
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
      account_ref: prior?.billing_account_ref ?? null,
      success_url: input.success_url,
      cancel_url: input.cancel_url,
    });
    await this.prisma.checkoutIntent.update({ where: { id: intent_id }, data: { provider_session_ref: session.session_ref } });
    return { url: session.url };
  }

  async portal(tenant_id: string, return_url: string): Promise<{ url: string }> {
    if (!this.billing.isConfigured()) throw new BillingRefusedError('BILLING_UNAVAILABLE');
    const row = await this.prisma.tenantSubscription.findFirst({
      where: { tenant_id, billing_account_ref: { not: null } },
      orderBy: { started_at: 'desc' },
    });
    if (row?.billing_account_ref == null) throw new BillingRefusedError('NO_BILLING_ACCOUNT');
    // A1 review — a commitment plan must not reach the provider's DEFAULT portal,
    // whose cancellation settings could contradict the (pending) annual terms.
    // It needs an explicit portal configuration set up to match the approved
    // contract (STRIPE_PORTAL_CONFIGURATION); until then the portal is refused.
    const plan = await this.prisma.plan.findUnique({ where: { id: row.plan_id } });
    const configuration = process.env['STRIPE_PORTAL_CONFIGURATION']?.trim() || undefined;
    if (plan?.commitment_months != null && configuration === undefined) {
      throw new BillingRefusedError('PORTAL_NOT_CONFIGURED', 'the billing portal for commitment plans needs an approved portal configuration');
    }
    return this.billing.createPortalSession(row.billing_account_ref, return_url, configuration);
  }

  /** A verified provider event. At most once per provider event id. */
  async handleEvent(evt: VerifiedBillingEvent, at: Date = new Date()): Promise<WebhookResult> {
    const seen = await this.prisma.billingEvent.findUnique({
      where: { provider_provider_event_id: { provider: this.billing.provider, provider_event_id: evt.id } },
    });
    if (seen !== null) return { outcome: 'DUPLICATE', tenant_id: null };

    const ref = evt.subscription_ref;
    // A provider failure throws here: nothing is recorded, the redelivery retries.
    const result: ApplyResult =
      ref === null
        ? { outcome: 'IGNORED', detail: `event ${evt.type} carries no subscription`, tenant_id: null }
        : await this.syncSubscription(ref, at);

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
  async syncSubscription(subscription_ref: string, at: Date = new Date()): Promise<ApplyResult> {
    const state = await this.billing.retrieveSubscription(subscription_ref);
    return this.applyProviderState(state, at);
  }

  async applyProviderState(state: ProviderSubscriptionState, at: Date = new Date()): Promise<ApplyResult> {
    const existing = await this.prisma.tenantSubscription.findFirst({
      where: { billing_provider: state.provider, billing_subscription_ref: state.subscription_ref },
    });
    const intent =
      state.intent_id === null ? null : await this.prisma.checkoutIntent.findUnique({ where: { id: state.intent_id }, include: { plan: true } });
    const tenant_id = existing?.tenant_id ?? intent?.tenant_id ?? null;
    if (tenant_id === null) return { outcome: 'IGNORED', detail: 'subscription is not linked to an Aramo checkout', tenant_id: null };
    // The provider metadata must agree with Aramo's own record: never let one
    // tenant's payment move another tenant's entitlement.
    if (state.tenant_id !== null && state.tenant_id !== tenant_id) {
      this.log.warn(`billing tenant mismatch for ${state.subscription_ref}`);
      return { outcome: 'IGNORED', detail: 'provider metadata tenant does not match the Aramo record', tenant_id };
    }
    if (intent !== null && intent.tenant_id !== tenant_id) {
      return { outcome: 'IGNORED', detail: 'checkout intent tenant does not match', tenant_id };
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${tenant_id}`}, 0))`;
      const mapped = mapProviderStatus(state.provider_status);
      const row = await tx.tenantSubscription.findFirst({
        where: { billing_provider: state.provider, billing_subscription_ref: state.subscription_ref },
      });
      if (row !== null) return this.updateRow(tx, row, state, mapped, at);
      if (intent === null) return { outcome: 'IGNORED', detail: 'unknown subscription without a checkout intent', tenant_id } as ApplyResult;
      return this.openRow(tx, tenant_id, intent, state, mapped, at);
    });
  }

  private async updateRow(
    tx: Tx,
    row: {
      id: string;
      tenant_id: string;
      plan_id: string;
      status: string;
      grace_until: Date | null;
      ended_at: Date | null;
      activated_by: string | null;
      commitment_end: Date | null;
    },
    state: ProviderSubscriptionState,
    mapped: ReturnType<typeof mapProviderStatus>,
    at: Date,
  ): Promise<ApplyResult> {
    if (row.ended_at !== null) {
      // An ended subscription is never reopened; a resubscription is a new checkout.
      return { outcome: 'IGNORED', detail: 'subscription already ended', tenant_id: row.tenant_id, subscription_id: row.id };
    }
    const grace_until = mapped.grace
      ? row.status === 'PAST_DUE' && row.grace_until !== null
        ? row.grace_until
        : new Date(at.getTime() + graceDays() * 86_400_000)
      : null;
    // A plan change made in the provider (its price maps to another catalog plan).
    const plan_id = (await this.planForPrice(tx, state.price_ref)) ?? row.plan_id;
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
        plan_id,
      },
    });
    const reactivated = !SENDING.has(row.status) && SENDING.has(mapped.status);
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
    intent: { id: string; user_id: string; plan_id: string; plan: { key: string } },
    state: ProviderSubscriptionState,
    mapped: ReturnType<typeof mapProviderStatus>,
    at: Date,
  ): Promise<ApplyResult> {
    if (mapped.ends) return { outcome: 'IGNORED', detail: 'checkout subscription already ended', tenant_id };
    // The plan is the one the owner chose at checkout; a provider price that maps
    // to a different sellable plan wins (plan change made in the provider).
    const plan_id = (await this.planForPrice(tx, state.price_ref)) ?? intent.plan_id;
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: plan_id } });
    const open = await tx.tenantSubscription.findFirst({ where: { tenant_id, ended_at: null } });
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
        commitment_start: plan.commitment_months !== null ? anchor : null,
        commitment_end: plan.commitment_months !== null ? addMonthsClamped(anchor, plan.commitment_months) : null,
        eligibility_state: plan.eligibility !== null ? 'OK' : null,
        eligibility_checked_at: plan.eligibility !== null ? at : null,
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

  private async planForPrice(tx: Tx, price_ref: string | null): Promise<string | null> {
    if (price_ref === null) return null;
    for (const [key, price] of this.prices()) {
      if (price !== price_ref) continue;
      const p = await tx.plan.findUnique({ where: { key } });
      if (p !== null && p.sellable) return p.id;
    }
    return null;
  }

  /**
   * A1 — re-check eligibility-bound plans (Standard Professional ⇐ ATS). A lapse
   * is RECORDED and surfaced to the tenant and the operator; sending and the
   * current commitment are kept (no automatic downgrade or price change — that
   * is a commercial decision). Recovery clears it.
   */
  async refreshEligibility(at: Date = new Date()): Promise<{ checked: number; lapsed: number; restored: number }> {
    const rows = await this.prisma.tenantSubscription.findMany({
      where: { ended_at: null, plan: { eligibility: { not: null } } },
      include: { plan: true },
    });
    const tally = { checked: 0, lapsed: 0, restored: 0 };
    for (const r of rows) {
      tally.checked += 1;
      const ok = await this.eligible(r.tenant_id, r.plan.eligibility);
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

  /** Re-fetch every open provider-linked subscription (missed webhooks heal). */
  async reconcile(at: Date = new Date(), limit = 200): Promise<{ checked: number; applied: number; failed: number; results: ApplyResult[] }> {
    const rows = await this.prisma.tenantSubscription.findMany({
      where: { ended_at: null, billing_subscription_ref: { not: null } },
      select: { billing_subscription_ref: true },
      orderBy: { provider_state_at: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
    const tally = { checked: 0, applied: 0, failed: 0, results: [] as ApplyResult[] };
    for (const r of rows) {
      tally.checked += 1;
      try {
        const res = await this.syncSubscription(r.billing_subscription_ref as string, at);
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
