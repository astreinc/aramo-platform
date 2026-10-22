import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { PersonalSignupRepository, PERSONAL_UNBOUND_LAPSE_DAYS } from '@aramo/identity';

// Sign Personal (Free) Launch v1.1 (LOCKED) §3.6 — an unbound PROVISIONED Personal
// signup lapses after 7 days: the tenant is soft-disabled (nothing
// is deleted; audited). OFF unless SIGN_PERSONAL_LAPSE_SWEEP_ENABLED=1; interval
// SIGN_PERSONAL_LAPSE_SWEEP_INTERVAL_MS (default 1 hour). Same shape as the P3
// domain-claim sweeper; safe with more than one process (each lapse is a CAS
// inside its own transaction that re-checks the binding).
export const PERSONAL_LAPSE_SWEEP_DEFAULT_INTERVAL_MS = 3_600_000;

export function personalLapseSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SIGN_PERSONAL_LAPSE_SWEEP_INTERVAL_MS'] ?? PERSONAL_LAPSE_SWEEP_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : PERSONAL_LAPSE_SWEEP_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class PersonalLapseSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PersonalLapseSweeper');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly signups: PersonalSignupRepository) {}

  onApplicationBootstrap(): void {
    if (process.env['SIGN_PERSONAL_LAPSE_SWEEP_ENABLED'] !== '1') return;
    this.timer = setInterval(() => void this.tick(), personalLapseSweepIntervalMs());
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One sweep (public so tests can drive it). Returns how many signups lapsed. */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const n = await this.signups.lapseUnbound(now, PERSONAL_UNBOUND_LAPSE_DAYS);
      if (n > 0) this.logger.log(`lapsed ${n} unbound personal signup(s)`);
      return n;
    } catch (err) {
      this.logger.warn(`personal lapse sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
