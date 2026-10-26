import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { BillingCommandService, type BillingCommandRow } from '../billing/billing-command.service.js';
import { BILLING_COMMAND_UNCONFIRMED_STATES, type BillingCommandState } from '../billing/billing-provider-command.js';
import { takeBillingLock } from '../billing/governed-subscription.js';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, assertProductKey, type ProductKey } from '../product-registry.js';

import type { CommercialChangeApplicationRow } from './commercial-apply.service.js';
import { applyExpiredNow, explanationOf } from './commercial-apply-records.js';
import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { CommercialApplyRefusedError } from './commercial-approval-eligibility.js';
import { COMMERCIAL_ACTIONS } from './commercial-change-request.js';
import {
  COMMERCIAL_CLOCK,
  type CommercialActor,
  type CommercialCallContext,
  type CommercialClock,
  CommercialChangeRequestError,
  type CommercialChangeRequestRow,
  CommercialChangeRequestService,
} from './commercial-change-request.service.js';
import {
  CONVERSION_RELEASE_MAX_WINDOW_MS,
  CONVERSION_STEP_CANCEL_HELD,
  CONVERSION_STEP_END_SELF_SERVICE,
  ConversionApplyFailedError,
  type ConversionDirection,
  type ConversionPayload,
  type ConversionReleaseState,
  type ToSelfServicePayload,
  effectiveReleaseState,
  isHeldResolution,
} from './commercial-conversion.js';
import {
  CommercialConversionLedger,
  ConversionFailure,
  type ConversionReleaseRow,
  assertUsageDefined,
  conversionPayloadOf,
  governedRow,
  heldActivation,
  pinnedGovernedVersion,
  releasablePlanVersion,
} from './commercial-conversion.ledger.js';
import { CommercialOperatorRepository } from './commercial-operator.repository.js';

// CCP-C2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C2, §7.2; Conversion Rule C-11…C-15,
// C-21…C-23, C-29; Charter Amendment A1-Apply-Deadline) — the apply of an APPROVED CONVERSION change
// request, and the conversion read.
//
// Authority (TD-A6-3 narrowed by TD-B2-3; AD-8): REQUESTER-ONLY — the actor must be the request's
// `requested_by` and still hold the requester scope; then the NC-5 re-check of every approval under
// the request's snapshotted chain (assertApplyEligible), the frozen payload's integrity, and the apply
// deadline of the snapshotted policy version when it declares one (AD-2/AD-3).
//
// ONE local transaction under the shared billing lock:
//   TO_SELF_SERVICE (C-12, C-21)  APPROVED → APPLYING → APPLIED with the RELEASE (one checkout or one
//                                 held activation, until the approved expiry) and its application.
//                                 Releasing is Aramo-owned and complete on commit; the governed row
//                                 is untouched until the provider-confirmed activation (webhook).
//                                 With `held_subscription_ref`, the held provider subscription is
//                                 re-fetched after commit (outside any transaction) so the applying
//                                 transaction can convert it (C-29).
//   TO_GOVERNED (C-13, C-22)      APPROVED → APPLYING and the C1 SUBSCRIPTION_CANCEL command (IMMEDIATE,
//                                 as C1 built it; TD-C1-5, DR-C2-1) in the same transaction (outbox).
//                                 The request COMMITS IN APPLYING: pending-provider is the command's
//                                 state (C-23). The transaction that applies the provider-confirmed
//                                 end confirms the command and opens the governed row
//                                 (CommercialConversionLedger.completeConfirmedInTx).
// A failed check rolls back in full; a separate transaction records APPLY_FAILED (retryable). A
// refusal (authority, NC-5, deadline) changes nothing and writes one audit row.
//
// HALT boundary (PBD C2 row): no path here, and no route, ends or re-points a governed row by a local
// edit that implies Stripe changed. Every Stripe-side change is a C1 durable command confirmed only by
// applied provider state; nothing is reported committed on local commit.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;
const SUBJECT = (id: string): string => `commercial_change_request:${id}`;

