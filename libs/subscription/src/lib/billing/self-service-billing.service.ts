import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { COMMERCIAL_TERMINAL_STATES } from '../commercial/commercial-change-request.js';
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_REGISTRY, type LegalDocumentKey, type LegalDocumentVersion, approvedLegalDocument, legalRef } from '../legal/legal-documents.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProductKey, assertProductKey, isProductKey, openBaseSubscription } from '../product-registry.js';

import { BillingCommandService, type BillingCommandRow } from './billing-command.service.js';
import { BILLING_COMMAND_UNCONFIRMED_STATES } from './billing-provider-command.js';
import { takeBillingLock } from './governed-subscription.js';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service.js';

// CCP-C7 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C7, §10; Charter :95 "act on them
// only through Stripe commands", :99 "Tenant-side billing self-service stays a tenant-tier,
// owner-only act"; Conversion Rule C-15, C-22, C-23; MP-A2 N-11, N-12) — tenant self-service
// visibility and the owner's upgrade / cancel, per registered product.
//
//   view     GET  — the product's legal-terms state, its open SELF_SERVICE row, every pending
//                   provider change (C-23) and, per action, whether it is available and why not.
//                   The SAME gates as the actions (one evaluator), so the view never offers what
//                   the action refuses.
//   cancel   POST — CANCEL_AT_PERIOD_END only: one locked local transaction writes the owner's
//                   SelfServiceBillingRequest and enqueues the CCP-C1 SUBSCRIPTION_CANCEL
//                   (AT_PERIOD_END) command in the SAME transaction (the outbox). The provider call
//                   happens later, outside any transaction (C1 dispatcher); the change is
//                   pending-provider until the applied provider state confirms it (C1, C-23).
//   upgrade  POST — every gate, then refused FINANCIAL_TREATMENT_UNDEFINED: a provider price
//                   change needs a proration / usage ruling (TD-C1-2; T8 usage rule; Charter L3).
//                   Nothing is written. Decision request DR-C7-1.
//
// Gates, in order (the first that fails is the stable refusal code):
//   1. PRODUCT_NOT_SELF_SERVICE        the product has no self-service registry entry (fail closed).
//   2. SELF_SERVICE_TERMS_NOT_APPROVED the product's terms document has no APPROVED version: the
//                                      designed disabled state (PBD §10: NOT DELIVERED until
//                                      approved legal terms). In force today (sign ToS is DRAFT).
//   3. GOVERNED_SUBSCRIPTION_OPEN      the tenant holds an open governed (MANUAL) row of the product
//                                      (A6, D2/H5; C-15: a self-service path never ends, re-sources
//                                      or re-points a governed row). DB backstop: the request trigger.
//   4. ACTIVATION_PENDING              a held self-service activation is open (A6 hold, C-7/C-8).
//   5. CONVERSION_IN_PROGRESS          an open CONVERSION change request, or a live release (C2).
//   6. NO_SELF_SERVICE_SUBSCRIPTION    no open, provider-linked SELF_SERVICE base row of the product.
//   7. PROVIDER_CHANGE_PENDING         an unconfirmed provider command already targets that row.
//   8. per action: cancel — ALREADY_CANCELING; FINANCIAL_TREATMENT_UNDEFINED inside a commitment
//      term (DR-C2-1: no early cancellation). upgrade — PLAN_NOT_AVAILABLE; then
//      FINANCIAL_TREATMENT_UNDEFINED (DR-C7-1).
// Owner-only authority (sign:billing:manage, ADR-0035 D-3) and the BUSINESS-tenant rule are the
// caller's (the sign-service controller), as for checkout and portal.

export const SELF_SERVICE_ACTIONS = ['CANCEL_AT_PERIOD_END', 'UPGRADE'] as const;
export type SelfServiceAction = (typeof SELF_SERVICE_ACTIONS)[number];

export type SelfServiceRefusal =
  | 'PRODUCT_NOT_SELF_SERVICE'
  | 'SELF_SERVICE_TERMS_NOT_APPROVED'
  | 'GOVERNED_SUBSCRIPTION_OPEN'
  | 'ACTIVATION_PENDING'
  | 'CONVERSION_IN_PROGRESS'
  | 'NO_SELF_SERVICE_SUBSCRIPTION'
  | 'PROVIDER_CHANGE_PENDING'
  | 'ALREADY_CANCELING'
  | 'PLAN_NOT_AVAILABLE'
  | 'FINANCIAL_TREATMENT_UNDEFINED';

export class SelfServiceRefusedError extends Error {
  constructor(
    public readonly reason: SelfServiceRefusal,
    public readonly detail: string | null = null,
  ) {
    super(detail ?? reason);
    this.name = 'SelfServiceRefusedError';
  }
}

