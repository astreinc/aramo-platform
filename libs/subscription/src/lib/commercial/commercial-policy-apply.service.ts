import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import {
  ApplyFailure,
  applyDeadlineGate,
  applyExpiredNow,
  auditApplyRefusal,
  explanationOf,
  isApplyRefusal,
  recordApplyFailure,
} from './commercial-apply-records.js';
import { CommercialAuditRepository } from './commercial-audit.repository.js';
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
import { CommercialOperatorRepository } from './commercial-operator.repository.js';
import { PolicyActivationRefusedError, activatePolicyVersionInTx } from './commercial-policy-activation.js';

// CCP-B5-R (TD-B5-1, Architect APPROVED 2026-10-25) — the governed apply of an APPROVED (or
// APPLY_FAILED, retry) POLICY_ACTIVATE on the CCP-A6 apply infrastructure. Reached through the same
// command, CommercialApplyService.apply, and route POST …/change-requests/{id}/apply.
//
//   APPROVED | APPLY_FAILED → APPLYING (attempt + 1) → APPLIED, in ONE transaction with the policy
//   write (activatePolicyVersionInTx: the NC-5 SNAPSHOT re-check, ACTIVE → RETIRED, target →
//   ACTIVE). The request is APPLIED only when the activation commits with it (DB guard, union block
//   "CCP-B5-R"; the deferred trigger of 20261027000200 refuses a commit in APPLYING).
//
// Authority (TD-B2-3 / TD-A6-3; Amendment A1 AD-8): ONLY the original requester — a human, still
// holding the finance_admin role (POLICY_ACTIVATE's requester authority is a role, TD-A3-5) with a
// live D9 attestation. Approval evidence stays distinct from execution: the approval rows are never
// touched; the NC-5 signature re-check (assertApplyEligible) reads them.
//
//   refusal  NOT_HUMAN, NOT_REQUESTER, REQUESTER_NO_LONGER_AUTHORIZED, NOT_APPROVED, an NC-5
//            signature refusal, INTEGRITY, APPLY_EXPIRED: nothing changes; ONE APPLY_REFUSED row
//            (an expiry committed by this attempt is recorded by its one APPLY_EXPIRED event).
//   failure  the NC-5 snapshot no longer holds (POLICY_ACTIVE_CHANGED, POLICY_TARGET_*) or the
//            write faulted: the transaction rolls back in full; a separate transaction records
//            APPLY_FAILED (attempt counted) with ONE APPLY_FAILED row. Retryable.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export interface CommercialPolicyApplyResult {
  request: CommercialChangeRequestRow;
  replayed: boolean;
}

/** Test seam (fault injection) for the policy activation apply. */
export const COMMERCIAL_POLICY_APPLY_FAULT_HOOK = Symbol('COMMERCIAL_POLICY_APPLY_FAULT_HOOK');
export type CommercialPolicyApplyFaultHook = (point: 'after_policy_write' | 'before_applied', ctx: { change_request_id: string }) => void | Promise<void>;

/** The stable APPLY_FAILED code of each NC-5 snapshot refusal (distinct from the subscription TARGET_* codes). */
export const POLICY_APPLY_FAILURE_CODES: Readonly<Record<string, string>> = {
  TARGET_SNAPSHOT_MISSING: 'POLICY_TARGET_SNAPSHOT_MISSING',
  TARGET_NOT_FOUND: 'POLICY_TARGET_NOT_FOUND',
  TARGET_NOT_ACTIVATABLE: 'POLICY_TARGET_NOT_ACTIVATABLE',
  TARGET_CHANGED: 'POLICY_TARGET_CHANGED',
  TARGET_MALFORMED: 'POLICY_TARGET_MALFORMED',
  POLICY_ACTIVE_CHANGED: 'POLICY_ACTIVE_CHANGED',
};

const SUBJECT = (id: string): string => `commercial_change_request:${id}`;
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;
const REQUESTER_ROLE = COMMERCIAL_ACTIONS.POLICY_ACTIVATE.requester_role as string;

@Injectable()
export class CommercialPolicyApplyService {
  readonly now: CommercialClock;

