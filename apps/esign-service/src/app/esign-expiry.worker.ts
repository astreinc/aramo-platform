import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { ENVELOPE_NOTIFICATION_SERVICE, EnvelopeNotificationService, EsignService } from '@aramo/esign';

// Aramo Sign launch — the envelope expiry sweep. Same shape as EsignDeliveryWorker:
// a plain interval started on bootstrap and cleared on shutdown, with an overlap
// latch. Each tick moves overdue SENT / IN_PROGRESS envelopes to EXPIRED (a
// compare-and-set that also revokes their signing sessions) and then notifies the
// open signers and the console sender. Running more than one process is safe: the
// CAS lets exactly one expire a given envelope, and only that one notifies.
// Disabled with ESIGN_EXPIRY_WORKER_ENABLED=0; interval ESIGN_EXPIRY_INTERVAL_MS
// (default 5 minutes).
@Injectable()
export class EsignExpiryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('EsignExpiryWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly esign: EsignService,
    @Inject(ENVELOPE_NOTIFICATION_SERVICE) private readonly notifications: EnvelopeNotificationService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['ESIGN_EXPIRY_WORKER_ENABLED'] === '0') return;
    const intervalMs = Number(process.env['ESIGN_EXPIRY_INTERVAL_MS'] ?? '300000');
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

  // One sweep. Public so tests can drive it deterministically. Returns how many
  // envelopes this tick expired.
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const expired = await this.esign.expireDueEnvelopes(now);
      for (const e of expired) {
        try {
          await this.notifications.envelopeExpired(e.tenant_id, e.envelope_id);
        } catch (err) {
          this.logger.warn(`expiry notification failed for envelope ${e.envelope_id}: ${(err as Error).message}`);
        }
      }
      if (expired.length > 0) this.logger.log(`expired ${expired.length} envelope(s)`);
      return expired.length;
    } catch (err) {
      this.logger.warn(`expiry tick failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
