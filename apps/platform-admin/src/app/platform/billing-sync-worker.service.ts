import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { BillingProductsService } from '@aramo/subscription';

// CCP Billing Products Directive v1.0 (LOCKED) §3.3 / BP-10 / BP-13 — the billing-products sync worker:
// drains the BillingProductSync jobs the governed apply enqueued and makes Stripe, the App Store and
// Google Play match the catalog. OFF unless CCP_BILLING_SYNC_ENABLED=1 (the master switch; each provider
// is additionally dark until its own credentials are set). Interval CCP_BILLING_SYNC_INTERVAL_MS (default
// 1 minute, minimum 1 s). Safe with more than one process (jobs are leased with SKIP LOCKED). Same shape
// as the usage roll-up worker.
export const BILLING_SYNC_DEFAULT_INTERVAL_MS = 60_000;

export function billingSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CCP_BILLING_SYNC_ENABLED'] === '1';
}

export function billingSyncIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['CCP_BILLING_SYNC_INTERVAL_MS'] ?? BILLING_SYNC_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : BILLING_SYNC_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class BillingSyncWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BillingSyncWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly billingProducts: BillingProductsService) {}

  onApplicationBootstrap(): void {
    if (!billingSyncEnabled()) return;
    this.timer = setInterval(() => void this.tick(), billingSyncIntervalMs());
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One drain (public so tests can drive it). Returns how many jobs it processed. */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      return await this.billingProducts.drain();
    } catch (err) {
      this.logger.warn(`billing sync drain failed: ${(err as Error).message.slice(0, 200)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