/**
 * The per-product self-service registry: which terms document governs the product's self-service
 * actions. Keyed by the CLOSED product registry (ProductKey = sign only), so a product without an
 * entry cannot compile in, and a registry value beyond `sign` needs approved pricing first (PBD §7.1).
 */
export interface SelfServiceProductEntry {
  readonly terms_document: LegalDocumentKey;
}
export const SELF_SERVICE_PRODUCTS: Readonly<Record<ProductKey, SelfServiceProductEntry>> = {
  sign: { terms_document: 'sign.terms_of_service' },
};
/** Injection token for a test-only fixture registry (never bound in a shipped module). */
export const SELF_SERVICE_PRODUCT_REGISTRY = 'SELF_SERVICE_PRODUCT_REGISTRY';

/** The cancel mode is fixed: an at-period-end cancel (no proration, no refund; DR-C2-1, TD-C1-5). */
export const SELF_SERVICE_CANCEL_STEP = 'cancel_at_period_end';

/** DR-C7-1 — a provider price change waits for its proration / usage ruling. */
export const PRICE_CHANGE_UNDEFINED_DETAIL = 'PRICE_CHANGE: a provider price change needs a proration and usage-transition ruling (TD-C1-2, T8)';
export const COMMITMENT_TERM_DETAIL = 'COMMITMENT_TERM: a cancellation inside the commitment term has no approved financial treatment (DR-C2-1)';

export interface SelfServiceActionState {
  available: boolean;
  reason: SelfServiceRefusal | null;
}

export interface SelfServicePendingChange {
  action: string;
  state: string;
  requested_at: Date;
  confirmed_at: Date | null;
}

export interface SelfServiceView {
  product_key: ProductKey;
  terms: { state: 'APPROVED' | 'NOT_APPROVED'; document_key: LegalDocumentKey; version: string | null; url: string | null };
  subscription: { plan_key: string; status: string; current_period_end: Date | null; cancel_at_period_end: boolean; commitment_end: Date | null } | null;
  // C-23 — true while any self-service change of this product is not provider-confirmed.
  pending_provider: boolean;
  pending_changes: SelfServicePendingChange[];
  actions: { cancel: SelfServiceActionState; upgrade: SelfServiceActionState };
}

export interface SelfServiceCancelResult {
  request_id: string;
  action: 'CANCEL_AT_PERIOD_END';
  status: 'PENDING_PROVIDER' | 'CONFIRMED';
  pending_provider: boolean;
  command: BillingCommandRow;
  replayed: boolean;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Db = Tx | PrismaService;

interface SelfServiceRow {
  id: string;
  plan_key: string;
  status: string;
  billing_provider: string;
  billing_subscription_ref: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  commitment_end: Date | null;
}

@Injectable()
export class SelfServiceBillingService {
  private readonly legal: readonly LegalDocumentVersion[];
  private readonly products: Readonly<Record<string, SelfServiceProductEntry>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: BillingCommandService,
    private readonly lifecycle: SubscriptionLifecycleService,
    @Optional() @Inject(LEGAL_DOCUMENT_REGISTRY) legal?: readonly LegalDocumentVersion[],
    @Optional() @Inject(SELF_SERVICE_PRODUCT_REGISTRY) products?: Readonly<Record<string, SelfServiceProductEntry>>,
  ) {
    this.legal = legal ?? LEGAL_DOCUMENTS;
    this.products = products ?? SELF_SERVICE_PRODUCTS;
  }

  private entry(product_key: string): SelfServiceProductEntry {
    // Fail closed: an unregistered product (or one with no self-service entry) is refused.
    const e = isProductKey(product_key) ? this.products[product_key] : undefined;
    if (e === undefined) throw new SelfServiceRefusedError('PRODUCT_NOT_SELF_SERVICE', `product ${String(product_key)} has no self-service billing`);
    return e;
  }

  private terms(e: SelfServiceProductEntry): LegalDocumentVersion | null {
    return approvedLegalDocument(e.terms_document, this.legal);
  }

