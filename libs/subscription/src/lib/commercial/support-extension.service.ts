import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { takeBillingLock } from '../billing/governed-subscription.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, isProductKey } from '../product-registry.js';

import { type CommercialApplyResult, CommercialApplyService } from './commercial-apply.service.js';
import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { COMMERCIAL_OPEN_STATES, boundedExceptionChain, payloadChecksum, validatePayload } from './commercial-change-request.js';
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
import { CommercialPolicyRepository } from './commercial-policy.repository.js';
import { type SupportExtensionDecision, decideSupportExtension, overlayCovers } from './support-extension.js';

// CCP-A8 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A8; DDR v1.2 §3.2(5); Charter §7
// D5; Q7; Recon Report §1 C1, G1) — the support exception overlay service.
//
// `request` is the support_admin's single entry point (`platform:subscription:support`):
//   1. Refusals (nothing is written): not a user principal, scope missing, invalid input, the
//      platform tenant, an unknown tenant, the named subscription is not the OPEN BASE row of
//      that tenant × product, an open change request already exists (Q14), no valid ACTIVE
//      policy (fail closed).
//   2. Under the shared billing lock `billing:<tenant>` (so two concurrent extensions, and the
//      webhook, serialize) the prior overlays of the tenant × product and the requester's live D9
//      attestation are read and `decideSupportExtension` decides against the ACTIVE policy.
//   3. Within bounds → in THE SAME transaction: a SUPPORT_EXTENSION request of kind EXCEPTION with
//      the zero-step BOUNDED_EXCEPTION chain (its basis = the clause and the counter snapshot),
//      then CommercialApplyService.applyBoundedExceptionInTx (the A6 core): DRAFT → APPLYING →
//      APPLIED, the overlay, the CommercialChangeApplication, and every audit event with
//      is_exception = true (SUPPORT_EXTENSION_EXCEPTION_APPLIED carries the counters).
//   4. Any breach (LENGTH, FREQUENCY, CUMULATIVE, ELIGIBILITY) → ESCALATES: a NORMAL
//      SUPPORT_EXTENSION request is created and submitted (Finance-only chain, Q7) and a
//      SUPPORT_EXTENSION_ESCALATED event records the breaches. NOTHING applies: the approved
//      request is applied later through POST /change-requests/{id}/apply (the A6 path).
// Removal is a SUPPORT_EXTENSION request with operation REMOVE through the generic change-request
// routes (Finance-only chain), applied by the A6 path; this service only reads overlays for it.
//
// No path here writes TenantSubscription (G1; HALT condition of the A8 row) or any usage row.

export const SUPPORT_EXTENSION_SCOPE = 'platform:subscription:support';

export interface SupportExtensionRow {
  id: string;
  tenant_id: string;
  product_key: string;
  subscription_id: string;
  change_request_id: string;
  is_exception: boolean;
  days: number;
  grace_until_at_apply: Date | null;
  base_until: Date;
  extends_until: Date;
  policy_version_id: string;
  applied_by: string;
  applied_at: Date;
  removed_at: Date | null;
  removed_by: string | null;
  remove_change_request_id: string | null;
}

export interface RequestSupportExtensionInput {
  tenant_id: string;
  product_key: string;
  subscription_id: string;
  requested_days: number;
  reason: string;
  idempotency_key: string;
}

export type SupportExtensionOutcome =
  | {
      outcome: 'APPLIED';
      replayed: boolean;
      request: CommercialChangeRequestRow;
      extension: SupportExtensionRow;
      application: CommercialApplyResult['application'];
      /** null on an idempotent replay (the decision is in the request's chain basis). */
      decision: SupportExtensionDecision | null;
    }
  | {
      outcome: 'ESCALATED';
      replayed: boolean;
      request: CommercialChangeRequestRow;
      /** null on an idempotent replay (the decision is on the SUPPORT_EXTENSION_ESCALATED event). */
      decision: SupportExtensionDecision | null;
    };

const SUBJECT = (id: string): string => `commercial_change_request:${id}`;
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

function isUniqueViolation(e: unknown, target: string): boolean {
  const err = e as { code?: string; meta?: unknown; message?: string };
  if (err?.code !== 'P2002' && !String(err?.message ?? '').includes('duplicate key')) return false;
  return (JSON.stringify(err.meta ?? {}) + String(err.message ?? '')).includes(target);
}

