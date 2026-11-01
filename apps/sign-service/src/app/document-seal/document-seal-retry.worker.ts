import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DocumentSealService } from '@aramo/sign';

// Feature-Parity Directive v1.0 §1.15 — the document seal retry job. Same plain interval
// pattern as the other sign-service workers (no scheduler, Redis or BullMQ). Scheduled
// only when the seal is enabled (a provider is bound: SIGN_SEAL_PROVIDER set and
// `sign.document_seal` AVAILABLE). SIGN_SEAL_RETRY_INTERVAL_MS sets the tick (default
// 300000 = 5 minutes, minimum 60000). A `busy` latch stops a slow run overlapping
// itself; across processes the PENDING-only conditional update keeps two runs from
// recording the same seal twice.

export const SEAL_RETRY_DEFAULT_INTERVAL_MS = 300_000;
export const SEAL_RETRY_MIN_INTERVAL_MS = 60_000;

export function sealRetryIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['SIGN_SEAL_RETRY_INTERVAL_MS'] ?? SEAL_RETRY_DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= SEAL_RETRY_MIN_INTERVAL_MS ? raw : SEAL_RETRY_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class DocumentSealRetryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('DocumentSealRetryWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(private readonly sealer: DocumentSealService) {}

  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!this.sealer.enabled) return;
    this.timer = setInterval(() => void this.tick(), sealRetryIntervalMs(process.env));
    this.timer.unref?.();
    this.logger.log('document seal retry enabled');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const r = await this.sealer.retryDue();
      if (r.attempted > 0) this.logger.log(`document_seal.retry attempted=${r.attempted} sealed=${r.sealed}`);
    } catch (err) {
      this.logger.warn(`document_seal.retry_failed error=${(err as Error).name}`);
    } finally {
      this.busy = false;
    }
  }
}
