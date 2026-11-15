import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, Optional } from '@nestjs/common';
import { BillingTermRolloverService, SIGN_PRODUCT_KEY, SubscriptionLifecycleService } from '@aramo/subscription';

import { EsignOwnerActivationService } from './esign-owner-activation.service.js';

// Aramo Sign launch — billing reconciliation: every open provider-linked
// subscription is re-fetched from the provider on an interval, so a missed or
// failed webhook heals (status, grace, cancellation, period end) without manual
// action. Opt-in: SIGN_BILLING_RECONCILE_ENABLED=1; interval
// SIGN_BILLING_RECONCILE_INTERVAL_MS (default 1 h). A failing sweep logs and
// waits for the next tick; it never throws.
//
// Sign Monthly and Annual-Commitment Pricing v1.0 (Q2) — each sweep also moves an ANNUAL_COMMIT subscription
// in the last period of its commitment to the plan's MONTHLY price (BillingTermRolloverService), so it
// continues month to month at it. Only rows sold on a version with explicit terms carry a term: dark until
// such a version is published.

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class EsignBillingReconcileWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(EsignBillingReconcileWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly owners: EsignOwnerActivationService,
    @Optional() private readonly rollover?: BillingTermRolloverService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['SIGN_BILLING_RECONCILE_ENABLED'] !== '1') return;
    const n = Number(process.env['SIGN_BILLING_RECONCILE_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);
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
      const r = await this.lifecycle.reconcile(SIGN_PRODUCT_KEY, at);
      for (const res of r.results) {
        if (res.activated_owner_user_id !== undefined && res.tenant_id !== null) {
          await this.owners.activate(res.tenant_id, res.activated_owner_user_id, 'billing-reconcile');
        }
      }
      if (r.checked > 0) this.log.log(`billing reconcile: checked ${r.checked}, applied ${r.applied}, failed ${r.failed}`);
      // Q2 — the post-commitment move to the MONTHLY price (no-op without ANNUAL_COMMIT rows).
      if (this.rollover !== undefined) {
        const t = await this.rollover.run(SIGN_PRODUCT_KEY, at);
        if (t.due > 0) this.log.log(`billing term rollover: due ${t.due}, moved ${t.moved}, skipped ${t.skipped}, failed ${t.failed}`);
      }
      // A1 — eligibility-bound plans (Standard Professional ⇐ ATS): record lapses.
      const e = await this.lifecycle.refreshEligibility(SIGN_PRODUCT_KEY, at);
      if (e.lapsed > 0 || e.restored > 0) this.log.warn(`plan eligibility: ${e.lapsed} lapsed, ${e.restored} restored`);
      return r.applied;
    } catch (err) {
      this.log.error(`billing reconcile sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
