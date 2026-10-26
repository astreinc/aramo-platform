import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

// Privacy Notice 1.1 remediation E-6 — the delivery-evidence store
// (subscription."LegalChangeNoticeRun" and "LegalChangeNoticeDelivery", migration
// 20261030020000_legal_change_notice_delivery). One delivery row per (document, version,
// channel, recipient user), so a re-run never sends twice; the claim is an
// INSERT … ON CONFLICT DO NOTHING, so two concurrent runs never both send to one person.
// Nothing here stores an address or an email body.

export type LegalNoticeChannel = 'EMAIL' | 'IN_SERVICE';
export type LegalNoticeDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';

export interface LegalNoticeRunCounts {
  eligible_count: number;
  sent_count: number;
  failed_count: number;
  suppressed_count: number;
  already_done_count: number;
  in_doubt_count: number;
}

export interface LegalNoticeIdentity {
  document_key: string;
  version: string;
  // YYYY-MM-DD
  effective_date: string;
}

export interface LegalNoticeTemplateRef {
  template_id: string;
  template_version: string;
  template_sha256: string;
}

/** The outcome of claiming one recipient for an email send. */
export type EmailClaim =
  | { kind: 'CLAIMED'; delivery_id: string; attempt: number }
  | { kind: 'ALREADY_DONE'; status: 'SENT' | 'SUPPRESSED' }
  | { kind: 'IN_DOUBT' };

