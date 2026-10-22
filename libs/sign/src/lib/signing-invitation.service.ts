import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { signBaseUrl } from './sign-base-url.js';
import { generateSigningToken, signingSessionExpiresAt } from './signing-token.js';
import { SIGNING_NOTIFICATION_PORT, type SigningNotificationPort } from './ports/signing-notification.port.js';

// Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED §4 — delivery of the next signer's
// invitation in a SEQUENTIAL envelope.
//
// completeSigner records the invitation as a durable intent (NotificationDelivery,
// SIGNATURE_REQUEST, PENDING) in the SAME transaction that completes the previous
// signer. This service turns an intent into a live link and an email:
//
//   1. claim    — compare-and-set to DISPATCHING (attempts+1, claimed_at). Only one
//                 dispatcher wins an intent; a stale claim (a crash between claim and
//                 delivery) becomes reclaimable after STALE_CLAIM_MS.
//   2. issue    — under the envelope row lock: the envelope must still be signable
//                 and the signer still the one whose turn it is; any earlier link of
//                 that signer is revoked and exactly one new session is minted. A
//                 terminal envelope (declined / voided / expired) or a signer who is
//                 no longer current CANCELS the intent — the sequence ends.
//   3. deliver  — the email is sent AFTER that transaction commits (never inside it);
//                 SENT on success, FAILED (retryable, up to MAX_ATTEMPTS) otherwise.
//
// Delivery is at-least-once: a crash after the email but before it is marked SENT
// re-sends it on retry, and the re-issued link revokes the earlier one, so exactly
// one link works. Raw tokens and links are never logged.
//
// Only intents this flow created are retried (claimed_at is set once claimed); the
// first invitations of a send keep their existing record-only behaviour.

const STALE_CLAIM_MS = 5 * 60_000;
export const SIGNING_INVITATION_MAX_ATTEMPTS = 10;

type Intent = { id: string; tenant_id: string; envelope_id: string; signer_id: string | null; status: string; attempts: number };

@Injectable()
export class SigningInvitationService {
  private readonly logger = new Logger(SigningInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    @Optional() @Inject(SIGNING_NOTIFICATION_PORT) private readonly notifier?: SigningNotificationPort,
  ) {}

  // Delivers open invitation intents (optionally for one envelope). Returns how many
  // were SENT by this call. Safe to run concurrently from several processes.
  async dispatch(filter: { tenant_id?: string; envelope_id?: string } = {}, now: Date = new Date(), limit = 50): Promise<number> {
    const intents = await this.prisma.notificationDelivery.findMany({
      where: {
        ...filter,
        notification_kind: 'SIGNATURE_REQUEST',
        OR: [
          { status: 'PENDING' },
          { status: 'FAILED', claimed_at: { not: null }, attempts: { lt: SIGNING_INVITATION_MAX_ATTEMPTS } },
          { status: 'DISPATCHING', claimed_at: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: { id: true, tenant_id: true, envelope_id: true, signer_id: true, status: true, attempts: true },
    });
    let sent = 0;
    for (const intent of intents) {
      try {
        if (await this.deliverOne(intent, now)) sent += 1;
      } catch (err) {
        this.logger.warn(`invitation ${intent.id} failed: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  private async deliverOne(intent: Intent, now: Date): Promise<boolean> {
    // 1. claim
    const claimed = await this.prisma.notificationDelivery.updateMany({
      where: { id: intent.id, status: intent.status, attempts: intent.attempts },
      data: { status: 'DISPATCHING', claimed_at: now, attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return false;

    // 2. issue the link under the envelope row lock
    const issued = await this.prisma.$transaction(async (tx) => {
      const status = await this.repo.lockEnvelope(tx, intent.tenant_id, intent.envelope_id);
      if (status !== 'SENT' && status !== 'IN_PROGRESS') return { kind: 'cancel', reason: `envelope ${status}` } as const;
      if (intent.signer_id === null) return { kind: 'cancel', reason: 'no signer' } as const;
      const signer = await tx.signer.findFirst({
        where: { id: intent.signer_id, tenant_id: intent.tenant_id, envelope_id: intent.envelope_id },
        select: { id: true, name: true, email: true, status: true },
      });
      if (signer === null || (signer.status !== 'PENDING' && signer.status !== 'VIEWED')) return { kind: 'cancel', reason: 'signer no longer awaiting' } as const;
      const env = await tx.signatureEnvelope.findFirstOrThrow({ where: { id: intent.envelope_id, tenant_id: intent.tenant_id }, select: { routing_mode: true, subject: true } });
      if (env.routing_mode === 'SEQUENTIAL') {
        const current = await tx.signer.findFirst({
          where: { tenant_id: intent.tenant_id, envelope_id: intent.envelope_id, status: { not: 'SIGNED' } },
          orderBy: { signing_order: 'asc' },
          select: { id: true },
        });
        if (current?.id !== signer.id) return { kind: 'cancel', reason: 'not this signer’s turn' } as const;
      }
      await tx.signingSession.updateMany({
        where: { tenant_id: intent.tenant_id, envelope_id: intent.envelope_id, signer_id: signer.id, status: { in: ['ISSUED', 'EXCHANGED', 'ACTIVE'] } },
        data: { status: 'REVOKED', revoked_at: now },
      });
      const tok = generateSigningToken();
      await tx.signingSession.create({
        data: {
          id: randomUUID(),
          tenant_id: intent.tenant_id,
          envelope_id: intent.envelope_id,
          signer_id: signer.id,
          token_hash: tok.hash,
          status: 'ISSUED',
          expires_at: signingSessionExpiresAt(now),
        },
      });
      return { kind: 'issued', raw: tok.raw, signer, subject: env.subject } as const;
    });
    if (issued.kind === 'cancel') {
      await this.prisma.notificationDelivery.update({ where: { id: intent.id }, data: { status: 'CANCELLED', last_error: issued.reason.slice(0, 500) } });
      return false;
    }

    // 3. deliver after commit
    const base = signBaseUrl();
    if (this.notifier === undefined || base === null) {
      await this.fail(intent.id, 'no delivery channel (notifier or Sign base URL unset)');
      return false;
    }
    try {
      const result = await this.notifier.notify({
        kind: 'SIGNATURE_REQUEST',
        to_email: issued.signer.email,
        to_name: issued.signer.name,
        envelope_subject: issued.subject,
        tenant_id: intent.tenant_id,
        signing_url: `${base}/s/${issued.raw}`,
      });
      if (!result.delivered) {
        await this.fail(intent.id, 'provider reported not delivered');
        return false;
      }
      await this.prisma.notificationDelivery.update({ where: { id: intent.id }, data: { status: 'SENT', sent_at: new Date(), last_error: null } });
      return true;
    } catch (err) {
      await this.fail(intent.id, (err as Error).message);
      return false;
    }
  }

  private async fail(id: string, error: string): Promise<void> {
    await this.prisma.notificationDelivery.update({ where: { id }, data: { status: 'FAILED', last_error: error.slice(0, 500) } });
  }
}
