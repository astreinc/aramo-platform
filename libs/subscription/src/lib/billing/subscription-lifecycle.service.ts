import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { type AllowanceReadResult, AllowanceService, subscriptionSends } from '../allowance.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import {
  BILLING_PROVIDER_PORT,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  type ProviderSubscriptionState,
  type VerifiedBillingEvent,
} from './billing-provider.port.js';

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

export const PAST_DUE_GRACE_DAYS_DEFAULT = 7;

export type BillingRefusal =
  | 'BILLING_UNAVAILABLE'
  | 'PLAN_NOT_SELLABLE'
  | 'ALREADY_SUBSCRIBED'
  | 'NO_BILLING_ACCOUNT';

export class BillingRefusedError extends Error {
  constructor(public readonly reason: BillingRefusal, detail?: string) {
    super(detail ?? reason);
    this.name = 'BillingRefusedError';
  }
}

export interface SellablePlanView {
  key: string;
  name: string;
  description: string | null;
  allowances: { allowance_key: string; included_quantity: number; period: string }[];
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
}

export interface AccountView {
  subscription: SubscriptionView | null;
  allowance: AllowanceReadResult;
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

function graceDays(): number {
  const n = Number(process.env['BILLING_PAST_DUE_GRACE_DAYS'] ?? PAST_DUE_GRACE_DAYS_DEFAULT);
  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : PAST_DUE_GRACE_DAYS_DEFAULT;
}

@Injectable()
export class SubscriptionLifecycleService {
  private readonly log = new Logger(SubscriptionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
  ) {}

  private prices(): Map<string, string> {
    return parsePlanPrices(process.env['STRIPE_PLAN_PRICES']);
  }

  billingAvailable(): boolean {
    return this.billing.isConfigured() && this.prices().size > 0;
  }

  async listSellablePlans(): Promise<SellablePlanView[]> {
    const prices = this.prices();
    const plans = await this.prisma.plan.findMany({ where: { sellable: true }, include: { allowances: true }, orderBy: { key: 'asc' } });
    return plans.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      allowances: p.allowances.map((a) => ({ allowance_key: a.allowance_key, included_quantity: a.included_quantity, period: a.period })),
      purchasable: this.billing.isConfigured() && prices.has(p.key),
    }));
  }

  /** The tenant's open subscription, else its most recent one (for display). */
  private async currentRow(tenant_id: string) {
    const open = await this.prisma.tenantSubscription.findFirst({ where: { tenant_id, ended_at: null }, include: { plan: true } });
    if (open !== null) return open;
    return this.prisma.tenantSubscription.findFirst({ where: { tenant_id }, include: { plan: true }, orderBy: { started_at: 'desc' } });
  }

  async account(tenant_id: string, allowance_key: string, at: Date = new Date()): Promise<AccountView> {
    const row = await this.currentRow(tenant_id);
    const allowance = await this.allowance.getStatus(tenant_id, allowance_key, at);
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
            },
      allowance,
      billing_available: this.billingAvailable(),
    };
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
  }): Promise<{ url: string }> {
    if (!this.billing.isConfigured()) throw new BillingRefusedError('BILLING_UNAVAILABLE');
    const plan = await this.prisma.plan.findUnique({ where: { key: input.plan_key } });
    const price = this.prices().get(input.plan_key);
    if (plan === null || !plan.sellable) throw new BillingRefusedError('PLAN_NOT_SELLABLE');
    if (price === undefined) throw new BillingRefusedError('BILLING_UNAVAILABLE', 'no provider price configured for the plan');
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
    await this.prisma.checkoutIntent.create({
      data: { id: intent_id, tenant_id: input.tenant_id, user_id: input.user_id, plan_id: plan.id, provider: this.billing.provider },
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
    return this.billing.createPortalSession(row.billing_account_ref, return_url);
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
    row: { id: string; tenant_id: string; status: string; grace_until: Date | null; ended_at: Date | null; activated_by: string | null },
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
    await tx.tenantSubscription.update({
      where: { id: row.id },
      data: {
        status: mapped.status,
        grace_until,
        current_period_end: state.current_period_end,
        cancel_at_period_end: state.cancel_at_period_end,
        billing_account_ref: state.account_ref,
        provider_state_at: at,
        ended_at: mapped.ends ? at : null,
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
    let plan_id = intent.plan_id;
    if (state.price_ref !== null) {
      for (const [key, price] of this.prices()) {
        if (price !== state.price_ref) continue;
        const p = await tx.plan.findUnique({ where: { key } });
        if (p !== null && p.sellable) plan_id = p.id;
      }
    }
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
    await tx.tenantSubscription.create({
      data: {
        id,
        tenant_id,
        plan_id,
        period_anchor: state.current_period_start.getTime() > 0 ? state.current_period_start : at,
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
