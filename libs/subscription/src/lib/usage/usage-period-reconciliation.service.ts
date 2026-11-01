import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { billingPeriodAt } from '../billing-period.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { METERED_USAGE_OPTIONS, type MeteredUsageOptions, USAGE_PERIOD_CLOSE_GRACE_MS } from './metered-usage.service.js';
import { aggregateLedger, normalizeUsageLines, reconcileUsageLines, type UsageDiscrepancy, type UsageLine } from './usage-reconciliation.js';

// Sign usage metering — Amendment A3 billing: the idempotent billing-period reconciliation.
//
// Billing is monthly and consolidated: each billable event is one ledger entry and one provider
// meter event (keyed by the entry id); the provider aggregates the period's meter events into the
// ONE period invoice. Nothing charges per event and there is no prepaid wallet.
//
// reconcilePeriod(subscription, period) runs once the period is CLOSED (period end + the close
// grace: the recorder refuses later events for it, so its ledger is final). It writes ONE
// append-only UsagePeriodReconciliation row per (subscription, product, period):
//   - the ledger totals per unit, the entry count and a digest over every entry of the period;
//   - for a provider-billed subscription, the provider invoice's usage lines and the outcome
//     MATCHED (every unit's quantity and amount equal) or MISMATCH (with the discrepancies);
//   - for a subscription not billed by the provider, NOT_PROVIDER_BILLED (the ledger totals are the
//     statement).
// Idempotent: a re-run with the same digest, invoice ref and invoice lines returns the stored row
// (replayed); anything different is refused RECONCILIATION_CONFLICT — a reconciliation is never
// rewritten, and no path here can add a second charge to an invoice.
//
// The provider invoice lines are supplied by the caller: reading them from the provider needs the
// provider meters and metered prices (open decision D4), so no job calls this yet.

export type UsageReconciliationRefusal =
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'INVALID_PERIOD'
  | 'PERIOD_OPEN'
  | 'INVOICE_REQUIRED'
  | 'INVOICE_NOT_EXPECTED'
  | 'INVALID_INVOICE'
  | 'RECONCILIATION_CONFLICT';

export class UsageReconciliationError extends Error {
  constructor(
    readonly code: UsageReconciliationRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'UsageReconciliationError';
  }
}

export interface ProviderUsageInvoice {
  readonly provider: 'STRIPE';
  readonly invoice_ref: string;
  readonly currency: 'USD';
  /** The invoice's metered usage lines, mapped to Aramo unit keys. */
  readonly lines: readonly UsageLine[];
}

export interface UsagePeriodReconciliationView {
  readonly id: string;
  readonly subscription_id: string;
  readonly product_key: string;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly ledger_entry_count: number;
  readonly ledger_amount_minor: number;
  readonly ledger_digest: string;
  readonly ledger_lines: readonly UsageLine[];
  readonly provider_invoice_ref: string | null;
  readonly provider_amount_minor: number | null;
  readonly outcome: 'MATCHED' | 'MISMATCH' | 'NOT_PROVIDER_BILLED';
  readonly discrepancies: readonly UsageDiscrepancy[];
  readonly replayed: boolean;
}

type Row = {
  id: string;
  subscription_id: string;
  product_key: string;
  period_start: Date;
  period_end: Date;
  ledger_entry_count: number;
  ledger_amount_minor: bigint;
  ledger_digest: string;
  ledger_lines: unknown;
  provider_invoice_ref: string | null;
  provider_lines: unknown;
  provider_amount_minor: bigint | null;
  outcome: string;
  discrepancies: unknown;
};

function viewOf(r: Row, replayed: boolean): UsagePeriodReconciliationView {
  return {
    id: r.id,
    subscription_id: r.subscription_id,
    product_key: r.product_key,
    period_start: r.period_start,
    period_end: r.period_end,
    ledger_entry_count: r.ledger_entry_count,
    ledger_amount_minor: Number(r.ledger_amount_minor),
    ledger_digest: r.ledger_digest,
    ledger_lines: r.ledger_lines as UsageLine[],
    provider_invoice_ref: r.provider_invoice_ref,
    provider_amount_minor: r.provider_amount_minor === null ? null : Number(r.provider_amount_minor),
    outcome: r.outcome as UsagePeriodReconciliationView['outcome'],
    discrepancies: r.discrepancies as UsageDiscrepancy[],
    replayed,
  };
}

const sameLines = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return err?.code === 'P2002' || String(err?.message ?? '').includes('duplicate key');
}

