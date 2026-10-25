import { takeBillingLock } from '../billing/governed-subscription.js';
import type { PrismaService } from '../prisma/prisma.service.js';

import type { CommercialAuditRepository } from './commercial-audit.repository.js';
import { CommercialApplyRefusedError } from './commercial-approval-eligibility.js';
import { COMMERCIAL_ACTIONS, type CommercialActionType } from './commercial-change-request.js';
import { type CommercialActor, type CommercialCallContext, CommercialChangeRequestError, type CommercialChangeRequestRow } from './commercial-change-request.service.js';
import type { CommercialOperatorRepository } from './commercial-operator.repository.js';

// CCP-A6-R (Architect dispositions on A6, 2026-10-25: TD-A6-3 approved; "all refusals: a stable
// typed code, an operator-facing explanation, an audit row, test coverage, and no partial state")
// — the shared refusal and failure records of every governed apply (the CCP-A6 subscription /
// entitlement apply and the CCP-B2-backend catalog apply).
//
//   refusal  the request may not be applied by this actor now (authority, state, approvals,
//            integrity). Nothing changes; ONE COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED audit row.
//   failure  the apply ran and a guard refused its substance, or it faulted. The apply transaction
//            rolled back in full; a separate transaction moves the request to APPLY_FAILED (the
//            attempt counted) with ONE COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED audit row. Retryable.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** Operator-facing explanation per stable code (refusals and failures). */
export const APPLY_EXPLANATIONS: Readonly<Record<string, string>> = {
  // refusals
  NOT_HUMAN: 'Only a signed-in person can apply a commercial change; service principals cannot.',
  NOT_REQUESTER: 'Only the person who requested this change can apply it.',
  REQUESTER_SCOPE_MISSING: 'Your session does not carry the authority to request this kind of change.',
  REQUESTER_NO_LONGER_AUTHORIZED: 'The requester no longer holds the authority to request this kind of change; ask a current holder to raise a new request.',
  ACTION_NOT_APPLICABLE: 'This kind of change request is not applied by this command.',
  NOT_APPROVED: 'The request is not approved (or its earlier apply did not fail), so it cannot be applied.',
  APPROVALS_INCOMPLETE: 'The recorded approvals do not cover every step of the approval chain.',
  APPROVER_NOT_DISTINCT: 'The approvals are not from distinct people independent of the requester.',
  APPROVER_NO_LONGER_ELIGIBLE: 'An approver no longer holds the role, scopes or attestation the step requires; the approval stays on record but cannot be relied on. A new request is needed.',
  INTEGRITY: 'The request no longer matches the payload that was approved; it cannot be applied.',
  APPLY_EXPIRED: 'The apply authority of this approved request has expired (apply deadline passed); raise a new request for fresh approvals.',
  // failures
  STRIPE_OWNED: 'The subscription is managed by the billing provider; change it through a governed provider command, not here.',
  TARGET_STALE: 'The subscription named in the request is no longer the current one (it changed or ended after approval).',
  TARGET_NOT_FOUND: 'The subscription named in the request does not exist for this tenant and product.',
  TARGET_NOT_GOVERNED: 'The subscription named in the request is not an Aramo-managed (MANUAL) subscription.',
  TARGET_NOT_REPLACEABLE: 'The open subscription is a Free Personal subscription and cannot be replaced by this request.',
  PLAN_NOT_FOUND: 'No plan with this key exists for this product.',
  PLAN_VERSION_MISMATCH: 'The plan version does not belong to the named plan.',
  PLAN_VERSION_NOT_PUBLISHED: 'Only a published plan version can be assigned.',
  PLAN_NOT_ASSIGNABLE: 'This plan is inactive or free and cannot be assigned by a change request.',
  PLAN_TENANT_KIND_MISMATCH: 'This plan is for a different kind of organization.',
  NO_CHANGE: 'The subscription is already on this plan version.',
  CAPABILITY_NOT_IN_PRODUCT: 'A requested capability is not part of this product.',
  TENANT_NOT_FOUND: 'The tenant does not exist.',
  INVALID_PAYLOAD: 'The approved payload does not meet the schema of this action.',
  ONE_OPEN_BASE_VIOLATION: 'Another open subscription of this product exists for the tenant.',
  USAGE_EXCEEDS_NEW_LIMIT: 'Current consumption plus open reservations exceed the new limit; the change cannot take effect now.',
  USAGE_CROSS_PERIOD: 'The change would move the billing period and strand usage already recorded; this is not supported.',
  RESERVATION_CONFLICT: 'Open reservations would stop counting under the new billing period; the change would allow double consumption.',
  FUTURE_EFFECTIVE_DATE: 'Future-dated changes are not supported; nothing is scheduled.',
  USAGE_TREATMENT_UNDEFINED: 'The new terms drop or redefine an allowance; no usage treatment is defined for that.',
  VERSION_NOT_FOUND: 'The plan version does not exist.',
  VERSION_NOT_DRAFT: 'Only a draft plan version can be published.',
  VERSION_NOT_PUBLISHED: 'Only a published plan version can be retired.',
  PRODUCT_NOT_REGISTERED: 'The plan version belongs to a product outside the product registry.',
  PRICE_PIN_CONFLICT: 'The plan version is already pinned to a different provider price.',
  // CCP-B5-R — the POLICY_ACTIVATE apply (the NC-5 snapshot re-check failed; nothing was activated)
  POLICY_TARGET_SNAPSHOT_MISSING: 'The request carries no snapshot of the policy version the approvers saw; it cannot be activated.',
  POLICY_TARGET_NOT_FOUND: 'The policy version named in the request no longer exists.',
  POLICY_TARGET_NOT_ACTIVATABLE: 'The policy version named in the request is no longer a draft or retired version, so it cannot be activated.',
  POLICY_TARGET_CHANGED: 'The policy version changed after it was approved; the approvers did not see this content.',
  POLICY_TARGET_MALFORMED: 'The policy version content does not parse as a commercial policy.',
  POLICY_ACTIVE_CHANGED: 'Another policy version became active after this request was raised; raise a new request against the current policy.',
  UNEXPECTED: 'The apply failed unexpectedly and was rolled back; it can be retried.',
  // CCP-C4 — the Stripe-side billing adjustments (credits, discounts, refunds)
  REFUND_POLICY_NOT_APPROVED: 'Refunds are not available yet: the refund policy has not been approved. Nothing was sent to Stripe.',
  TARGET_NOT_SELF_SERVICE: 'The tenant has no self-service (Stripe-managed) subscription of this product; credits, discounts and refunds are sent to Stripe only for those.',
  COMPENSATION_TARGET_INVALID: 'The request this one compensates is not an applied request of the same kind, tenant and product.',
  COMPENSATION_MISMATCH: 'A compensation must reverse exactly the amount, currency or percentage of the request it compensates.',
  ALREADY_COMPENSATED: 'The request named here has already been compensated.',
  // CCP-C4-R — the refund resolution and the refund identity checks
  REFUND_OUTCOME_UNCERTAIN: 'Whether this refund happened at Stripe is not proven yet (a provider read failed, a refund is pending or for another amount, or a send is in progress). The request stays open; try again later.',
  NOT_RESOLVABLE: 'Only a refund that is being applied and has not been confirmed can be resolved this way.',
  REFUND_EXCEEDS_REMAINDER: 'The refund is larger than what is still refundable on that payment; nothing was sent to Stripe.',
  REFUND_CURRENCY_MISMATCH: 'The refund currency is not the currency of that payment; nothing was sent to Stripe.',
  // CCP-C4-P (Amendment A1 RF-4, RF-5)
  REFUND_PAYMENT_DISPUTED: 'A dispute on that payment is open or unresolved; no refund can be made until it is settled.',
  REFUND_REMAINDER_UNVERIFIABLE: 'The refundable amount of that payment could not be verified at Stripe, so the refund is refused rather than guessed.',
  REFUND_PAYMENT_MISMATCH: 'The invoice or payment is not one this tenant paid for this product.',
};

