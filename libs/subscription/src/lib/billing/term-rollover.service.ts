import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { billingTermOf, hasExplicitTerms, type PlanVersionContent, planVersionTerms } from '../plan-version.js';
import { currentPublishedVersion } from '../plan-version.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertProductKey, BASE_COMPOSITION, type ProductKey } from '../product-registry.js';

import { BILLING_PROVIDER_SEAT_PORT, type BillingProviderSeatPort } from './billing-provider.port.js';
import { findWebPin } from './provider-price.js';
import { SubscriptionLifecycleService, termSwitchRefusal } from './subscription-lifecycle.service.js';

// Aramo Sign Monthly and Annual-Commitment Pricing Directive v1.0 (LOCKED 2026-11-15) §3.4, ruling Q2 — after
// its 12-month commitment an ANNUAL_COMMIT subscription continues month to month at the plan's CURRENT
// MONTHLY price. In the LAST period of the commitment (the provider period end has reached the commitment
// end) and unless it is set to cancel, the Stripe subscription's item is moved to the MONTHLY price WITHOUT
// proration, so the first period after the commitment is billed at it. The row's term then moves to MONTHLY
// when the provider state is applied (webhook or the re-fetch below), never on the local call alone.
//
//   target   the plan's current PUBLISHED version when it carries explicit terms, else the row's own
//            version (it does: only a row sold on explicit terms has a term); its MONTHLY term's Stripe pin.
//            No MONTHLY pin: nothing is moved (reported as skipped) and the price stays as it is.
//   rule     termSwitchRefusal (Q4): ANNUAL_COMMIT → MONTHLY only once the commitment is reached.
//   scope    Stripe-billed SELF_SERVICE rows with term ANNUAL_COMMIT only. Legacy rows (no term), store and
//            Razorpay rows are never touched (Q3: existing subscriptions keep their terms).
//   safety   idempotent: the provider call carries a key per (row, commitment end), and a row already on the
//            target price is left as it is. Runs from the Sign billing reconcile worker (opt-in, dark).

export interface TermRolloverCounts {
  due: number;
  moved: number;
  skipped: number;
  failed: number;
}

/** The rows a run considers, as read (exported for the unit tests). */
export interface TermRolloverRow {
  id: string;
  plan_id: string;
  plan_version_id: string;
  term: string | null;
  source: string;
  billing_provider: string | null;
  billing_subscription_ref: string | null;
  cancel_at_period_end: boolean;
  commitment_end: Date | null;
  current_period_end: Date | null;
}

/** True when the row is in the last period of its ANNUAL_COMMIT commitment and continues afterwards. */
export function termRolloverDue(row: TermRolloverRow): boolean {
  return (
    row.term === 'ANNUAL_COMMIT' &&
    row.source === 'SELF_SERVICE' &&
    row.billing_provider === 'STRIPE' &&
    row.billing_subscription_ref !== null &&
    !row.cancel_at_period_end &&
    row.commitment_end !== null &&
    row.current_period_end !== null &&
    row.current_period_end.getTime() >= row.commitment_end.getTime()
  );
}

/** The version whose MONTHLY term the row continues at (Q2): the current published one with explicit terms, else its own. */
type VersionRow = { id: string; content: unknown; content_checksum: string };
export function rolloverVersion(pinned: VersionRow, current: VersionRow | null): { row: VersionRow; content: PlanVersionContent } | null {
  const currentContent = current === null ? null : planVersionTerms(current);
  if (current !== null && currentContent !== null && hasExplicitTerms(currentContent) && billingTermOf(currentContent, 'MONTHLY') !== null) return { row: current, content: currentContent };
  const own = planVersionTerms(pinned);
  return hasExplicitTerms(own) && billingTermOf(own, 'MONTHLY') !== null ? { row: pinned, content: own } : null;
}

@Injectable()
export class BillingTermRolloverService {
  private readonly log = new Logger(BillingTermRolloverService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Bound by SubscriptionModule (the Stripe adapter). Unbound or without price updates: nothing is moved.
    @Optional() @Inject(BILLING_PROVIDER_SEAT_PORT) private readonly port?: BillingProviderSeatPort,
    @Optional() private readonly lifecycle?: SubscriptionLifecycleService,
  ) {}

  async run(product_key: ProductKey, at: Date = new Date(), limit = 200): Promise<TermRolloverCounts> {
    const counts: TermRolloverCounts = { due: 0, moved: 0, skipped: 0, failed: 0 };
    const port = this.port;
    if (port === undefined || port.updateSubscriptionPrice === undefined || !port.isConfigured()) return counts;
    const rows = await this.prisma.tenantSubscription.findMany({
      where: {
        product_key: assertProductKey(product_key),
        composition_role: BASE_COMPOSITION,
        ended_at: null,
        source: 'SELF_SERVICE',
        billing_provider: 'STRIPE',
        billing_subscription_ref: { not: null },
        term: 'ANNUAL_COMMIT',
        cancel_at_period_end: false,
        commitment_end: { not: null },
      },
      include: { plan_version: true },
      orderBy: [{ commitment_end: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    for (const r of rows) {
      if (!termRolloverDue(r)) continue;
      counts.due += 1;
      try {
        if (termSwitchRefusal(r, planVersionTerms(r.plan_version), 'MONTHLY') !== null) {
          counts.skipped += 1;
          continue;
        }
        const target = rolloverVersion(r.plan_version, await currentPublishedVersion(this.prisma, r.plan_id));
        const pin = target === null ? null : await findWebPin(this.prisma, target.row.id, 'STRIPE', 'MONTHLY');
        if (pin === null) {
          this.log.warn(`term rollover: no MONTHLY Stripe price for subscription ${r.id}; it continues at its current price`);
          counts.skipped += 1;
          continue;
        }
        const key = `aramo-term-rollover-${r.id}-${(r.commitment_end as Date).toISOString().slice(0, 10)}`;
        const state = await port.updateSubscriptionPrice(r.billing_subscription_ref as string, pin.provider_price_ref, key);
        // Apply the provider-confirmed state now (the webhook would too): the row moves to the MONTHLY term.
        if (this.lifecycle !== undefined) await this.lifecycle.applyProviderState(state, product_key, at);
        counts.moved += 1;
      } catch (e) {
        counts.failed += 1;
        this.log.error(`term rollover failed for subscription ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return counts;
  }
}
