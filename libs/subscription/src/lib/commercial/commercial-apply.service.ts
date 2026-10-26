import { Inject, Injectable, Optional } from '@nestjs/common';
import { grantCapabilitiesInTx, revokeCapabilitiesInTx } from '@aramo/entitlement';
import { v7 as uuidv7 } from 'uuid';

import { addMonthsClamped, billingPeriodAt } from '../billing-period.js';
import { isGovernedSubscription, takeBillingLock } from '../billing/governed-subscription.js';
import { PIN_REASON_CHANGE_REQUEST, type PlanVersionContent, planVersionTerms } from '../plan-version.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, PRODUCT_CAPABILITIES, assertProductKey, openBaseSubscription, type ProductKey } from '../product-registry.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { type ApplyServiceAction, isApplyServiceAction, validatePayload } from './commercial-change-request.js';
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
import {
  ApplyFailure,
  CommercialApplyFailedError,
  applyDeadlineGate,
  applyExpiredNow,
  assertRequesterStillAuthorized,
  auditApplyRefusal,
  isApplyRefusal,
  preflightApply,
  recordApplyFailure,
} from './commercial-apply-records.js';
// CCP-B2-backend — the catalog publish / retire apply rides the same command and route.
import { CommercialCatalogApplyService, type CommercialCatalogApplicationRow, isCatalogApplicable } from './commercial-catalog-apply.service.js';
import { CommercialPolicyApplyService } from './commercial-policy-apply.service.js';
import { changeCarriesContract, type ContractAmendmentBlock, type ContractEndBlock, type ContractRecordBlock } from './commercial-contract.js';
import { ContractApplyConflict, type ContractEffect, amendContractInTx, contractOfSubscription, endContractInTx, recordContractInTx } from './commercial-contract.repository.js';
import { approvalExpiresAt } from './commercial-policy-boundaries.js';
import type { CommercialPolicyContent } from './commercial-policy.js';
import { supportExtensionWindow } from './support-extension.js';
import { type PaymentRecordPayload, initialObligationOf } from './commercial-payment-terms.js';
import {
  type PaymentReceiptRow,
  PaymentRecordRefusedError,
  amendmentObligationsToAdd,
  applyPaymentRecordInTx,
  assertContractRefFreeOfReceipts,
  initialReceiptFor,
  linkInitialReceiptInTx,
  recordObligationsInTx,
} from './commercial-payment-record.js';

