import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { UsageProviderReportService, usageBillingEnabled } from '@aramo/subscription';

// Sign usage / metered billing (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 D-2;
// Amendment A1 §A1.1) — reports recorded usage (the UsageLedgerEntry outbox) to the billing
// provider's metered prices, one tick every 5 minutes.
// OFF BY DEFAULT: runs only with SIGN_USAGE_BILLING_ENABLED=1. Even then nothing is sent without a
// provider key, and a live-mode key is held (live billing is not authorized). A failing tick logs
// and waits for the next one; it never throws.

export const SIGN_USAGE_REPORT_INTERVAL_MS = 5 * 60 * 1000;

export function signUsageReportInterval(env: NodeJS.ProcessEnv = process.env): number | null {
  return usageBillingEnabled(env) ? SIGN_USAGE_REPORT_INTERVAL_MS : null;
}

@Injectable()
export class SignUsageReportWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(SignUsageReportWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly reports: UsageProviderReportService) {}

  onApplicationBootstrap(): void {
    const interval = signUsageReportInterval();
    if (interval === null) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(at: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const r = await this.reports.dispatchDue(at);
      if (r.claimed > 0) {
        this.log.log(`usage reports: claimed ${r.claimed} (reported ${r.reported}, skipped ${r.skipped}, failed ${r.failed}, deferred ${r.deferred})`);
      }
      return r.claimed;
    } catch (err) {
      this.log.error(`usage report tick failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
