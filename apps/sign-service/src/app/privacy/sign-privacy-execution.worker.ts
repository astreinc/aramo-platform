import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PrivacyRequestService, privacyDeletionExecutionEnabled, privacyExecutionNextAttemptAt } from '@aramo/identity';

import { SignPrivacyExecutionService } from './sign-privacy-execution.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 — executes Aramo Sign DELETION requests the
// privacy team moved to EXECUTING (and retries a self-service execution that failed
// part-way; every step is idempotent). The plain interval pattern of the other
// sign-service workers. OFF unless SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1
// (production enablement needs a separate authorization). One request at a time;
// a `busy` latch stops a slow run from overlapping itself.
//
// PRIV-ADMIN-1 OD-4 — bounded retry: a request that failed waits its back-off (1, 5, 15,
// 60 minutes after failure 1..4) before the next attempt; the execution service returns
// it to DATA_INVENTORY after the 5th failure. A failure stamps updated_at, so the queue
// (updated_at ascending) serves requests that have not failed first, and a request in
// back-off is skipped without taking a slot of the batch (no starvation).

export const PRIVACY_EXECUTION_INTERVAL_MS = 60_000;
/** Requests attempted per run. */
export const PRIVACY_EXECUTION_BATCH = 10;
/** Requests read per run (those in back-off are skipped). */
export const PRIVACY_EXECUTION_SCAN = 100;

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

  /**
   * One run (public so tests drive it; `now` is injectable so a test that pins time
   * drives the back-off with the same clock). Returns the number of requests handled.
   */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.busy || this.stopped || !privacyDeletionExecutionEnabled(process.env)) return 0;
    this.busy = true;
    let handled = 0;
    try {
      const due = (await this.requests.listExecuting('SIGN', PRIVACY_EXECUTION_SCAN)).filter((r) => r.request_type === 'DELETION');
      const attempts = await this.requests.executionAttempts(due.map((r) => r.id));
      let tried = 0;
      for (const r of due) {
        if (tried >= PRIVACY_EXECUTION_BATCH) break;
        const a = attempts.get(r.id);
        const next = a === undefined ? null : privacyExecutionNextAttemptAt(a.attempts, a.last_failure_at);
        if (next !== null && next.getTime() > now.getTime()) continue;
        tried += 1;
        try {
          await this.execution.execute(r.id, now);
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
