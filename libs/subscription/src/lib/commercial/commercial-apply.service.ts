import { Inject, Injectable, Optional } from '@nestjs/common';
import { grantCapabilitiesInTx } from '@aramo/entitlement';
import { v7 as uuidv7 } from 'uuid';

import { addMonthsClamped, billingPeriodAt } from '../billing-period.js';
import { isGovernedSubscription, takeBillingLock } from '../billing/governed-subscription.js';
import { PIN_REASON_CHANGE_REQUEST, type PlanVersionContent, planVersionTerms } from '../plan-version.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, PRODUCT_CAPABILITIES, assertProductKey, openBaseSubscription, type ProductKey } from '../product-registry.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { CommercialApplyRefusedError } from './commercial-approval-eligibility.js';
import { COMMERCIAL_ACTIONS, type ApplyServiceAction, isApplyServiceAction, validatePayload } from './commercial-change-request.js';
import {
  COMMERCIAL_CLOCK,
  type CommercialActor,
  type CommercialCallContext,
  type CommercialClock,
  CommercialChangeRequestError,
  type CommercialChangeRequestRow,
  CommercialChangeRequestService,
} from './commercial-change-request.service.js';
import { CommercialOperatorRepository } from './commercial-operator.repository.js';
import { approvalExpiresAt } from './commercial-policy-boundaries.js';
import type { CommercialPolicyContent } from './commercial-policy.js';
import { supportExtensionWindow } from './support-extension.js';

// CCP-A6 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A6; Conversion Rule C-21…C-24;
// MP-A2 G2/G3; Reconciliation Report §1 C3) — the transactional apply of an APPROVED commercial
// change request for the Aramo-owned operations: a MANUAL (governed) subscription open, change
// or end, and the entitlement grant that accompanies it.
//
// ONE local Postgres transaction on the subscription client (the pre-execution record: one
// database, one owning role; the raw cross-schema entitlement write follows
// insert-decision-record.ts):
//   1. the shared billing lock `billing:<tenant>` (the webhook and checkout take the same lock,
//      so console and provider writes for the tenant serialize);
//   2. SELECT … FOR UPDATE on the request; an APPLIED request replays (idempotent: the
//      application is keyed by change_request_id, UNIQUE);
//   3. NC-5 (ratified, TD-A3-0): every recorded approval is re-checked under the request's
//      SNAPSHOTTED chain against the live roster (assertApplyEligible); lost eligibility refuses
//      with NO state change and NO commercial mutation; the approvals are never touched;
//   4. APPROVED | APPLY_FAILED → APPLYING (apply_attempts + 1);
//   5. G1 — a Stripe-owned row (billing_subscription_ref set, or SELF_SERVICE) is refused: those
//      are Stripe-owned operations (C-22), never a local edit;
//      G2 — one open BASE row per tenant × product: an open ends the prior row (named in the
//      payload, else stale) in the same transaction; the partial unique index backs it;
//      G3 — the subscription is pinned to the PUBLISHED plan version the payload names;
//   6. the subscription write, then the entitlement write (grantCapabilitiesInTx);
//   7. the CommercialChangeApplication record and the commercial audit events;
//   8. APPLYING → APPLIED. The DB guard refuses APPLIED unless the application row and both
//      domain sides exist, and refuses to COMMIT anything left in APPLYING.
// Any failure after step 3 rolls the whole transaction back (no partial state); a SEPARATE
// transaction then records APPLY_FAILED (apply_attempts + 1, audited). APPLY_FAILED is
// retryable: the retry runs every step again.
//
// C-23: nothing here reports an external change as committed — every Stripe-owned operation is
// refused (G1), never performed. C-24: signing continuity — no envelope, executed document or
// usage row is read or written. Out of scope: Stripe commands (C1), conversion (C2), revoke (A7).
//
// CCP-A8 (PBD §5.1 row A8) REUSES this service rather than forking it: SUPPORT_EXTENSION is the
// fifth applied action. An escalated (Finance-approved, Q7) extension and an overlay removal run
// `apply` unchanged (steps 1–8; the domain step writes the SupportExtension overlay, never the
// subscription row, so G1 holds by construction). The bounded EXCEPTION (zero approvals, DDR
// v1.2 §3.2(5)) runs `applyBoundedExceptionInTx` from SupportExtensionService inside ITS
// transaction, which already holds the billing lock: DRAFT → APPLYING, then the SAME core
// (`completeInTx`: domain, application row, audit with is_exception = true, APPLIED).

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** Test seam (fault injection): called at each named point inside the apply transaction. */
export const COMMERCIAL_APPLY_FAULT_HOOK = Symbol('COMMERCIAL_APPLY_FAULT_HOOK');
export type CommercialApplyFaultPoint = 'after_subscription_write' | 'after_entitlement_write' | 'before_applied';
export type CommercialApplyFaultHook = (point: CommercialApplyFaultPoint, ctx: { change_request_id: string }) => void | Promise<void>;

