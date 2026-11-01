import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { BillingProviderUnavailableError } from '../billing/billing-provider.port.js';
import { USAGE_METER_REPORT_PORT, type UsageMeterReportPort } from '../billing/usage-meter.port.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { METERED_USAGE_OPTIONS, type MeteredUsageOptions, USAGE_MAX_AGE_MS } from './metered-usage.service.js';
import { usageBillingEnabled } from './metered-units.js';

// Sign usage / metered billing (Feature Parity D-2, A1) — delivers recorded usage to the billing
// provider's metered prices. Each UsageLedgerEntry has one UsageProviderReport row (PENDING at
// record time). A tick:
//   - claims due PENDING rows with a lease (a conditional UPDATE: concurrent ticks never send the
//     same row twice, and a crashed tick's row becomes due again when the lease ends);
//   - per row, OUTSIDE any transaction, reports one meter event keyed by the ledger entry id (the
//     provider de-duplicates on it, so a resend after a lost response never counts twice);
//   - records the outcome: REPORTED; SKIPPED NOT_PROVIDER_BILLED (the subscription is not billed
//     by the provider, e.g. an Aramo-managed MANUAL subscription invoiced outside it: its usage is
//     in the period summary); FAILED OUTSIDE_PROVIDER_WINDOW (older than the provider accepts),
//     PROVIDER_REFUSED (a 4xx) or PROVIDER_RETRIES_EXHAUSTED; PENDING with a reason and a later
//     attempt for METER_NOT_CONFIGURED (the version's price has no provider meter) and transient
//     provider errors (exponential backoff).
// HELD (nothing claimed, nothing sent) while SIGN_USAGE_BILLING_ENABLED is not '1', while no
// provider key is configured, and for a live-mode key (live billing is not authorized; as the
// CCP-C1 command outbox). The ledger is never changed here.

export const USAGE_REPORT_BATCH = 50;
export const USAGE_REPORT_LEASE_MS = 5 * 60 * 1000;
export const USAGE_REPORT_MAX_ATTEMPTS = 10;
const METER_RECHECK_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export type UsageReportHold = 'DISABLED' | 'NOT_CONFIGURED' | 'LIVE_MODE';

export interface UsageReportTick {
  readonly held: UsageReportHold | null;
  readonly claimed: number;
  readonly reported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly deferred: number;
}

export function usageReportBackoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

@Injectable()
export class UsageProviderReportService {
  private readonly log = new Logger(UsageProviderReportService.name);
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(USAGE_METER_REPORT_PORT) private readonly port: UsageMeterReportPort,
    @Optional() @Inject(METERED_USAGE_OPTIONS) opts?: MeteredUsageOptions,
  ) {
    this.env = opts?.env ?? process.env;
  }

  private hold(): UsageReportHold | null {
    if (!usageBillingEnabled(this.env)) return 'DISABLED';
    if (!this.port.meterReportingConfigured()) return 'NOT_CONFIGURED';
    if (this.port.mode() === 'live') return 'LIVE_MODE';
    return null;
  }

  async dispatchDue(at: Date = new Date(), limit: number = USAGE_REPORT_BATCH): Promise<UsageReportTick> {
    const held = this.hold();
    const out = { held, claimed: 0, reported: 0, skipped: 0, failed: 0, deferred: 0 };
    if (held !== null) {
      if (held === 'LIVE_MODE') this.log.warn('usage reports not sent: the provider key is live-mode (live billing is not authorized)');
      return out;
    }
    const due = await this.prisma.usageProviderReport.findMany({
      where: { state: 'PENDING', next_attempt_at: { lte: at } },
      orderBy: [{ next_attempt_at: 'asc' }, { ledger_entry_id: 'asc' }],
      take: limit,
      select: { ledger_entry_id: true, next_attempt_at: true },
    });
    for (const row of due) {
      // Claim: only the tick whose conditional update wins sends this row.
      const claim = await this.prisma.usageProviderReport.updateMany({
        where: { ledger_entry_id: row.ledger_entry_id, state: 'PENDING', next_attempt_at: row.next_attempt_at },
        data: { next_attempt_at: new Date(at.getTime() + USAGE_REPORT_LEASE_MS), updated_at: at },
      });
      if (claim.count !== 1) continue;
      out.claimed += 1;
      const outcome = await this.deliver(row.ledger_entry_id, at);
      out[outcome] += 1;
    }
    return out;
  }

  private async deliver(ledger_entry_id: string, at: Date): Promise<'reported' | 'skipped' | 'failed' | 'deferred'> {
    const entry = await this.prisma.usageLedgerEntry.findUniqueOrThrow({ where: { id: ledger_entry_id } });
    const report = await this.prisma.usageProviderReport.findUniqueOrThrow({ where: { ledger_entry_id } });
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { id: entry.subscription_id },
      select: { billing_provider: true, billing_account_ref: true },
    });
    const finish = async (data: { state: 'REPORTED' | 'SKIPPED' | 'FAILED' | 'PENDING'; reason?: string | null; attempts?: number; next_attempt_at?: Date; provider?: string; provider_event_ref?: string; reported_at?: Date }) => {
      await this.prisma.usageProviderReport.update({ where: { ledger_entry_id }, data: { ...data, updated_at: at, next_attempt_at: data.next_attempt_at ?? at } });
    };
    if (sub === null || sub.billing_provider !== 'STRIPE' || sub.billing_account_ref === null) {
      await finish({ state: 'SKIPPED', reason: 'NOT_PROVIDER_BILLED' });
      return 'skipped';
    }
    if (entry.occurred_at.getTime() < at.getTime() - USAGE_MAX_AGE_MS) {
      await finish({ state: 'FAILED', reason: 'OUTSIDE_PROVIDER_WINDOW' });
      return 'failed';
    }
    const price = await this.prisma.planVersionUnitPrice.findUnique({
      where: { plan_version_id_unit_key: { plan_version_id: entry.plan_version_id, unit_key: entry.unit_key } },
      select: { provider: true, provider_meter_event: true },
    });
    if (price?.provider !== 'STRIPE' || price.provider_meter_event === null) {
      await finish({ state: 'PENDING', reason: 'METER_NOT_CONFIGURED', next_attempt_at: new Date(at.getTime() + METER_RECHECK_MS) });
      return 'deferred';
    }
    try {
      const r = await this.port.reportMeterEvent({
        event_name: price.provider_meter_event,
        account_ref: sub.billing_account_ref,
        value: entry.quantity,
        identifier: entry.id,
        occurred_at: entry.occurred_at,
      });
      await finish({ state: 'REPORTED', reason: null, attempts: report.attempts + 1, provider: 'STRIPE', provider_event_ref: r.provider_event_ref, reported_at: at });
      return 'reported';
    } catch (e) {
      const attempts = report.attempts + 1;
      const retryable = e instanceof BillingProviderUnavailableError ? e.retryable : true;
      if (!retryable) {
        this.log.warn(`usage report ${ledger_entry_id} refused by the provider: ${(e as Error).message}`);
        await finish({ state: 'FAILED', reason: 'PROVIDER_REFUSED', attempts });
        return 'failed';
      }
      if (attempts >= USAGE_REPORT_MAX_ATTEMPTS) {
        await finish({ state: 'FAILED', reason: 'PROVIDER_RETRIES_EXHAUSTED', attempts });
        return 'failed';
      }
      await finish({ state: 'PENDING', reason: 'PROVIDER_UNAVAILABLE', attempts, next_attempt_at: new Date(at.getTime() + usageReportBackoffMs(attempts)) });
      return 'deferred';
    }
  }
}
