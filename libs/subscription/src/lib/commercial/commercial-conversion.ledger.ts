import { Injectable } from '@nestjs/common';
import { grantCapabilitiesInTx } from '@aramo/entitlement';
import { v7 as uuidv7 } from 'uuid';

import { addMonthsClamped, billingPeriodAt } from '../billing-period.js';
import { isGovernedSubscription } from '../billing/governed-subscription.js';
import { planVersionTerms } from '../plan-version.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, PRODUCT_CAPABILITIES, assertProductKey, openBaseSubscription, type ProductKey } from '../product-registry.js';

import { downgradedTerms } from './commercial-apply.service.js';
import { CommercialAuditRepository } from './commercial-audit.repository.js';
import type { CommercialChangeApplicationRow } from './commercial-apply.service.js';
import type { CommercialChangeRequestRow } from './commercial-change-request.service.js';
import {
  type ConversionFailureCode,
  type ConversionPayload,
  type ToGovernedPayload,
  asConversionPayload,
  conversionPayloadErrors,
  isHeldResolution,
  releaseConsumable,
} from './commercial-conversion.js';

// CCP-C2 (PBD §5.2 row C2; Conversion Rule C-12, C-13, C-14, C-21, C-23) — the IN-TRANSACTION half of
// the conversion. Every method runs inside the caller's transaction, which already holds the shared
// billing lock `billing:<tenant>`:
//   - the checkout transaction (startCheckout): the release is consumed by exactly ONE checkout
//     (C-1 exception, C-12);
//   - the webhook / re-fetch transaction (applyProviderState): a provider-confirmed, sending
//     activation that a valid release binds ends the governed row and opens the SELF_SERVICE row in
//     that ONE transaction (C-12); a confirmed provider end completes a self-service → governed
//     conversion by opening the governed MANUAL row in that same transaction (C-13);
//   - the apply transaction (CommercialConversionService).
// Nothing here calls the provider. Nothing here deletes or rewrites history (C-14): an ended row
// keeps its ended_at/status, releases and applications are append-only, every step is audited.
//
// The G3 / T8 checks mirror CommercialApplyService (A6) on purpose (no edit to the A6 file, which
// A6-R is changing in parallel): see TD-C2-9 in the acceptance record.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type ReadClient = Pick<Tx, 'commercialConversionRelease'>;

export interface ConversionReleaseRow {
  id: string;
  change_request_id: string;
  tenant_id: string;
  product_key: string;
  governed_subscription_id: string;
  plan_id: string;
  plan_version_id: string;
  held_subscription_ref: string | null;
  state: string;
  expires_at: Date;
  intent_id: string | null;
  consumed_at: Date | null;
  self_service_subscription_id: string | null;
  converted_at: Date | null;
  expired_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/** A conversion step failed a re-check (rolled back by the apply path; recorded by the webhook path). */
export class ConversionFailure extends Error {
  constructor(
    readonly code: ConversionFailureCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`conversion failed (${code})`);
    this.name = 'ConversionFailure';
  }
}

export interface ActivationTarget {
  plan_id: string;
  plan_version_id: string | null;
}

export interface ActivationReleaseVerdict {
  release: ConversionReleaseRow | null;
  /** The release binds this activation and every C-12 condition holds. */
  valid: boolean;
  /** Why a release that exists does not apply (empty when valid or when there is none). */
  reason: string;
}

const SYSTEM = { id: null, type: 'system' as const, role_keys: [] as string[] };
const SUBJECT = (id: string): string => `commercial_change_request:${id}`;

export function conversionPayloadOf(req: { payload: unknown }): ConversionPayload {
  const p = req.payload as Record<string, unknown> | null;
  const errors = p === null || typeof p !== 'object' || Array.isArray(p) ? ['payload must be a JSON object'] : conversionPayloadErrors(p);
  if (errors.length > 0) throw new ConversionFailure('INVALID_PAYLOAD', { errors });
  return asConversionPayload(p as Record<string, unknown>);
}

// ---- shared re-checks (G3 / T2 / T8), read-only ----------------------------------------------

