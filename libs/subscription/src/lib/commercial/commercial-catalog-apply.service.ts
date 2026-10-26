import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PlanVersionRepository, PlanVersionStateError, currentPublishedVersion } from '../plan-version.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isProductKey } from '../product-registry.js';

import {
  ApplyFailure,
  applyDeadlineGate,
  applyExpiredNow,
  assertRequesterStillAuthorized,
  auditApplyRefusal,
  isApplyRefusal,
  preflightApply,
  recordApplyFailure,
} from './commercial-apply-records.js';
import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { type B2CatalogApplyAction, isCatalogApplicable, validatePayload } from './commercial-change-request.js';
import {
  COMMERCIAL_CLOCK,
  type CommercialActor,
  type CommercialCallContext,
  type CommercialClock,
  type CommercialChangeRequestRow,
  CommercialChangeRequestService,
} from './commercial-change-request.service.js';
import { CommercialOperatorRepository } from './commercial-operator.repository.js';

export { isCatalogApplicable } from './commercial-change-request.js';

// CCP-B2-backend (Architect disposition TD-A6-13, 2026-10-25; PBD §5.3 row B2 "draft, version,
// finance-then-owner publish, retire") — the governed apply of the catalog lifecycle on the CCP-A6
// apply infrastructure: an APPROVED PLAN_VERSION_PUBLISH or PLAN_RETIRE change request (CCP-A3
// action types; chain Finance → Owner, the owner step with platform:catalog:publish) is applied in
// ONE transaction through the CCP-A5 repository methods:
//   PLAN_VERSION_PUBLISH  DRAFT → PUBLISHED (PlanVersionRepository.publish; the plan's previous
//                         PUBLISHED version → RETIRED in the same transaction); an optional
//                         provider price is pinned to the version first (pinProviderPrice, D3)
//   PLAN_RETIRE           PUBLISHED → RETIRED (PlanVersionRepository.retire): a plan VERSION; there
//                         is no plan-level retire action type (TD-B2-1)
// TD-A5-1 (ratified): publishing or retiring a version NEVER moves a subscription — existing
// subscribers keep their pinned version (grandfathering). Same authority, refusal and failure
// rules as CCP-A6 (TD-A6-3: the original requester, a human, live authority; NC-5 re-check;
// APPLY_FAILED retryable; the shared records in commercial-apply-records.ts). Reached through the
// same command, CommercialApplyService.apply, and route POST …/change-requests/{id}/apply.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export interface CommercialCatalogApplicationRow {
  id: string;
  change_request_id: string;
  action_type: string;
  plan_id: string;
  plan_version_id: string;
  retired_plan_version_id: string | null;
  provider_price_ref: string | null;
  attempt: number;
  applied_by: string;
  applied_at: Date;
}

export interface CommercialCatalogApplyResult {
  request: CommercialChangeRequestRow;
  catalog_application: CommercialCatalogApplicationRow;
  replayed: boolean;
}

/** Test seam (fault injection) for the catalog apply. */
export const COMMERCIAL_CATALOG_APPLY_FAULT_HOOK = Symbol('COMMERCIAL_CATALOG_APPLY_FAULT_HOOK');
export type CommercialCatalogApplyFaultHook = (point: 'after_catalog_write' | 'before_applied', ctx: { change_request_id: string }) => void | Promise<void>;

const SUBJECT = (id: string): string => `commercial_change_request:${id}`;
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;
// The CCP-A5 per-plan lock (plan-version.repository.ts lockSql): serializes catalog writes per plan.
const planLock = (plan_id: string): string => `SELECT pg_advisory_xact_lock(hashtextextended('subscription.plan_version:${plan_id}', 0))`;

@Injectable()
export class CommercialCatalogApplyService {
  readonly now: CommercialClock;