@Injectable()
export class UsagePeriodReconciliationService {
  private readonly clock: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(METERED_USAGE_OPTIONS) opts?: MeteredUsageOptions,
  ) {
    this.clock = opts?.clock ?? (() => new Date());
  }

  async reconcilePeriod(input: { subscription_id: string; period_start: Date; invoice: ProviderUsageInvoice | null; reconciled_by: string }): Promise<UsagePeriodReconciliationView> {
    const now = this.clock();
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { id: input.subscription_id },
      select: { id: true, tenant_id: true, product_key: true, period_anchor: true, billing_provider: true, billing_account_ref: true },
    });
    if (sub === null) throw new UsageReconciliationError('SUBSCRIPTION_NOT_FOUND', 'subscription not found');
    const period = billingPeriodAt(sub.period_anchor, input.period_start);
    if (period.start.getTime() !== input.period_start.getTime()) throw new UsageReconciliationError('INVALID_PERIOD', 'period_start is not the start of a billing period of the subscription');
    if (now.getTime() < period.end.getTime() + USAGE_PERIOD_CLOSE_GRACE_MS) throw new UsageReconciliationError('PERIOD_OPEN', 'the billing period is not closed yet');

    const providerBilled = sub.billing_provider === 'STRIPE' && sub.billing_account_ref !== null;
    if (providerBilled && input.invoice === null) throw new UsageReconciliationError('INVOICE_REQUIRED', 'a provider-billed period is reconciled against its invoice');
    if (!providerBilled && input.invoice !== null) throw new UsageReconciliationError('INVOICE_NOT_EXPECTED', 'the subscription is not billed by the provider');
    let providerLines: UsageLine[] | null = null;
    if (input.invoice !== null) {
      if (input.invoice.invoice_ref.trim() === '' || input.invoice.currency !== 'USD') throw new UsageReconciliationError('INVALID_INVOICE', 'the invoice needs a reference and USD');
      try {
        providerLines = normalizeUsageLines(input.invoice.lines);
      } catch (e) {
        throw new UsageReconciliationError('INVALID_INVOICE', (e as Error).message);
      }
    }

    const entries = await this.prisma.usageLedgerEntry.findMany({
      where: { subscription_id: sub.id, period_start: period.start },
      select: { id: true, unit_key: true, quantity: true, amount_minor: true },
    });
    const ledger = aggregateLedger(entries);
    const result = providerLines === null ? null : reconcileUsageLines(ledger.lines, providerLines);
    const outcome = result === null ? 'NOT_PROVIDER_BILLED' : result.outcome;
    const providerAmount = providerLines === null ? null : providerLines.reduce((n, l) => n + l.amount_minor, 0);

    const replayOf = async (): Promise<UsagePeriodReconciliationView | null> => {
      const existing = (await this.prisma.usagePeriodReconciliation.findUnique({
        where: { subscription_id_product_key_period_start: { subscription_id: sub.id, product_key: sub.product_key, period_start: period.start } },
      })) as Row | null;
      if (existing === null) return null;
      const same =
        existing.ledger_digest === ledger.digest &&
        existing.provider_invoice_ref === (input.invoice?.invoice_ref ?? null) &&
        sameLines(existing.provider_lines, providerLines);
      if (!same) throw new UsageReconciliationError('RECONCILIATION_CONFLICT', 'this billing period was already reconciled with different events or invoice totals');
      return viewOf(existing, true);
    };

    const prior = await replayOf();
    if (prior !== null) return prior;
    try {
      const row = (await this.prisma.usagePeriodReconciliation.create({
        data: {
          id: uuidv7(),
          tenant_id: sub.tenant_id,
          subscription_id: sub.id,
          product_key: sub.product_key,
          period_start: period.start,
          period_end: period.end,
          ledger_entry_count: ledger.entry_count,
          ledger_amount_minor: BigInt(ledger.amount_minor),
          ledger_digest: ledger.digest,
          ledger_lines: ledger.lines.map((l) => ({ ...l })),
          provider: input.invoice === null ? null : 'STRIPE',
          provider_invoice_ref: input.invoice?.invoice_ref ?? null,
          ...(providerLines === null ? {} : { provider_lines: providerLines.map((l) => ({ ...l })) }),
          provider_amount_minor: providerAmount === null ? null : BigInt(providerAmount),
          currency: 'USD',
          outcome,
          discrepancies: (result?.discrepancies ?? []).map((d) => ({ ...d })),
          reconciled_by: input.reconciled_by,
          reconciled_at: now,
        },
      })) as Row;
      return viewOf(row, false);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const raced = await replayOf();
        if (raced !== null) return raced;
      }
      throw e;
    }
  }
}