/** Why an apply attempt failed (the request moves to APPLY_FAILED; retryable). */
export type CommercialApplyFailureCode =
  | 'STRIPE_OWNED' // G1: the row is owned by the provider (billing_subscription_ref set, or SELF_SERVICE)
  | 'TARGET_STALE' // the open row is not the one the approved payload names (or it has ended)
  | 'TARGET_NOT_FOUND' // the named subscription does not exist for this tenant × product
  | 'TARGET_NOT_GOVERNED' // the named row is not a governed (MANUAL) BASE row
  | 'TARGET_NOT_REPLACEABLE' // the prior open row is FREE (Personal Free v1.1 governs it)
  | 'PLAN_NOT_FOUND' // no plan with the key for this product
  | 'PLAN_VERSION_MISMATCH' // the version is not a version of that plan
  | 'PLAN_VERSION_NOT_PUBLISHED' // G3: only a PUBLISHED version is pinned
  | 'PLAN_NOT_ASSIGNABLE' // an INACTIVE or FREE plan is never assigned by a change request
  | 'PLAN_TENANT_KIND_MISMATCH' // the plan is for another tenant kind
  | 'NO_CHANGE' // SUBSCRIPTION_CHANGE to the version already pinned
  | 'CAPABILITY_NOT_IN_PRODUCT' // ENTITLEMENT_GRANT of a capability outside the product bundle
  | 'TENANT_NOT_FOUND'
  | 'INVALID_PAYLOAD' // the frozen payload does not meet the A6 schema
  | 'ONE_OPEN_BASE_VIOLATION' // G2 backstop: the partial unique index refused a second open row
  // T8 (Architect ruling 2026-10-25) — a transition whose usage treatment is undefined fails
  // closed: details.kind DOWNGRADE | CROSS_PERIOD | OPEN_RESERVATIONS | FUTURE_EFFECTIVE_DATE.
  // No proration, reset, rollover or partial-period policy is implemented (decision requests
  // DR-A6-1…4, doc/ccp/slices/CCP-A6-acceptance.md).
  | 'USAGE_TREATMENT_UNDEFINED'
  // CCP-A8 — SUPPORT_EXTENSION REMOVE: the named overlay is not this tenant × product's, or it is
  // already removed.
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_ALREADY_REMOVED'
  | 'UNEXPECTED'; // any other error (fault, DB error): rolled back, recorded, retryable

class ApplyFailure extends Error {
  constructor(
    readonly code: CommercialApplyFailureCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`apply failed (${code})`);
    this.name = 'ApplyFailure';
  }
}

/** The apply attempt failed and was rolled back; the request is now APPLY_FAILED (retryable). */
export class CommercialApplyFailedError extends Error {
  constructor(
    readonly code: CommercialApplyFailureCode,
    readonly attempt: number,
    readonly detail: Record<string, unknown>,
    readonly request_state: string,
  ) {
    super(`apply failed (${code}); the request is ${request_state}`);
    this.name = 'CommercialApplyFailedError';
  }
}

export interface CommercialChangeApplicationRow {
  id: string;
  change_request_id: string;
  action_type: string;
  tenant_id: string;
  product_key: string;
  subscription_id: string | null;
  replaced_subscription_id: string | null;
  from_plan_version_id: string | null;
  to_plan_version_id: string | null;
  capabilities: string[];
  capabilities_inserted: string[];
  attempt: number;
  applied_by: string;
  applied_at: Date;
}

export interface CommercialApplyResult {
  request: CommercialChangeRequestRow;
  application: CommercialChangeApplicationRow;
  /** The request was already APPLIED: nothing was written (idempotent replay). */
  replayed: boolean;
}

interface DomainEffect {
  subscription_id: string | null;
  replaced_subscription_id: string | null;
  from_plan_version_id: string | null;
  to_plan_version_id: string | null;
  capabilities: readonly string[];
  events: Array<{ event_type: string; subject: string; payload: Record<string, unknown> }>;
}

const SUBJECT = (id: string): string => `commercial_change_request:${id}`;

/** CCP-A8 — the bounded-exception evidence recorded on its audit events (Recon Report §1 C1). */
export interface BoundedExceptionEvidence {
  clause: Record<string, unknown>;
  counters: Record<string, unknown>;
}
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

function isUniqueViolation(e: unknown, target: string): boolean {
  const err = e as { code?: string; meta?: unknown; message?: string };
  if (err?.code !== 'P2002' && !String(err?.message ?? '').includes('duplicate key')) return false;
  return (JSON.stringify(err.meta ?? {}) + String(err.message ?? '')).includes(target);
}

/**
 * T8 — the usage treatment of a same-period, immediately-effective change is defined ONLY when it
 * is an upgrade: the usage ledger counts per (tenant, allowance key, period_start), so with the
 * period kept, remaining = the new limit − the existing consumption (nothing is reset or
 * manufactured). Every term of `from` must be met or exceeded by `to`: each allowance (same
 * period kind; unlimited ≥ any limit), each capacity, and each short-window cap (a new window cap
 * is a restriction). Anything else is a DOWNGRADE (undefined; fail closed).
 */