export { ApplyFailure, CommercialApplyFailedError } from './commercial-apply-records.js';

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
// usage row is read or written. Out of scope: Stripe commands (C1), conversion (C2).
//
// CCP-A7 (Charter D1) — ENTITLEMENT_REVOKE is applied by the same transaction: the named
// capabilities (the product bundle minus `core`, all currently active) are marked revoked
// (revokeCapabilitiesInTx; the row is kept, its grant provenance untouched), recorded in
// CommercialChangeApplication.capabilities_revoked and audited. Every governed grant records its
// commercial provenance (PLAN for a subscription's product bundle, MANUAL for ENTITLEMENT_GRANT)
// and is the ONLY path that re-grants (clears) a revoke. C-24: a revoke stops NEW sends (the
// esign:* scopes are read live); in-flight signing is untouched.
// usage row is read or written. Out of scope: Stripe commands (C1), conversion (C2), revoke (A7).
//
// CCP-A8 (PBD §5.1 row A8) REUSES this service rather than forking it: SUPPORT_EXTENSION is the
// fifth applied action. An escalated (Finance-approved, Q7) extension and an overlay removal run
// `apply` unchanged (steps 1–8; the domain step writes the SupportExtension overlay, never the
// subscription row, so G1 holds by construction). The bounded EXCEPTION (zero approvals, DDR
// v1.2 §3.2(5)) runs `applyBoundedExceptionInTx` from SupportExtensionService inside ITS
// transaction, which already holds the billing lock: DRAFT → APPLYING, then the SAME core
// (`completeInTx`: domain, application row, audit with is_exception = true, APPLIED).
//
// CCP-C8-PR (PAYMENT_RECORD amendment PR-4, PR-7, §4.3) — PAYMENT_RECORD is the sixth applied action:
// the domain step writes the receipt (or the PR-9 correction) and nothing else; the application row,
// audit and APPLIED follow. A SUBSCRIPTION_OPEN recording a PREPAID contract runs the §4.3 sequence in
// THIS transaction, in order: lock the INITIAL receipt FOR UPDATE → verify it → the subscription → the
// contract (FK to it) → the obligations (FK to the contract) → link the receipt (+ COMMERCIAL_PAYMENT_
// RECEIPT_LINKED) → the entitlements → the application row → APPLIED. Any failure rolls all of it back
// (the receipt stays unlinked and reusable); APPLY_FAILED is recorded separately. POSTPAID has no
// payment precondition (its obligations are recorded from activation).

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** Test seam (fault injection): called at each named point inside the apply transaction. */
export const COMMERCIAL_APPLY_FAULT_HOOK = Symbol('COMMERCIAL_APPLY_FAULT_HOOK');
export type CommercialApplyFaultPoint =
  | 'after_subscription_write'
  | 'after_entitlement_write'
  | 'before_applied'
  // CCP-C8-PR (§4.3 failure recovery) — the PREPAID SUBSCRIPTION_OPEN steps.
  | 'c8pr_after_receipt_verified'
  | 'c8pr_after_subscription_insert'
  | 'c8pr_after_contract_insert'
  | 'c8pr_after_obligations_insert'
  | 'c8pr_after_receipt_link';
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
  | 'CAPABILITY_NOT_IN_PRODUCT' // ENTITLEMENT_GRANT / _REVOKE of a capability outside the product bundle
  | 'CAPABILITY_NOT_REVOCABLE' // CCP-A7: ENTITLEMENT_REVOKE of `core` (shared, non-commercial; C-20)
  | 'CAPABILITY_NOT_HELD' // CCP-A7: ENTITLEMENT_REVOKE of a capability not active for the tenant (stale)
  | 'TENANT_NOT_FOUND'
  | 'INVALID_PAYLOAD' // the frozen payload does not meet the A6 schema
  | 'ONE_OPEN_BASE_VIOLATION' // G2 backstop: the partial unique index refused a second open row
  // T8 + Architect dispositions DR-A6-1…4 (2026-10-25); no proration, reset or rollover exists:
  | 'USAGE_EXCEEDS_NEW_LIMIT' // DR-A6-1: consumed + reserved exceed a lowered limit
  | 'USAGE_CROSS_PERIOD' // DR-A6-2: the billing period would move under recorded consumption
  | 'RESERVATION_CONFLICT' // DR-A6-3: valid reservations would stop counting (double consumption)
  | 'FUTURE_EFFECTIVE_DATE' // DR-A6-4: future-dated; never APPLIED early, no scheduler
  | 'USAGE_TREATMENT_UNDEFINED' // an allowance is dropped or its period kind changes (no treatment defined)
  | 'CONTRACT_ALREADY_RECORDED' // the governed row already has a contract
  | 'CONTRACT_REF_TAKEN' // contract_ref is unique across the platform
  | 'CONTRACT_MISMATCH' // the named contract does not govern the row (or a contract-linked END names none)
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_ALREADY_REMOVED'
  // CCP-C8-PR (PR-6 … PR-9, §4.2, §5) — PAYMENT_RECORD and the PREPAID activation gate.
  | 'PAYMENT_ALREADY_RECORDED'
  | 'PAYMENT_REFERENCE_DUPLICATE'
  | 'PAYMENT_NOT_RECORDED'
  | 'PAYMENT_OBLIGATION_MISMATCH'
  | 'PAYMENT_AMOUNT_UNSUPPORTED'
  | 'PAYMENT_RECORD_NOT_GOVERNED'
  | 'PAYMENT_CORRECTION_TARGET_INVALID'
  | 'PAYMENT_TERMS_CHANGE_UNDEFINED'
  | 'UNEXPECTED'; // any other error (fault, DB error): rolled back, recorded, retryable

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
  /** CCP-A7 — what an ENTITLEMENT_REVOKE revoked (empty for every other action). */
  capabilities_revoked: string[];
  attempt: number;
  applied_by: string;
  applied_at: Date;
}

