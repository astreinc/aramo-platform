import { Inject, Injectable, Optional } from '@nestjs/common';

import { BillingRegionChangeError, BillingRegionService } from '../billing/region/billing-region.service.js';
import type { BillingRegionChange, BillingRegionView, RegionEnableRefusal } from '../billing/region/billing-region.view.js';
import { regionEnableRefusal } from '../billing/region/region-guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
import { COMMERCIAL_OPEN_STATES, validatePayload } from './commercial-change-request.js';
import {
  COMMERCIAL_CLOCK,
  type CommercialActor,
  type CommercialCallContext,
  type CommercialClock,
  type CommercialChangeRequestRow,
  CommercialChangeRequestService,
} from './commercial-change-request.service.js';
import { CommercialOperatorRepository } from './commercial-operator.repository.js';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) ruling Q3, §4.1, §6 G-3 — the governed apply of
// an APPROVED (or APPLY_FAILED, retry) BILLING_REGION_CHANGE on the CCP-A6 apply infrastructure. Reached
// through the same command, CommercialApplyService.apply, and route POST …/change-requests/{id}/apply.
//
//   APPROVED | APPLY_FAILED → APPLYING (attempt + 1) → APPLIED, in ONE transaction with the region write
//   (BillingRegionService.applyChange: the shape re-check, the unknown-region refusal and G-3 whenever the
//   resulting region is ON). The DB guard admits APPLIED only when the region the payload names exists,
//   and its deferred trigger refuses a commit left in APPLYING.
//
// Authority (TD-A6-3): the ORIGINAL requester, a human, holding platform:catalog:draft live; NC-5 re-check
// of every approval under the snapshotted chain (Finance). Refusals: nothing changes, ONE APPLY_REFUSED
// row. Failures (G-3 refusal, unknown region, invalid payload, a fault): rolled back in full, then a
// separate transaction records APPLY_FAILED (attempt counted, ONE APPLY_FAILED row). Retryable — e.g. a
// G-3 `gateway_not_configured` applies once the gateway keys are set on the server.
//
// The record: CommercialCatalogApplication cannot hold it (plan_id / plan_version_id are NOT NULL), so the
// apply is recorded by its commercial audit events (COMMERCIAL_BILLING_REGION_CHANGED, then
// COMMERCIAL_CHANGE_REQUEST_APPLIED). Registration identifiers (§5) are never copied into an audit event
// or a log line: the event names which registration keys the change set, never their values.

export interface CommercialBillingRegionApplyResult {
  request: CommercialChangeRequestRow;
  /** The region after the change (null on an idempotent replay: read it with BillingRegionService.get). */
  region: BillingRegionView | null;
  replayed: boolean;
}

/** The stable APPLY_FAILED code of each region refusal (explained in APPLY_EXPLANATIONS). */
export const BILLING_REGION_APPLY_FAILURE_CODES: Readonly<Record<BillingRegionChangeError['reason'], string>> = {
  invalid_change: 'INVALID_PAYLOAD',
  region_not_supported: 'BILLING_REGION_NOT_FOUND',
  gateway_not_configured: 'BILLING_REGION_GATEWAY_NOT_CONFIGURED',
  selling_entity_inactive: 'BILLING_REGION_SELLING_ENTITY_INACTIVE',
  price_tax_mode_unset: 'BILLING_REGION_PRICE_TAX_MODE_UNSET',
};

/** Test seam (fault injection) for the billing region apply. */
export const COMMERCIAL_BILLING_REGION_APPLY_FAULT_HOOK = Symbol('COMMERCIAL_BILLING_REGION_APPLY_FAULT_HOOK');
export type CommercialBillingRegionApplyFaultHook = (point: 'after_region_write' | 'before_applied', ctx: { change_request_id: string }) => void | Promise<void>;