@Injectable()
export class LegalChangeNoticeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(input: LegalNoticeIdentity & LegalNoticeTemplateRef & { mode: 'DRY_RUN' | 'SEND'; template_status: 'DRAFT' | 'APPROVED'; authorization_ref: string | null }): Promise<string> {
    const id = uuidv7();
    await this.prisma.legalChangeNoticeRun.create({
      data: {
        id,
        mode: input.mode,
        document_key: input.document_key,
        version: input.version,
        effective_date: new Date(`${input.effective_date}T00:00:00.000Z`),
        template_id: input.template_id,
        template_version: input.template_version,
        template_sha256: input.template_sha256,
        template_status: input.template_status,
        authorization_ref: input.authorization_ref,
      },
    });
    return id;
  }

  async finishRun(run_id: string, status: 'COMPLETED' | 'ABORTED', counts: LegalNoticeRunCounts, now: Date): Promise<void> {
    await this.prisma.legalChangeNoticeRun.update({ where: { id: run_id }, data: { status, ...counts, finished_at: now } });
  }

  /** The current state of a recipient's delivery for this document version and channel. */
  async deliveryStatus(n: { document_key: string; version: string; channel: LegalNoticeChannel; user_id: string }): Promise<LegalNoticeDeliveryStatus | null> {
    const row = await this.prisma.legalChangeNoticeDelivery.findUnique({
      where: { document_key_version_channel_user_id: n },
      select: { status: true },
    });
    return (row?.status as LegalNoticeDeliveryStatus | undefined) ?? null;
  }

  /**
   * Claim a recipient for an email send in `run_id`:
   *   - no row         → a PENDING row is inserted (CLAIMED, attempt 1);
   *   - FAILED         → reset to PENDING under this run (CLAIMED, attempt n+1): resume;
   *   - SENT/SUPPRESSED→ ALREADY_DONE (never re-sent);
   *   - PENDING        → IN_DOUBT: an earlier run claimed it and stopped before recording the
   *                      outcome, so the email may have gone. Re-claimed only with resendInDoubt.
   */
  async claimEmail(
    n: LegalNoticeIdentity & LegalNoticeTemplateRef & { user_id: string; tenant_id: string; run_id: string; resend_in_doubt: boolean },
    now: Date,
  ): Promise<EmailClaim> {
    const id = uuidv7();
    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "subscription"."LegalChangeNoticeDelivery"
        ("id", "document_key", "version", "effective_date", "channel", "user_id", "tenant_id", "run_id",
         "template_id", "template_version", "template_sha256", "status", "attempt_count", "created_at", "updated_at")
      VALUES (${id}::uuid, ${n.document_key}, ${n.version}, ${n.effective_date}::date, 'EMAIL', ${n.user_id}::uuid, ${n.tenant_id}::uuid, ${n.run_id}::uuid,
              ${n.template_id}, ${n.template_version}, ${n.template_sha256}, 'PENDING', 1, ${now}, ${now})
      ON CONFLICT ("document_key", "version", "channel", "user_id") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 1) return { kind: 'CLAIMED', delivery_id: inserted[0]!.id, attempt: 1 };

    const existing = await this.prisma.legalChangeNoticeDelivery.findUnique({
      where: { document_key_version_channel_user_id: { document_key: n.document_key, version: n.version, channel: 'EMAIL', user_id: n.user_id } },
      select: { id: true, status: true, attempt_count: true, run_id: true },
    });
    if (existing === null) return { kind: 'IN_DOUBT' };
    if (existing.status === 'SENT' || existing.status === 'SUPPRESSED') return { kind: 'ALREADY_DONE', status: existing.status };
    if (existing.status === 'PENDING' && !n.resend_in_doubt) return { kind: 'IN_DOUBT' };
    // FAILED (or an in-doubt PENDING the operator chose to resend): a conditional reset, so a
    // concurrent run that got there first wins and this one backs off.
    const reset = await this.prisma.legalChangeNoticeDelivery.updateMany({
      where: { id: existing.id, status: existing.status, run_id: existing.run_id, attempt_count: existing.attempt_count },
      data: {
        status: 'PENDING',
        run_id: n.run_id,
        attempt_count: existing.attempt_count + 1,
        error_code: null,
        template_id: n.template_id,
        template_version: n.template_version,
        template_sha256: n.template_sha256,
        updated_at: now,
      },
    });
    if (reset.count !== 1) return { kind: 'IN_DOUBT' };
    return { kind: 'CLAIMED', delivery_id: existing.id, attempt: existing.attempt_count + 1 };
  }

  async markSent(delivery_id: string, provider: string, provider_message_id: string, now: Date): Promise<void> {
    await this.prisma.legalChangeNoticeDelivery.update({
      where: { id: delivery_id },
      data: { status: 'SENT', provider, provider_message_id, sent_at: now, error_code: null, updated_at: now },
    });
  }

  async markFailed(delivery_id: string, provider: string, error_code: string, now: Date): Promise<void> {
    await this.prisma.legalChangeNoticeDelivery.update({
      where: { id: delivery_id },
      data: { status: 'FAILED', provider, error_code, updated_at: now },
    });
  }

  async markSuppressed(delivery_id: string, error_code: string, now: Date): Promise<void> {
    await this.prisma.legalChangeNoticeDelivery.update({
      where: { id: delivery_id },
      data: { status: 'SUPPRESSED', error_code, updated_at: now },
    });
  }

  /**
   * In-service channel: the Sign workspace showed the notice (SHOWN) or the user dismissed it
   * (ACKNOWLEDGED). The first record is the delivery (status SENT, sent_at = first shown);
   * the acknowledgement time is written once. Idempotent.
   */
  async recordInService(n: LegalNoticeIdentity & { user_id: string; tenant_id: string; event: 'SHOWN' | 'ACKNOWLEDGED' }, now: Date): Promise<void> {
    const ack = n.event === 'ACKNOWLEDGED' ? now : null;
    await this.prisma.$executeRaw`
      INSERT INTO "subscription"."LegalChangeNoticeDelivery"
        ("id", "document_key", "version", "effective_date", "channel", "user_id", "tenant_id", "status", "attempt_count", "created_at", "updated_at", "sent_at", "acknowledged_at")
      VALUES (${uuidv7()}::uuid, ${n.document_key}, ${n.version}, ${n.effective_date}::date, 'IN_SERVICE', ${n.user_id}::uuid, ${n.tenant_id}::uuid, 'SENT', 1, ${now}, ${now}, ${now}, ${ack})
      ON CONFLICT ("document_key", "version", "channel", "user_id") DO NOTHING`;
    if (ack !== null) {
      await this.prisma.legalChangeNoticeDelivery.updateMany({
        where: { document_key: n.document_key, version: n.version, channel: 'IN_SERVICE', user_id: n.user_id, acknowledged_at: null },
        data: { acknowledged_at: ack, updated_at: now },
      });
    }
  }

  /** The `key@version` notices this user has acknowledged in the service. */
  async acknowledgedInService(user_id: string, notices: readonly { document_key: string; version: string }[]): Promise<Set<string>> {
    if (notices.length === 0) return new Set();
    const rows = await this.prisma.legalChangeNoticeDelivery.findMany({
      where: {
        user_id,
        channel: 'IN_SERVICE',
        acknowledged_at: { not: null },
        OR: notices.map((x) => ({ document_key: x.document_key, version: x.version })),
      },
      select: { document_key: true, version: true },
    });
    return new Set(rows.map((r) => `${r.document_key}@${r.version}`));
  }
}
