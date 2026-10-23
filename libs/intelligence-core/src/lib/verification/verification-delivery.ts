import { Injectable, Logger } from '@nestjs/common';
import type { VerificationChannel } from '@aramo/intelligence-contracts';

// ATI-SEP-1 T4 — the verification DELIVERY PORT. TI decides what to send and
// when (outbox 'identifier_verification.requested' → the drain); an adapter
// decides how. The interface is mailer-agnostic: an SMTP / SES / provider
// adapter implements it and is bound to VERIFICATION_DELIVERY_PORT by the
// composition root. Real mailer wiring is the deployer's concern — the default
// adapter below only LOGS (masked destination, never the code) and reports SMS
// as NOT_AVAILABLE (SMS is on hold).

export const VERIFICATION_DELIVERY_PORT = Symbol('VERIFICATION_DELIVERY_PORT');

export interface VerificationMessage {
  verification_id: string;
  channel: VerificationChannel;
  /** Normalized email address or E.164-ish phone number. */
  destination: string;
  /** The one-time code — an adapter must never log or persist it. */
  code: string;
  expires_at: Date;
}

export type VerificationDeliveryResult =
  | { status: 'SENT' }
  /** The channel cannot deliver at all (non-retryable). */
  | { status: 'NOT_AVAILABLE' }
  /** A transient failure: the drain retries with backoff. */
  | { status: 'RETRY'; error: string };

export interface VerificationDeliveryPort {
  /** Synchronous capability check (used to tell the caller up front). */
  isAvailable(channel: VerificationChannel): boolean;
  deliver(message: VerificationMessage): Promise<VerificationDeliveryResult>;
}

export function maskDestination(destination: string): string {
  const at = destination.indexOf('@');
  if (at > 0) return `${destination[0]}***${destination.slice(at)}`;
  return destination.length > 4 ? `***${destination.slice(-2)}` : '***';
}

/** Default adapter: EMAIL → logged (no code), SMS → NOT_AVAILABLE. */
@Injectable()
export class LogVerificationDeliveryAdapter implements VerificationDeliveryPort {
  private readonly logger = new Logger('VerificationDelivery');

  isAvailable(channel: VerificationChannel): boolean {
    return channel === 'EMAIL';
  }

  async deliver(message: VerificationMessage): Promise<VerificationDeliveryResult> {
    if (!this.isAvailable(message.channel)) return { status: 'NOT_AVAILABLE' };
    this.logger.log(
      `verification ${message.verification_id}: ${message.channel} code issued to ${maskDestination(message.destination)} ` +
        `(LOG adapter — no mail is sent; bind a real adapter to VERIFICATION_DELIVERY_PORT)`,
    );
    return { status: 'SENT' };
  }
}
