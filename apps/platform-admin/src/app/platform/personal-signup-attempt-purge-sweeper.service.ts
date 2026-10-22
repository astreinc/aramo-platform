import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { PersonalSignupRepository, PERSONAL_ABANDONED_PURGE_DAYS, PERSONAL_REFUSED_RETENTION_DAYS } from '@aramo/identity';

// Personal signup-attempt cleanup (PO decision 2026-10-22; Lead ruling 2026-10-22:
// "guarded expiry cleanup for unbound or refused signup attempts without destroying
// retained security evidence"). Each run applies two guarded rules
// (PersonalSignupRepository.purgeExpiredAttempts):
//   (a) abandoned attempts (PENDING / EMAIL_VERIFIED / FAILED, no tenant, never
//       accepted) are deleted 3 days after the attempt expired;
//   (b) refused attempts (security evidence) are kept 180 days, then deleted.
// PROVISIONING / PROVISIONED / LAPSED attempts, tenants and users are never touched.
// Unlike the 7-day unbound lapse (opt-in: it soft-disables real tenants), this sweep
// is ON by default. SIGN_PERSONAL_SIGNUP_PURGE_ENABLED=0 switches it off;
// SIGN_PERSONAL_SIGNUP_PURGE_INTERVAL_MS tunes it (default once a day, PO 2026-10-22).
// Each run deletes everything that reaches its deadline before the NEXT run (the
// interval is passed as early_ms), so a record is gone between (deadline − interval)
// and its deadline — never later than the Privacy Notice promises. It also runs once
// shortly after start, so a restart (deploy) can never stretch the gap past one
// interval. Safe with more than one process: each rule is one idempotent DELETE.
//
// Every run logs ONE structured line (also when nothing was deleted, so the monitor
// sees the sweep is alive):
//   {"event":"personal_signup_attempt_purge","abandoned":a,"refused":r,
//    "abandoned_cutoff":"<iso>","refused_cutoff":"<iso>"}
// and, when anything was deleted, the repository writes one GLOBAL identity audit
// event (identity.personal.signup.attempts_purged) in the same transaction. Counts
// only — never an email, phone or address.
export const PERSONAL_SIGNUP_PURGE_DEFAULT_INTERVAL_MS = 86_400_000;
/** First run after start (lets the app finish booting). */
export const PERSONAL_SIGNUP_PURGE_STARTUP_DELAY_MS = 60_000;
export const PERSONAL_SIGNUP_PURGE_EVENT = 'personal_signup_attempt_purge';

export function personalSignupPurgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_PERSONAL_SIGNUP_PURGE_ENABLED'] !== '0';
}

export function personalSignupPurgeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SIGN_PERSONAL_SIGNUP_PURGE_INTERVAL_MS'] ?? PERSONAL_SIGNUP_PURGE_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : PERSONAL_SIGNUP_PURGE_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class PersonalSignupAttemptPurgeSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PersonalSignupAttemptPurgeSweeper');
  private timer?: NodeJS.Timeout;
  private startup?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly signups: PersonalSignupRepository) {}

  onApplicationBootstrap(): void {
    if (!personalSignupPurgeEnabled()) {
      this.logger.log(JSON.stringify({ event: PERSONAL_SIGNUP_PURGE_EVENT, enabled: false }));
      return;
    }
    this.timer = setInterval(() => void this.tick(), personalSignupPurgeIntervalMs());
    this.timer.unref?.();
    this.startup = setTimeout(() => void this.tick(), PERSONAL_SIGNUP_PURGE_STARTUP_DELAY_MS);
    this.startup.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.startup !== undefined) {
      clearTimeout(this.startup);
      this.startup = undefined;
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One sweep (public so tests can drive it). Returns how many attempts were deleted in total (-1 on failure). */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const r = await this.signups.purgeExpiredAttempts(now, {
        abandoned_days: PERSONAL_ABANDONED_PURGE_DAYS,
        refused_days: PERSONAL_REFUSED_RETENTION_DAYS,
        early_ms: personalSignupPurgeIntervalMs(),
      });
      this.logger.log(
        JSON.stringify({
          event: PERSONAL_SIGNUP_PURGE_EVENT,
          abandoned: r.abandoned,
          refused: r.refused,
          abandoned_cutoff: r.abandoned_cutoff.toISOString(),
          refused_cutoff: r.refused_cutoff.toISOString(),
        }),
      );
      return r.abandoned + r.refused;
    } catch (err) {
      this.logger.warn(JSON.stringify({ event: PERSONAL_SIGNUP_PURGE_EVENT, failed: true, error: (err as Error).message }));
      return -1;
    } finally {
      this.running = false;
    }
  }
}
