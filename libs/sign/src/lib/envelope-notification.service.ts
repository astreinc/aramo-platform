import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { signBaseUrl } from './sign-base-url.js';
import { EsignRepository } from './esign.repository.js';
import { generateSigningToken } from './signing-token.js';
import {
  SIGNING_NOTIFICATION_PORT,
  type SigningNotification,
  type SigningNotificationPort,
} from './ports/signing-notification.port.js';
import { SENDER_DIRECTORY_PORT, type SenderDirectoryPort } from './ports/sender-directory.port.js';
import { copyRecipients, currentTurnOf, isCopyRecipient, signingRecipients } from './domain/recipients.js';

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

// The signed-copy (and M-A5 §2.2 ON_SEND copy) link lifetime: SIGN_EXECUTED_ACCESS_TTL_DAYS.
export function executedAccessExpiresAt(now: Date = new Date()): Date {
  const days = Number(process.env['SIGN_EXECUTED_ACCESS_TTL_DAYS'] ?? EXECUTED_ACCESS_TTL_DAYS_DEFAULT);
  const ttlDays = Number.isFinite(days) && days > 0 ? days : EXECUTED_ACCESS_TTL_DAYS_DEFAULT;
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

type EnvelopeFull = Awaited<ReturnType<EsignRepository['getEnvelopeFull']>>;

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
  // M-A5 §2.3 / §2.4 — ON_COMPLETION / BOTH copy recipients receive the same executed
  // copy, with copy wording (recipient_role COPY). Recorded in NotificationDelivery
  // only: no ledger event follows ENVELOPE_COMPLETED. An in-person signer without an
  // email receives nothing by email (§3.5).
  async envelopeCompleted(tenant_id: string, envelope_id: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const signWeb = signBaseUrl();
    const recipients = [...signingRecipients(env.signers), ...copyRecipients(env.signers, 'COMPLETION')];
    for (const signer of recipients) {
      if (signer.email === null) continue;
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
        ...(isCopyRecipient(signer) ? { recipient_role: 'COPY' as const } : {}),
      });
    }
    await this.toSender(env, { kind: 'SIGNATURE_COMPLETED' });
  }

  // ── M-A5 §2.2 — at send, an ON_SEND / BOTH copy recipient gets a RECIPIENT_COPY
  // email with a link to the SOURCE documents (minted with the send). Recorded in
  // NotificationDelivery; the ledger event COPY_DELIVERY_ISSUED was appended in the
  // send transaction. Raw tokens and links are never logged. ──
  async copiesIssued(tenant_id: string, envelope_id: string, copies: readonly { signer_id: string; raw_token: string }[]): Promise<void> {
    if (copies.length === 0) return;
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const signWeb = signBaseUrl();
    for (const c of copies) {
      const cc = env.signers.find((s) => s.id === c.signer_id);
      if (cc === undefined || cc.email === null) continue;
      if (signWeb === null) {
        await this.recordDispatch(tenant_id, envelope_id, cc.id, 'RECIPIENT_COPY', { ok: false, error: 'Sign base URL unset' });
        continue;
      }
      await this.deliver(tenant_id, envelope_id, cc.id, {
        kind: 'RECIPIENT_COPY',
        recipient_role: 'COPY',
        to_email: cc.email,
        to_name: cc.name,
        envelope_subject: env.subject,
        tenant_id,
        copy_url: `${signWeb}/c/${c.raw_token}`,
        ...(env.message ? { sender_message: env.message } : {}),
      });
    }
  }

  // M-A5 §2.5 — who hears that an envelope ended early (void, decline, expiry):
  // signing recipients who had not finished (and have an email), plus ON_SEND / BOTH
  // copy recipients (who were told the envelope existed).
  private endNoticeRecipients(env: EnvelopeFull, skip: (s: EnvelopeFull['signers'][number]) => boolean) {
    const signing = signingRecipients(env.signers).filter((s) => !skip(s));
    const copies = copyRecipients(env.signers, 'SEND');
    return [...signing, ...copies].filter((s): s is typeof s & { email: string } => s.email !== null);
  }

  // ── Decline: the sender gets the reason; other open signers learn it ended. ──
  async envelopeDeclined(tenant_id: string, envelope_id: string, declined_by_signer_id: string, reason: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const decliner = env.signers.find((s) => s.id === declined_by_signer_id);
    await this.toSender(env, { kind: 'SIGNATURE_DECLINED', reason: decliner ? `${decliner.name}: ${reason}` : reason });
    for (const signer of this.endNoticeRecipients(env, (s) => s.id === declined_by_signer_id || s.status === 'SIGNED')) {
      await this.deliver(tenant_id, envelope_id, signer.id, {
        kind: 'SIGNATURE_DECLINED',
        to_email: signer.email,
        to_name: signer.name,
        envelope_subject: env.subject,
        ...(isCopyRecipient(signer) ? { recipient_role: 'COPY' as const } : {}),
      });
    }
  }

  // ── Void: every signer who had not finished learns the request was withdrawn. ──
  async envelopeVoided(tenant_id: string, envelope_id: string, reason: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    for (const signer of this.endNoticeRecipients(env, (s) => s.status === 'SIGNED' || s.status === 'DECLINED')) {
      await this.deliver(tenant_id, envelope_id, signer.id, {
        kind: 'SIGNATURE_VOIDED',
        to_email: signer.email,
        to_name: signer.name,
        envelope_subject: env.subject,
        reason,
        ...(isCopyRecipient(signer) ? { recipient_role: 'COPY' as const } : {}),
      });
    }
  }

  // ── Expiry: open signers and the sender learn the signing window closed. ──
  async envelopeExpired(tenant_id: string, envelope_id: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    for (const signer of this.endNoticeRecipients(env, (s) => s.status === 'SIGNED' || s.status === 'DECLINED')) {
      await this.deliver(tenant_id, envelope_id, signer.id, {
        kind: 'SIGNATURE_EXPIRED',
        to_email: signer.email,
        to_name: signer.name,
        envelope_subject: env.subject,
        ...(isCopyRecipient(signer) ? { recipient_role: 'COPY' as const } : {}),
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

  // Multi-Signer M-3b — the sender hears each signer's signature while others remain
  // (console envelopes only, like every sender notice). Recorded like every notice.
  async signerSigned(tenant_id: string, envelope_id: string, signer_id: string): Promise<void> {
    const env = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const signer = env.signers.find((s) => s.id === signer_id);
    if (signer === undefined) return;
    // M-A5 §1.3 — progress counts signing recipients only (a copy never signs).
    const signing = signingRecipients(env.signers);
    const signed = signing.filter((s) => s.status === 'SIGNED').length;
    if (signed >= signing.length) return; // the completion notice covers the last one
    const next = env.routing_mode === 'SEQUENTIAL' ? (currentTurnOf(env.signers) ?? undefined) : undefined;
    await this.toSender(env, {
      kind: 'SIGNER_SIGNED',
      signer_name: signer.name,
      signed_count: signed,
      signer_count: signing.length,
      ...(next !== undefined ? { next_signer_name: next.name } : {}),
    });
  }

  private async toSender(
    env: EnvelopeFull,
    n: Pick<SigningNotification, 'kind' | 'reason' | 'signer_name' | 'signed_count' | 'signer_count' | 'next_signer_name'>,
  ): Promise<void> {
    // Sender notifications are a Sign-console feature (OWNED documents, or — DOC-TEMPLATE-
    // LIB-1 T-5 — a console envelope started from a template, whose document is CORE_REF).
    if (!env.documents.some((d) => d.source_mode === 'OWNED') && env.source_application !== 'aramo-sign') return;
    if (this.senders === undefined) return;
    const sender = await this.senders.findSender(env.tenant_id, env.created_by);
    if (sender === null) return;
    const consoleWeb = signBaseUrl();
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
    const minted = generateSigningToken();
    await this.prisma.executedAccessGrant.create({
      data: {
        id: randomUUID(),
        tenant_id,
        envelope_id,
        signer_id,
        token_hash: minted.hash,
        expires_at: executedAccessExpiresAt(),
        access_kind: 'EXECUTED',
      },
    });
    return minted.raw;
  }
}