/** The conversion as an operator reads it (the console is B3's). */
export type ConversionStatus =
  | 'NOT_APPLIED' // DRAFT / PENDING_APPROVAL / APPROVED / REJECTED / EXPIRED / WITHDRAWN
  | 'APPLY_FAILED'
  | 'RELEASED' // TO_SELF_SERVICE: an unconsumed release
  | 'CHECKOUT_STARTED' // TO_SELF_SERVICE: consumed by its one checkout, awaiting the provider-confirmed activation
  | 'RELEASE_EXPIRED'
  | 'CONVERTED' // TO_SELF_SERVICE: the governed row ended and the SELF_SERVICE row opened (webhook)
  | 'PENDING_PROVIDER' // TO_GOVERNED: the provider command is not confirmed yet (C-23)
  | 'COMPLETED'; // TO_GOVERNED: the provider end was confirmed and the governed row is open (or kept)

export interface ConversionView {
  request: CommercialChangeRequestRow;
  direction: ConversionDirection | null;
  status: ConversionStatus;
  /** C-23 / TD-C1-9: true while a Stripe-owned operation of this request is not provider-confirmed. */
  pending_provider: boolean;
  release: (ConversionReleaseRow & { effective_state: ConversionReleaseState }) | null;
  commands: BillingCommandRow[];
  application: CommercialChangeApplicationRow | null;
}

export interface ConversionApplyResult extends ConversionView {
  /** The request was already applied or already pending-provider: nothing was written by this call. */
  replayed: boolean;
}