export function downgradedTerms(from: PlanVersionContent, to: PlanVersionContent): string[] {
  const out: string[] = [];
  const meets = (f: { unlimited: boolean; q: number | null }, t: { unlimited: boolean; q: number | null } | undefined): boolean =>
    t !== undefined && (t.unlimited || (!f.unlimited && f.q !== null && t.q !== null && t.q >= f.q));
  for (const a of from.allowances) {
    const b = to.allowances.find((x) => x.allowance_key === a.allowance_key);
    if (b === undefined || b.period !== a.period || !meets({ unlimited: a.unlimited, q: a.included_quantity }, { unlimited: b.unlimited, q: b.included_quantity })) out.push(`allowance:${a.allowance_key}`);
  }
  for (const c of from.capacities) {
    const d = to.capacities.find((x) => x.capacity_key === c.capacity_key);
    if (!meets({ unlimited: c.unlimited, q: c.limit_quantity }, d === undefined ? undefined : { unlimited: d.unlimited, q: d.limit_quantity })) out.push(`capacity:${c.capacity_key}`);
  }
  for (const w of to.allowance_windows) {
    const v = from.allowance_windows.find((x) => x.allowance_key === w.allowance_key && x.window_kind === w.window_kind);
    if (v === undefined || w.limit_quantity < v.limit_quantity) out.push(`window:${w.allowance_key}:${w.window_kind}`);
  }
  return out;
}

