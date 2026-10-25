import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { BillingCommandService, BillingWebhookInboxService, SIGN_PRODUCT_KEY } from '@aramo/subscription';

import { EsignOwnerActivationService } from './esign-owner-activation.service.js';

// CCP-C1 (PBD §5.2 row C1; Conversion Rule C-22, C-23) — the Stripe command outbox and webhook
// inbox worker. Each tick:
//   1. dispatch due commands (each provider call outside any local transaction);
//   2. reconcile by provider re-fetch: commands awaiting confirmation are re-fetched and applied
//      (the applying transaction confirms them);
//   3. drain the webhook inbox (rows left RECEIVED by a crash, FAILED rows whose backoff elapsed,
//      expired PROCESSING leases).
// OFF BY DEFAULT: runs only with SIGN_BILLING_COMMANDS_ENABLED=1 (interval
// SIGN_BILLING_COMMANDS_INTERVAL_MS, default 60 s, floor 10 s). Enabling it enables nothing
// commercial by itself: with no provider key nothing is dispatched, a live-mode key is refused
// (production hold, PBD §7.3), and only approved change requests can enqueue commands. A failing
// tick logs and waits for the next one; it never throws.

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;

export function billingCommandWorkerInterval(env: NodeJS.ProcessEnv = process.env): number | null {
  if (env['SIGN_BILLING_COMMANDS_ENABLED'] !== '1') return null;
  const n = Number(env['SIGN_BILLING_COMMANDS_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= MIN_INTERVAL_MS ? n : DEFAULT_INTERVAL_MS;
}

@Injectable()
export class EsignBillingCommandWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(EsignBillingCommandWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly commands: BillingCommandService,
    private readonly inbox: BillingWebhookInboxService,
    private readonly owners: EsignOwnerActivationService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = billingCommandWorkerInterval();
    if (interval === null) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(at: Date = new Date()): Promise<{ dispatched: number; reconciled: number; drained: number }> {
    if (this.running) return { dispatched: 0, reconciled: 0, drained: 0 };
    this.running = true;
    try {
      const d = await this.commands.dispatchDue(at);
      const r = await this.commands.reconcilePending(SIGN_PRODUCT_KEY, at);
      const i = await this.inbox.drain(SIGN_PRODUCT_KEY, at);
      // A re-fetch or a drained webhook may open a sending subscription: activate its owner, as
      // the webhook route and the reconcile worker do.
      for (const res of [...r.results, ...i.results]) {
        if (res.outcome === 'APPLIED' && 'activated_owner_user_id' in res && res.activated_owner_user_id !== undefined && res.tenant_id !== null) {
          await this.owners.activate(res.tenant_id, res.activated_owner_user_id, 'billing-commands');
        }
      }
      if (d.claimed + r.checked + i.claimed > 0) {
        this.log.log(
          `billing commands: dispatched ${d.claimed} (accepted ${d.accepted}, retry ${d.retry_wait}, failed ${d.failed}); re-fetched ${r.checked} (confirmed ${r.confirmed}); inbox drained ${i.claimed} (failed ${i.failed})`,
        );
      }
      if (d.failed > 0 || i.failed > 0) this.log.warn('billing commands: failures are listed at GET /platform/commercial/billing-commands and /billing-webhook-inbox');
      return { dispatched: d.claimed, reconciled: r.checked, drained: i.claimed };
    } catch (err) {
      this.log.error(`billing command tick failed: ${(err as Error).message}`);
      return { dispatched: 0, reconciled: 0, drained: 0 };
    } finally {
      this.running = false;
    }
  }
}
