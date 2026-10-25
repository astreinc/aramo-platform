import { Inject, Injectable, Optional } from '@nestjs/common';

import { BillingCommandService, type BillingCommandRow } from '../billing/billing-command.service.js';
import {
  type AdjustmentCommandParams,
  BILLING_COMMAND_UNCONFIRMED_STATES,
  type BillingCommandState,
  isAdjustmentCommandKind,
} from '../billing/billing-provider-command.js';
import { takeBillingLock } from '../billing/governed-subscription.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, assertProductKey, openBaseSubscription, type ProductKey } from '../product-registry.js';

import { CommercialApplyFailedError } from './commercial-apply-records.js';
import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { CommercialApplyRefusedError } from './commercial-approval-eligibility.js';
import {
  ADJUSTMENT_STEP,
  BillingAdjustmentFailure,
  type BillingAdjustmentOperation,
  BillingAdjustmentRefusedError,
  REFUND_POLICY_NOT_APPROVED,
  adjustmentOperationOf,
  discountCouponRef,
  refundExecutionEnabled,
} from './commercial-billing-adjustment.js';
import type { CommercialBillingAdjustmentRow } from './commercial-billing-adjustment.ledger.js';
import { COMMERCIAL_ACTIONS, type C4BillingAdjustmentAction, CommercialPayloadError, isBillingAdjustmentAction, validatePayload } from './commercial-change-request.js';
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

// CCP-C4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C4, §10; Conversion Rule C-22, C-23;
// Charter Amendment A1-Apply-Deadline AD-2…AD-8) — the requester-only apply of an APPROVED credit,
// discount or refund, and its read. NOT DELIVERED until the refund policy (legal) is verified.
//
// Authority (TD-A6-3 narrowed by TD-B2-3; AD-8): REQUESTER-ONLY — a user principal holding the
// requester scope (`platform:billing:request`) who is the request's `requested_by`; then the apply
// deadline of the snapshotted policy (AD-7, lazily), then the NC-5 re-check of every approval under the
// snapshotted chain (assertApplyEligible) in the apply transaction. Approvers gain no apply authority.
//
// Refund designed disabled state (PBD §10): a REFUND apply is refused REFUND_POLICY_NOT_APPROVED
// (nothing changes; one audit row; zero provider calls) unless CCP_REFUND_EXECUTION_ENABLED=1.
//
// ONE local transaction under the shared billing lock: APPROVED → APPLYING and the C1 durable command
// (the outbox). The request COMMITS IN APPLYING (pending-provider, C-23). No provider call here: the
// dispatcher calls Stripe with no transaction open, and the request becomes APPLIED only in the
// transaction that applies the provider-confirmed effect (verified webhook or re-fetch;
// CommercialBillingAdjustmentLedger). A failed pre-command check rolls back; a separate transaction
// records APPLY_FAILED (retryable). A FAILED command keeps the request APPLYING; the requester's next
// apply RE-ARMS that same command (same derived idempotency key): never a second command, so never a
// second money movement.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;
const SUBJECT = (id: string): string => `commercial_change_request:${id}`;

/** The adjustment as an operator reads it (pending-provider shown until the provider confirms, C-23). */
export type BillingAdjustmentStatus =
  | 'NOT_APPLIED' // DRAFT / PENDING_APPROVAL / APPROVED / REJECTED / EXPIRED / WITHDRAWN / APPLY_EXPIRED
  | 'APPLY_FAILED'
  | 'PENDING_PROVIDER' // APPLYING: the command is queued, sent or awaiting the provider-confirmed effect
  | 'COMMAND_FAILED' // APPLYING: the command FAILED (visible; the requester's apply re-arms it)
  | 'APPLIED'; // the provider-confirmed effect is recorded

export interface BillingAdjustmentView {
  request: CommercialChangeRequestRow;
  operation: BillingAdjustmentOperation | null;
  status: BillingAdjustmentStatus;
  /** C-23: true while a Stripe-owned operation of this request is not provider-confirmed. */
  pending_provider: boolean;
  /** The refund designed disabled state: true for a REFUND while the refund policy is not approved. */
  refund_execution_disabled: boolean;
  commands: BillingCommandRow[];
  adjustment: CommercialBillingAdjustmentRow | null;
}