/** G3 — a PUBLISHED version of an assignable (governed) plan of this product, for the tenant's kind. */
export async function pinnedGovernedVersion(tx: Tx, tenant_id: string, product_key: ProductKey, plan_key: string, plan_version_id: string) {
  const plan = await tx.plan.findUnique({ where: { key: plan_key } });
  if (plan === null || plan.product_key !== product_key) throw new ConversionFailure('PLAN_NOT_FOUND', { plan_key, product_key });
  const version = await tx.planVersion.findUnique({ where: { id: plan_version_id } });
  if (version === null || version.plan_id !== plan.id) throw new ConversionFailure('PLAN_VERSION_MISMATCH', { plan_key, plan_version_id });
  if (version.status !== 'PUBLISHED') throw new ConversionFailure('PLAN_VERSION_NOT_PUBLISHED', { plan_version_id, status: version.status });
  if (plan.status !== 'ACTIVE' || plan.sales_model === 'FREE' || plan.sales_model === 'SELF_SERVICE') {
    throw new ConversionFailure('PLAN_NOT_ASSIGNABLE', { plan_key, status: plan.status, sales_model: plan.sales_model });
  }
  await assertTenantKind(tx, tenant_id, plan);
  return { plan, version };
}

/** T2 — the self-service plan a release may be for: sellable, ACTIVE, SELF_SERVICE, on a PUBLISHED version. */
export async function releasablePlanVersion(tx: Tx, tenant_id: string, product_key: ProductKey, plan_key: string, plan_version_id: string) {
  const plan = await tx.plan.findUnique({ where: { key: plan_key } });
  if (plan === null || plan.product_key !== product_key) throw new ConversionFailure('PLAN_NOT_FOUND', { plan_key, product_key });
  const version = await tx.planVersion.findUnique({ where: { id: plan_version_id } });
  if (version === null || version.plan_id !== plan.id) throw new ConversionFailure('PLAN_VERSION_MISMATCH', { plan_key, plan_version_id });
  if (version.status !== 'PUBLISHED') throw new ConversionFailure('PLAN_VERSION_NOT_PUBLISHED', { plan_version_id, status: version.status });
  if (plan.status !== 'ACTIVE' || plan.sales_model !== 'SELF_SERVICE' || !plan.sellable) {
    throw new ConversionFailure('PLAN_NOT_ASSIGNABLE', { plan_key, status: plan.status, sales_model: plan.sales_model, sellable: plan.sellable });
  }
  await assertTenantKind(tx, tenant_id, plan);
  return { plan, version };
}

async function assertTenantKind(tx: Tx, tenant_id: string, plan: { key: string; tenant_kind: string | null }): Promise<void> {
  const tenant = await tx.$queryRawUnsafe<Array<{ kind: string | null }>>(`SELECT kind::text AS kind FROM identity."Tenant" WHERE id = $1::uuid`, tenant_id);
  if (tenant.length !== 1) throw new ConversionFailure('TENANT_NOT_FOUND', { tenant_id });
  if (plan.tenant_kind !== null && tenant[0]?.kind !== plan.tenant_kind) {
    throw new ConversionFailure('PLAN_TENANT_KIND_MISMATCH', { plan_key: plan.key, plan_tenant_kind: plan.tenant_kind, tenant_kind: tenant[0]?.kind ?? null });
  }
}

/** T8 (A6 rule as built) — same period kept: an upgrade-or-equal only, and no open reservation. */
export async function assertUsageDefined(tx: Tx, tenant_id: string, product_key: ProductKey, from_version_id: string, to: { id: string; content: unknown; content_checksum: string }): Promise<void> {
  const from = await tx.planVersion.findUniqueOrThrow({ where: { id: from_version_id } });
  const down = downgradedTerms(planVersionTerms(from), planVersionTerms(to));
  if (down.length > 0) throw new ConversionFailure('USAGE_TREATMENT_UNDEFINED', { kind: 'DOWNGRADE', terms: down, from_plan_version_id: from.id, to_plan_version_id: to.id });
  const reserved = await tx.allowanceUsage.count({ where: { tenant_id, allowance_key: { startsWith: `${product_key}.` }, state: 'RESERVED' } });
  if (reserved > 0) throw new ConversionFailure('USAGE_TREATMENT_UNDEFINED', { kind: 'OPEN_RESERVATIONS', reserved });
}

