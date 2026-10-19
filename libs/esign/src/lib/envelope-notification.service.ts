import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { generateSigningToken } from './signing-token.js';
import {
  SIGNING_NOTIFICATION_PORT,
  type SigningNotification,
  type SigningNotificationPort,
} from './ports/signing-notification.port.js';
import { SENDER_DIRECTORY_PORT, type SenderDirectoryPort } from './ports/sender-directory.port.js';

// Aramo Sign launch (Aramo-Sign-Standalone-Product-Final-Implementation-Authorization-
// v1_0) — envelope lifecycle notifications.
//
//  - Every attempt is recorded in NotificationDelivery (SENT | FAILED + error);
//    a delivery failure is retryable and never corrupts the envelope.
//  - SIGNERS hear about completion (with a time-limited link to their signed copy),
//    void, decline by another signer, and expiry.
//  - The SENDER hears about completion, decline and expiry — only for envelopes
//    authored in the Sign console (OWNED source). ATS-originated envelopes
//    (CORE_REF) reach the recruiter through Core's own lifecycle handling, so ATS
//    behaviour is unchanged.
//  - Raw tokens and links are never logged.

export const ENVELOPE_NOTIFICATION_SERVICE = 'ENVELOPE_NOTIFICATION_SERVICE';
export const EXECUTED_ACCESS_TTL_DAYS_DEFAULT = 30;

type EnvelopeFull = Awaited<ReturnType<EsignRepository['getEnvelopeFull']>>;

function trimOrigin(v: string | undefined): string | null {
  return v === undefined || v.trim() === '' ? null : v.trim().replace(/\/+$/, '');
}

@Injectable()
export class EnvelopeNotificationService {
  private readonly logger = new Logger(EnvelopeNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    @Optional() @Inject(SIGNING_NOTIFICATION_PORT) private readonly notifier?: SigningNotificationPort,
    @Optional() @Inject(SENDER_DIRECTORY_PORT) private readonly senders?: SenderDirectoryPort,
  ) {}

  // ── Completion: each signer gets their signed copy; the sender is told. ──
  async envelopeCompleted(tenant_id: string, envelope_id: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const signWeb = trimOrigin(process.env['ESIGN_SIGN_WEB_BASE_URL']);
    for (const signer of env.signers) {
      let download_url: string | undefined;
      if (signWeb !== null) {
        const raw = await this.mintExecutedAccess(tenant_id, envelope_id, signer.id);
        download_url = `${signWeb}/d/${raw}`;
      }
      await this.deliver(tenant_id, envelope_id, signer.id, {
        kind: 'SIGNATURE_COMPLETED',
        to_email: signer.email,
        to_name: signer.name,
        envelope_subject: env.subject,
        download_url,
      });
    }
    await this.toSender(env, { kind: 'SIGNATURE_COMPLETED' });
  }

  // ── Decline: the sender gets the reason; other open signers learn it ended. ──
  async envelopeDeclined(tenant_id: string, envelope_id: string, declined_by_signer_id: string, reason: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const decliner = env.signers.find((s) => s.id === declined_by_signer_id);
    await this.toSender(env, { kind: 'SIGNATURE_DECLINED', reason: decliner ? `${decliner.name}: ${reason}` : reason });
    for (const signer of env.signers) {
      if (signer.id === declined_by_signer_id || signer.status === 'SIGNED') continue;
      await this.deliver(tenant_id, envelope_id, signer.id, {
        kind: 'SIGNATURE_DECLINED',
        to_email: signer.email,
        to_name: signer.name,
        envelope_subject: env.subject,
      });
    }
  }

  // ── Void: every signer who had not finished learns the request was withdrawn. ──
  async envelopeVoided(tenant_id: string, envelope_id: string, reason: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    for (const signer of env.signers) {
      if (signer.status === 'SIGNED' || signer.status === 'DECLINED') continue;
      await this.deliver(tenant_id, envelope_id, signer.id, {
        kind: 'SIGNATURE_VOIDED',
        to_email: signer.email,
        to_name: signer.name,
        envelope_subject: env.subject,
        reason,
      });
    }
  }

  // ── Expiry: open signers and the sender learn the signing window closed. ──
  async envelopeExpired(tenant_id: string, envelope_id: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    for (const signer of env.signers) {
      if (signer.status === 'SIGNED' || signer.status === 'DECLINED') continue;
      await this.deliver(tenant_id, envelope_id, signer.id, {
        kind: 'SIGNATURE_EXPIRED',
        to_email: signer.email,
        to_name: signer.name,
        envelope_subject: env.subject,
      });
    }
    await this.toSender(env, { kind: 'SIGNATURE_EXPIRED' });
  }

  // Record the outcome of an invitation/reminder dispatch done elsewhere.
  async recordDispatch(
    tenant_id: string,
    envelope_id: string,
    signer_id: string | null,
    kind: SigningNotification['kind'],
    outcome: { ok: true } | { ok: false; error: string },
  ): Promise<void> {
    await this.repo.recordNotificationDelivery({
      tenant_id,
      envelope_id,
      signer_id,
      notification_kind: kind,
      status: outcome.ok ? 'SENT' : 'FAILED',
      last_error: outcome.ok ? null : outcome.error.slice(0, 500),
    });
  }

  private async toSender(env: EnvelopeFull, n: Pick<SigningNotification, 'kind' | 'reason'>): Promise<void> {
    // Sender notifications are a Sign-console feature (OWNED documents only).
    if (!env.documents.some((d) => d.source_mode === 'OWNED')) return;
    if (this.senders === undefined) return;
    const sender = await this.senders.findSender(env.tenant_id, env.created_by);
    if (sender === null) return;
    const consoleWeb = trimOrigin(process.env['ESIGN_SENDER_WEB_BASE_URL']);
    await this.deliver(env.tenant_id, env.id, null, {
      ...n,
      audience: 'SENDER',
      to_email: sender.email,
      to_name: sender.name,
      envelope_subject: env.subject,
      console_url: consoleWeb === null ? undefined : `${consoleWeb}/sign/envelopes/${env.id}`,
    });
  }

  private async deliver(tenant_id: string, envelope_id: string, signer_id: string | null, n: SigningNotification): Promise<void> {
    if (this.notifier === undefined) return;
    try {
      const result = await this.notifier.notify(n);
      await this.recordDispatch(tenant_id, envelope_id, signer_id, n.kind, result.delivered ? { ok: true } : { ok: false, error: 'provider reported not delivered' });
    } catch (err) {
      const message = (err as Error).message ?? 'delivery failed';
      this.logger.warn(`${n.kind} (${n.audience ?? 'SIGNER'}) delivery failed — envelope ${envelope_id}: ${message}`);
      try {
        await this.recordDispatch(tenant_id, envelope_id, signer_id, n.kind, { ok: false, error: message });
      } catch {
        // Recording is best-effort too; never let it break the lifecycle path.
      }
    }
  }

  private async mintExecutedAccess(tenant_id: string, envelope_id: string, signer_id: string): Promise<string> {
    const days = Number(process.env['ESIGN_EXECUTED_ACCESS_TTL_DAYS'] ?? EXECUTED_ACCESS_TTL_DAYS_DEFAULT);
    const ttlDays = Number.isFinite(days) && days > 0 ? days : EXECUTED_ACCESS_TTL_DAYS_DEFAULT;
    const minted = generateSigningToken();
    await this.prisma.executedAccessGrant.create({
      data: {
        id: randomUUID(),
        tenant_id,
        envelope_id,
        signer_id,
        token_hash: minted.hash,
        expires_at: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      },
    });
    return minted.raw;
  }
}