export interface CommercialApplyResult {
  request: CommercialChangeRequestRow;
  /** The CCP-A6 application (subscription / entitlement); null for a catalog apply. */
  application: CommercialChangeApplicationRow | null;
  /** CCP-B2-backend — the catalog application (plan-version publish / retire); null otherwise. */
  catalog_application: CommercialCatalogApplicationRow | null;
  /** The request was already APPLIED: nothing was written (idempotent replay). */
  replayed: boolean;
}

interface DomainEffect {
  subscription_id: string | null;
  replaced_subscription_id: string | null;
  from_plan_version_id: string | null;
  to_plan_version_id: string | null;
  capabilities: readonly string[];
  /** CCP-A7 — the capabilities to revoke (ENTITLEMENT_REVOKE only). */
  revoke: readonly string[];
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
 * T8 + DR-A6-1 (Architect, 2026-10-25) — compare the terms of a same-period, immediately effective
 * change. The usage ledger counts per (tenant, allowance key, period_start), so with the period
 * kept the existing consumption and reservations carry over exactly (nothing reset or
 * manufactured). Per term:
 *   'undefined'  an allowance of `from` is missing in `to`, or its period kind changes;
 *   'lowered'    a limit is lower (or limited where it was unlimited), or a short-window cap is
 *                added or tightened: admissible only while consumed + reserved fit the new limit;
 *   otherwise    the term is met or exceeded (an upgrade): no usage check needed.
 */
export interface TermChange {
  kind: 'allowance' | 'capacity' | 'window';
  key: string;
  window_kind?: string;
  change: 'undefined' | 'lowered';
  new_limit: number | null;
}
export function changedTerms(from: PlanVersionContent, to: PlanVersionContent): TermChange[] {
  const out: TermChange[] = [];
  const lower = (f: { unlimited: boolean; q: number | null }, t: { unlimited: boolean; q: number | null }): boolean =>
    !t.unlimited && (f.unlimited || f.q === null || t.q === null || t.q < f.q);
  for (const a of from.allowances) {
    const b = to.allowances.find((x) => x.allowance_key === a.allowance_key);
    if (b === undefined || b.period !== a.period) out.push({ kind: 'allowance', key: a.allowance_key, change: 'undefined', new_limit: null });
    else if (lower({ unlimited: a.unlimited, q: a.included_quantity }, { unlimited: b.unlimited, q: b.included_quantity })) {
      out.push({ kind: 'allowance', key: a.allowance_key, change: 'lowered', new_limit: b.included_quantity ?? 0 });
    }
  }
  for (const c of from.capacities) {
    const d = to.capacities.find((x) => x.capacity_key === c.capacity_key);
    if (d === undefined) out.push({ kind: 'capacity', key: c.capacity_key, change: 'lowered', new_limit: 0 });
    else if (lower({ unlimited: c.unlimited, q: c.limit_quantity }, { unlimited: d.unlimited, q: d.limit_quantity })) {
      out.push({ kind: 'capacity', key: c.capacity_key, change: 'lowered', new_limit: d.limit_quantity ?? 0 });
    }
  }
  for (const w of to.allowance_windows) {
    const v = from.allowance_windows.find((x) => x.allowance_key === w.allowance_key && x.window_kind === w.window_kind);
    if (v === undefined || w.limit_quantity < v.limit_quantity) out.push({ kind: 'window', key: w.allowance_key, window_kind: w.window_kind, change: 'lowered', new_limit: w.limit_quantity });
  }
  return out;
}

/** The day window used by the short-window caps (AllowanceService DAY_WINDOW_MS). */
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CommercialApplyService {
  readonly now: CommercialClock;

  constructor(
    readonly prisma: PrismaService,
    readonly audit: CommercialAuditRepository,
    readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
    @Optional() @Inject(COMMERCIAL_APPLY_FAULT_HOOK) private readonly fault?: CommercialApplyFaultHook,
    @Optional() private readonly catalog?: CommercialCatalogApplyService,
    @Optional() private readonly policy?: CommercialPolicyApplyService,
  ) {
    this.now = clock ?? (() => new Date());
  }

  /**
   * Applies an APPROVED (or APPLY_FAILED, retry) change request of an A6 action type, or a
   * CCP-A7 ENTITLEMENT_REVOKE. The apply
   * authority is the action's REQUESTER scope (the maker who may ask for the change may also
   * execute it once the distinct checker chain has approved it; TD-A6-3).
   */
  async apply(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<CommercialApplyResult> {
    const head = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    // NOT_FOUND has no request to attach an audit row to (the CommercialAuditEvent FK).
    if (head === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    // CCP-B2-backend — PLAN_VERSION_PUBLISH / PLAN_RETIRE (catalog, not tenant-scoped).
    if (this.catalog !== undefined && isCatalogApplicable(head.action_type)) {
      const c = await this.catalog.apply(actor, head, ctx);
      return { request: c.request, application: null, catalog_application: c.catalog_application, replayed: c.replayed };
    }
    // CCP-B5-R (TD-B5-1) — POLICY_ACTIVATE (governance, not tenant-scoped; requester-only).
    if (this.policy !== undefined && head.action_type === 'POLICY_ACTIVATE') {
      const p = await this.policy.apply(actor, head, ctx);
      return { request: p.request, application: null, catalog_application: null, replayed: p.replayed };
    }
    // TD-A6-3 (approved) — the ORIGINAL requester, a human, holding the requester scope.
    let scope: string;
    try {
      // Merge train TD-MERGE-30: A6 ∪ A7 (ENTITLEMENT_REVOKE) ∪ A8 (SUPPORT_EXTENSION) are applied by this path.
      scope = preflightApply(actor, head, isApplyServiceAction);
      // CCP-A8: a bounded EXCEPTION is applied by the call that creates it, never here.
      if (head.kind !== 'NORMAL') throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `a ${head.kind} request is not applied by this path`, { action_type: head.action_type, kind: head.kind });
    } catch (e) {
      if (isApplyRefusal(e)) await auditApplyRefusal(this, actor, head, e, ctx);
      throw e;
    }
    // Every applicable action (A6, A7) is tenant-scoped (tenant_id + product_key are immutable from INSERT).
    const tenant_id = head.tenant_id as string;
    const product_key = assertProductKey(head.product_key);

    let expiredNow = false;
    let out: CommercialApplyResult | null = null;
    try {
      out = await this.prisma.$transaction(async (tx): Promise<CommercialApplyResult | null> => {
        await takeBillingLock(tx, tenant_id);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state === 'APPLIED') {
          const application = (await tx.commercialChangeApplication.findUniqueOrThrow({ where: { change_request_id: id } })) as CommercialChangeApplicationRow;
          return { request: req, application, catalog_application: null, replayed: true };
        }
        // Charter Amendment A1 (AD-3, AD-4, AD-7) — the apply deadline, before anything else.
        if ((await applyDeadlineGate(tx, this.changeRequests, req, this.now(), ctx)) === 'EXPIRED_NOW') {
          expiredNow = true;
          return null; // commit the expiry; refused below
        }
        // NC-5 — refuses NOT_APPROVED (any state but APPROVED / APPLY_FAILED), lost eligibility
        // and broken integrity, before anything is written.
        await this.changeRequests.assertApplyEligible(id, ctx.platform_tenant_id, tx);
        // TD-A6-3 — the requester's CURRENT authority (live RBAC, in this transaction).
        await assertRequesterStillAuthorized(tx, this.operators, ctx.platform_tenant_id, actor.user_id, scope);
        const now = this.now();
        const attempt = req.apply_attempts + 1;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: attempt, updated_at: now } });

        return this.completeInTx(tx, actor, req, attempt, tenant_id, product_key, now, ctx, null);
      }, TX_OPTIONS);
    } catch (e) {
      if (isApplyRefusal(e)) {
        await auditApplyRefusal(this, actor, head, e, ctx);
        throw e;
      }
      const failure =
        e instanceof ApplyFailure
          ? e
          : isUniqueViolation(e, 'TenantSubscription_one_open_base_per_tenant_product')
            ? new ApplyFailure('ONE_OPEN_BASE_VIOLATION', { index: 'TenantSubscription_one_open_base_per_tenant_product' })
            : new ApplyFailure('UNEXPECTED', { error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw await recordApplyFailure(this, actor, id, tenant_id, failure, ctx);
    }
    if (expiredNow || out === null) throw applyExpiredNow(head);
    return out;
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
    // CCP-C8-PR §4.3 steps 1–2 — a PREPAID SUBSCRIPTION_OPEN locks and verifies its INITIAL receipt first.
    const receipt = await this.prepaidInitialReceipt(tx, req, payload, tenant_id, product_key);
    if (receipt !== null) await this.fault?.('c8pr_after_receipt_verified', { change_request_id: id });
    const effect = await this.applyDomain(tx, req, req.action_type as ApplyServiceAction, payload, tenant_id, product_key, now, actor);
    if (receipt !== null) await this.fault?.('c8pr_after_subscription_insert', { change_request_id: id });
    // CCP-B4 — the contract record, amendment or end evidence, in the same transaction.
    effect.events.push(...(await this.applyContract(tx, req, req.action_type as ApplyServiceAction, payload, effect, now, receipt)));
    await this.fault?.('after_subscription_write', { change_request_id: id });
    // CCP-A7 — a governed grant records its commercial provenance and re-grants a revoked row.
    const inserted = await grantCapabilitiesInTx(tx, {
      tenant_id,
      capabilities: effect.capabilities,
      granted_source: req.action_type === 'ENTITLEMENT_GRANT' ? 'MANUAL' : 'PLAN',
      granted_by: actor.user_id,
      change_request_id: id,
    });
    // CCP-A7 — the governed revoke (rows kept, revoked by this request).
    const revoked = await revokeCapabilitiesInTx(tx, { tenant_id, capabilities: effect.revoke, revoked_by: actor.user_id, change_request_id: id });
    if (revoked.length !== new Set(effect.revoke).size) {
      throw new ApplyFailure('CAPABILITY_NOT_HELD', { capabilities: effect.revoke.filter((c) => !(revoked as string[]).includes(c)) });
    }
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
        capabilities_revoked: revoked,
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
      await append('COMMERCIAL_ENTITLEMENT_GRANTED', `tenant_entitlement:${tenant_id}`, {
        capabilities: [...effect.capabilities].sort(),
        inserted,
        source: 'CHANGE_REQUEST',
        granted_source: req.action_type === 'ENTITLEMENT_GRANT' ? 'MANUAL' : 'PLAN',
      });
    }
    if (revoked.length > 0) {
      await append('COMMERCIAL_ENTITLEMENT_REVOKED', `tenant_entitlement:${tenant_id}`, { capabilities: revoked, source: 'CHANGE_REQUEST', effective_at: now.toISOString() });
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
      capabilities_revoked: revoked,
      effective_at: now.toISOString(),
      kind: req.kind,
      ...(exception !== null ? { exception: { zero_approvals: true, clause: exception.clause, counters: exception.counters } } : {}),
    });
    await this.fault?.('before_applied', { change_request_id: id });

    const request = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLIED', applied_at: now, updated_at: now } })) as CommercialChangeRequestRow;
    return { request, application, catalog_application: null, replayed: false };
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
      case 'PAYMENT_RECORD': {
        // CCP-C8-PR (PR-4) — the receipt (or correction); re-resolved here, so a stale request fails closed.
        try {
          const e = await applyPaymentRecordInTx(tx, req, p as unknown as PaymentRecordPayload, tenant_id, product_key, now);
          return { subscription_id: e.subscription_id, replaced_subscription_id: null, from_plan_version_id: null, to_plan_version_id: null, capabilities: [], revoke: [], events: e.events };
        } catch (err) {
          if (err instanceof PaymentRecordRefusedError) throw new ApplyFailure(err.code, err.detail);
          throw err;
        }
      }
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
          throw new ApplyFailure('FUTURE_EFFECTIVE_DATE', { period_anchor: requested.toISOString(), effective_at: now.toISOString() });
        }
        let anchor: Date;
        if (open !== null) {
          if (requested !== null && requested.getTime() !== open.period_anchor.getTime()) {
            throw new ApplyFailure('USAGE_CROSS_PERIOD', { period_anchor: requested.toISOString(), current_period_anchor: open.period_anchor.toISOString() });
          }
          anchor = open.period_anchor;
          await this.assertUsageFits(tx, tenant_id, product_key, open.plan_version_id, version, open.period_anchor, now);
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
          revoke: [],
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
        // CCP-B4 — a change that records or amends a contract may keep the pinned version (a
        // terms-only amendment): the subscription row is then not written at all (no usage
        // transition, no re-pin). Without a contract block, the same version is still NO_CHANGE.
        const sameVersion = version.id === row.plan_version_id;
        if (sameVersion && !changeCarriesContract(p)) throw new ApplyFailure('NO_CHANGE', { plan_version_id: version.id });
        if (!sameVersion) {
          // T8 / DR-A6-1 / DR-A6-3 — immediately effective, same period (the anchor is kept).
          await this.assertUsageFits(tx, tenant_id, product_key, row.plan_version_id, version, row.period_anchor, now);
          // TD-A5-9 — the re-pin names its reason; the DB trigger records SubscriptionVersionPinEvent.
          await tx.$executeRaw`SELECT set_config('aramo.subscription_pin_reason', ${PIN_REASON_CHANGE_REQUEST}, true), set_config('aramo.subscription_pin_price_ref', '', true)`;
          await tx.tenantSubscription.update({ where: { id: row.id }, data: { plan_id: plan.id, plan_version_id: version.id } });
        }
        return {
          subscription_id: row.id,
          replaced_subscription_id: null,
          from_plan_version_id: row.plan_version_id,
          to_plan_version_id: version.id,
          capabilities: bundle,
          revoke: [],
          events: sameVersion ? [] : [
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
          revoke: [],
          events: [{ event_type: 'COMMERCIAL_SUBSCRIPTION_ENDED', subject: `tenant_subscription:${row.id}`, payload: { subscription_id: row.id, source: row.source, from_plan_version_id: row.plan_version_id, effective_at: now.toISOString() } }],
        };
      }
      case 'ENTITLEMENT_GRANT': {
        const caps = p['capabilities'] as string[];
        const outside = caps.filter((c) => !bundle.includes(c));
        if (outside.length > 0) throw new ApplyFailure('CAPABILITY_NOT_IN_PRODUCT', { capabilities: outside, product_bundle: [...bundle] });
        return { subscription_id: null, replaced_subscription_id: null, from_plan_version_id: null, to_plan_version_id: null, capabilities: caps, revoke: [], events: [] };
      }
      case 'ENTITLEMENT_REVOKE': {
        // CCP-A7 (Charter D1) — revoke the product's own capability. `core` is the shared,
        // non-commercial default capability (D4; C-20: the owner needs it to reach billing): never
        // revoked by a product request. Every named capability must be ACTIVE (else stale).
        const caps = p['capabilities'] as string[];
        const outside = caps.filter((c) => !bundle.includes(c));
        if (outside.length > 0) throw new ApplyFailure('CAPABILITY_NOT_IN_PRODUCT', { capabilities: outside, product_bundle: [...bundle] });
        if (caps.includes('core')) throw new ApplyFailure('CAPABILITY_NOT_REVOCABLE', { capabilities: ['core'] });
        const held = await tx.$queryRawUnsafe<Array<{ capability: string }>>(
          `SELECT capability::text AS capability FROM entitlement."TenantEntitlement" WHERE tenant_id = $1::uuid AND capability::text = ANY($2::text[]) AND revoked_at IS NULL`,
          tenant_id,
          caps,
        );
        const notHeld = caps.filter((c) => !held.some((h) => h.capability === c));
        if (notHeld.length > 0) throw new ApplyFailure('CAPABILITY_NOT_HELD', { capabilities: notHeld });
        return { subscription_id: null, replaced_subscription_id: null, from_plan_version_id: null, to_plan_version_id: null, capabilities: [], revoke: [...caps].sort(), events: [] };
      }
    }
  }

  /**
   * CCP-B4 — writes the contract side of an OPEN / CHANGE / END inside the apply transaction
   * (after the subscription write, so the insert guards see the row in its applied state). A
   * conflict is an APPLY_FAILED (the whole transaction rolls back; retryable).
   */
  private async applyContract(
    tx: Tx,
    req: CommercialChangeRequestRow,
    action: ApplyServiceAction,
    p: Record<string, unknown>,
    effect: DomainEffect,
    now: Date,
    receipt: PaymentReceiptRow | null = null,
  ): Promise<ContractEffect[]> {
    if (action === 'PAYMENT_RECORD' || action === 'SUPPORT_EXTENSION') return [];
    if (effect.subscription_id === null) return [];
    const ctx = { change_request_id: req.id, change_request_kind: req.kind, requested_by: req.requested_by, now };
    try {
      switch (action) {
        case 'SUBSCRIPTION_OPEN':
        case 'SUBSCRIPTION_CHANGE': {
          // A contract ends only by an explicit SUBSCRIPTION_END that names it (its approvers
          // approved ending exactly that contract), never as a side effect of an open replacing
          // its row.
          if (effect.replaced_subscription_id !== null) {
            const governed = await contractOfSubscription(tx, effect.replaced_subscription_id);
            if (governed !== null) throw new ContractApplyConflict('CONTRACT_MISMATCH', { replaced_subscription_id: effect.replaced_subscription_id, contract_id: governed.id, reason: 'replaces_contract_subscription' });
          }
          const out: ContractEffect[] = [];
          if (p['contract'] !== undefined) {
            const block = p['contract'] as ContractRecordBlock;
            // §4.2 — the ref is not held by another unlinked receipt (this open's own receipt excepted).
            await assertContractRefFreeOfReceipts(tx, block.contract_ref, receipt?.id ?? null);
            const recorded = await recordContractInTx(tx, effect.subscription_id, block, ctx);
            out.push(recorded);
            await this.fault?.('c8pr_after_contract_insert', { change_request_id: req.id });
            // CCP-C8-PR §4.3 step 5 — every PR-1 obligation (FK to the contract).
            const ids = await recordObligationsInTx(tx, recorded.contract_id as string, block.payment_terms.obligations, block.payment_terms.currency, req.id, now);
            if (receipt !== null) await this.fault?.('c8pr_after_obligations_insert', { change_request_id: req.id });
            // §4.3 step 6 — link the receipt to the contract and its INITIAL obligation.
            if (receipt !== null) {
              out.push(await linkInitialReceiptInTx(tx, receipt, { id: recorded.contract_id as string, contract_ref: block.contract_ref }, ids.get('INITIAL') as string, req.id, now));
              await this.fault?.('c8pr_after_receipt_link', { change_request_id: req.id });
            }
          }
          if (p['contract_amendment'] !== undefined) {
            const block = p['contract_amendment'] as ContractAmendmentBlock;
            // PR-1 (v1): a payment-terms amendment only ADDS obligations; any other change fails closed.
            const add = block.payment_terms === undefined ? [] : await amendmentObligationsToAdd(tx, block.contract_id, block.payment_terms);
            const amended = await amendContractInTx(tx, effect.subscription_id, block, ctx);
            out.push(amended);
            if (add.length > 0) await recordObligationsInTx(tx, amended.contract_id as string, add, (block.payment_terms as { currency: string }).currency, req.id, now);
          }
          return out;
        }
        case 'SUBSCRIPTION_END': {
          const e = await endContractInTx(tx, effect.subscription_id, p['contract_end'] as ContractEndBlock | undefined, ctx);
          return e === null ? [] : [e];
        }
        default:
          return [];
      }
    } catch (e) {
      if (e instanceof ContractApplyConflict) throw new ApplyFailure(e.code, e.detail);
      if (e instanceof PaymentRecordRefusedError) throw new ApplyFailure(e.code, e.detail);
      throw e;
    }
  }

  /**
   * CCP-C8-PR PR-7 / §4.3 steps 1–2 — for a SUBSCRIPTION_OPEN recording a PREPAID contract: the matching
   * applied, uncorrected, unlinked INITIAL receipt, locked FOR UPDATE, else PAYMENT_NOT_RECORDED /
   * PAYMENT_OBLIGATION_MISMATCH (APPLY_FAILED, retryable before the deadline). Null for every other apply
   * (a POSTPAID contract has no payment precondition).
   */
  private async prepaidInitialReceipt(tx: Tx, req: CommercialChangeRequestRow, p: Record<string, unknown>, tenant_id: string, product_key: ProductKey): Promise<PaymentReceiptRow | null> {
    if (req.action_type !== 'SUBSCRIPTION_OPEN' || p['contract'] === undefined) return null;
    const block = p['contract'] as ContractRecordBlock;
    if (initialObligationOf(block.payment_terms) === null) return null;
    try {
      return await initialReceiptFor(tx, tenant_id, product_key, block.contract_ref, block.payment_terms, true);
    } catch (e) {
      if (e instanceof PaymentRecordRefusedError) throw new ApplyFailure(e.code, e.detail);
      throw e;
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
        revoke: [],
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
      revoke: [],
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

  /**
   * T8 / DR-A6-1 / DR-A6-3 — a same-period change carries usage exactly (no reset): an upgrade
   * always fits; a lowered term is admissible only while consumed + RESERVED usage fit the new
   * limit (every valid reservation is preserved and stays counted). Each checked key is read under
   * the same advisory lock AllowanceService.reserve / CapacityService.reserve take, so no concurrent
   * reservation can slip past the check. A dropped allowance or a changed period kind has no
   * defined treatment.
   */
  private async assertUsageFits(
    tx: Tx,
    tenant_id: string,
    product_key: ProductKey,
    from_version_id: string,
    to: { id: string; content: unknown; content_checksum: string },
    anchor: Date,
    now: Date,
  ): Promise<void> {
    const from = await tx.planVersion.findUniqueOrThrow({ where: { id: from_version_id } });
    const changes = changedTerms(planVersionTerms(from), planVersionTerms(to));
    const undefinedTerms = changes.filter((c) => c.change === 'undefined');
    if (undefinedTerms.length > 0) {
      throw new ApplyFailure('USAGE_TREATMENT_UNDEFINED', { terms: undefinedTerms.map((c) => `${c.kind}:${c.key}`), from_plan_version_id: from.id, to_plan_version_id: to.id });
    }
    const period = billingPeriodAt(anchor, now);
    const exceeded: Array<Record<string, unknown>> = [];
    for (const c of [...changes].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`))) {
      if (c.kind === 'capacity') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity:${tenant_id}:${c.key}`}, 0))`;
        const agg = await tx.capacityUsage.aggregate({ where: { tenant_id, capacity_key: c.key, state: 'ACTIVE' }, _sum: { quantity: true } });
        const used = Number(agg._sum.quantity ?? 0n);
        if (used > (c.new_limit ?? 0)) exceeded.push({ term: `capacity:${c.key}`, used, new_limit: c.new_limit });
        continue;
      }
      if (!c.key.startsWith(`${product_key}.`)) continue;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant_id}:${c.key}`}, 0))`;
      const used =
        c.kind === 'allowance'
          ? await tx.allowanceUsage.count({ where: { tenant_id, allowance_key: c.key, period_start: period.start, state: { in: ['RESERVED', 'CONSUMED'] } } })
          : await tx.allowanceUsage.count({ where: { tenant_id, allowance_key: c.key, state: { in: ['RESERVED', 'CONSUMED'] }, reserved_at: { gt: new Date(now.getTime() - DAY_WINDOW_MS), lte: now } } });
      if (used > (c.new_limit ?? 0)) exceeded.push({ term: c.kind === 'window' ? `window:${c.key}:${c.window_kind}` : `allowance:${c.key}`, used, new_limit: c.new_limit });
    }
    if (exceeded.length > 0) throw new ApplyFailure('USAGE_EXCEEDS_NEW_LIMIT', { exceeded, period_start: period.start.toISOString(), from_plan_version_id: from.id, to_plan_version_id: to.id });
  }

  /**
   * T8 / DR-A6-2 / DR-A6-3 — a fresh open must not strand usage already recorded in its first
   * period under another period alignment (the ledger counts by period_start): stranded valid
   * reservations → RESERVATION_CONFLICT (they would stop counting: double consumption); stranded
   * consumption → USAGE_CROSS_PERIOD (allowance would be manufactured).
   */
  private async assertNoStrandedUsage(tx: Tx, tenant_id: string, product_key: ProductKey, anchor: Date, now: Date): Promise<void> {
    const period = billingPeriodAt(anchor, now);
    const where = { tenant_id, allowance_key: { startsWith: `${product_key}.` }, reserved_at: { gte: period.start }, NOT: { period_start: period.start } };
    const reserved = await tx.allowanceUsage.count({ where: { ...where, state: 'RESERVED' } });
    if (reserved > 0) throw new ApplyFailure('RESERVATION_CONFLICT', { reserved_rows: reserved, period_start: period.start.toISOString() });
    const consumed = await tx.allowanceUsage.count({ where: { ...where, state: 'CONSUMED' } });
    if (consumed > 0) throw new ApplyFailure('USAGE_CROSS_PERIOD', { usage_rows: consumed, period_start: period.start.toISOString() });
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
}