  constructor(
    readonly prisma: PrismaService,
    readonly audit: CommercialAuditRepository,
    readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
    @Optional() @Inject(COMMERCIAL_POLICY_APPLY_FAULT_HOOK) private readonly fault?: CommercialPolicyApplyFaultHook,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async apply(actor: CommercialActor, head: CommercialChangeRequestRow, ctx: CommercialCallContext): Promise<CommercialPolicyApplyResult> {
    try {
      if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', explanationOf('NOT_HUMAN'));
      if (head.action_type !== 'POLICY_ACTIVATE') {
        throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `${head.action_type} is not applied by the policy activation path`, { action_type: head.action_type });
      }
      if (actor.user_id !== head.requested_by) throw new CommercialChangeRequestError('NOT_REQUESTER', explanationOf('NOT_REQUESTER'), { reason: 'not_requester' });
    } catch (e) {
      if (isApplyRefusal(e)) await auditApplyRefusal(this, actor, head, e, ctx);
      throw e;
    }
    const id = head.id;
    let expiredNow = false;
    let out: CommercialPolicyApplyResult | null = null;
    try {
      out = await this.prisma.$transaction(async (tx): Promise<CommercialPolicyApplyResult | null> => {
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state === 'APPLIED') return { request: req, replayed: true };
        // Charter Amendment A1 (AD-3, AD-4, AD-7) — the apply deadline, before anything else.
        if ((await applyDeadlineGate(tx, this.changeRequests, req, this.now(), ctx)) === 'EXPIRED_NOW') {
          expiredNow = true;
          return null; // commit the expiry; refused below
        }
        // NC-5 — NOT_APPROVED (any state but APPROVED / APPLY_FAILED), integrity, and every
        // signature against the snapshotted chain and the live roster; writes nothing.
        await this.changeRequests.assertApplyEligible(id, ctx.platform_tenant_id, tx);
        // TD-A6-3 — the requester's CURRENT authority: the finance_admin role and a live D9 attestation.
        const live = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id, true);
        if (!live.attested || !live.role_keys.includes(REQUESTER_ROLE)) {
          throw new CommercialChangeRequestError('REQUESTER_NO_LONGER_AUTHORIZED', explanationOf('REQUESTER_NO_LONGER_AUTHORIZED'), {
            required_role: REQUESTER_ROLE,
            attested: live.attested,
            live_role_keys: live.role_keys,
          });
        }
        const now = this.now();
        const attempt = req.apply_attempts + 1;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: attempt, updated_at: now } });
        return this.completeInTx(tx, actor, req, attempt, live.role_keys, now, ctx);
      }, TX_OPTIONS);
    } catch (e) {
      if (isApplyRefusal(e)) {
        await auditApplyRefusal(this, actor, head, e, ctx);
        throw e;
      }
      const failure =
        e instanceof ApplyFailure
          ? e
          : e instanceof PolicyActivationRefusedError
            ? new ApplyFailure(POLICY_APPLY_FAILURE_CODES[e.reason] ?? 'UNEXPECTED', { snapshot_refusal: e.reason, ...e.detail })
            : new ApplyFailure('UNEXPECTED', { error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw await recordApplyFailure(this, actor, id, null, failure, ctx);
    }
    if (expiredNow || out === null) throw applyExpiredNow(head);
    return out;
  }

  private async completeInTx(
    tx: Tx,
    actor: CommercialActor,
    req: CommercialChangeRequestRow,
    attempt: number,
    role_keys: readonly string[],
    now: Date,
    ctx: CommercialCallContext,
  ): Promise<CommercialPolicyApplyResult> {
    const id = req.id;
    const r = await activatePolicyVersionInTx(tx, { policy_version_id: req.policy_version_id, policy_checksum: req.policy_checksum, payload: req.payload }, { activated_by: actor.user_id, at: now, change_request_id: id });
    await this.fault?.('after_policy_write', { change_request_id: id });
    const append = (event_type: string, subject: string, policy_version_id: string, body: Record<string, unknown>) =>
      this.audit.append(
        {
          actor: { id: actor.user_id, type: 'user', role_keys: [...role_keys] },
          event_type,
          tenant_id: req.tenant_id,
          subject,
          change_request_id: id,
          policy_version_id,
          payload: body,
          correlation_id: ctx.correlation_id,
        },
        tx,
      );
    const rollback = r.to_previous_status === 'RETIRED';
    await append('COMMERCIAL_POLICY_VERSION_ACTIVATED', `commercial_policy_version:${r.to_version_id}`, r.to_version_id, {
      version_number: r.to_version_number,
      content_checksum: r.to_content_checksum,
      replaces: r.from_version_id,
      replaces_version_number: r.from_version_number,
      rollback,
    });
    // Approval evidence is referenced, never rewritten (distinct from execution).
    const approvals = await tx.commercialApproval.findMany({ where: { change_request_id: id }, orderBy: { step_index: 'asc' } });
    await append('COMMERCIAL_CHANGE_REQUEST_APPLIED', SUBJECT(id), req.policy_version_id, {
      action_type: 'POLICY_ACTIVATE',
      outcome: 'APPLIED',
      change: 'POLICY_ACTIVATE',
      attempt,
      requested_by: req.requested_by,
      reason: req.reason,
      policy_checksum: req.policy_checksum,
      approvals: approvals.map((a) => ({ approval_id: a.id, step_index: a.step_index, approver_user_id: a.approver_user_id, attestation_id: a.attestation_id, approved_at: a.created_at.toISOString() })),
      from_version_id: r.from_version_id,
      from_version_number: r.from_version_number,
      to_version_id: r.to_version_id,
      to_version_number: r.to_version_number,
      rollback,
      effective_at: now.toISOString(),
    });
    await this.fault?.('before_applied', { change_request_id: id });
    const request = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLIED', applied_at: now, updated_at: now } })) as CommercialChangeRequestRow;
    return { request, replayed: false };
  }
}
