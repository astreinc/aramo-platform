import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EXECUTED_ARTIFACT_CUSTODY_PORT } from '@aramo/sign';

import { ExecutedArtifactCustodyService } from './executed-artifact-custody.service.js';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 item 7 —
// the custody reconcile job. Same plain interval pattern as the other sign-service
// workers (no scheduler, Redis or BullMQ). Gated by the same enablement as the custody
// upload: it runs only when SIGN_ARTIFACT_BUCKET is set. SIGN_ARTIFACT_RECONCILE_INTERVAL_MS
// sets the tick (default 600000 = 10 minutes, minimum 60000). A `busy` latch stops a slow
// run overlapping itself; across processes the NULL-only custody update keeps two runs
// from recording the same artifact twice.

export const CUSTODY_RECONCILE_DEFAULT_INTERVAL_MS = 600_000;
export const CUSTODY_RECONCILE_MIN_INTERVAL_MS = 60_000;

export function custodyReconcileIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['SIGN_ARTIFACT_RECONCILE_INTERVAL_MS'] ?? CUSTODY_RECONCILE_DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= CUSTODY_RECONCILE_MIN_INTERVAL_MS ? raw : CUSTODY_RECONCILE_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class SignArtifactReconcileWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SignArtifactReconcileWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(@Inject(EXECUTED_ARTIFACT_CUSTODY_PORT) private readonly custody: ExecutedArtifactCustodyService) {}

  /** True once the interval is scheduled (only when the Sign bucket is configured). */
  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!this.custody.enabled) return;
    this.timer = setInterval(() => void this.tick(), custodyReconcileIntervalMs(process.env));
    this.timer.unref?.();
    this.logger.log('artifact custody reconcile enabled');
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
      await this.custody.reconcile();
    } catch (err) {
      this.logger.warn(`sign_artifact_custody.reconcile_failed error=${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
