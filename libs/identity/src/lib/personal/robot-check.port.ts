import { Logger } from '@nestjs/common';

import type { RobotVerdict } from './personal-risk-rating.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.1 — the robot check
// (Cloudflare Turnstile), verified server-side on `start`. 'unavailable' (no
// secret, provider unreachable) is refused by the signup — fail closed — unless
// SIGN_TURNSTILE_MODE=test (tests / local development only), where every token
// passes.

export const ROBOT_CHECK_PORT = Symbol('ROBOT_CHECK_PORT');

export interface RobotCheckPort {
  verify(token: string | null, ip: string): Promise<{ verdict: RobotVerdict }>;
}

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export class DisabledRobotCheck implements RobotCheckPort {
  async verify(): Promise<{ verdict: RobotVerdict }> {
    return { verdict: 'unavailable' };
  }
}

export class TestModeRobotCheck implements RobotCheckPort {
  async verify(): Promise<{ verdict: RobotVerdict }> {
    return { verdict: 'pass' };
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export class TurnstileRobotCheckAdapter implements RobotCheckPort {
  private readonly logger = new Logger('TurnstileRobotCheck');

  constructor(
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 5000,
  ) {}

  async verify(token: string | null, ip: string): Promise<{ verdict: RobotVerdict }> {
    if (token === null || token.trim() === '' || token.length > 4096) return { verdict: 'fail' };
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (ip !== '' && ip !== 'unknown') body.set('remoteip', ip);
    try {
      const res = await this.fetchImpl(TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { verdict: 'unavailable' };
      const out = (await res.json()) as { success?: unknown; 'error-codes'?: unknown };
      if (out.success === true) return { verdict: 'pass' };
      const codes = Array.isArray(out['error-codes']) ? (out['error-codes'] as unknown[]).map(String) : [];
      // A misconfigured secret is our problem, not the person's: unavailable (fail closed).
      if (codes.some((c) => c === 'missing-input-secret' || c === 'invalid-input-secret' || c === 'internal-error')) {
        this.logger.warn(`turnstile verification unavailable: ${codes.join(',')}`);
        return { verdict: 'unavailable' };
      }
      return { verdict: 'fail' };
    } catch (err) {
      this.logger.warn(`turnstile verification unavailable: ${(err as Error).message}`);
      return { verdict: 'unavailable' };
    }
  }
}

/** SIGN_TURNSTILE_MODE=test → always pass; SIGN_TURNSTILE_SECRET set → Turnstile; else disabled. */
export function robotCheckAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): RobotCheckPort {
  if (env['SIGN_TURNSTILE_MODE']?.trim().toLowerCase() === 'test') return new TestModeRobotCheck();
  const secret = env['SIGN_TURNSTILE_SECRET']?.trim();
  return secret === undefined || secret === '' ? new DisabledRobotCheck() : new TurnstileRobotCheckAdapter(secret);
}
