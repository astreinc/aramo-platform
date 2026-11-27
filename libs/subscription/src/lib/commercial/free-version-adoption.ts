import { billingPeriodAt } from '../billing-period.js';
import { FREE_SUBSCRIPTION_SOURCE } from '../free-personal-subscription.js';
import { PIN_REASON_CHANGE_REQUEST, type PlanVersionContent, planVersionTerms } from '../plan-version.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION } from '../product-registry.js';
import { ApplyFailure } from './commercial-apply-records.js';
import { type TermChange, changedTerms, undefinedTermTreatment } from './commercial-apply.service.js';

// SIGN-FREE-PARITY-1 S1 (LOCKED 2026-11-27; typed divergence D-1) — the opt-in part of an approved
// PLAN_VERSION_PUBLISH of a FREE plan (`adopt_free_subscriptions: true`): every open FREE-source BASE
// subscription of the plan pinned to an older version moves to the version just published, in the
// same transaction. TD-A5-1 (publishing never moves a subscription) still holds for every request
// without the option and for every non-FREE plan.
//
// Admissible only when the move is an improvement for every subscriber:
//   - no allowance, capacity or window is lowered (a REMOVED window is not lowered: the cap is gone);
//   - a dropped allowance has zero RESERVED + CONSUMED usage in the subscriber's current period,
//     read under the advisory lock AllowanceService.reserve takes (the CCP-PERSONAL-ARRANGED-1 P-1
//     FREE treatment, undefinedTermTreatment with replacedSource FREE);
//   - a changed period kind is refused (undefined treatment).
// Any refusal fails the whole apply (nothing is published, nothing moves): FREE_ADOPTION_REFUSED.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export interface FreeAdoptionMove {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly product_key: string;
  readonly from_plan_version_id: string;
  readonly period_anchor: Date;
}

/** The terms the move would lower or leave undefined (empty = an improvement). Pure. */
export function freeAdoptionRefusals(from: PlanVersionContent, to: PlanVersionContent): { refused: TermChange[]; zeroUsageRequired: TermChange[] } {
  const changes = changedTerms(from, to);
  const lowered = changes.filter((c) => c.change === 'lowered');
  const { refused, zeroUsageRequired } = undefinedTermTreatment(changes, to, FREE_SUBSCRIPTION_SOURCE);
  return { refused: [...lowered, ...refused], zeroUsageRequired };
}

export async function adoptFreeSubscriptions(
  tx: Tx,
  plan: { id: string; key: string; sales_model: string },
  to: { id: string; content: unknown; content_checksum: string },
  now: Date,
): Promise<FreeAdoptionMove[]> {
  if (plan.sales_model !== 'FREE') throw new ApplyFailure('FREE_ADOPTION_NOT_FREE_PLAN', { plan_key: plan.key, sales_model: plan.sales_model });
  const rows = await tx.tenantSubscription.findMany({
    where: { plan_id: plan.id, source: FREE_SUBSCRIPTION_SOURCE, composition_role: BASE_COMPOSITION, ended_at: null, NOT: { plan_version_id: to.id } },
    orderBy: { id: 'asc' },
  });
  const toTerms = planVersionTerms(to);
  const fromTerms = new Map<string, PlanVersionContent>();
  const moves: FreeAdoptionMove[] = [];
  for (const row of rows) {
    let from = fromTerms.get(row.plan_version_id);
    if (from === undefined) {
      from = planVersionTerms(await tx.planVersion.findUniqueOrThrow({ where: { id: row.plan_version_id } }));
      fromTerms.set(row.plan_version_id, from);
    }
    const { refused, zeroUsageRequired } = freeAdoptionRefusals(from, toTerms);
    if (refused.length > 0) {
      throw new ApplyFailure('FREE_ADOPTION_REFUSED', { subscription_id: row.id, terms: refused.map((c) => `${c.kind}:${c.key}${c.window_kind ? `:${c.window_kind}` : ''}`), from_plan_version_id: row.plan_version_id, to_plan_version_id: to.id });
    }
    if (zeroUsageRequired.length > 0) {
      const period = billingPeriodAt(row.period_anchor, now);
      for (const c of zeroUsageRequired) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${row.tenant_id}:${c.key}`}, 0))`;
        const used = await tx.allowanceUsage.count({ where: { tenant_id: row.tenant_id, allowance_key: c.key, period_start: period.start, state: { in: ['RESERVED', 'CONSUMED'] } } });
        if (used > 0) {
          throw new ApplyFailure('FREE_ADOPTION_REFUSED', { subscription_id: row.id, terms: [`allowance:${c.key}`], used, period_start: period.start.toISOString(), from_plan_version_id: row.plan_version_id, to_plan_version_id: to.id });
        }
      }
    }
    // TD-A5-9 — the re-pin names its reason; the DB trigger records SubscriptionVersionPinEvent.
    await tx.$executeRaw`SELECT set_config('aramo.subscription_pin_reason', ${PIN_REASON_CHANGE_REQUEST}, true), set_config('aramo.subscription_pin_price_ref', '', true)`;
    await tx.tenantSubscription.update({ where: { id: row.id }, data: { plan_version_id: to.id } });
    moves.push({ subscription_id: row.id, tenant_id: row.tenant_id, product_key: row.product_key, from_plan_version_id: row.plan_version_id, period_anchor: row.period_anchor });
  }
  return moves;
}
