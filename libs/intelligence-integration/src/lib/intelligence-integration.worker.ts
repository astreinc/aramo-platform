import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { INTELLIGENCE_INTEGRATION_CONFIG, type IntelligenceIntegrationConfig } from './intelligence-config.js';
import { IntelligenceEntitlementSyncService } from './intelligence-entitlement-sync.service.js';
import { IntelligenceInboundSyncService } from './intelligence-inbound-sync.service.js';

// ATI-SEP-1 T8 — the background loops of the ATS ↔ TI integration, hosted by the
// talent-intake-worker process ONLY (the same process pin as the ATS talent
// outbox drain: they run iff ATS_TALENT_EVENTS_DRAIN_ENABLED=1, which the worker
// entrypoint defaults on and the API pins to 0), and only when the TI client is
// configured:
//   * inbound inbox drain     — INTELLIGENCE_INBOUND_SYNC_INTERVAL_MS (default 5000; 0 off);
//   * full REPLACE entitlement sync — INTELLIGENCE_ENTITLEMENT_SYNC_INTERVAL_MS
//     (default 900000; 0 off), plus one run shortly after boot.
// Each loop never overlaps itself; timers are unref'd and cleared on shutdown.

@Injectable()
export class IntelligenceIntegrationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('IntelligenceIntegrationWorker');
  private readonly timers: NodeJS.Timeout[] = [];
  private inboundBusy = false;
  private entitlementBusy = false;

  constructor(
    @Inject(INTELLIGENCE_INTEGRATION_CONFIG) private readonly config: IntelligenceIntegrationConfig,
    private readonly inbound: IntelligenceInboundSyncService,
    private readonly entitlements: IntelligenceEntitlementSyncService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['ATS_TALENT_EVENTS_DRAIN_ENABLED'] !== '1') return;
    if (!this.config.configured) {
      this.logger.log({ event: 'intelligence_integration_worker_idle', reason: 'TI_NOT_CONFIGURED' });
      return;
    }
    if (this.config.inboundSyncIntervalMs > 0) this.every(this.config.inboundSyncIntervalMs, () => this.inboundTick());
    if (this.config.entitlementSyncIntervalMs > 0) {
      this.every(this.config.entitlementSyncIntervalMs, () => this.entitlementTick());
      const first = setTimeout(() => void this.entitlementTick(), 5_000);
      first.unref?.();
      this.timers.push(first);
    }
    this.logger.log({
      event: 'intelligence_integration_worker_started',
      inbound_interval_ms: this.config.inboundSyncIntervalMs,
      entitlement_interval_ms: this.config.entitlementSyncIntervalMs,
    });
  }

  onApplicationShutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  private every(ms: number, fn: () => Promise<void>): void {
    const t = setInterval(() => void fn(), ms);
    t.unref?.();
    this.timers.push(t);
  }

  async inboundTick(): Promise<void> {
    if (this.inboundBusy) return;
    this.inboundBusy = true;
    try {
      await this.inbound.drainOnce();
    } catch (err) {
      this.logger.warn({ event: 'intelligence_inbound_tick_failed', reason: (err as Error).message });
    } finally {
      this.inboundBusy = false;
    }
  }

  async entitlementTick(): Promise<void> {
    if (this.entitlementBusy) return;
    this.entitlementBusy = true;
    try {
      await this.entitlements.replaceAll();
    } catch (err) {
      this.logger.warn({ event: 'intelligence_entitlement_tick_failed', reason: (err as Error).message });
    } finally {
      this.entitlementBusy = false;
    }
  }
}