@Injectable()
export class SupportExtensionService {
  private readonly now: CommercialClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommercialAuditRepository,
    private readonly policies: CommercialPolicyRepository,
    private readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    private readonly applier: CommercialApplyService,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async request(actor: CommercialActor, input: RequestSupportExtensionInput, ctx: CommercialCallContext): Promise<SupportExtensionOutcome> {
    if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', 'only a user principal can request a support extension');
    if (!actor.scopes.includes(SUPPORT_EXTENSION_SCOPE)) {
      throw new CommercialChangeRequestError('REQUESTER_SCOPE_MISSING', `a support extension requires ${SUPPORT_EXTENSION_SCOPE}`, { missing_scopes: [SUPPORT_EXTENSION_SCOPE] });
    }
    if (!isProductKey(input.product_key)) throw new CommercialChangeRequestError('INVALID_INPUT', `unknown product_key ${input.product_key}`, { reason: 'unknown_product_key' });
    if (input.tenant_id === ctx.platform_tenant_id) throw new CommercialChangeRequestError('INVALID_INPUT', 'the platform tenant is not a commercial tenant', { reason: 'platform_tenant' });
    const payload = (() => {
      try {
        return validatePayload('SUPPORT_EXTENSION', { operation: 'EXTEND', subscription_id: input.subscription_id, requested_days: input.requested_days });
      } catch (e) {
        throw new CommercialChangeRequestError('INVALID_INPUT', (e as Error).message, { reason: 'invalid_payload', errors: (e as { errors?: unknown }).errors ?? [] });
      }
    })();
    const checksum = payloadChecksum(payload);

    const replay = await this.replayOf(actor, input, checksum);
    if (replay !== null) return replay;

    const policy = await this.policies.getActivePolicy();
    const tenant_id = input.tenant_id;
    const product_key = input.product_key;
    const decided: { value: SupportExtensionDecision | null } = { value: null };
    try {
      const applied = await this.prisma.$transaction(async (tx) => {
        await takeBillingLock(tx, tenant_id);
        // The same Q14 lock CommercialChangeRequestService.create takes (one open request per
        // tenant × product), so a concurrent create and this call serialize.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ccp:change_request:${tenant_id}:${product_key}`}, 0))`;
        const tenant = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM identity."Tenant" WHERE id = $1::uuid`, tenant_id);
        if ((tenant[0]?.n ?? 0) !== 1) throw new CommercialChangeRequestError('TENANT_NOT_FOUND', 'tenant not found', { tenant_id });
        const now = this.now();
        await this.changeRequests.expireOpenFor(tx, tenant_id, product_key, now, ctx);
        const open = await tx.commercialChangeRequest.findFirst({ where: { tenant_id, product_key, state: { in: [...COMMERCIAL_OPEN_STATES] } }, select: { id: true, state: true } });
        if (open !== null) {
          throw new CommercialChangeRequestError('OPEN_REQUEST_EXISTS', 'an open change request already exists for this tenant and product', { open_request_id: open.id, open_state: open.state });
        }
        const row = await tx.tenantSubscription.findUnique({ where: { id: input.subscription_id } });
        if (row === null || row.tenant_id !== tenant_id || row.product_key !== product_key || row.ended_at !== null || row.composition_role !== BASE_COMPOSITION) {
          throw new CommercialChangeRequestError('INVALID_INPUT', 'the subscription is not the open base subscription of this tenant and product', { reason: 'subscription_not_open', subscription_id: input.subscription_id });
        }
        const prior = await tx.supportExtension.findMany({ where: { tenant_id, product_key }, select: { applied_at: true, days: true } });
        const requester = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id);
        const decision = decideSupportExtension(policy.content, {
          requested_days: input.requested_days,
          now,
          prior,
          subscription_status: row.status,
          requester_attested: requester.attested,
        });
        decided.value = decision;
        if (!decision.within_bounds) return null; // escalates below, outside this transaction

        const id = uuidv7();
        const basis = { ruling: 'DDR v1.2 §3.2(5) bounded support extension', clause: decision.clause, counters: decision.counters, policy_version_number: policy.version_number };
        const chain = boundedExceptionChain(basis);
        await tx.commercialChangeRequest.create({
          data: {
            id,
            action_type: 'SUPPORT_EXTENSION',
            kind: 'EXCEPTION',
            state: 'DRAFT',
            tenant_id,
            product_key,
            payload: payload as object,
            payload_checksum: checksum,
            required_chain: chain as unknown as object,
            policy_version_id: policy.version_id,
            policy_checksum: policy.checksum,
            requested_by: actor.user_id,
            reason: input.reason,
            idempotency_key: input.idempotency_key,
            created_at: now,
            updated_at: now,
          },
        });
        await this.audit.append(
          {
            actor: { id: actor.user_id, type: 'user', role_keys: requester.role_keys },
            event_type: 'COMMERCIAL_CHANGE_REQUEST_CREATED',
            is_exception: true,
            tenant_id,
            subject: SUBJECT(id),
            change_request_id: id,
            policy_version_id: policy.version_id,
            payload: { action_type: 'SUPPORT_EXTENSION', kind: 'EXCEPTION', product_key, payload_checksum: checksum, policy_checksum: policy.checksum, chain_rule: chain.rule, chain_basis: basis, steps: [] },
            correlation_id: ctx.correlation_id,
          },
          tx,
        );
        const out = await this.applier.applyBoundedExceptionInTx(tx, actor, id, ctx, policy.content, { clause: decision.clause, counters: decision.counters });
        const extension = (await tx.supportExtension.findUniqueOrThrow({ where: { change_request_id: id } })) as SupportExtensionRow;
        return { out, extension };
      }, TX_OPTIONS);
      if (applied !== null) {
        return { outcome: 'APPLIED', replayed: false, request: applied.out.request, extension: applied.extension, application: applied.out.application, decision: decided.value };
      }
    } catch (e) {
      if (isUniqueViolation(e, 'idempotency_key')) {
        const again = await this.replayOf(actor, input, checksum);
        if (again !== null) return again;
      }
      if (isUniqueViolation(e, 'one_open_per_tenant_product')) {
        throw new CommercialChangeRequestError('OPEN_REQUEST_EXISTS', 'an open change request already exists for this tenant and product', {});
      }
      throw e;
    }
    if (decided.value === null) throw new Error('support extension: no decision was reached');
    return this.escalate(actor, input, payload, decided.value, ctx);
  }

  /** Out of bounds: a NORMAL request, created and submitted (Finance, Q7). Nothing applies. */
  private async escalate(
    actor: CommercialActor,
    input: RequestSupportExtensionInput,
    payload: Record<string, unknown>,
    decision: SupportExtensionDecision,
    ctx: CommercialCallContext,
  ): Promise<SupportExtensionOutcome> {
    const created = await this.changeRequests.create(
      actor,
      { action_type: 'SUPPORT_EXTENSION', kind: 'NORMAL', tenant_id: input.tenant_id, product_key: input.product_key, payload, reason: input.reason, idempotency_key: input.idempotency_key },
      ctx,
    );
    if (created.replayed) return { outcome: 'ESCALATED', replayed: true, request: created.request, decision: null };
    const request = await this.changeRequests.submit(actor, created.request.id, ctx);
    await this.prisma.$transaction(async (tx) => {
      const role_keys = (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
      await this.audit.append(
        {
          actor: { id: actor.user_id, type: 'user', role_keys },
          event_type: 'SUPPORT_EXTENSION_ESCALATED',
          tenant_id: input.tenant_id,
          subject: SUBJECT(request.id),
          change_request_id: request.id,
          policy_version_id: request.policy_version_id,
          payload: { action_type: 'SUPPORT_EXTENSION', subscription_id: input.subscription_id, breaches: decision.breaches, eligibility: decision.eligibility, counters: decision.counters, clause: decision.clause, applied: false },
          correlation_id: ctx.correlation_id,
        },
        tx,
      );
    });
    return { outcome: 'ESCALATED', replayed: false, request, decision };
  }

  /** Idempotent replay on `idempotency_key` (same requester, same extension); a different body conflicts. */
  private async replayOf(actor: CommercialActor, input: RequestSupportExtensionInput, checksum: string): Promise<SupportExtensionOutcome | null> {
    const existing = (await this.prisma.commercialChangeRequest.findUnique({ where: { idempotency_key: input.idempotency_key } })) as CommercialChangeRequestRow | null;
    if (existing === null) return null;
    const same =
      existing.action_type === 'SUPPORT_EXTENSION' &&
      existing.tenant_id === input.tenant_id &&
      existing.product_key === input.product_key &&
      existing.payload_checksum === checksum &&
      existing.reason === input.reason &&
      existing.requested_by === actor.user_id;
    if (!same) throw new CommercialChangeRequestError('IDEMPOTENCY_KEY_CONFLICT', 'the idempotency key was used for a different request', { change_request_id: existing.id });
    if (existing.kind === 'EXCEPTION') {
      const extension = (await this.prisma.supportExtension.findUniqueOrThrow({ where: { change_request_id: existing.id } })) as SupportExtensionRow;
      const application = await this.prisma.commercialChangeApplication.findUniqueOrThrow({ where: { change_request_id: existing.id } });
      return { outcome: 'APPLIED', replayed: true, request: existing, extension, application, decision: null };
    }
    return { outcome: 'ESCALATED', replayed: true, request: existing, decision: null };
  }

  /** The overlays of a tenant (optionally one product), newest first, with whether each covers `now`. */
  async list(tenant_id: string, product_key?: string): Promise<Array<SupportExtensionRow & { active: boolean }>> {
    if (product_key !== undefined && !isProductKey(product_key)) throw new CommercialChangeRequestError('INVALID_INPUT', `unknown product_key ${product_key}`, { reason: 'unknown_product_key' });
    const rows = (await this.prisma.supportExtension.findMany({
      where: { tenant_id, ...(product_key !== undefined ? { product_key } : {}) },
      orderBy: [{ applied_at: 'desc' }, { id: 'desc' }],
      take: 200,
    })) as SupportExtensionRow[];
    const now = this.now();
    return rows.map((r) => ({ ...r, active: overlayCovers(r, now) }));
  }
}