  constructor(
    readonly prisma: PrismaService,
    readonly audit: CommercialAuditRepository,
    readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    private readonly versions: PlanVersionRepository,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
    @Optional() @Inject(COMMERCIAL_CATALOG_APPLY_FAULT_HOOK) private readonly fault?: CommercialCatalogApplyFaultHook,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async apply(actor: CommercialActor, head: CommercialChangeRequestRow, ctx: CommercialCallContext): Promise<CommercialCatalogApplyResult> {
    let scope: string;
    try {
      scope = preflightApply(actor, head, isCatalogApplicable);
    } catch (e) {
      if (isApplyRefusal(e)) await auditApplyRefusal(this, actor, head, e, ctx);
      throw e;
    }
    const id = head.id;
    let expiredNow = false;
    let out: CommercialCatalogApplyResult | null = null;
    try {
      out = await this.prisma.$transaction(async (tx): Promise<CommercialCatalogApplyResult | null> => {
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state === 'APPLIED') {
          const catalog_application = (await tx.commercialCatalogApplication.findUniqueOrThrow({ where: { change_request_id: id } })) as CommercialCatalogApplicationRow;
          return { request: req, catalog_application, replayed: true };
        }
        // Charter Amendment A1 (AD-3, AD-4, AD-7) — the apply deadline, before anything else.
        if ((await applyDeadlineGate(tx, this.changeRequests, req, this.now(), ctx)) === 'EXPIRED_NOW') {
          expiredNow = true;
          return null;
        }
        await this.changeRequests.assertApplyEligible(id, ctx.platform_tenant_id, tx);
        await assertRequesterStillAuthorized(tx, this.operators, ctx.platform_tenant_id, actor.user_id, scope);
        const now = this.now();
        const attempt = req.apply_attempts + 1;
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: attempt, updated_at: now } });

        const action = req.action_type as B2CatalogApplyAction;
        let payload: Record<string, unknown>;
        try {
          payload = validatePayload(action, req.payload);
        } catch (e) {
          throw new ApplyFailure('INVALID_PAYLOAD', { errors: (e as { errors?: unknown }).errors ?? [(e as Error).message] });
        }
        const effect = await this.applyDomain(tx, action, payload, actor, now);
        await this.fault?.('after_catalog_write', { change_request_id: id });

        const catalog_application = (await tx.commercialCatalogApplication.create({
          data: {
            id: uuidv7(),
            change_request_id: id,
            action_type: action,
            plan_id: effect.plan_id,
            plan_version_id: effect.plan_version_id,
            retired_plan_version_id: effect.retired_plan_version_id,
            provider_price_ref: effect.provider_price_ref,
            attempt,
            applied_by: actor.user_id,
            applied_at: now,
          },
        })) as CommercialCatalogApplicationRow;

        const role_keys = (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
        const append = (event_type: string, subject: string, body: Record<string, unknown>) =>
          this.audit.append(
            {
              actor: { id: actor.user_id, type: 'user', role_keys },
              event_type,
              tenant_id: null,
              subject,
              change_request_id: id,
              policy_version_id: req.policy_version_id,
              payload: { action_type: action, ...body },
              correlation_id: ctx.correlation_id,
            },
            tx,
          );
        await append(action === 'PLAN_VERSION_PUBLISH' ? 'COMMERCIAL_PLAN_VERSION_PUBLISHED' : 'COMMERCIAL_PLAN_VERSION_RETIRED', `plan_version:${effect.plan_version_id}`, {
          plan_id: effect.plan_id,
          plan_key: effect.plan_key,
          plan_version_id: effect.plan_version_id,
          version_number: effect.version_number,
          content_checksum: effect.content_checksum,
          retired_plan_version_id: effect.retired_plan_version_id,
          provider_price_ref: effect.provider_price_ref,
          effective_at: now.toISOString(),
        });
        // T10 — requester, reason, policy (the event column + checksum), approval evidence, the
        // version transition, the effective timestamp and the outcome.
        const approvals = await tx.commercialApproval.findMany({ where: { change_request_id: id }, orderBy: { step_index: 'asc' } });
        await append('COMMERCIAL_CHANGE_REQUEST_APPLIED', SUBJECT(id), {
          outcome: 'APPLIED',
          catalog_application_id: catalog_application.id,
          attempt,
          requested_by: req.requested_by,
          reason: req.reason,
          policy_checksum: req.policy_checksum,
          approvals: approvals.map((a) => ({ approval_id: a.id, step_index: a.step_index, approver_user_id: a.approver_user_id, attestation_id: a.attestation_id, approved_at: a.created_at.toISOString() })),
          plan_version_id: effect.plan_version_id,
          from_status: effect.from_status,
          to_status: effect.to_status,
          retired_plan_version_id: effect.retired_plan_version_id,
          effective_at: now.toISOString(),
        });
        await this.fault?.('before_applied', { change_request_id: id });
        const request = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLIED', applied_at: now, updated_at: now } })) as CommercialChangeRequestRow;
        return { request, catalog_application, replayed: false };
      }, TX_OPTIONS);
    } catch (e) {
      if (isApplyRefusal(e)) {
        await auditApplyRefusal(this, actor, head, e, ctx);
        throw e;
      }
      const failure = e instanceof ApplyFailure ? e : new ApplyFailure('UNEXPECTED', { error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw await recordApplyFailure(this, actor, id, null, failure, ctx);
    }
    if (expiredNow || out === null) throw applyExpiredNow(head);
    return out;
  }

  private async applyDomain(tx: Tx, action: B2CatalogApplyAction, p: Record<string, unknown>, actor: CommercialActor, now: Date) {
    const head = await tx.planVersion.findUnique({ where: { id: p['plan_version_id'] as string }, include: { plan: true } });
    if (head === null) throw new ApplyFailure('VERSION_NOT_FOUND', { plan_version_id: p['plan_version_id'] });
    if (!isProductKey(head.plan.product_key)) throw new ApplyFailure('PRODUCT_NOT_REGISTERED', { plan_key: head.plan.key, product_key: head.plan.product_key });
    await tx.$executeRawUnsafe(planLock(head.plan_id));
    // Re-read under the per-plan lock.
    const version = await tx.planVersion.findUniqueOrThrow({ where: { id: head.id } });
    const base = { plan_id: version.plan_id, plan_key: head.plan.key, plan_version_id: version.id, version_number: version.version_number, content_checksum: version.content_checksum };
    if (action === 'PLAN_VERSION_PUBLISH') {
      if (version.status !== 'DRAFT') throw new ApplyFailure('VERSION_NOT_DRAFT', { plan_version_id: version.id, status: version.status });
      const prior = await currentPublishedVersion(tx, version.plan_id);
      const price = typeof p['provider_price_ref'] === 'string' ? p['provider_price_ref'] : null;
      if (price !== null) {
        try {
          await this.versions.pinProviderPrice({ plan_version_id: version.id, provider: 'STRIPE', provider_price_ref: price, created_by: actor.user_id, at: now }, tx);
        } catch (e) {
          if (e instanceof PlanVersionStateError) throw new ApplyFailure('PRICE_PIN_CONFLICT', { plan_version_id: version.id, provider_price_ref: price, error: e.message });
          throw e;
        }
      }
      await this.versions.publish(version.id, now, tx);
      return { ...base, retired_plan_version_id: prior?.id ?? null, provider_price_ref: price, from_status: 'DRAFT', to_status: 'PUBLISHED' };
    }
    if (version.status !== 'PUBLISHED') throw new ApplyFailure('VERSION_NOT_PUBLISHED', { plan_version_id: version.id, status: version.status });
    await this.versions.retire(version.id, now, tx);
    return { ...base, retired_plan_version_id: null, provider_price_ref: null, from_status: 'PUBLISHED', to_status: 'RETIRED' };
  }
}
