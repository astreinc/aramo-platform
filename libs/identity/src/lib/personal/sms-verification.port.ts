import { Logger } from '@nestjs/common';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.3 — phone
// verification delivery. Aramo generates and hashes the code (personal-otp.ts);
// the port only delivers a text. Adapters: `log` (dev / test; records), `disabled`
// (the production default — configured=false, so the signup reports that phone
// verification is unavailable and a step-up account stays blocked). Real
// providers come later, selected with SIGN_SMS_PROVIDER. Phone numbers are used
// for verification and security only, never marketing.

export const SMS_VERIFICATION_PORT = Symbol('SMS_VERIFICATION_PORT');

export interface SmsVerificationPort {
  readonly configured: boolean;
  send(e164: string, text: string): Promise<{ ok: boolean; ref: string | null }>;
}

export class DisabledSmsAdapter implements SmsVerificationPort {
  readonly configured = false;
  async send(): Promise<{ ok: boolean; ref: string | null }> {
    return { ok: false, ref: null };
  }
}

export class LogSmsAdapter implements SmsVerificationPort {
  readonly configured = true;
  private readonly logger = new Logger('LogSmsAdapter');
  readonly sent: { to: string; text: string; at: Date }[] = [];
  private n = 0;

  async send(e164: string, text: string): Promise<{ ok: boolean; ref: string | null }> {
    this.sent.push({ to: e164, text, at: new Date() });
    this.n += 1;
    const masked = `${e164.slice(0, 3)}…${e164.slice(-2)}`;
    // The code is only written to the log outside production (dev convenience).
    this.logger.log(process.env['NODE_ENV'] === 'production' ? `sms to ${masked}` : `sms to ${masked}: ${text}`);
    return { ok: true, ref: `log-${this.n}` };
  }
}

/** SIGN_SMS_PROVIDER: 'log' → LogSmsAdapter; anything else (unset) → disabled. */
export function smsVerificationAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): SmsVerificationPort {
  return env['SIGN_SMS_PROVIDER']?.trim().toLowerCase() === 'log' ? new LogSmsAdapter() : new DisabledSmsAdapter();
}
