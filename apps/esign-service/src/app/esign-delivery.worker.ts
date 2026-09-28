import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI
// token (emitted via decorator metadata) — a type-only import breaks resolution.
import { OutboxDeliveryService } from '@aramo/esign';

// E-Sign OC v2 (DEC-B) — lifecycle-managed outbound delivery worker. No
// @nestjs/schedule, Redis, or BullMQ: a plain interval started on bootstrap and
// cleared on shutdown, keeping esign-service small and independent.
//
// Overlap guard: a boolean `draining` latch ensures a slow drain never runs twice
// concurrently in one process. Clean shutdown: the timer is cleared and further
// ticks are refused. Restart safety across processes is provided by the outbox
// row lease in OutboxDeliveryService. Disabled with ESIGN_DELIVERY_WORKER_ENABLED=0.
@Injectable()
export class EsignDeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('EsignDeliveryWorker');
  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;

  constructor(private readonly delivery: OutboxDeliveryService) {}

  onApplicationBootstrap(): void {
    if (process.env['ESIGN_DELIVERY_WORKER_ENABLED'] === '0') return;
    const intervalMs = Number(process.env['ESIGN_DELIVERY_INTERVAL_MS'] ?? '15000');
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Do not hold the event loop open on account of the timer alone (tests/shutdown).
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One drain tick. Public so tests can drive it deterministically.
  async tick(): Promise<void> {
    if (this.draining || this.stopped) return; // overlap guard
    this.draining = true;
    try {
      await this.delivery.deliverDueBatch();
    } catch (err) {
      this.logger.warn(`delivery tick failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }
}
