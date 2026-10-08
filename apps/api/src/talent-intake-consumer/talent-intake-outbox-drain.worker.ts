import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI
// token (emitted via decorator metadata).
import { LeaseSafeOutboxDrainService } from '@aramo/outbox-publisher';

// ADR-0033 — lifecycle-managed Talent Intake outbox drain. REDIS-INDEPENDENT by
// construction (a plain interval, mirroring EsignDeliveryWorker — no BullMQ,
// Redis, or @nestjs/schedule): Redis/BullMQ being down does NOT affect the
// Talent Intake AWS path. Restart + MULTI-REPLICA safety come from the
// lease-safe FOR UPDATE SKIP LOCKED claim in the repository, NOT an app-memory
// singleton — so concurrent ticks across API replicas are benign. The in-process
// overlap latch only prevents a slow drain running twice within ONE process. The
// drain calls drainOnce() ONLY; there is no fallback to BullMQ/structured-log on
// an EventBridge failure (the lease model keeps rows retryable or quarantines
// them). Disabled with TALENT_INTAKE_DRAIN_ENABLED=0.
@Injectable()
export class TalentIntakeOutboxDrainWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly drain: LeaseSafeOutboxDrainService,
    @Inject('TalentIntakeOutboxDrainWorkerLogger')
    private readonly logger: AramoLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['TALENT_INTAKE_DRAIN_ENABLED'] === '0') return;
    const intervalMs = Number(process.env['TALENT_INTAKE_DRAIN_INTERVAL_MS'] ?? '15000');
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Do not hold the event loop open on the timer alone (tests/shutdown).
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One drain tick. Public so tests can drive it deterministically.
  async tick(): Promise<void> {
    if (this.draining || this.stopped) return; // in-process overlap guard
    this.draining = true;
    try {
      const outcome = await this.drain.drainOnce();
      if (outcome.claimed > 0) {
        this.logger.log({
          event: 'talent_intake_outbox_drain_tick',
          claimed: outcome.claimed,
          published: outcome.published,
          failed: outcome.failed,
          quarantined: outcome.quarantined,
        });
      }
    } catch (err) {
      this.logger.warn({
        event: 'talent_intake_outbox_drain_tick_failed',
        reason: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      this.draining = false;
    }
  }
}
