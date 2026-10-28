import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PrivacyRequestService, privacyDeletionExecutionEnabled } from '@aramo/identity';

import { SignPrivacyExecutionService } from './sign-privacy-execution.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 — executes Aramo Sign DELETION requests the
// privacy team moved to EXECUTING (and retries a self-service execution that failed
// part-way; every step is idempotent). The plain interval pattern of the other
// sign-service workers. OFF unless SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1
// (production enablement needs a separate authorization). One request at a time;
// a `busy` latch stops a slow run from overlapping itself.

export const PRIVACY_EXECUTION_INTERVAL_MS = 60_000;

@Injectable()
export class SignPrivacyExecutionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SignPrivacyExecutionWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly requests: PrivacyRequestService,
    private readonly execution: SignPrivacyExecutionService,
  ) {}

  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!privacyDeletionExecutionEnabled(process.env)) return;
    this.timer = setInterval(() => void this.tick(), PRIVACY_EXECUTION_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log('privacy deletion execution worker enabled');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One run (public so tests drive it). Returns the number of requests handled. */
  async tick(): Promise<number> {
    if (this.busy || this.stopped || !privacyDeletionExecutionEnabled(process.env)) return 0;
    this.busy = true;
    let handled = 0;
    try {
      for (const r of await this.requests.listExecuting('SIGN', 10)) {
        if (r.request_type !== 'DELETION') continue;
        try {
          await this.execution.execute(r.id);
          handled += 1;
        } catch (err) {
          this.logger.warn(`privacy execution of ${r.reference} failed: ${(err as Error).name}`);
        }
      }
    } finally {
      this.busy = false;
    }
    return handled;
  }
}
