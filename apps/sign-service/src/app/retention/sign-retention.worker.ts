import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { SignRetentionService } from './sign-retention.service.js';

// Privacy Notice 1.1 remediation — the retention worker (E-1 to E-4). The same plain
// interval pattern as the other sign-service workers (no scheduler, Redis or BullMQ).
// OFF BY DEFAULT: it runs only when SIGN_RETENTION_WORKER_ENABLED=1. E-4 (processed
// notification outbox, finished push jobs) additionally needs
// SIGN_RETENTION_QUEUE_CLEANUP_ENABLED=1. SIGN_RETENTION_INTERVAL_MS sets the tick
// (default 3600000 = 1 hour, minimum 60000). Enabling it in production needs separate
// PO authorization. A `busy` latch stops a slow run from overlapping itself; across
// processes the repository's row locks keep runs from deleting the same rows twice.

export const RETENTION_DEFAULT_INTERVAL_MS = 3_600_000;
export const RETENTION_MIN_INTERVAL_MS = 60_000;

export function retentionWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['SIGN_RETENTION_WORKER_ENABLED'] === '1';
}

export function retentionQueueCleanupEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['SIGN_RETENTION_QUEUE_CLEANUP_ENABLED'] === '1';
}

export function retentionIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['SIGN_RETENTION_INTERVAL_MS'] ?? RETENTION_DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= RETENTION_MIN_INTERVAL_MS ? raw : RETENTION_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class SignRetentionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SignRetentionWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(private readonly retention: SignRetentionService) {}

  /** True once the interval is scheduled (only when enabled). */
  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!retentionWorkerEnabled(process.env)) return;
    this.timer = setInterval(() => void this.tick(), retentionIntervalMs(process.env));
    this.timer.unref?.();
    this.logger.log(`retention worker enabled (queue cleanup ${retentionQueueCleanupEnabled(process.env) ? 'on' : 'off'})`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One run. Public so tests drive it deterministically.
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.retention.run({ queues: retentionQueueCleanupEnabled(process.env) });
    } catch (err) {
      this.logger.warn(`retention run failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