export const explanationOf = (code: string): string => APPLY_EXPLANATIONS[code] ?? 'The change could not be applied.';

/** A guard refused the substance of an apply attempt (rolled back; recorded as APPLY_FAILED). */
export class ApplyFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`apply failed (${code})`);
    this.name = 'ApplyFailure';
  }
}

/** The apply attempt failed and was rolled back; the request is now APPLY_FAILED (retryable). */
export class CommercialApplyFailedError extends Error {
  readonly explanation: string;
  constructor(
    readonly code: string,
    readonly attempt: number,
    readonly detail: Record<string, unknown>,
    readonly request_state: string,
  ) {
    super(`apply failed (${code}); the request is ${request_state}`);
    this.name = 'CommercialApplyFailedError';
    this.explanation = explanationOf(code);
  }
}

const SUBJECT = (id: string): string => `commercial_change_request:${id}`;

/** TD-A6-3 — checks before any transaction (each refusal is audited by the caller). */
export function preflightApply(actor: CommercialActor, head: CommercialChangeRequestRow, applicable: (action_type: string) => boolean): string {
  if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', explanationOf('NOT_HUMAN'));
  if (!applicable(head.action_type)) {
    throw new CommercialChangeRequestError('ACTION_NOT_APPLICABLE', `${head.action_type} is not applied by this path`, { action_type: head.action_type });
  }
  if (actor.user_id !== head.requested_by) throw new CommercialChangeRequestError('NOT_REQUESTER', explanationOf('NOT_REQUESTER'), { reason: 'not_requester' });
  const scope = COMMERCIAL_ACTIONS[head.action_type as CommercialActionType].requester_scope as string;
  if (!actor.scopes.includes(scope)) {
    throw new CommercialChangeRequestError('REQUESTER_SCOPE_MISSING', `applying ${head.action_type} requires ${scope}`, { missing_scopes: [scope] });
  }
  return scope;
}