@Injectable()
export class CommercialConversionService {
  private readonly log = new Logger(CommercialConversionService.name);
  private readonly now: CommercialClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommercialAuditRepository,
    private readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    private readonly ledger: CommercialConversionLedger,
    private readonly commands: BillingCommandService,
    private readonly lifecycle: SubscriptionLifecycleService,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async apply(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<ConversionApplyResult> {
    if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', 'only a user principal can apply a commercial change');
    const head = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (head === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    if (head.action_type !== 'CONVERSION') {
      throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `${head.action_type} is not applied by the conversion path`, { action_type: head.action_type });
    }
    const scope = COMMERCIAL_ACTIONS.CONVERSION.requester_scope as string;
    if (!actor.scopes.includes(scope)) {
      throw new CommercialChangeRequestError('REQUESTER_SCOPE_MISSING', `applying CONVERSION requires ${scope}`, { missing_scopes: [scope] });
    }
    // TD-B2-3 (narrowing TD-A6-3) / AD-8 — requester-only. Approvers gain no apply authority.
    if (actor.user_id !== head.requested_by) throw new CommercialChangeRequestError('NOT_REQUESTER', 'only the original requester may apply this change request');
    const tenant_id = head.tenant_id as string;
    const product_key = assertProductKey(head.product_key);

    const after: { replayed: boolean; held_to_sync: string | null; expired_now: boolean } = { replayed: false, held_to_sync: null, expired_now: false };
    try {
      await this.prisma.$transaction(async (tx) => {
        await takeBillingLock(tx, tenant_id);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state === 'APPLIED') {
          after.replayed = true;
          return;
        }
        if (req.state === 'APPLYING') {
          // Pending-provider (C-13): nothing to do until the provider confirms. AD-4: an apply in
          // progress completes under recovery — if every command is already confirmed (an unwired
          // completion), complete it now.
          after.replayed = true;
          const cmds = await tx.billingProviderCommand.findMany({ where: { change_request_id: id } });
          if (cmds.length > 0 && cmds.every((c) => c.state === 'CONFIRMED')) {
            await this.ledger.completeToGovernedInTx(tx, req, this.now(), ctx.correlation_id);
            after.replayed = false;
          }
          return;
        }
        // Charter Amendment A1 (AD-3, AD-4, AD-7; CCP-B5-R) — the apply deadline, before anything
        // else (never reached from APPLYING, above): an APPLY_EXPIRED request is refused; an
        // APPROVED / APPLY_FAILED one at or past its deadline becomes APPLY_EXPIRED NOW (its one
        // APPLY_EXPIRED event is the record; the slot is released) and that commits.
        // CCP-FIX1 (O-D4-2): the A6-R refusal, byte-for-byte (code APPLY_EXPIRED → HTTP reason apply_expired).
        if (req.state === 'APPLY_EXPIRED') throw new CommercialChangeRequestError('APPLY_EXPIRED', explanationOf('APPLY_EXPIRED'), { state: req.state });
        if (await this.changeRequests.expireApplyIfDue(tx, req, this.now(), ctx)) {
          after.expired_now = true;
          return;
        }
        // NC-5 — refuses NOT_APPROVED (any state but APPROVED / APPLY_FAILED), lost eligibility and
        // broken integrity, before anything is written.
        await this.changeRequests.assertApplyEligible(id, ctx.platform_tenant_id, tx);
        const now = this.now();
        const attempt = req.apply_attempts + 1;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: attempt, updated_at: now } });
        const applying = { ...req, state: 'APPLYING', apply_attempts: attempt };
        const p = conversionPayloadOf(req);
        if (p.direction === 'TO_SELF_SERVICE') {
          await this.release(tx, applying, p, tenant_id, product_key, actor, ctx, now);
          if (p.held_subscription_ref !== undefined) after.held_to_sync = p.held_subscription_ref;
          return;
        }
        // A retry after a failed completion: the provider end is already confirmed; complete now.
        const prior = await tx.billingProviderCommand.findMany({ where: { change_request_id: id } });
        if (prior.length > 0 && prior.every((c) => c.state === 'CONFIRMED')) {
          await this.ledger.completeToGovernedInTx(tx, applying, now, ctx.correlation_id);
          return;
        }
        await this.requestProviderEnd(tx, applying, p, tenant_id, product_key, actor, ctx, now);
      }, TX_OPTIONS);
    } catch (e) {
      if (e instanceof CommercialApplyRefusedError || e instanceof CommercialChangeRequestError) {
        await this.auditRefusal(actor, head, e, ctx);
        throw e;
      }
      const failure =
        e instanceof ConversionFailure
          ? e
          : isUniqueViolation(e, 'TenantSubscription_one_open_base_per_tenant_product')
            ? new ConversionFailure('ONE_OPEN_BASE_VIOLATION', { index: 'TenantSubscription_one_open_base_per_tenant_product' })
            : isUniqueViolation(e, 'CommercialConversionRelease_one_released_per_tenant_product')
              ? new ConversionFailure('RELEASE_EXISTS', { index: 'CommercialConversionRelease_one_released_per_tenant_product' })
              : new ConversionFailure('UNEXPECTED', { error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw await this.recordFailure(actor, id, tenant_id, failure, ctx);
    }
    // AD-6 — the expiry committed above is recorded by its one APPLY_EXPIRED event (not audited again).
    if (after.expired_now) throw applyExpiredNow(head);
    // C-29 — the release adopting a held activation: re-fetch the provider subscription (outside any
    // transaction; authoritative provider state) so the applying transaction converts it. A provider
    // failure leaves the release RELEASED: the next webhook or re-fetch converts it before expiry.
    if (after.held_to_sync !== null) {
      try {
        await this.lifecycle.syncSubscription(after.held_to_sync, product_key, this.now());
      } catch (err) {
        this.log.warn(`held activation ${after.held_to_sync} re-fetch after release failed: ${(err as Error).message}`);
      }
    }
    return { ...(await this.view(id)), replayed: after.replayed };
  }

  // ---- TO_SELF_SERVICE (C-12) ---------------------------------------------------------------

  private async release(tx: Tx, req: CommercialChangeRequestRow, p: ToSelfServicePayload, tenant_id: string, product_key: ProductKey, actor: CommercialActor, ctx: CommercialCallContext, now: Date): Promise<void> {
    const governed = await governedRow(tx, tenant_id, product_key, p.governed_subscription_id);
    const { plan, version } = await releasablePlanVersion(tx, tenant_id, product_key, p.plan_key, p.plan_version_id);
    const expires_at = new Date(p.release_expires_at);
    if (expires_at.getTime() <= now.getTime()) throw new ConversionFailure('RELEASE_EXPIRY_PASSED', { release_expires_at: p.release_expires_at, at: now.toISOString() });
    if (expires_at.getTime() - now.getTime() > CONVERSION_RELEASE_MAX_WINDOW_MS) throw new ConversionFailure('RELEASE_WINDOW_TOO_LONG', { release_expires_at: p.release_expires_at, max_window_ms: CONVERSION_RELEASE_MAX_WINDOW_MS });
    // One unconsumed release per tenant × product (an expired one is closed first).
    const live = (await tx.commercialConversionRelease.findMany({ where: { tenant_id, product_key, state: 'RELEASED' } })) as ConversionReleaseRow[];
    for (const r of live) {
      if (!(await this.ledger.expireInTx(tx, r, now, ctx.correlation_id))) throw new ConversionFailure('RELEASE_EXISTS', { release_id: r.id, change_request_id: r.change_request_id });
    }
    // A consumed release whose checkout is not provider-confirmed expired could still activate.
    const consumed = await tx.commercialConversionRelease.findMany({ where: { tenant_id, product_key, state: 'CONSUMED' }, select: { id: true, intent_id: true } });
    for (const c of consumed) {
      const intent = c.intent_id === null ? null : await tx.checkoutIntent.findUnique({ where: { id: c.intent_id }, select: { status: true } });
      if (intent?.status === 'CREATED') throw new ConversionFailure('RELEASE_CHECKOUT_OPEN', { release_id: c.id, intent_id: c.intent_id });
    }
    if (p.held_subscription_ref !== undefined) await heldActivation(tx, tenant_id, p.held_subscription_ref);

    const release_id = uuidv7();
    await tx.commercialConversionRelease.create({
      data: {
        id: release_id,
        change_request_id: req.id,
        tenant_id,
        product_key,
        governed_subscription_id: governed.id,
        plan_id: plan.id,
        plan_version_id: version.id,
        held_subscription_ref: p.held_subscription_ref ?? null,
        state: 'RELEASED',
        expires_at,
        created_by: actor.user_id,
        created_at: now,
        updated_at: now,
      },
    });
    const application = await tx.commercialChangeApplication.create({
      data: {
        id: uuidv7(),
        change_request_id: req.id,
        action_type: 'CONVERSION',
        tenant_id,
        product_key,
        subscription_id: governed.id,
        replaced_subscription_id: null,
        from_plan_version_id: governed.plan_version_id,
        to_plan_version_id: version.id,
        capabilities: [],
        capabilities_inserted: [],
        attempt: req.apply_attempts,
        applied_by: actor.user_id,
        applied_at: now,
      },
    });
    const append = await this.appender(tx, actor, req, tenant_id, ctx);
    await append('COMMERCIAL_CONVERSION_RELEASED', `conversion_release:${release_id}`, {
      direction: 'TO_SELF_SERVICE',
      release_id,
      governed_subscription_id: governed.id,
      plan_key: plan.key,
      plan_version_id: version.id,
      expires_at: expires_at.toISOString(),
      held_subscription_ref: p.held_subscription_ref ?? null,
    });
    await append('COMMERCIAL_CHANGE_REQUEST_APPLIED', SUBJECT(req.id), await this.appliedPayload(tx, req, { application_id: application.id, direction: 'TO_SELF_SERVICE', release_id, subscription_id: governed.id, from_plan_version_id: governed.plan_version_id, to_plan_version_id: version.id, effective_at: now.toISOString() }));
    await tx.commercialChangeRequest.update({ where: { id: req.id }, data: { state: 'APPLIED', applied_at: now, updated_at: now } });
  }

  // ---- TO_GOVERNED (C-13) -------------------------------------------------------------------

  private async requestProviderEnd(tx: Tx, req: CommercialChangeRequestRow, p: ConversionPayload, tenant_id: string, product_key: ProductKey, actor: CommercialActor, ctx: CommercialCallContext, now: Date): Promise<void> {
    let target_ref: string;
    let step: string;
    let detail: Record<string, unknown>;
    if (isHeldResolution(p)) {
      const held = p as { held_subscription_ref: string; governed_subscription_id: string };
      await heldActivation(tx, tenant_id, held.held_subscription_ref);
      const gov = await governedRow(tx, tenant_id, product_key, held.governed_subscription_id);
      target_ref = held.held_subscription_ref;
      step = CONVERSION_STEP_CANCEL_HELD;
      detail = { held_subscription_ref: target_ref, governed_subscription_id: gov.id };
    } else {
      const sp = p as { subscription_id: string; plan_key: string; plan_version_id: string };
      const ss = await tx.tenantSubscription.findUnique({ where: { id: sp.subscription_id } });
      if (ss === null || ss.tenant_id !== tenant_id || ss.product_key !== product_key) throw new ConversionFailure('TARGET_NOT_FOUND', { subscription_id: sp.subscription_id });
      if (ss.ended_at !== null) throw new ConversionFailure('TARGET_STALE', { subscription_id: ss.id, ended_at: ss.ended_at.toISOString() });
      if (ss.source !== 'SELF_SERVICE' || ss.billing_subscription_ref === null || ss.composition_role !== BASE_COMPOSITION) {
        throw new ConversionFailure('TARGET_NOT_SELF_SERVICE', { subscription_id: ss.id, source: ss.source });
      }
      // DR-C2-1 — an immediate cancel inside a commitment term has no defined financial treatment.
      if (ss.commitment_end !== null && ss.commitment_end.getTime() > now.getTime()) {
        throw new ConversionFailure('FINANCIAL_TREATMENT_UNDEFINED', { kind: 'COMMITMENT_TERM', commitment_end: ss.commitment_end.toISOString() });
      }
      // Every check of the completion that can be taken now, BEFORE any provider change (G3, T8).
      const { version } = await pinnedGovernedVersion(tx, tenant_id, product_key, sp.plan_key, sp.plan_version_id);
      await assertUsageDefined(tx, tenant_id, product_key, ss.plan_version_id, version);
      target_ref = ss.billing_subscription_ref;
      step = CONVERSION_STEP_END_SELF_SERVICE;
      detail = { self_service_subscription_id: ss.id, provider_subscription_ref: target_ref, plan_key: sp.plan_key, plan_version_id: version.id };
    }
    // C-22 — the durable command, in this transaction (outbox); dispatched outside any transaction.
    const { command } = await this.commands.enqueue(
      { change_request_id: req.id, step, command_kind: 'SUBSCRIPTION_CANCEL', tenant_id, product_key, target_ref, mode: 'IMMEDIATE', created_by: actor.user_id, at: now },
      tx,
    );
    const append = await this.appender(tx, actor, req, tenant_id, ctx);
    await append('COMMERCIAL_CONVERSION_PENDING_PROVIDER', SUBJECT(req.id), { direction: 'TO_GOVERNED', attempt: req.apply_attempts, command_id: command.id, idempotency_key: command.idempotency_key, cancel_mode: 'IMMEDIATE', ...detail });
  }

  // ---- reads ----------------------------------------------------------------------------

  async view(id: string): Promise<ConversionView> {
    const request = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (request === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    if (request.action_type !== 'CONVERSION') throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `${request.action_type} is not a conversion`, { action_type: request.action_type });
    const now = this.now();
    const rel = (await this.prisma.commercialConversionRelease.findUnique({ where: { change_request_id: id } })) as ConversionReleaseRow | null;
    const commands = await this.commands.forChangeRequest(id);
    const application = (await this.prisma.commercialChangeApplication.findUnique({ where: { change_request_id: id } })) as CommercialChangeApplicationRow | null;
    const dir = (request.payload as { direction?: unknown } | null)?.direction;
    const direction: ConversionDirection | null = dir === 'TO_SELF_SERVICE' || dir === 'TO_GOVERNED' ? dir : null;
    const pending_provider = commands.some((c) => (BILLING_COMMAND_UNCONFIRMED_STATES as readonly string[]).includes(c.state as BillingCommandState));
    const release = rel === null ? null : { ...rel, effective_state: effectiveReleaseState(rel, now) };
    let status: ConversionStatus;
    if (request.state === 'APPLY_FAILED') status = 'APPLY_FAILED';
    else if (direction === 'TO_SELF_SERVICE' && release !== null) {
      status = { RELEASED: 'RELEASED', CONSUMED: 'CHECKOUT_STARTED', CONVERTED: 'CONVERTED', EXPIRED: 'RELEASE_EXPIRED' }[release.effective_state] as ConversionStatus;
    } else if (direction === 'TO_GOVERNED' && request.state === 'APPLIED') status = 'COMPLETED';
    else if (direction === 'TO_GOVERNED' && request.state === 'APPLYING') status = 'PENDING_PROVIDER';
    else status = 'NOT_APPLIED';
    return { request, direction, status, pending_provider, release, commands, application };
  }

  /** Expire every unconsumed release past its expiry (the recovery of the PBD C2 row). */
  async expireReleases(limit = 100): Promise<number> {
    const now = this.now();
    const due = (await this.prisma.commercialConversionRelease.findMany({ where: { state: 'RELEASED', expires_at: { lte: now } }, take: Math.min(Math.max(limit, 1), 500) })) as ConversionReleaseRow[];
    let n = 0;
    for (const r of due) {
      await this.prisma.$transaction(async (tx) => {
        await takeBillingLock(tx, r.tenant_id);
        const cur = (await tx.commercialConversionRelease.findUniqueOrThrow({ where: { id: r.id } })) as ConversionReleaseRow;
        if (await this.ledger.expireInTx(tx, cur, now, 'ccp-c2:release-expiry')) n += 1;
      });
    }
    return n;
  }

  // ---- audit helpers, failure and refusal records (separate transactions) -------------------

  private async appender(tx: Tx, actor: CommercialActor, req: CommercialChangeRequestRow, tenant_id: string, ctx: CommercialCallContext) {
    const role_keys = (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
    return (event_type: string, subject: string, body: Record<string, unknown>) =>
      this.audit.append(
        {
          actor: { id: actor.user_id, type: 'user', role_keys },
          event_type,
          tenant_id,
          subject,
          change_request_id: req.id,
          policy_version_id: req.policy_version_id,
          payload: { action_type: 'CONVERSION', product_key: req.product_key, ...body },
          correlation_id: ctx.correlation_id,
        },
        tx,
      );
  }

  private async appliedPayload(tx: Tx, req: CommercialChangeRequestRow, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const approvals = await tx.commercialApproval.findMany({ where: { change_request_id: req.id }, orderBy: { step_index: 'asc' } });
    return {
      outcome: 'APPLIED',
      attempt: req.apply_attempts,
      requested_by: req.requested_by,
      reason: req.reason,
      policy_checksum: req.policy_checksum,
      approvals: approvals.map((a) => ({ approval_id: a.id, step_index: a.step_index, approver_user_id: a.approver_user_id, attestation_id: a.attestation_id, approved_at: a.created_at.toISOString() })),
      ...body,
    };
  }

  private async recordFailure(actor: CommercialActor, id: string, tenant_id: string, failure: ConversionFailure, ctx: CommercialCallContext): Promise<Error> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await takeBillingLock(tx, tenant_id);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state !== 'APPROVED' && req.state !== 'APPLY_FAILED') return new ConversionApplyFailedError(failure.code, req.apply_attempts, failure.detail, req.state);
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
            payload: { action_type: 'CONVERSION', direction: (req.payload as { direction?: unknown })?.direction ?? null, attempt, failure: failure.code, detail: failure.detail },
            correlation_id: ctx.correlation_id,
          },
          tx,
        );
        return new ConversionApplyFailedError(failure.code, attempt, failure.detail, 'APPLY_FAILED');
      }, TX_OPTIONS);
    } catch {
      return new ConversionApplyFailedError(failure.code, 0, failure.detail, 'UNRECORDED');
    }
  }

  private async auditRefusal(actor: CommercialActor, req: CommercialChangeRequestRow, e: CommercialApplyRefusedError | CommercialChangeRequestError, ctx: CommercialCallContext): Promise<void> {
    const refusal = e instanceof CommercialChangeRequestError ? e.code : e.reason;
    const detail = e instanceof CommercialChangeRequestError ? e.details : e.detail;
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

function isUniqueViolation(e: unknown, target: string): boolean {
  const err = e as { code?: string; meta?: unknown; message?: string };
  if (err?.code !== 'P2002' && !String(err?.message ?? '').includes('duplicate key')) return false;
  return (JSON.stringify(err.meta ?? {}) + String(err.message ?? '')).includes(target);
}