  /** Gates 3–7 (shared by the view and the actions). Returns the self-service row. */
  private async commonGates(db: Db, tenant_id: string, product_key: ProductKey): Promise<SelfServiceRow> {
    const governed = await db.tenantSubscription.findFirst({ where: { ...openBaseSubscription(tenant_id, product_key), source: 'MANUAL' }, select: { id: true } });
    if (governed !== null) throw new SelfServiceRefusedError('GOVERNED_SUBSCRIPTION_OPEN');
    if ((await this.lifecycle.tenantActivationState(tenant_id, product_key)) !== null) throw new SelfServiceRefusedError('ACTIVATION_PENDING');
    const conversion = await db.commercialChangeRequest.findFirst({
      where: { tenant_id, product_key, action_type: 'CONVERSION', state: { notIn: [...COMMERCIAL_TERMINAL_STATES] } },
      select: { id: true },
    });
    const release = await db.commercialConversionRelease.findFirst({ where: { tenant_id, product_key, state: { in: ['RELEASED', 'CONSUMED'] } }, select: { id: true } });
    if (conversion !== null || release !== null) throw new SelfServiceRefusedError('CONVERSION_IN_PROGRESS');
    const row = await db.tenantSubscription.findFirst({
      where: { ...openBaseSubscription(tenant_id, product_key), source: 'SELF_SERVICE', billing_provider: { not: null }, billing_subscription_ref: { not: null } },
      include: { plan: { select: { key: true } } },
    });
    if (row === null) throw new SelfServiceRefusedError('NO_SELF_SERVICE_SUBSCRIPTION');
    const pending = await db.billingProviderCommand.findFirst({
      where: { tenant_id, product_key, provider: row.billing_provider as string, target_ref: row.billing_subscription_ref as string, state: { in: [...BILLING_COMMAND_UNCONFIRMED_STATES] } },
      select: { id: true },
    });
    if (pending !== null) throw new SelfServiceRefusedError('PROVIDER_CHANGE_PENDING');
    return {
      id: row.id,
      plan_key: row.plan.key,
      status: row.status,
      billing_provider: row.billing_provider as string,
      billing_subscription_ref: row.billing_subscription_ref as string,
      current_period_end: row.current_period_end,
      cancel_at_period_end: row.cancel_at_period_end,
      commitment_end: row.commitment_end,
    };
  }

  private cancelGate(row: SelfServiceRow): void {
    if (row.cancel_at_period_end) throw new SelfServiceRefusedError('ALREADY_CANCELING');
    // DR-C2-1 — no early cancellation of a committed row: an at-period-end cancel is admitted only
    // when the current period reaches the end of the commitment term (a non-renewal).
    if (row.commitment_end !== null && (row.current_period_end === null || row.current_period_end.getTime() < row.commitment_end.getTime())) {
      throw new SelfServiceRefusedError('FINANCIAL_TREATMENT_UNDEFINED', COMMITMENT_TERM_DETAIL);
    }
  }

  private async upgradeGate(tenant_id: string, product_key: ProductKey, row: SelfServiceRow, plan_key: string | null): Promise<void> {
    if (plan_key !== null) {
      const plans = await this.lifecycle.catalog(product_key, tenant_id);
      const target = plans.find((p) => p.key === plan_key);
      if (target === undefined || target.key === row.plan_key || target.sales_model !== 'SELF_SERVICE' || target.status !== 'ACTIVE' || !target.eligible) {
        throw new SelfServiceRefusedError('PLAN_NOT_AVAILABLE');
      }
    }
    throw new SelfServiceRefusedError('FINANCIAL_TREATMENT_UNDEFINED', PRICE_CHANGE_UNDEFINED_DETAIL);
  }

  private async actionState(fn: () => Promise<void>): Promise<SelfServiceActionState> {
    try {
      await fn();
      return { available: true, reason: null };
    } catch (e) {
      if (e instanceof SelfServiceRefusedError) return { available: false, reason: e.reason };
      throw e;
    }
  }

  /** GET — the product's self-service state for this tenant (read only). */
  async view(tenant_id: string, product_key: ProductKey): Promise<SelfServiceView> {
    const product = assertProductKey(product_key);
    const e = this.entry(product);
    const terms = this.terms(e);
    const row = await this.prisma.tenantSubscription.findFirst({
      where: { ...openBaseSubscription(tenant_id, product), source: 'SELF_SERVICE' },
      include: { plan: { select: { key: true } } },
    });
    const requests = await this.prisma.selfServiceBillingRequest.findMany({ where: { tenant_id, product_key: product }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 20 });
    const cmds =
      requests.length === 0 ? [] : await this.prisma.billingProviderCommand.findMany({ where: { self_service_request_id: { in: requests.map((r) => r.id) } } });
    const pending_changes: SelfServicePendingChange[] = requests.map((r) => {
      const c = cmds.filter((x) => x.self_service_request_id === r.id);
      const confirmed = c.length > 0 && c.every((x) => x.state === 'CONFIRMED');
      return { action: r.action, state: confirmed ? 'CONFIRMED' : 'PENDING_PROVIDER', requested_at: r.created_at, confirmed_at: confirmed ? (c[0]?.confirmed_at ?? null) : null };
    });
    const gated = (action: (row: SelfServiceRow) => Promise<void> | void) =>
      this.actionState(async () => {
        if (terms === null) throw new SelfServiceRefusedError('SELF_SERVICE_TERMS_NOT_APPROVED');
        const r = await this.commonGates(this.prisma, tenant_id, product);
        await action(r);
      });
    return {
      product_key: product,
      terms: { state: terms === null ? 'NOT_APPROVED' : 'APPROVED', document_key: e.terms_document, version: terms?.version ?? null, url: terms?.url ?? null },
      subscription:
        row === null
          ? null
          : { plan_key: row.plan.key, status: row.status, current_period_end: row.current_period_end, cancel_at_period_end: row.cancel_at_period_end, commitment_end: row.commitment_end },
      pending_provider: pending_changes.some((p) => p.state !== 'CONFIRMED'),
      pending_changes,
      actions: {
        cancel: await gated((r) => this.cancelGate(r)),
        upgrade: await gated((r) => this.upgradeGate(tenant_id, product, r, null)),
      },
    };
  }