/** TD-A6-3 — the requester's CURRENT authority, read live from the RBAC rows in the apply transaction. */
export async function assertRequesterStillAuthorized(tx: Tx, operators: CommercialOperatorRepository, platform_tenant_id: string, user_id: string, scope: string): Promise<void> {
  const live = await operators.readOperator(tx, platform_tenant_id, user_id, true);
  if (!live.scopes.includes(scope)) {
    throw new CommercialChangeRequestError('REQUESTER_NO_LONGER_AUTHORIZED', explanationOf('REQUESTER_NO_LONGER_AUTHORIZED'), { required_scope: scope, live_role_keys: live.role_keys });
  }
}

/**
 * Charter Amendment A1 (Apply deadline, LOCKED 2026-10-25; AD-4, AD-7) — the apply-time deadline
 * gate, run inside the apply transaction right after the request row is locked:
 *   - an APPLY_EXPIRED request is refused APPLY_EXPIRED (an audited refusal);
 *   - an APPROVED / APPLY_FAILED request at or past its deadline is expired NOW (its one
 *     COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED event is the record) and the caller commits that and
 *     then refuses APPLY_EXPIRED without a second audit row.
 * Returns 'EXPIRED_NOW' or 'OPEN'.
 */
export async function applyDeadlineGate(
  tx: Tx,
  changeRequests: { expireApplyIfDue: (tx: Tx, req: CommercialChangeRequestRow, now: Date, ctx: CommercialCallContext) => Promise<boolean> },
  req: CommercialChangeRequestRow,
  now: Date,
  ctx: CommercialCallContext,
): Promise<'EXPIRED_NOW' | 'OPEN'> {
  if (req.state === 'APPLY_EXPIRED') throw new CommercialChangeRequestError('APPLY_EXPIRED', explanationOf('APPLY_EXPIRED'), { state: req.state });
  return (await changeRequests.expireApplyIfDue(tx, req, now, ctx)) ? 'EXPIRED_NOW' : 'OPEN';
}

