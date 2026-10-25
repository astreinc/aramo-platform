import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { NotificationFanoutService } from './notification-fanout.service.js';
import { PushDeliveryService } from './push-delivery.service.js';

// Aramo Sign Mobile — the notification worker (directive §8, B-4). The same plain
// interval pattern as the other sign-service workers (no scheduler, Redis or
// BullMQ): each tick drains the notification outbox into feed rows and push jobs,
// then delivers due push jobs. A `busy` latch stops a slow tick from overlapping
// itself; across processes the row leases keep work single-claimed.
// SIGN_NOTIFICATION_WORKER_ENABLED=0 disables it; SIGN_NOTIFICATION_INTERVAL_MS
// sets the tick (default 5000).
@Injectable()
export class NotificationPushWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('NotificationPushWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly fanout: NotificationFanoutService,
    private readonly delivery: PushDeliveryService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['SIGN_NOTIFICATION_WORKER_ENABLED'] === '0') return;
    const raw = Number(process.env['SIGN_NOTIFICATION_INTERVAL_MS'] ?? '5000');
    const intervalMs = Number.isFinite(raw) && raw >= 500 ? raw : 5000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One tick. Public so tests drive it deterministically.
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.fanout.processDueBatch();
      await this.delivery.deliverDueBatch();
    } catch (err) {
      this.logger.warn(`notification tick failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