@Injectable()
export class CommercialApplyService {
  private readonly now: CommercialClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommercialAuditRepository,
    private readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
    @Optional() @Inject(COMMERCIAL_APPLY_FAULT_HOOK) private readonly fault?: CommercialApplyFaultHook,
  ) {
    this.now = clock ?? (() => new Date());
  }

  /**
   * Applies an APPROVED (or APPLY_FAILED, retry) change request of an A6 action type. The apply
   * authority is the action's REQUESTER scope (the maker who may ask for the change may also
   * execute it once the distinct checker chain has approved it; TD-A6-3).
   */
  async apply(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<CommercialApplyResult> {
    if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', 'only a user principal can apply a commercial change');
    const head = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (head === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    if (!isApplyServiceAction(head.action_type)) {
      throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `${head.action_type} is not applied by this path`, { action_type: head.action_type });
    }
    if (head.kind !== 'NORMAL') {
      // CCP-A8: a bounded EXCEPTION is applied by the call that creates it, never here.
      throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `a ${head.kind} request is not applied by this path`, { action_type: head.action_type, kind: head.kind });
    }
    const scope = COMMERCIAL_ACTIONS[head.action_type].requester_scope as string;
    if (!actor.scopes.includes(scope)) {
      throw new CommercialChangeRequestError('REQUESTER_SCOPE_MISSING', `applying ${head.action_type} requires ${scope}`, { missing_scopes: [scope] });
    }
    // Every A6 action is tenant-scoped (tenant_id + product_key are immutable from INSERT).
    const tenant_id = head.tenant_id as string;
    const product_key = assertProductKey(head.product_key);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await takeBillingLock(tx, tenant_id);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state === 'APPLIED') {
          const application = (await tx.commercialChangeApplication.findUniqueOrThrow({ where: { change_request_id: id } })) as CommercialChangeApplicationRow;
          return { request: req, application, replayed: true };
        }
        // NC-5 — refuses NOT_APPROVED (any state but APPROVED / APPLY_FAILED), lost eligibility
        // and broken integrity, before anything is written.
        await this.changeRequests.assertApplyEligible(id, ctx.platform_tenant_id, tx);
        const now = this.now();
        const attempt = req.apply_attempts + 1;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: attempt, updated_at: now } });
        return this.completeInTx(tx, actor, req, attempt, tenant_id, product_key, now, ctx, null);
      }, TX_OPTIONS);
    } catch (e) {
      if (e instanceof CommercialApplyRefusedError || e instanceof CommercialChangeRequestError) {
        await this.auditRefusal(actor, head, e, ctx);
        throw e;
      }
      const failure =
        e instanceof ApplyFailure
          ? e
          : isUniqueViolation(e, 'TenantSubscription_one_open_base_per_tenant_product')
            ? new ApplyFailure('ONE_OPEN_BASE_VIOLATION', { index: 'TenantSubscription_one_open_base_per_tenant_product' })
            : new ApplyFailure('UNEXPECTED', { error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw await this.recordFailure(actor, id, tenant_id, failure, ctx);
    }
  }


  /**
   * CCP-A8 — the bounded EXCEPTION apply (DDR v1.2 §3.2(5): the only act that applies without
   * approval). Runs INSIDE the caller's transaction, which already holds the billing lock and has
   * just inserted `request_id` (SUPPORT_EXTENSION, kind EXCEPTION, the zero-step BOUNDED_EXCEPTION
   * chain) in DRAFT after deciding it is within the active policy's bounds. DRAFT → APPLYING
   * (attempt 1), then the same core as an approved apply. Any failure throws and rolls the whole
   * transaction back: no request, no overlay, no audit row survives (the caller reports it).
   */
  async applyBoundedExceptionInTx(
    tx: Tx,
    actor: CommercialActor,
    request_id: string,
    ctx: CommercialCallContext,
    policy: CommercialPolicyContent,
    evidence: BoundedExceptionEvidence,
  ): Promise<CommercialApplyResult> {
    await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, request_id);
    const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id: request_id } })) as CommercialChangeRequestRow;
    if (req.action_type !== 'SUPPORT_EXTENSION' || req.kind !== 'EXCEPTION' || req.state !== 'DRAFT' || req.tenant_id === null) {
      throw new CommercialChangeRequestError('STATE_INVALID', 'only a DRAFT bounded SUPPORT_EXTENSION exception is applied by this path', { state: req.state, kind: req.kind });
    }
    const tenant_id = req.tenant_id;
    await takeBillingLock(tx, tenant_id); // re-entrant: the caller already holds it
    const product_key = assertProductKey(req.product_key);
    const now = this.now();
    // submitted_at / expires_at are set with the move out of DRAFT (A3 CHECKs); the expiry is moot
    // for an act that commits APPLIED in this transaction (DB: it can commit only as APPLIED).
    await tx.commercialChangeRequest.update({
      where: { id: request_id },
      data: { state: 'APPLYING', apply_attempts: 1, submitted_at: now, expires_at: approvalExpiresAt(policy, now), updated_at: now },
    });
    return this.completeInTx(tx, actor, req, 1, tenant_id, product_key, now, ctx, evidence);
  }

  /** Steps 5–8 inside the apply transaction, for a request already moved to APPLYING. */
  private async completeInTx(
    tx: Tx,
    actor: CommercialActor,
    req: CommercialChangeRequestRow,
    attempt: number,
    tenant_id: string,
    product_key: ProductKey,
    now: Date,
    ctx: CommercialCallContext,
    exception: BoundedExceptionEvidence | null,
  ): Promise<CommercialApplyResult> {
    const id = req.id;

    const payload = this.payloadOf(req);
    const effect = await this.applyDomain(tx, req, req.action_type as ApplyServiceAction, payload, tenant_id, product_key, now, actor);
    await this.fault?.('after_subscription_write', { change_request_id: id });
    const inserted = await grantCapabilitiesInTx(tx, { tenant_id, capabilities: effect.capabilities });
    await this.fault?.('after_entitlement_write', { change_request_id: id });

    const application = (await tx.commercialChangeApplication.create({
      data: {
        id: uuidv7(),
        change_request_id: id,
        action_type: req.action_type,
        tenant_id,
        product_key,
        subscription_id: effect.subscription_id,
        replaced_subscription_id: effect.replaced_subscription_id,
        from_plan_version_id: effect.from_plan_version_id,
        to_plan_version_id: effect.to_plan_version_id,
        capabilities: [...effect.capabilities].sort(),
        capabilities_inserted: inserted,
        attempt,
        applied_by: actor.user_id,
        applied_at: now,
      },
    })) as CommercialChangeApplicationRow;

    const role_keys = (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
    const append = (event_type: string, subject: string, body: Record<string, unknown>) =>
      this.audit.append(
        {
          actor: { id: actor.user_id, type: 'user', role_keys },
          event_type,
          tenant_id,
          subject,
          change_request_id: id,
          policy_version_id: req.policy_version_id,
          payload: { action_type: req.action_type, product_key, ...body },
          correlation_id: ctx.correlation_id,
          // CCP-A8 (DDR v1.2 §3.2(5)): every event of a bounded EXCEPTION carries is_exception.
          is_exception: exception !== null,
        },
        tx,
      );
    for (const e of effect.events) await append(e.event_type, e.subject, e.payload);
    if (effect.capabilities.length > 0) {
      await append('COMMERCIAL_ENTITLEMENT_GRANTED', `tenant_entitlement:${tenant_id}`, { capabilities: [...effect.capabilities].sort(), inserted, source: 'CHANGE_REQUEST' });
    }
    // T10 — requester, reason, policy version (the event column), approval evidence, old and
    // new terms, the effective timestamp and the outcome.
    const approvals = await tx.commercialApproval.findMany({ where: { change_request_id: id }, orderBy: { step_index: 'asc' } });
    await append('COMMERCIAL_CHANGE_REQUEST_APPLIED', SUBJECT(id), {
      outcome: 'APPLIED',
      application_id: application.id,
      attempt,
      requested_by: req.requested_by,
      reason: req.reason,
      policy_checksum: req.policy_checksum,
      approvals: approvals.map((a) => ({ approval_id: a.id, step_index: a.step_index, approver_user_id: a.approver_user_id, attestation_id: a.attestation_id, approved_at: a.created_at.toISOString() })),
      subscription_id: effect.subscription_id,
      from_plan_version_id: effect.from_plan_version_id,
      to_plan_version_id: effect.to_plan_version_id,
      capabilities: [...effect.capabilities].sort(),
      effective_at: now.toISOString(),
      kind: req.kind,
      ...(exception !== null ? { exception: { zero_approvals: true, clause: exception.clause, counters: exception.counters } } : {}),
    });
    await this.fault?.('before_applied', { change_request_id: id });

    const request = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLIED', applied_at: now, updated_at: now } })) as CommercialChangeRequestRow;
    return { request, application, replayed: false };
  }

  // ---- domain (inside the apply transaction) --------------------------------------------

  private payloadOf(req: CommercialChangeRequestRow): Record<string, unknown> {
    try {
      return validatePayload(req.action_type as ApplyServiceAction, req.payload);
    } catch (e) {
      throw new ApplyFailure('INVALID_PAYLOAD', { errors: (e as { errors?: unknown }).errors ?? [(e as Error).message] });
    }
  }

  private async applyDomain(
    tx: Tx,
    req: CommercialChangeRequestRow,
    action: ApplyServiceAction,
    p: Record<string, unknown>,
    tenant_id: string,
    product_key: ProductKey,
    now: Date,
    actor: CommercialActor,
  ): Promise<DomainEffect> {
    const bundle = PRODUCT_CAPABILITIES[product_key];
    switch (action) {
      case 'SUPPORT_EXTENSION':
        return this.supportExtensionEffect(tx, req, p, tenant_id, product_key, now, actor);
      case 'SUBSCRIPTION_OPEN': {
        const { plan, version } = await this.pinnedVersion(tx, tenant_id, product_key, p);
        const open = await tx.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key) });
        if (open !== null) this.assertNotStripeOwned(open);
        // G2 — the approved payload names the row it replaces; anything else is stale.
        if ((open?.id ?? null) !== (p['replaces_subscription_id'] ?? null)) {
          throw new ApplyFailure('TARGET_STALE', { expected: p['replaces_subscription_id'] ?? null, open_subscription_id: open?.id ?? null });
        }
        if (open !== null && open.source === 'FREE') throw new ApplyFailure('TARGET_NOT_REPLACEABLE', { subscription_id: open.id, source: open.source });
        // T6 / T8 — the effective date is the apply instant; the billing period is defined by the
        // anchor. Replacing a row keeps its anchor (same period, upgrade only); a fresh open may name
        // a past anchor, never a future one, and never one that strands usage of the current period.
        const requested = typeof p['period_anchor'] === 'string' ? new Date(p['period_anchor']) : null;
        if (requested !== null && requested.getTime() > now.getTime()) {
          throw new ApplyFailure('USAGE_TREATMENT_UNDEFINED', { kind: 'FUTURE_EFFECTIVE_DATE', period_anchor: requested.toISOString(), effective_at: now.toISOString() });
        }
        let anchor: Date;
        if (open !== null) {
          if (requested !== null && requested.getTime() !== open.period_anchor.getTime()) {
            throw new ApplyFailure('USAGE_TREATMENT_UNDEFINED', { kind: 'CROSS_PERIOD', period_anchor: requested.toISOString(), current_period_anchor: open.period_anchor.toISOString() });
          }
          anchor = open.period_anchor;
          await this.assertUsageDefined(tx, tenant_id, product_key, open.plan_version_id, version);
        } else {
          anchor = requested ?? now;
          await this.assertNoStrandedUsage(tx, tenant_id, product_key, anchor, now);
        }
        if (open !== null) {
          await tx.tenantSubscription.update({ where: { id: open.id }, data: { ended_at: now, status: open.status === 'ACTIVE' ? 'CANCELED' : open.status } });
        }
        const terms = planVersionTerms(version).plan;
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
        return {
          subscription_id: id,
          replaced_subscription_id: open?.id ?? null,
          from_plan_version_id: open?.plan_version_id ?? null,
          to_plan_version_id: version.id,
          capabilities: bundle,
          events: [
            ...(open !== null
              ? [{ event_type: 'COMMERCIAL_SUBSCRIPTION_ENDED', subject: `tenant_subscription:${open.id}`, payload: { subscription_id: open.id, source: open.source, replaced_by: id } }]
              : []),
            {
              event_type: 'COMMERCIAL_SUBSCRIPTION_OPENED',
              subject: `tenant_subscription:${id}`,
              payload: {
                subscription_id: id,
                source: 'MANUAL',
                plan_key: plan.key,
                from_plan_version_id: open?.plan_version_id ?? null,
                to_plan_version_id: version.id,
                to_content_checksum: version.content_checksum,
                period_anchor: anchor.toISOString(),
                effective_at: now.toISOString(),
                replaced_subscription_id: open?.id ?? null,
              },
            },
          ],
        };
      }
      case 'SUBSCRIPTION_CHANGE': {
        const row = await this.governedTarget(tx, tenant_id, product_key, p['subscription_id'] as string);
        const { plan, version } = await this.pinnedVersion(tx, tenant_id, product_key, p);
        if (version.id === row.plan_version_id) throw new ApplyFailure('NO_CHANGE', { plan_version_id: version.id });
        // T8 — immediately effective, same period (the anchor is kept): an upgrade only.
        await this.assertUsageDefined(tx, tenant_id, product_key, row.plan_version_id, version);
        // TD-A5-9 — the re-pin names its reason; the DB trigger records SubscriptionVersionPinEvent.
        await tx.$executeRaw`SELECT set_config('aramo.subscription_pin_reason', ${PIN_REASON_CHANGE_REQUEST}, true), set_config('aramo.subscription_pin_price_ref', '', true)`;
        await tx.tenantSubscription.update({ where: { id: row.id }, data: { plan_id: plan.id, plan_version_id: version.id } });
        return {
          subscription_id: row.id,
          replaced_subscription_id: null,
          from_plan_version_id: row.plan_version_id,
          to_plan_version_id: version.id,
          capabilities: bundle,
          events: [
            {
              event_type: 'COMMERCIAL_SUBSCRIPTION_CHANGED',
              subject: `tenant_subscription:${row.id}`,
              payload: {
                subscription_id: row.id,
                from_plan_id: row.plan_id,
                from_plan_version_id: row.plan_version_id,
                plan_key: plan.key,
                to_plan_version_id: version.id,
                to_content_checksum: version.content_checksum,
                period_anchor: row.period_anchor.toISOString(),
                effective_at: now.toISOString(),
              },
            },
          ],
        };
      }
      case 'SUBSCRIPTION_END': {
        const row = await this.governedTarget(tx, tenant_id, product_key, p['subscription_id'] as string);
        await tx.tenantSubscription.update({ where: { id: row.id }, data: { ended_at: now, status: row.status === 'ACTIVE' ? 'CANCELED' : row.status } });
        // The capability is NOT revoked here: a governed revoke is CCP-A7 (and C-20: the Sign
        // capability is also what lets the owner reach billing). Sending stops with the row.
        return {
          subscription_id: row.id,
          replaced_subscription_id: null,
          from_plan_version_id: row.plan_version_id,
          to_plan_version_id: null,
          capabilities: [],
          events: [{ event_type: 'COMMERCIAL_SUBSCRIPTION_ENDED', subject: `tenant_subscription:${row.id}`, payload: { subscription_id: row.id, source: row.source, from_plan_version_id: row.plan_version_id, effective_at: now.toISOString() } }],
        };
      }
      case 'ENTITLEMENT_GRANT': {
        const caps = p['capabilities'] as string[];
        const outside = caps.filter((c) => !bundle.includes(c));
        if (outside.length > 0) throw new ApplyFailure('CAPABILITY_NOT_IN_PRODUCT', { capabilities: outside, product_bundle: [...bundle] });
        return { subscription_id: null, replaced_subscription_id: null, from_plan_version_id: null, to_plan_version_id: null, capabilities: caps, events: [] };
      }
    }
  }

  /**
   * CCP-A8 — the SUPPORT_EXTENSION domain step. EXTEND inserts the overlay on the named open BASE
   * row of this tenant × product (stale otherwise); REMOVE records the single removal of the named
   * overlay. Neither writes `TenantSubscription` (G1 by construction: a Stripe-owned row keeps
   * every column, Recon G1), neither touches usage or limits (T8), and no capability is granted.
   */
  private async supportExtensionEffect(
    tx: Tx,
    req: CommercialChangeRequestRow,
    p: Record<string, unknown>,
    tenant_id: string,
    product_key: ProductKey,
    now: Date,
    actor: CommercialActor,
  ): Promise<DomainEffect> {
    if (p['operation'] === 'REMOVE') {
      const ext = await tx.supportExtension.findUnique({ where: { id: p['support_extension_id'] as string } });
      if (ext === null || ext.tenant_id !== tenant_id || ext.product_key !== product_key) throw new ApplyFailure('EXTENSION_NOT_FOUND', { support_extension_id: p['support_extension_id'] });
      if (ext.removed_at !== null) throw new ApplyFailure('EXTENSION_ALREADY_REMOVED', { support_extension_id: ext.id, removed_at: ext.removed_at.toISOString() });
      await tx.supportExtension.update({ where: { id: ext.id }, data: { removed_at: now, removed_by: actor.user_id, remove_change_request_id: req.id } });
      return {
        subscription_id: ext.subscription_id,
        replaced_subscription_id: null,
        from_plan_version_id: null,
        to_plan_version_id: null,
        capabilities: [],
        events: [
          {
            event_type: 'SUPPORT_EXTENSION_REMOVED',
            subject: `support_extension:${ext.id}`,
            payload: { support_extension_id: ext.id, subscription_id: ext.subscription_id, days: ext.days, extends_until: ext.extends_until.toISOString(), effective_at: now.toISOString() },
          },
        ],
      };
    }
    // EXTEND — the named row must still be the open BASE row of this tenant × product.
    const row = await tx.tenantSubscription.findUnique({ where: { id: p['subscription_id'] as string } });
    if (row === null || row.tenant_id !== tenant_id || row.product_key !== product_key) throw new ApplyFailure('TARGET_NOT_FOUND', { subscription_id: p['subscription_id'] });
    if (row.ended_at !== null || row.composition_role !== BASE_COMPOSITION) throw new ApplyFailure('TARGET_STALE', { subscription_id: row.id, ended_at: row.ended_at?.toISOString() ?? null });
    const days = p['requested_days'] as number;
    const window = supportExtensionWindow(now, row.grace_until, days);
    const id = uuidv7();
    await tx.supportExtension.create({
      data: {
        id,
        tenant_id,
        product_key,
        subscription_id: row.id,
        change_request_id: req.id,
        is_exception: req.kind === 'EXCEPTION',
        days,
        grace_until_at_apply: row.grace_until,
        base_until: window.base_until,
        extends_until: window.extends_until,
        policy_version_id: req.policy_version_id,
        applied_by: actor.user_id,
        applied_at: now,
      },
    });
    return {
      subscription_id: row.id,
      replaced_subscription_id: null,
      from_plan_version_id: null,
      to_plan_version_id: null,
      capabilities: [],
      events: [
        {
          event_type: req.kind === 'EXCEPTION' ? 'SUPPORT_EXTENSION_EXCEPTION_APPLIED' : 'SUPPORT_EXTENSION_APPLIED',
          subject: `support_extension:${id}`,
          payload: {
            support_extension_id: id,
            subscription_id: row.id,
            subscription_source: row.source,
            subscription_status: row.status,
            provider_linked: row.billing_subscription_ref !== null,
            days,
            grace_until_at_apply: row.grace_until?.toISOString() ?? null,
            base_until: window.base_until.toISOString(),
            extends_until: window.extends_until.toISOString(),
            effective_at: now.toISOString(),
          },
        },
      ],
    };
  }

  /** T8 — a same-period change is defined only as an upgrade with no open reservation. */
  private async assertUsageDefined(tx: Tx, tenant_id: string, product_key: ProductKey, from_version_id: string, to: { id: string; content: unknown; content_checksum: string }): Promise<void> {
    const from = await tx.planVersion.findUniqueOrThrow({ where: { id: from_version_id } });
    const down = downgradedTerms(planVersionTerms(from), planVersionTerms(to));
    if (down.length > 0) throw new ApplyFailure('USAGE_TREATMENT_UNDEFINED', { kind: 'DOWNGRADE', terms: down, from_plan_version_id: from.id, to_plan_version_id: to.id });
    const reserved = await tx.allowanceUsage.count({ where: { tenant_id, allowance_key: { startsWith: `${product_key}.` }, state: 'RESERVED' } });
    if (reserved > 0) throw new ApplyFailure('USAGE_TREATMENT_UNDEFINED', { kind: 'OPEN_RESERVATIONS', reserved });
  }

  /**
   * T8 — a fresh open must not strand usage already recorded in its first period under another
   * period alignment (the ledger counts by period_start: such usage would stop counting, i.e.
   * allowance would be manufactured). Undefined → fail closed.
   */
  private async assertNoStrandedUsage(tx: Tx, tenant_id: string, product_key: ProductKey, anchor: Date, now: Date): Promise<void> {
    const period = billingPeriodAt(anchor, now);
    const stranded = await tx.allowanceUsage.count({
      where: {
        tenant_id,
        allowance_key: { startsWith: `${product_key}.` },
        state: { in: ['RESERVED', 'CONSUMED'] },
        reserved_at: { gte: period.start },
        NOT: { period_start: period.start },
      },
    });
    if (stranded > 0) throw new ApplyFailure('USAGE_TREATMENT_UNDEFINED', { kind: 'CROSS_PERIOD', usage_rows: stranded, period_start: period.start.toISOString() });
  }

  /** G1 — a provider-owned row is changed only by a durable provider command (C-22), never here. */
  private assertNotStripeOwned(row: { id: string; source: string; billing_subscription_ref: string | null }): void {
    if (row.billing_subscription_ref !== null || row.source === 'SELF_SERVICE') {
      throw new ApplyFailure('STRIPE_OWNED', { subscription_id: row.id, source: row.source, provider_linked: row.billing_subscription_ref !== null });
    }
  }

  /** The named open governed BASE row of this tenant × product (CHANGE / END). */
  private async governedTarget(tx: Tx, tenant_id: string, product_key: ProductKey, subscription_id: string) {
    const row = await tx.tenantSubscription.findUnique({ where: { id: subscription_id } });
    if (row === null || row.tenant_id !== tenant_id || row.product_key !== product_key) throw new ApplyFailure('TARGET_NOT_FOUND', { subscription_id });
    this.assertNotStripeOwned(row);
    if (row.ended_at !== null) throw new ApplyFailure('TARGET_STALE', { subscription_id, ended_at: row.ended_at.toISOString() });
    if (row.composition_role !== BASE_COMPOSITION || !isGovernedSubscription(row)) throw new ApplyFailure('TARGET_NOT_GOVERNED', { subscription_id, source: row.source });
    return row;
  }

  /** G3 — the plan of this product and the PUBLISHED version the payload pins. */
  private async pinnedVersion(tx: Tx, tenant_id: string, product_key: ProductKey, p: Record<string, unknown>) {
    const plan = await tx.plan.findUnique({ where: { key: p['plan_key'] as string } });
    if (plan === null || plan.product_key !== product_key) throw new ApplyFailure('PLAN_NOT_FOUND', { plan_key: p['plan_key'], product_key });
    const version = await tx.planVersion.findUnique({ where: { id: p['plan_version_id'] as string } });
    if (version === null || version.plan_id !== plan.id) throw new ApplyFailure('PLAN_VERSION_MISMATCH', { plan_key: plan.key, plan_version_id: p['plan_version_id'] });
    if (version.status !== 'PUBLISHED') throw new ApplyFailure('PLAN_VERSION_NOT_PUBLISHED', { plan_version_id: version.id, status: version.status });
    if (plan.status !== 'ACTIVE' || plan.sales_model === 'FREE') throw new ApplyFailure('PLAN_NOT_ASSIGNABLE', { plan_key: plan.key, status: plan.status, sales_model: plan.sales_model });
    const tenant = await tx.$queryRawUnsafe<Array<{ kind: string | null }>>(`SELECT kind::text AS kind FROM identity."Tenant" WHERE id = $1::uuid`, tenant_id);
    if (tenant.length !== 1) throw new ApplyFailure('TENANT_NOT_FOUND', { tenant_id });
    if (plan.tenant_kind !== null && tenant[0]?.kind !== plan.tenant_kind) {
      throw new ApplyFailure('PLAN_TENANT_KIND_MISMATCH', { plan_key: plan.key, plan_tenant_kind: plan.tenant_kind, tenant_kind: tenant[0]?.kind ?? null });
    }
    return { plan, version };
  }

  // ---- failure and refusal records (separate transactions) ------------------------------

  /** APPLY_FAILED in its own transaction (the apply transaction rolled back in full). */
  private async recordFailure(actor: CommercialActor, id: string, tenant_id: string, failure: ApplyFailure, ctx: CommercialCallContext): Promise<Error> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await takeBillingLock(tx, tenant_id);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state !== 'APPROVED' && req.state !== 'APPLY_FAILED') {
          return new CommercialApplyFailedError(failure.code, req.apply_attempts, failure.detail, req.state);
        }
        const now = this.now();
        const attempt = req.apply_attempts + 1;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: attempt, updated_at: now } });
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLY_FAILED', updated_at: now } });
        const role_keys = (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
        await this.audit.append(
          {
            actor: { id: actor.user_id, type: 'user', role_keys },
            event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED',
            tenant_id,
            subject: SUBJECT(id),
            change_request_id: id,
            policy_version_id: req.policy_version_id,
            payload: { action_type: req.action_type, attempt, failure: failure.code, detail: failure.detail },
            correlation_id: ctx.correlation_id,
          },
          tx,
        );
        return new CommercialApplyFailedError(failure.code, attempt, failure.detail, 'APPLY_FAILED');
      }, TX_OPTIONS);
    } catch {
      // The failure could not be recorded: report the original failure (nothing was applied).
      return new CommercialApplyFailedError(failure.code, 0, failure.detail, 'UNRECORDED');
    }
  }

  /** A refused apply (NC-5, not approved, integrity, authority) writes one audit row and nothing else. */
  private async auditRefusal(actor: CommercialActor, req: CommercialChangeRequestRow, e: CommercialApplyRefusedError | CommercialChangeRequestError, ctx: CommercialCallContext): Promise<void> {
    const refusal = e instanceof CommercialApplyRefusedError ? e.reason : e.code;
    const detail = e instanceof CommercialApplyRefusedError ? e.detail : e.details;
    try {
      await this.prisma.$transaction(async (tx) => {
        const role_keys = (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
        await this.audit.append(
          {
            actor: { id: actor.user_id, type: 'user', role_keys },
            event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED',
            tenant_id: req.tenant_id,
            subject: SUBJECT(req.id),
            change_request_id: req.id,
            policy_version_id: req.policy_version_id,
            payload: { action_type: req.action_type, refusal, detail },
            correlation_id: ctx.correlation_id,
          },
          tx,
        );
      });
    } catch {
      // The refusal stands even if its audit row cannot be written.
    }
  }
}