/** T8 (DR-A6-2) — usage recorded in the new row's first period under another alignment would stop counting. */
export async function strandedUsage(tx: Tx, tenant_id: string, product_key: ProductKey, anchor: Date, at: Date): Promise<number> {
  const period = billingPeriodAt(anchor, at);
  return tx.allowanceUsage.count({
    where: {
      tenant_id,
      allowance_key: { startsWith: `${product_key}.` },
      state: { in: ['RESERVED', 'CONSUMED'] },
      reserved_at: { gte: period.start },
      NOT: { period_start: period.start },
    },
  });
}

/** The named open governed (MANUAL) BASE row of this tenant × product. */
export async function governedRow(tx: Tx, tenant_id: string, product_key: ProductKey, subscription_id: string) {
  const row = await tx.tenantSubscription.findUnique({ where: { id: subscription_id } });
  if (row === null || row.tenant_id !== tenant_id || row.product_key !== product_key) throw new ConversionFailure('TARGET_NOT_FOUND', { subscription_id });
  if (row.ended_at !== null) throw new ConversionFailure('TARGET_STALE', { subscription_id, ended_at: row.ended_at.toISOString() });
  if (row.composition_role !== BASE_COMPOSITION || !isGovernedSubscription(row) || row.billing_subscription_ref !== null) {
    throw new ConversionFailure('TARGET_NOT_GOVERNED', { subscription_id, source: row.source });
  }
  return row;
}

/** The open governed_subscription_open hold on this provider subscription of the tenant (C-7). */
export async function heldActivation(tx: Tx, tenant_id: string, subscription_ref: string) {
  const flag = await tx.billingReconciliationFlag.findFirst({ where: { tenant_id, subscription_ref, reason: 'governed_subscription_open', resolved_at: null } });
  if (flag === null) throw new ConversionFailure('HELD_ACTIVATION_NOT_FOUND', { subscription_ref });
  return flag;
}

@Injectable()
export class CommercialConversionLedger {
  constructor(private readonly audit: CommercialAuditRepository) {}