const SUBJECT = (id: string): string => `commercial_change_request:${id}`;
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;
// One lock per region: two approved changes of the same region apply one after the other.
const REGION_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('subscription.billing_region:' || $1, 0))`;

export function isBillingRegionApplicable(action_type: string): action_type is 'BILLING_REGION_CHANGE' {
  return action_type === 'BILLING_REGION_CHANGE';
}

function toFailure(e: unknown): ApplyFailure {
  if (e instanceof ApplyFailure) return e;
  if (e instanceof BillingRegionChangeError) return new ApplyFailure(BILLING_REGION_APPLY_FAILURE_CODES[e.reason] ?? 'UNEXPECTED', { refusal: e.reason, ...(e.details.length > 0 ? { errors: e.details } : {}) });
  return new ApplyFailure('UNEXPECTED', { error: String((e as Error)?.message ?? e).slice(0, 300) });
}

@Injectable()
export class CommercialBillingRegionApplyService {
  readonly now: CommercialClock;

  constructor(
    readonly prisma: PrismaService,
    readonly audit: CommercialAuditRepository,
    readonly operators: CommercialOperatorRepository,
    private readonly changeRequests: CommercialChangeRequestService,
    private readonly regions: BillingRegionService,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
    @Optional() @Inject(COMMERCIAL_BILLING_REGION_APPLY_FAULT_HOOK) private readonly fault?: CommercialBillingRegionApplyFaultHook,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async apply(actor: CommercialActor, head: CommercialChangeRequestRow, ctx: CommercialCallContext): Promise<CommercialBillingRegionApplyResult> {
    let scope: string;
    try {
      scope = preflightApply(actor, head, isBillingRegionApplicable);
    } catch (e) {
      if (isApplyRefusal(e)) await auditApplyRefusal(this, actor, head, e, ctx);
      throw e;
    }
    const id = head.id;
    const country = typeof (head.payload as Record<string, unknown> | null)?.['country'] === 'string' ? ((head.payload as Record<string, unknown>)['country'] as string) : '';
    let expiredNow = false;
    let out: CommercialBillingRegionApplyResult | null = null;
    try {
      out = await this.prisma.$transaction(async (tx): Promise<CommercialBillingRegionApplyResult | null> => {
        await tx.$executeRawUnsafe(REGION_LOCK_SQL, country);
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
        const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
        if (req.state === 'APPLIED') return { request: req, region: null, replayed: true };
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

        let change: BillingRegionChange;
        try {
          change = validatePayload('BILLING_REGION_CHANGE', req.payload) as unknown as BillingRegionChange;
        } catch (e) {
          throw new ApplyFailure('INVALID_PAYLOAD', { errors: (e as { errors?: unknown }).errors ?? [(e as Error).message] });
        }
        const prior = await tx.billingRegion.findUnique({ where: { country: change.country }, include: { selling_entity: true } });
        const region = await this.regions.applyChange(change, actor.user_id, tx);
        await this.fault?.('after_region_write', { change_request_id: id });

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
              payload: { action_type: 'BILLING_REGION_CHANGE', ...body },
              correlation_id: ctx.correlation_id,
            },
            tx,
          );
        await append('COMMERCIAL_BILLING_REGION_CHANGED', `billing_region:${region.country}`, {
          country: region.country,
          gateway: region.gateway,
          selling_entity_key: region.selling_entity.key,
          from:
            prior === null
              ? null
              : regionAuditState({
                  enabled: prior.enabled,
                  personal_web_enabled: prior.personal_web_enabled,
                  business_web_enabled: prior.business_web_enabled,
                  price_tax_mode: prior.price_tax_mode,
                  selling_entity: prior.selling_entity,
                }),
          to: regionAuditState(region),
          // §5 — which registration identifiers the change set; never their values.
          registration_keys_set: Object.keys(change.selling_entity?.registration ?? {}).sort(),
          registration_replaced: change.selling_entity?.registration !== undefined,
          effective_at: now.toISOString(),
        });
        const approvals = await tx.commercialApproval.findMany({ where: { change_request_id: id }, orderBy: { step_index: 'asc' } });
        await append('COMMERCIAL_CHANGE_REQUEST_APPLIED', SUBJECT(id), {
          outcome: 'APPLIED',
          attempt,
          requested_by: req.requested_by,
          reason: req.reason,
          policy_checksum: req.policy_checksum,
          approvals: approvals.map((a) => ({ approval_id: a.id, step_index: a.step_index, approver_user_id: a.approver_user_id, attestation_id: a.attestation_id, approved_at: a.created_at.toISOString() })),
          country: region.country,
          effective_at: now.toISOString(),
        });
        await this.fault?.('before_applied', { change_request_id: id });
        const request = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLIED', applied_at: now, updated_at: now } })) as CommercialChangeRequestRow;
        return { request, region, replayed: false };
      }, TX_OPTIONS);
    } catch (e) {
      if (isApplyRefusal(e)) {
        await auditApplyRefusal(this, actor, head, e, ctx);
        throw e;
      }
      throw await recordApplyFailure(this, actor, id, null, toFailure(e), ctx);
    }
    if (expiredNow || out === null) throw applyExpiredNow(head);
    return out;
  }
}

/** The non-sensitive region state an audit event records (no registration values). */
function regionAuditState(r: Pick<BillingRegionView, 'enabled' | 'personal_web_enabled' | 'business_web_enabled'> & { price_tax_mode: string; selling_entity: { display_name: string; legal_name: string; active: boolean } }): Record<string, unknown> {
  return {
    enabled: r.enabled,
    personal_web_enabled: r.personal_web_enabled,
    business_web_enabled: r.business_web_enabled,
    price_tax_mode: r.price_tax_mode,
    selling_entity_display_name: r.selling_entity.display_name,
    selling_entity_legal_name: r.selling_entity.legal_name,
    selling_entity_active: r.selling_entity.active,
  };
}

// ---- console reads -----------------------------------------------------------------------------

/** One billing region as the console shows it (catalog readers): the region, gateway state and G-3. */
export interface BillingRegionConsoleView extends BillingRegionView {
  /** G-2 — the region's gateway credentials are set on the server. */
  gateway_configured: boolean;
  /** G-3 — why the region could not be switched ON now (null: it could). */
  enable_refusal: RegionEnableRefusal | null;
}

export interface BillingRegionConsoleDetail extends BillingRegionConsoleView {
  /** §5 — the selling entity's registration identifiers (catalog / finance readers only; never logged). */
  registration: Record<string, string>;
  /** The open BILLING_REGION_CHANGE requests of this region (newest first). */
  open_requests: { id: string; state: string; requested_by: string; created_at: Date; expires_at: Date | null }[];
}

/** India Billing §4.10 — the reads behind Commercial › Billing regions. */
@Injectable()
export class CommercialBillingRegionReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly regions: BillingRegionService,
  ) {}

  async list(): Promise<BillingRegionConsoleView[]> {
    return (await this.regions.list()).map((r) => this.consoleView(r));
  }

  /** Every region with its registration and open requests (the console's one read; a handful of rows). */
  async listDetailed(): Promise<BillingRegionConsoleDetail[]> {
    const out: BillingRegionConsoleDetail[] = [];
    for (const r of await this.regions.list()) {
      const d = await this.detail(r.country);
      if (d !== null) out.push(d);
    }
    return out;
  }

  async detail(country: string): Promise<BillingRegionConsoleDetail | null> {
    const region = await this.regions.get(country);
    if (region === null) return null;
    const entity = await this.prisma.sellingEntity.findUnique({ where: { id: region.selling_entity.id }, select: { registration: true } });
    const open = await this.prisma.commercialChangeRequest.findMany({
      where: { action_type: 'BILLING_REGION_CHANGE', state: { in: [...COMMERCIAL_OPEN_STATES] }, payload: { path: ['country'], equals: region.country } },
      orderBy: { created_at: 'desc' },
      select: { id: true, state: true, requested_by: true, created_at: true, expires_at: true },
      take: 20,
    });
    return { ...this.consoleView(region), registration: registrationOf(entity?.registration), open_requests: open };
  }

  private consoleView(r: BillingRegionView): BillingRegionConsoleView {
    const configured = this.regions.gatewayIsConfigured(r);
    return { ...r, gateway_configured: configured, enable_refusal: regionEnableRefusal(r, configured) };
  }
}

function registrationOf(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