  /**
   * POST cancel — the owner's at-period-end cancel through the CCP-C1 durable command. One locked
   * local transaction: the gates, the SelfServiceBillingRequest, the command (outbox). A repeat for
   * the same subscription returns the recorded request (`replayed`); no second command.
   */
  async cancel(input: { tenant_id: string; product_key: ProductKey; user_id: string; at?: Date }): Promise<SelfServiceCancelResult> {
    const product = assertProductKey(input.product_key);
    const e = this.entry(product);
    const at = input.at ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      await takeBillingLock(tx, input.tenant_id);
      const terms = this.terms(e);
      if (terms === null) throw new SelfServiceRefusedError('SELF_SERVICE_TERMS_NOT_APPROVED');
      // Replay: the request already recorded for the open SELF_SERVICE row returns as it stands.
      const open = await tx.tenantSubscription.findFirst({ where: { ...openBaseSubscription(input.tenant_id, product), source: 'SELF_SERVICE' }, select: { id: true } });
      if (open !== null) {
        const prior = await tx.selfServiceBillingRequest.findUnique({ where: { subscription_id_action: { subscription_id: open.id, action: 'CANCEL_AT_PERIOD_END' } } });
        if (prior !== null) {
          const command = (await tx.billingProviderCommand.findFirstOrThrow({ where: { self_service_request_id: prior.id, step: SELF_SERVICE_CANCEL_STEP } })) as BillingCommandRow;
          return this.result(prior.id, command, true);
        }
      }
      const row = await this.commonGates(tx, input.tenant_id, product);
      this.cancelGate(row);
      const request_id = uuidv7();
      await tx.selfServiceBillingRequest.create({
        data: {
          id: request_id,
          tenant_id: input.tenant_id,
          product_key: product,
          action: 'CANCEL_AT_PERIOD_END',
          subscription_id: row.id,
          provider: row.billing_provider,
          target_ref: row.billing_subscription_ref,
          terms_ref: legalRef(terms),
          requested_by: input.user_id,
          created_at: at,
        },
      });
      const { command } = await this.commands.enqueue(
        {
          self_service_request_id: request_id,
          step: SELF_SERVICE_CANCEL_STEP,
          command_kind: 'SUBSCRIPTION_CANCEL',
          mode: 'AT_PERIOD_END',
          tenant_id: input.tenant_id,
          product_key: product,
          target_ref: row.billing_subscription_ref,
          created_by: input.user_id,
          at,
        },
        tx,
      );
      return this.result(request_id, command, false);
    });
  }

  /** POST upgrade — every gate, then the DR-C7-1 refusal. Never writes. */
  async upgrade(input: { tenant_id: string; product_key: ProductKey; plan_key: string }): Promise<never> {
    const product = assertProductKey(input.product_key);
    const e = this.entry(product);
    if (this.terms(e) === null) throw new SelfServiceRefusedError('SELF_SERVICE_TERMS_NOT_APPROVED');
    const row = await this.commonGates(this.prisma, input.tenant_id, product);
    await this.upgradeGate(input.tenant_id, product, row, input.plan_key);
    throw new SelfServiceRefusedError('FINANCIAL_TREATMENT_UNDEFINED', PRICE_CHANGE_UNDEFINED_DETAIL);
  }

  private result(request_id: string, command: BillingCommandRow, replayed: boolean): SelfServiceCancelResult {
    const confirmed = command.state === 'CONFIRMED';
    return { request_id, action: 'CANCEL_AT_PERIOD_END', status: confirmed ? 'CONFIRMED' : 'PENDING_PROVIDER', pending_provider: !confirmed, command, replayed };
  }
}
