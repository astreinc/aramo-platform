import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';
import type { OutboxDrainOutcome } from '@aramo/events';
import { LeaseSafeOutboxDrainService } from '@aramo/outbox-publisher';

export const ATS_TALENT_EVENTS_DRAIN = 'ATS_TALENT_EVENTS_DRAIN';

// ATI-SEP-1 A3 — lifecycle-managed drain of the ATS talent outbox. Same shape as
// TalentIntakeOutboxDrainWorker: a plain, Redis-independent interval;
// multi-replica safety comes from the FOR UPDATE SKIP LOCKED lease, the
// in-process latch only prevents overlapping ticks.
//
// Enabled ONLY when ATS_TALENT_EVENTS_DRAIN_ENABLED=1. The talent-intake-worker
// entrypoint defaults it to '1'; the API process leaves it unset ('0'), so the
// API request process never runs the handlers. Interval:
// ATS_TALENT_EVENTS_DRAIN_INTERVAL_MS (default 5000).
@Injectable()
export class AtsTalentEventsDrainWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;

  constructor(
    @Inject(ATS_TALENT_EVENTS_DRAIN) private readonly drain: LeaseSafeOutboxDrainService,
    @Inject('AtsTalentEventsDrainWorkerLogger') private readonly logger: AramoLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['ATS_TALENT_EVENTS_DRAIN_ENABLED'] !== '1') return;
    const intervalMs = Number(process.env['ATS_TALENT_EVENTS_DRAIN_INTERVAL_MS'] ?? '5000');
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.logger.log({ event: 'ats_talent_events_drain_started', interval_ms: intervalMs });
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One drain tick. Public so tests can drive it deterministically.
  async tick(): Promise<OutboxDrainOutcome | null> {
    if (this.draining || this.stopped) return null;
    this.draining = true;
    try {
      const outcome = await this.drain.drainOnce();
      if (outcome.claimed > 0) {
        this.logger.log({ event: 'ats_talent_events_drain_tick', ...outcome });
      }
      return outcome;
    } catch (err) {
      this.logger.warn({
        event: 'ats_talent_events_drain_tick_failed',
        reason: err instanceof Error ? err.message : 'unknown',
      });
      return null;
    } finally {
      this.draining = false;
    }
  }
}