/** The refusal reported after an expiry committed by the apply itself (not audited a second time). */
export function applyExpiredNow(req: CommercialChangeRequestRow): CommercialChangeRequestError {
  return new CommercialChangeRequestError('APPLY_EXPIRED', explanationOf('APPLY_EXPIRED'), { state: 'APPLY_EXPIRED', expired_by_this_attempt: true, change_request_id: req.id });
}

export function isApplyRefusal(e: unknown): e is CommercialApplyRefusedError | CommercialChangeRequestError {
  return e instanceof CommercialApplyRefusedError || e instanceof CommercialChangeRequestError;
}

/** ONE audit row for a refused apply; nothing else is written. */
export async function auditApplyRefusal(
  deps: { prisma: PrismaService; audit: CommercialAuditRepository; operators: CommercialOperatorRepository },
  actor: CommercialActor,
  req: CommercialChangeRequestRow,
  e: CommercialApplyRefusedError | CommercialChangeRequestError,
  ctx: CommercialCallContext,
): Promise<void> {
  const refusal = e instanceof CommercialApplyRefusedError ? e.reason : e.code;
  const detail = e instanceof CommercialApplyRefusedError ? e.detail : e.details;
  try {
    await deps.prisma.$transaction(async (tx) => {
      const role_keys = (await deps.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
      await deps.audit.append(
        {
          actor: { id: actor.user_id, type: 'user', role_keys },
          event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED',
          tenant_id: req.tenant_id,
          subject: SUBJECT(req.id),
          change_request_id: req.id,
          policy_version_id: req.policy_version_id,
          payload: { action_type: req.action_type, refusal, explanation: explanationOf(refusal), detail, actor_kind: actor.actor_kind },
          correlation_id: ctx.correlation_id,
        },
        tx,
      );
    });
  } catch {
    // The refusal stands even if its audit row cannot be written.
  }
}

/** APPLY_FAILED in its own transaction (the apply transaction rolled back in full). */
export async function recordApplyFailure(
  deps: { prisma: PrismaService; audit: CommercialAuditRepository; operators: CommercialOperatorRepository; now: () => Date },
  actor: CommercialActor,
  id: string,
  billing_tenant_id: string | null,
  failure: ApplyFailure,
  ctx: CommercialCallContext,
): Promise<CommercialApplyFailedError> {
  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        if (billing_tenant_id !== null) await takeBillingLock(tx, billing_tenant_id);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state !== 'APPROVED' && req.state !== 'APPLY_FAILED') {
          return new CommercialApplyFailedError(failure.code, req.apply_attempts, failure.detail, req.state);
        }
        const now = deps.now();
        const attempt = req.apply_attempts + 1;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: attempt, updated_at: now } });
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLY_FAILED', updated_at: now } });
        const role_keys = (await deps.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
        await deps.audit.append(
          {
            actor: { id: actor.user_id, type: 'user', role_keys },
            event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED',
            tenant_id: req.tenant_id,
            subject: SUBJECT(id),
            change_request_id: id,
            policy_version_id: req.policy_version_id,
            payload: { action_type: req.action_type, attempt, failure: failure.code, explanation: explanationOf(failure.code), detail: failure.detail },
            correlation_id: ctx.correlation_id,
          },
          tx,
        );
        return new CommercialApplyFailedError(failure.code, attempt, failure.detail, 'APPLY_FAILED');
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
  } catch {
    // The failure could not be recorded: report the original failure (nothing was applied).
    return new CommercialApplyFailedError(failure.code, 0, failure.detail, 'UNRECORDED');
  }
}
