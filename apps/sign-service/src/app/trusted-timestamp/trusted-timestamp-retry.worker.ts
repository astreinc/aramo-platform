import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { TrustedTimestampService } from '@aramo/sign';

// Feature-Parity Directive v1.0 §1.18 — the "timestamp pending" retry job. Same shape as
// EsignExpiryWorker: a plain interval started on bootstrap and cleared on shutdown, with
// an overlap latch. Each tick re-requests PENDING timestamps whose backoff has elapsed
// (30 s, 2 min, 10 min, then every 30 min). Runs only while the feature is on (a TSA
// adapter is bound); interval SIGN_TSA_RETRY_INTERVAL_MS (default 60000, minimum 10000).
@Injectable()
export class TrustedTimestampRetryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('TrustedTimestampRetryWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly timestamps: TrustedTimestampService) {}

  onApplicationBootstrap(): void {
    if (!this.timestamps.enabled) return;
    const configured = Number(process.env['SIGN_TSA_RETRY_INTERVAL_MS'] ?? '60000');
    const intervalMs = Number.isFinite(configured) ? Math.max(10_000, configured) : 60_000;
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

  // One sweep. Public so tests can drive it. Returns how many timestamps were granted.
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const granted = await this.timestamps.retryDue(now);
      if (granted > 0) this.logger.log(`granted ${granted} pending trusted timestamp(s)`);
      return granted;
    } catch (err) {
      this.logger.warn(`trusted timestamp retry tick failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