export interface BillingAdjustmentApplyResult extends BillingAdjustmentView {
  /** Nothing was written by this call (already APPLIED, or pending-provider with a live command). */
  replayed: boolean;
}

@Injectable()
export class CommercialBillingAdjustmentService {
  private readonly now: CommercialClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommercialAuditRepository,
    private readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    private readonly commands: BillingCommandService,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async apply(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<BillingAdjustmentApplyResult> {
    if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', 'only a user principal can apply a commercial change');
    const head = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (head === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    if (!isBillingAdjustmentAction(head.action_type)) {
      throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `${head.action_type} is not applied by the billing-adjustment path`, { action_type: head.action_type });
    }
    const action = head.action_type;
    const scope = COMMERCIAL_ACTIONS[action].requester_scope as string;
    if (!actor.scopes.includes(scope)) throw new CommercialChangeRequestError('REQUESTER_SCOPE_MISSING', `applying ${action} requires ${scope}`, { missing_scopes: [scope] });
    // TD-B2-3 (narrowing TD-A6-3) / AD-8 — requester-only. Approvers gain no apply authority.
    if (actor.user_id !== head.requested_by) throw new CommercialChangeRequestError('NOT_REQUESTER', 'only the original requester may apply this change request');
    // PBD §10 — the refund designed disabled state, before anything else: nothing is written but
    // the refusal's audit row, and nothing reaches the provider.
    if (action === 'REFUND' && !refundExecutionEnabled()) {
      const e = new BillingAdjustmentRefusedError(REFUND_POLICY_NOT_APPROVED, { state: head.state });
      await this.auditRefusal(actor, head, e, ctx);
      throw e;
    }
    const tenant_id = head.tenant_id as string;
    const product_key = assertProductKey(head.product_key);

    const after = { replayed: false, expired_now: false };
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
          // Pending-provider (C-23). A FAILED command (provider refusal, retries exhausted) is re-armed
          // — the SAME command and idempotency key, never a second one; otherwise nothing to do.
          after.replayed = true;
          const cmds = await tx.billingProviderCommand.findMany({ where: { change_request_id: id } });
          const failed = cmds.filter((c) => c.state === 'FAILED');
          if (failed.length > 0 && failed.length === cmds.length) {
            const now = this.now();
            for (const c of failed) {
              const n = await tx.billingProviderCommand.updateMany({ where: { id: c.id, state: 'FAILED' }, data: { state: 'PENDING', next_attempt_at: null, lease_until: null, updated_at: now } });
              if (n.count !== 1) throw new CommercialChangeRequestError('STATE_INVALID', 'the provider command changed concurrently', { command_id: c.id });
            }
            const append = await this.appender(tx, actor, req, tenant_id, ctx);
            await append('COMMERCIAL_BILLING_ADJUSTMENT_REARMED', SUBJECT(id), { attempt: req.apply_attempts, command_ids: failed.map((c) => c.id), failures: failed.map((c) => c.last_error_code) });
            after.replayed = false;
          }
          return;
        }
        // Charter Amendment A1 (AD-3, AD-4, AD-7) — the apply deadline, before anything else (never
        // reached from APPLYING): an APPLY_EXPIRED request is refused; an APPROVED / APPLY_FAILED one at
        // or past its deadline becomes APPLY_EXPIRED now (its one APPLY_EXPIRED event is the record).
        if (req.state === 'APPLY_EXPIRED') throw new BillingAdjustmentRefusedError('APPLY_EXPIRED', { state: req.state });
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
        await this.requestProviderAdjustment(tx, { ...req, state: 'APPLYING', apply_attempts: attempt }, action, tenant_id, product_key, actor, ctx, now);
      }, TX_OPTIONS);
    } catch (e) {
      if (e instanceof CommercialApplyRefusedError || e instanceof CommercialChangeRequestError || e instanceof BillingAdjustmentRefusedError) {
        await this.auditRefusal(actor, head, e, ctx);
        throw e;
      }
      const failure = e instanceof BillingAdjustmentFailure ? e : new BillingAdjustmentFailure('UNEXPECTED', { error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw await this.recordFailure(actor, id, tenant_id, failure, ctx);
    }
    if (after.expired_now) throw new BillingAdjustmentRefusedError('APPLY_EXPIRED', { state: 'APPLY_EXPIRED', expired_by_this_attempt: true });
    return { ...(await this.view(id)), replayed: after.replayed };
  }

  /**
   * Every check that can be taken before the provider call, then the C1 command in THIS transaction
   * (outbox; C-22). Throws BillingAdjustmentFailure (rolled back; recorded APPLY_FAILED).
   */
  private async requestProviderAdjustment(
    tx: Tx,
    req: CommercialChangeRequestRow,
    action: C4BillingAdjustmentAction,
    tenant_id: string,
    product_key: ProductKey,
    actor: CommercialActor,
    ctx: CommercialCallContext,
    now: Date,
  ): Promise<void> {
    let p: Record<string, unknown>;
    try {
      p = validatePayload(action, req.payload);
    } catch (e) {
      if (e instanceof CommercialPayloadError) throw new BillingAdjustmentFailure('INVALID_PAYLOAD', { errors: e.errors });
      throw e;
    }
    // C4-D7 — the tenant × product's open self-service (Stripe-owned) base row. A governed (MANUAL /
    // contract) row is never a C4 target (contract invoicing is gated, PBD §10).
    const row = await tx.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key) });
    if (row === null) throw new BillingAdjustmentFailure('TARGET_NOT_FOUND', { reason: 'no open subscription of this product' });
    if (typeof p['subscription_id'] === 'string' && p['subscription_id'] !== row.id) throw new BillingAdjustmentFailure('TARGET_STALE', { subscription_id: p['subscription_id'], open_subscription_id: row.id });
    if (row.source !== 'SELF_SERVICE' || row.billing_subscription_ref === null || row.billing_account_ref === null || row.composition_role !== BASE_COMPOSITION) {
      throw new BillingAdjustmentFailure('TARGET_NOT_SELF_SERVICE', { subscription_id: row.id, source: row.source });
    }
    const operation = adjustmentOperationOf(action, p);
    let coupon_ref: string | null = action === 'DISCOUNT' ? discountCouponRef(req.id) : null;
    // C4-D9 — a compensation reverses exactly one APPLIED request of the same kind, tenant and product.
    if (operation === 'CREDIT_REVERSE' || operation === 'DISCOUNT_REMOVE') {
      const orig_id = p['compensates_change_request_id'] as string;
      const orig = (await tx.commercialChangeRequest.findUnique({ where: { id: orig_id } })) as CommercialChangeRequestRow | null;
      if (orig === null || orig.action_type !== action || orig.state !== 'APPLIED' || orig.tenant_id !== tenant_id || orig.product_key !== product_key) {
        throw new BillingAdjustmentFailure('COMPENSATION_TARGET_INVALID', { compensates_change_request_id: orig_id });
      }
      const op = (orig.payload ?? {}) as Record<string, unknown>;
      if (typeof op['compensates_change_request_id'] === 'string') throw new BillingAdjustmentFailure('COMPENSATION_TARGET_INVALID', { compensates_change_request_id: orig_id, reason: 'a compensation is not compensated' });
      const same = action === 'CREDIT' ? op['amount_minor'] === p['amount_minor'] && op['currency'] === p['currency'] : op['discount_bps'] === p['discount_bps'];
      if (!same) throw new BillingAdjustmentFailure('COMPENSATION_MISMATCH', { compensates_change_request_id: orig_id });
      const done = await tx.commercialBillingAdjustment.findUnique({ where: { compensates_change_request_id: orig_id } });
      if (done !== null) throw new BillingAdjustmentFailure('ALREADY_COMPENSATED', { compensates_change_request_id: orig_id, by: done.change_request_id });
      const origAdj = await tx.commercialBillingAdjustment.findUnique({ where: { change_request_id: orig_id } });
      if (origAdj === null || origAdj.subscription_id !== row.id) throw new BillingAdjustmentFailure('COMPENSATION_TARGET_INVALID', { compensates_change_request_id: orig_id, reason: 'the original acted on another subscription' });
      if (operation === 'DISCOUNT_REMOVE') coupon_ref = discountCouponRef(orig_id);
    }
    const subscription_id = row.id;
    const { target_ref, params } = ((): { target_ref: string; params: AdjustmentCommandParams } => {
      switch (operation) {
        case 'CREDIT_GRANT':
        case 'CREDIT_REVERSE':
          return { target_ref: row.billing_account_ref as string, params: { subscription_id, amount_minor: p['amount_minor'] as number, currency: p['currency'] as string } };
        case 'DISCOUNT_APPLY':
          return { target_ref: row.billing_subscription_ref as string, params: { subscription_id, discount_bps: p['discount_bps'] as number, coupon_ref: coupon_ref as string } };
        case 'DISCOUNT_REMOVE':
          return { target_ref: row.billing_subscription_ref as string, params: { subscription_id, coupon_ref: coupon_ref as string } };
        case 'REFUND_CREATE':
          return { target_ref: p['provider_invoice_ref'] as string, params: { subscription_id, amount_minor: p['amount_minor'] as number, currency: p['currency'] as string, account_ref: row.billing_account_ref as string } };
      }
    })();
    // C-22 — the durable command, in this transaction (outbox); dispatched outside any transaction.
    const { command } = await this.commands.enqueue({ change_request_id: req.id, step: ADJUSTMENT_STEP[operation], command_kind: operation, tenant_id, product_key, target_ref, params, created_by: actor.user_id, at: now }, tx);
    const append = await this.appender(tx, actor, req, tenant_id, ctx);
    // No amount in the audit body (Finance amount interim); the request payload is the record.
    await append('COMMERCIAL_BILLING_ADJUSTMENT_PENDING_PROVIDER', SUBJECT(req.id), {
      attempt: req.apply_attempts,
      operation,
      command_id: command.id,
      idempotency_key: command.idempotency_key,
      subscription_id,
      ...(typeof p['compensates_change_request_id'] === 'string' ? { compensates_change_request_id: p['compensates_change_request_id'] } : {}),
    });
  }

  // ---- reads ----------------------------------------------------------------------------

  async view(id: string): Promise<BillingAdjustmentView> {
    const request = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (request === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    if (!isBillingAdjustmentAction(request.action_type)) {
      throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `${request.action_type} is not a billing adjustment`, { action_type: request.action_type });
    }
    const commands = (await this.commands.forChangeRequest(id)).filter((c) => isAdjustmentCommandKind(c.command_kind));
    const adj = await this.prisma.commercialBillingAdjustment.findUnique({ where: { change_request_id: id } });
    const adjustment: CommercialBillingAdjustmentRow | null = adj === null ? null : { ...adj, amount_minor: adj.amount_minor === null ? null : Number(adj.amount_minor) };
    const pending_provider = commands.some((c) => (BILLING_COMMAND_UNCONFIRMED_STATES as readonly string[]).includes(c.state as BillingCommandState));
    let operation: BillingAdjustmentOperation | null = null;
    try {
      operation = adjustmentOperationOf(request.action_type, validatePayload(request.action_type, request.payload));
    } catch {
      operation = null;
    }
    let status: BillingAdjustmentStatus;
    if (request.state === 'APPLIED') status = 'APPLIED';
    else if (request.state === 'APPLY_FAILED') status = 'APPLY_FAILED';
    else if (request.state === 'APPLYING') status = commands.length > 0 && commands.every((c) => c.state === 'FAILED') ? 'COMMAND_FAILED' : 'PENDING_PROVIDER';
    else status = 'NOT_APPLIED';
    return { request, operation, status, pending_provider, refund_execution_disabled: request.action_type === 'REFUND' && !refundExecutionEnabled(), commands, adjustment };
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
          payload: { action_type: req.action_type, product_key: req.product_key, ...body },
          correlation_id: ctx.correlation_id,
        },
        tx,
      );
  }

  private async recordFailure(actor: CommercialActor, id: string, tenant_id: string, failure: BillingAdjustmentFailure, ctx: CommercialCallContext): Promise<Error> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await takeBillingLock(tx, tenant_id);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state !== 'APPROVED' && req.state !== 'APPLY_FAILED') return new CommercialApplyFailedError(failure.code, req.apply_attempts, failure.detail, req.state);
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
      return new CommercialApplyFailedError(failure.code, 0, failure.detail, 'UNRECORDED');
    }
  }

  private async auditRefusal(
    actor: CommercialActor,
    req: CommercialChangeRequestRow,
    e: CommercialApplyRefusedError | CommercialChangeRequestError | BillingAdjustmentRefusedError,
    ctx: CommercialCallContext,
  ): Promise<void> {
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
