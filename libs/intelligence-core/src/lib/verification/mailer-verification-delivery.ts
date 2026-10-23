import { Logger, Module } from '@nestjs/common';
import { MAILER_PORT, MailerModule, type MailerPort } from '@aramo/mailer';

import {
  LogVerificationDeliveryAdapter,
  VERIFICATION_DELIVERY_PORT,
  maskDestination,
  type VerificationDeliveryPort,
  type VerificationDeliveryResult,
  type VerificationMessage,
} from './verification-delivery.js';

// ATI-SEP-1 T8 — the REAL verification delivery adapter: the talent's email
// one-time code goes out through @aramo/mailer (scope:shared — SES in
// production, the stub locally), so TI owns delivery end to end. SMS stays
// NOT_AVAILABLE (on hold).
//
// Binding (VerificationDeliveryModule): when MAILER_PROVIDER is set in the TI
// process, MailerModule is imported and this adapter is bound to
// VERIFICATION_DELIVERY_PORT; otherwise the LOG adapter is (no mail is sent).
// A mis-set mailer (e.g. ses without SES_FROM_ADDRESS) fails LOUD at boot — the
// MailerModule contract — never a silently degraded sender.
//
// The code is placed only in the message body handed to the mailer. It is
// never logged (the log line carries the verification id + a masked address).
// A mailer failure is TRANSIENT (RETRY): the outbox drain retries with backoff.

export const MAILER_PROVIDER_ENV = 'MAILER_PROVIDER';

export function renderVerificationCodeEmail(message: Pick<VerificationMessage, 'code' | 'expires_at'>): { subject: string; html: string; text: string } {
  const minutes = Math.max(1, Math.round((message.expires_at.getTime() - Date.now()) / 60_000));
  const code = message.code.replace(/[^0-9]/g, '');
  const text =
    `Your Aramo verification code is ${code}.\n\n` +
    `Enter it where you asked to verify this email address. It expires in about ${minutes} minutes.\n\n` +
    `If you did not ask for this code, you can ignore this email.`;
  const html =
    `<p>Your Aramo verification code is:</p>` +
    `<p style="font-size:24px;font-weight:600;letter-spacing:4px">${code}</p>` +
    `<p>Enter it where you asked to verify this email address. It expires in about ${minutes} minutes.</p>` +
    `<p>If you did not ask for this code, you can ignore this email.</p>`;
  return { subject: 'Your Aramo verification code', html, text };
}

export class MailerVerificationDeliveryAdapter implements VerificationDeliveryPort {
  private readonly logger = new Logger('VerificationDelivery');

  constructor(private readonly mailer: MailerPort) {}

  isAvailable(channel: VerificationMessage['channel']): boolean {
    return channel === 'EMAIL';
  }

  async deliver(message: VerificationMessage): Promise<VerificationDeliveryResult> {
    if (!this.isAvailable(message.channel)) return { status: 'NOT_AVAILABLE' };
    const rendered = renderVerificationCodeEmail(message);
    try {
      await this.mailer.send({ to: message.destination, subject: rendered.subject, html: rendered.html, text: rendered.text });
    } catch (err) {
      this.logger.warn(`verification ${message.verification_id}: mail to ${maskDestination(message.destination)} failed (${(err as Error).name})`);
      return { status: 'RETRY', error: 'MAILER_FAILED' };
    }
    this.logger.log(`verification ${message.verification_id}: ${message.channel} code sent to ${maskDestination(message.destination)}`);
    return { status: 'SENT' };
  }
}

export function mailerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[MAILER_PROVIDER_ENV] ?? '').trim().length > 0;
}

/** The bound adapter: the mailer one when a MailerPort is available, else the LOG one. */
export function selectVerificationDelivery(mailer: MailerPort | undefined | null): VerificationDeliveryPort {
  return mailer ? new MailerVerificationDeliveryAdapter(mailer) : new LogVerificationDeliveryAdapter();
}

// Evaluated once, at module load (the TI process env): import MailerModule only
// when a mailer is configured, so an unset MAILER_PROVIDER never trips the
// MailerModule fail-loud factory and the LOG adapter is bound instead.
@Module({
  imports: mailerConfigured() ? [MailerModule] : [],
  providers: [
    {
      provide: VERIFICATION_DELIVERY_PORT,
      useFactory: (mailer?: MailerPort) => selectVerificationDelivery(mailer),
      inject: [{ token: MAILER_PORT, optional: true }],
    },
  ],
  exports: [VERIFICATION_DELIVERY_PORT],
})
export class VerificationDeliveryModule {}