  private async policyOf(tx: Tx, change_request_id: string): Promise<string> {
    const r = await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id: change_request_id }, select: { policy_version_id: true } });
    return r.policy_version_id;
  }

  private async append(tx: Tx, e: { event_type: string; tenant_id: string; subject: string; change_request_id: string; policy_version_id: string; payload: Record<string, unknown>; correlation_id: string; actor?: { id: string | null; type: 'user' | 'system'; role_keys: readonly string[] } }): Promise<void> {
    await this.audit.append(
      { actor: e.actor ?? SYSTEM, event_type: e.event_type, tenant_id: e.tenant_id, subject: e.subject, change_request_id: e.change_request_id, policy_version_id: e.policy_version_id, payload: e.payload, correlation_id: e.correlation_id },
      tx,
    );
  }

  // ---- checkout (C-1 exception) -----------------------------------------------------------

  /** The release that admits this checkout (unconsumed, unexpired at `at`, same governed row, plan and version), else null. */
  async releaseForCheckout(
    client: ReadClient,
    q: { tenant_id: string; product_key: ProductKey; governed_subscription_id: string; plan_id: string; plan_version_id: string; at: Date },
  ): Promise<ConversionReleaseRow | null> {
    const r = (await client.commercialConversionRelease.findFirst({
      where: { tenant_id: q.tenant_id, product_key: q.product_key, state: 'RELEASED', held_subscription_ref: null, governed_subscription_id: q.governed_subscription_id },
    })) as ConversionReleaseRow | null;
    if (r === null || !releaseConsumable(r, q.at) || r.plan_id !== q.plan_id || r.plan_version_id !== q.plan_version_id) return null;
    return r;
  }

  /** RELEASED → CONSUMED, bound to the CheckoutIntent created in this same transaction (exactly once). */
  async consumeForCheckoutInTx(tx: Tx, release: ConversionReleaseRow, intent: { id: string; user_id: string }, at: Date): Promise<void> {
    const n = await tx.commercialConversionRelease.updateMany({ where: { id: release.id, state: 'RELEASED' }, data: { state: 'CONSUMED', intent_id: intent.id, consumed_at: at, updated_at: at } });
    if (n.count !== 1) throw new Error(`conversion release ${release.id} is no longer consumable`);
    await this.append(tx, {
      event_type: 'COMMERCIAL_CONVERSION_RELEASE_CONSUMED',
      tenant_id: release.tenant_id,
      subject: `conversion_release:${release.id}`,
      change_request_id: release.change_request_id,
      policy_version_id: await this.policyOf(tx, release.change_request_id),
      payload: { release_id: release.id, intent_id: intent.id, checkout_user_id: intent.user_id, consumed_at: at.toISOString() },
      correlation_id: `checkout:${intent.id}`,
    });
  }

  // ---- webhook: governed → self-service (C-12) ---------------------------------------------

  /**
   * Under the billing lock, for an activation that would end the open governed row: the release
   * that binds it — consumed by this checkout, or an unconsumed release adopting this held provider
   * subscription — and whether every C-12 condition holds. An adopting release past its expiry is
   * marked EXPIRED here (the activation falls back to the hold, C-12 last bullet).
   */
  async releaseForActivation(
    tx: Tx,
    q: {
      tenant_id: string;
      product_key: ProductKey;
      governed: { id: string };
      intent: { id: string; status: string } | null;
      subscription_ref: string;
      current_period_start: Date;
      target: ActivationTarget;
      at: Date;
    },
  ): Promise<ActivationReleaseVerdict> {
    let r =
      q.intent === null ? null : ((await tx.commercialConversionRelease.findFirst({ where: { intent_id: q.intent.id } })) as ConversionReleaseRow | null);
    if (r === null) {
      const held = (await tx.commercialConversionRelease.findFirst({
        where: { tenant_id: q.tenant_id, product_key: q.product_key, state: 'RELEASED', held_subscription_ref: q.subscription_ref },
      })) as ConversionReleaseRow | null;
      if (held !== null && !releaseConsumable(held, q.at)) {
        await this.expireInTx(tx, held, q.at, `webhook:${q.subscription_ref}`);
        return { release: held, valid: false, reason: `conversion release ${held.id} expired` };
      }
      r = held;
    }
    if (r === null) return { release: null, valid: false, reason: '' };
    const invalid = (why: string): ActivationReleaseVerdict => ({ release: r, valid: false, reason: `conversion release ${r?.id} not applicable: ${why}` });
    if (r.tenant_id !== q.tenant_id || r.product_key !== q.product_key) return invalid('another tenant or product');
    if (r.state !== 'CONSUMED' && r.state !== 'RELEASED') return invalid(`the release is ${r.state}`);
    if (r.governed_subscription_id !== q.governed.id) return invalid('it names another governed subscription');
    if (q.intent === null || q.intent.status !== 'CREATED') return invalid(`the checkout is ${q.intent?.status ?? 'missing'}`);
    if (q.target.plan_id !== r.plan_id || q.target.plan_version_id !== r.plan_version_id) return invalid('the activated plan version is not the released one');
    const anchor = q.current_period_start.getTime() > 0 ? q.current_period_start : q.at;
    const stranded = await strandedUsage(tx, q.tenant_id, q.product_key, anchor, q.at);
    if (stranded > 0) return invalid(`USAGE_TREATMENT_UNDEFINED (CROSS_PERIOD, ${stranded} usage row(s) in the new first period)`);
    return { release: r, valid: true, reason: '' };
  }

  /** The webhook transaction ended the governed row and opened the SELF_SERVICE row: record and link it (C-12, C-14). */
  async convertedInTx(
    tx: Tx,
    c: { release: ConversionReleaseRow; governed: { id: string; source: string; plan_version_id: string }; self_service_subscription_id: string; intent_id: string; subscription_ref: string; at: Date; correlation_id: string },
  ): Promise<void> {
    const { release: r, at } = c;
    const n = await tx.commercialConversionRelease.updateMany({
      where: { id: r.id, state: r.state },
      data:
        r.state === 'RELEASED'
          ? { state: 'CONVERTED', intent_id: c.intent_id, consumed_at: at, converted_at: at, self_service_subscription_id: c.self_service_subscription_id, updated_at: at }
          : { state: 'CONVERTED', converted_at: at, self_service_subscription_id: c.self_service_subscription_id, updated_at: at },
    });
    if (n.count !== 1) throw new Error(`conversion release ${r.id} changed concurrently`);
    const policy_version_id = await this.policyOf(tx, r.change_request_id);
    const base = { tenant_id: r.tenant_id, change_request_id: r.change_request_id, policy_version_id, correlation_id: c.correlation_id };
    await this.append(tx, {
      ...base,
      event_type: 'COMMERCIAL_SUBSCRIPTION_ENDED',
      subject: `tenant_subscription:${c.governed.id}`,
      payload: { subscription_id: c.governed.id, source: c.governed.source, from_plan_version_id: c.governed.plan_version_id, replaced_by: c.self_service_subscription_id, conversion_release_id: r.id, effective_at: at.toISOString() },
    });
    await this.append(tx, {
      ...base,
      event_type: 'COMMERCIAL_CONVERSION_COMPLETED',
      subject: SUBJECT(r.change_request_id),
      payload: {
        direction: 'TO_SELF_SERVICE',
        release_id: r.id,
        governed_subscription_id: c.governed.id,
        self_service_subscription_id: c.self_service_subscription_id,
        provider_subscription_ref: c.subscription_ref,
        intent_id: c.intent_id,
        held_activation: r.held_subscription_ref !== null,
        effective_at: at.toISOString(),
      },
    });
  }

  /** RELEASED → EXPIRED (at or after expires_at). Idempotent. */
  async expireInTx(tx: Tx, r: ConversionReleaseRow, at: Date, correlation_id: string): Promise<boolean> {
    if (releaseConsumable(r, at)) return false;
    const n = await tx.commercialConversionRelease.updateMany({ where: { id: r.id, state: 'RELEASED' }, data: { state: 'EXPIRED', expired_at: at, updated_at: at } });
    if (n.count !== 1) return false;
    await this.append(tx, {
      event_type: 'COMMERCIAL_CONVERSION_RELEASE_EXPIRED',
      tenant_id: r.tenant_id,
      subject: `conversion_release:${r.id}`,
      change_request_id: r.change_request_id,
      policy_version_id: await this.policyOf(tx, r.change_request_id),
      payload: { release_id: r.id, expires_at: r.expires_at.toISOString(), expired_at: at.toISOString() },
      correlation_id,
    });
    return true;
  }

  // ---- provider-confirmed end: self-service → governed (C-13) ------------------------------

  /**
   * In the transaction that applied the provider state and CONFIRMED `command_ids` (C1): complete
   * every CONVERSION request in APPLYING all of whose commands are now confirmed. A failed re-check
   * records APPLYING → APPLY_FAILED in this same transaction (retryable; the provider state stays
   * applied). Returns the outcome per request.
   */
  async completeConfirmedInTx(tx: Tx, q: { command_ids: readonly string[]; at: Date; correlation_id: string }): Promise<Array<{ change_request_id: string; outcome: 'APPLIED' | 'APPLY_FAILED' }>> {
    if (q.command_ids.length === 0) return [];
    const cmds = await tx.billingProviderCommand.findMany({ where: { id: { in: [...q.command_ids] } }, select: { change_request_id: true } });
    const out: Array<{ change_request_id: string; outcome: 'APPLIED' | 'APPLY_FAILED' }> = [];
    for (const id of [...new Set(cmds.map((c) => c.change_request_id))].sort()) {
      await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
      const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
      if (req.action_type !== 'CONVERSION' || req.state !== 'APPLYING') continue;
      const pending = await tx.billingProviderCommand.count({ where: { change_request_id: id, state: { not: 'CONFIRMED' } } });
      if (pending > 0) continue;
      try {
        await this.completeToGovernedInTx(tx, req, q.at, q.correlation_id);
        out.push({ change_request_id: id, outcome: 'APPLIED' });
      } catch (e) {
        if (!(e instanceof ConversionFailure)) throw e;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLY_FAILED', updated_at: q.at } });
        await this.append(tx, {
          event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED',
          tenant_id: req.tenant_id as string,
          subject: SUBJECT(id),
          change_request_id: id,
          policy_version_id: req.policy_version_id,
          payload: { action_type: 'CONVERSION', direction: 'TO_GOVERNED', attempt: req.apply_attempts, failure: e.code, detail: e.detail, stage: 'provider_confirmed_completion' },
          correlation_id: q.correlation_id,
        });
        out.push({ change_request_id: id, outcome: 'APPLY_FAILED' });
      }
    }
    return out;
  }

  /**
   * Self-service → governed, after the provider-confirmed end was applied (C-13). The request is
   * APPLYING (locked by the caller). Throws ConversionFailure on a failed re-check (nothing written).
   */
  async completeToGovernedInTx(tx: Tx, req: CommercialChangeRequestRow, at: Date, correlation_id: string): Promise<CommercialChangeApplicationRow> {
    const p = conversionPayloadOf(req) as ToGovernedPayload;
    if (p.direction !== 'TO_GOVERNED') throw new ConversionFailure('INVALID_PAYLOAD', { errors: ['not a TO_GOVERNED conversion'] });
    const tenant_id = req.tenant_id as string;
    const product_key = assertProductKey(req.product_key);
    const base = { tenant_id, change_request_id: req.id, policy_version_id: req.policy_version_id, correlation_id };
    let effect: { subscription_id: string; replaced: string | null; from: string | null; to: string; capabilities: readonly string[]; inserted: string[] };

    if (isHeldResolution(p)) {
      // C-9 / C-29 — the held provider subscription is confirmed ended; the governed row is kept.
      const held = p as { held_subscription_ref: string; governed_subscription_id: string };
      const gov = await governedRow(tx, tenant_id, product_key, held.governed_subscription_id);
      effect = { subscription_id: gov.id, replaced: null, from: gov.plan_version_id, to: gov.plan_version_id, capabilities: [], inserted: [] };
      await this.append(tx, {
        ...base,
        event_type: 'COMMERCIAL_CONVERSION_COMPLETED',
        subject: SUBJECT(req.id),
        payload: { direction: 'TO_GOVERNED', held_subscription_ref: held.held_subscription_ref, governed_subscription_id: gov.id, governed_kept: true, effective_at: at.toISOString() },
      });
    } else {
      const ss_p = p as { subscription_id: string; plan_key: string; plan_version_id: string };
      const ss = await tx.tenantSubscription.findUnique({ where: { id: ss_p.subscription_id } });
      if (ss === null || ss.tenant_id !== tenant_id || ss.product_key !== product_key) throw new ConversionFailure('TARGET_NOT_FOUND', { subscription_id: ss_p.subscription_id });
      // The governed row opens ONLY after the provider-confirmed end has been applied (C-13).
      if (ss.ended_at === null) throw new ConversionFailure('TARGET_STALE', { subscription_id: ss.id, reason: 'the provider-confirmed end is not applied' });
      const open = await tx.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key) });
      if (open !== null) throw new ConversionFailure('TARGET_STALE', { open_subscription_id: open.id, reason: 'another base subscription is open' });
      const { plan, version } = await pinnedGovernedVersion(tx, tenant_id, product_key, ss_p.plan_key, ss_p.plan_version_id);
      await assertUsageDefined(tx, tenant_id, product_key, ss.plan_version_id, version);
      const terms = planVersionTerms(version).plan;
      const anchor = ss.period_anchor; // T8 — the same billing period is kept.
      const id = uuidv7();
      await tx.tenantSubscription.create({
        data: {
          id,
          tenant_id,
          plan_id: plan.id,
          plan_version_id: version.id,
          product_key,
          composition_role: BASE_COMPOSITION,
          period_anchor: anchor,
          source: 'MANUAL',
          created_by: req.requested_by,
          status: 'ACTIVE',
          commitment_start: terms.commitment_months !== null ? anchor : null,
          commitment_end: terms.commitment_months !== null ? addMonthsClamped(anchor, terms.commitment_months) : null,
        },
      });
      const capabilities = PRODUCT_CAPABILITIES[product_key];
      const inserted = await grantCapabilitiesInTx(tx, { tenant_id, capabilities });
      effect = { subscription_id: id, replaced: ss.id, from: ss.plan_version_id, to: version.id, capabilities, inserted: [...inserted].sort() };
      await this.append(tx, {
        ...base,
        event_type: 'COMMERCIAL_SUBSCRIPTION_OPENED',
        subject: `tenant_subscription:${id}`,
        payload: { subscription_id: id, source: 'MANUAL', plan_key: plan.key, from_plan_version_id: ss.plan_version_id, to_plan_version_id: version.id, to_content_checksum: version.content_checksum, period_anchor: anchor.toISOString(), effective_at: at.toISOString(), replaced_subscription_id: ss.id, conversion: true },
      });
      await this.append(tx, { ...base, event_type: 'COMMERCIAL_ENTITLEMENT_GRANTED', subject: `tenant_entitlement:${tenant_id}`, payload: { capabilities: [...capabilities].sort(), inserted, source: 'CHANGE_REQUEST' } });
      await this.append(tx, {
        ...base,
        event_type: 'COMMERCIAL_CONVERSION_COMPLETED',
        subject: SUBJECT(req.id),
        payload: { direction: 'TO_GOVERNED', self_service_subscription_id: ss.id, provider_subscription_ref: ss.billing_subscription_ref, governed_subscription_id: id, effective_at: at.toISOString() },
      });
    }

    const application = (await tx.commercialChangeApplication.create({
      data: {
        id: uuidv7(),
        change_request_id: req.id,
        action_type: 'CONVERSION',
        tenant_id,
        product_key,
        subscription_id: effect.subscription_id,
        replaced_subscription_id: effect.replaced,
        from_plan_version_id: effect.from,
        to_plan_version_id: effect.to,
        capabilities: [...effect.capabilities].sort(),
        capabilities_inserted: effect.inserted,
        attempt: req.apply_attempts,
        applied_by: req.requested_by,
        applied_at: at,
      },
    })) as CommercialChangeApplicationRow;
    const approvals = await tx.commercialApproval.findMany({ where: { change_request_id: req.id }, orderBy: { step_index: 'asc' } });
    const commands = await tx.billingProviderCommand.findMany({ where: { change_request_id: req.id }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] });
    await this.append(tx, {
      ...base,
      event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLIED',
      subject: SUBJECT(req.id),
      payload: {
        action_type: 'CONVERSION',
        direction: 'TO_GOVERNED',
        product_key,
        outcome: 'APPLIED',
        application_id: application.id,
        attempt: req.apply_attempts,
        requested_by: req.requested_by,
        reason: req.reason,
        policy_checksum: req.policy_checksum,
        approvals: approvals.map((a) => ({ approval_id: a.id, step_index: a.step_index, approver_user_id: a.approver_user_id, attestation_id: a.attestation_id, approved_at: a.created_at.toISOString() })),
        provider_commands: commands.map((c) => ({ command_id: c.id, step: c.step, confirmation_source: c.confirmation_source, confirmation_event_id: c.confirmation_event_id, confirmed_at: c.confirmed_at?.toISOString() ?? null })),
        subscription_id: effect.subscription_id,
        replaced_subscription_id: effect.replaced,
        from_plan_version_id: effect.from,
        to_plan_version_id: effect.to,
        capabilities: [...effect.capabilities].sort(),
        effective_at: at.toISOString(),
      },
    });
    await tx.commercialChangeRequest.update({ where: { id: req.id }, data: { state: 'APPLIED', applied_at: at, updated_at: at } });
    return application;
  }
}
