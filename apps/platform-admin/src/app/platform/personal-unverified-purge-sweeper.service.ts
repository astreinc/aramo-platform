import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { PersonalSignupRepository, PERSONAL_UNVERIFIED_PURGE_DAYS } from '@aramo/identity';

// PO decision 2026-10-22 — a Personal signup request whose email was never verified
// (PENDING / REFUSED) is DELETED 3 days after it was created; the Privacy Notice
// promises it. Unlike the 7-day unbound lapse (opt-in: it soft-disables real
// tenants), this sweep is ON by default: it only removes requests that can no
// longer be verified (their 24 h code window has passed) and touches no tenant,
// user or verified request. SIGN_PERSONAL_UNVERIFIED_PURGE_ENABLED=0 switches it
// off; SIGN_PERSONAL_UNVERIFIED_PURGE_INTERVAL_MS tunes it (default 1 hour). Safe
// with more than one process: the purge is one idempotent DELETE.
//
// Every run logs ONE structured line (also when nothing was deleted, so the
// monitor sees the sweep is alive):
//   {"event":"personal_unverified_signup_purge","deleted":n,"cutoff":"<iso>"}
// and, when n > 0, the repository writes one GLOBAL identity audit event in the
// same transaction. Counts only — never an email, phone or address.
export const PERSONAL_UNVERIFIED_PURGE_DEFAULT_INTERVAL_MS = 3_600_000;
export const PERSONAL_UNVERIFIED_PURGE_EVENT = 'personal_unverified_signup_purge';

export function personalUnverifiedPurgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_PERSONAL_UNVERIFIED_PURGE_ENABLED'] !== '0';
}

export function personalUnverifiedPurgeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SIGN_PERSONAL_UNVERIFIED_PURGE_INTERVAL_MS'] ?? PERSONAL_UNVERIFIED_PURGE_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : PERSONAL_UNVERIFIED_PURGE_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class PersonalUnverifiedPurgeSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PersonalUnverifiedPurgeSweeper');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly signups: PersonalSignupRepository) {}

  onApplicationBootstrap(): void {
    if (!personalUnverifiedPurgeEnabled()) {
      this.logger.log(JSON.stringify({ event: PERSONAL_UNVERIFIED_PURGE_EVENT, enabled: false }));
      return;
    }
    this.timer = setInterval(() => void this.tick(), personalUnverifiedPurgeIntervalMs());
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One sweep (public so tests can drive it). Returns how many requests were deleted (-1 on failure). */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const { deleted, cutoff } = await this.signups.purgeUnverified(now, PERSONAL_UNVERIFIED_PURGE_DAYS);
      this.logger.log(JSON.stringify({ event: PERSONAL_UNVERIFIED_PURGE_EVENT, deleted, cutoff: cutoff.toISOString() }));
      return deleted;
    } catch (err) {
      this.logger.warn(JSON.stringify({ event: PERSONAL_UNVERIFIED_PURGE_EVENT, failed: true, error: (err as Error).message }));
      return -1;
    } finally {
      this.running = false;
    }
  }
}
