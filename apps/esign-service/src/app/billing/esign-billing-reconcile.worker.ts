import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SubscriptionLifecycleService } from '@aramo/subscription';

import { EsignOwnerActivationService } from './esign-owner-activation.service.js';

// Aramo Sign launch — billing reconciliation: every open provider-linked
// subscription is re-fetched from the provider on an interval, so a missed or
// failed webhook heals (status, grace, cancellation, period end) without manual
// action. Opt-in: ESIGN_BILLING_RECONCILE_ENABLED=1; interval
// ESIGN_BILLING_RECONCILE_INTERVAL_MS (default 1 h). A failing sweep logs and
// waits for the next tick; it never throws.

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class EsignBillingReconcileWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(EsignBillingReconcileWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly owners: EsignOwnerActivationService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['ESIGN_BILLING_RECONCILE_ENABLED'] !== '1') return;
    const n = Number(process.env['ESIGN_BILLING_RECONCILE_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);
    const interval = Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS;
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
      const r = await this.lifecycle.reconcile(at);
      for (const res of r.results) {
        if (res.activated_owner_user_id !== undefined && res.tenant_id !== null) {
          await this.owners.activate(res.tenant_id, res.activated_owner_user_id, 'billing-reconcile');
        }
      }
      if (r.checked > 0) this.log.log(`billing reconcile: checked ${r.checked}, applied ${r.applied}, failed ${r.failed}`);
      return r.applied;
    } catch (err) {
      this.log.error(`billing reconcile sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
