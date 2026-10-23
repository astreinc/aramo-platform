import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { IntelligenceOutboxDrainService, ProjectionService, reassessmentIntervalMs } from '@aramo/intelligence-core';

// ATI-SEP-1 T5/T7 — in-process background loops of the TI service:
//   * outbox drain (TI_OUTBOX_DRAIN_ENABLED, default 1; TI_OUTBOX_DRAIN_INTERVAL_MS,
//     default 5000) — lease-safe, so several replicas may run it;
//   * re-assessment (TI_REASSESSMENT_ENABLED, default 1; TI_REASSESSMENT_INTERVAL_MS,
//     default 3600000) — staleness / expiry and repair of failed post-commit rebuilds.
// Each loop never overlaps itself; timers are unref'd and cleared on shutdown.

export const TI_OUTBOX_DRAIN_ENABLED_ENV = 'TI_OUTBOX_DRAIN_ENABLED';
export const TI_OUTBOX_DRAIN_INTERVAL_MS_ENV = 'TI_OUTBOX_DRAIN_INTERVAL_MS';
export const TI_REASSESSMENT_ENABLED_ENV = 'TI_REASSESSMENT_ENABLED';

const enabled = (v: string | undefined) => !['0', 'false', 'off', 'no'].includes((v ?? '1').trim().toLowerCase());

function intervalFrom(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 250 ? n : fallback;
}

@Injectable()
export class IntelligenceWorkers implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('IntelligenceWorkers');
  private readonly timers: NodeJS.Timeout[] = [];
  private draining = false;
  private reassessing = false;

  constructor(
    private readonly drain: IntelligenceOutboxDrainService,
    private readonly projection: ProjectionService,
  ) {}

  onApplicationBootstrap(): void {
    if (enabled(process.env[TI_OUTBOX_DRAIN_ENABLED_ENV])) {
      const every = intervalFrom(process.env[TI_OUTBOX_DRAIN_INTERVAL_MS_ENV], 5000);
      this.schedule(every, () => this.drainTick());
      this.logger.log(`outbox drain every ${every} ms`);
    }
    if (enabled(process.env[TI_REASSESSMENT_ENABLED_ENV])) {
      const every = reassessmentIntervalMs();
      this.schedule(every, () => this.reassessTick());
      this.logger.log(`re-assessment every ${every} ms`);
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  private schedule(every: number, fn: () => Promise<void>): void {
    const t = setInterval(() => void fn(), every);
    t.unref();
    this.timers.push(t);
  }

  async drainTick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drain.drainOnce();
    } catch (err) {
      this.logger.warn(`outbox drain failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  async reassessTick(): Promise<void> {
    if (this.reassessing) return;
    this.reassessing = true;
    try {
      await this.projection.reassess();
    } catch (err) {
      this.logger.warn(`re-assessment failed: ${(err as Error).message}`);
    } finally {
      this.reassessing = false;
    }
  }
}
