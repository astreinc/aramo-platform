import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { EsignRepository, type LockingTx } from '../esign.repository.js';
import { isTerminalEnvelopeStatus } from '../domain/envelope-lifecycle.js';
import type { MessagePurpose, MessagingChannel } from '../ports/outbound-messaging.port.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8 / §1.9 — persistence
// for Sign messaging: the sender's per-recipient choice, the delivery records, the opt-out
// list and the SMS one-time-code challenges. Ledger events go through
// EsignRepository.appendEvent under the envelope row lock (the same hash chain as every
// other event); none is appended to a terminal envelope, whose chain hash is final.

export type DeliveryStatus = 'SENT' | 'DELIVERED' | 'READ' | 'UNDELIVERED' | 'FAILED' | 'SUPPRESSED';
export type SuppressedReason = 'opted_out' | 'rate_limited' | 'quiet_hours' | 'channel_unavailable';
export type OtpChallengeStatus = 'ACTIVE' | 'VERIFIED' | 'EXPIRED' | 'LOCKED' | 'SUPERSEDED';

export interface RecipientMessagingRow {
  signer_id: string;
  tenant_id: string;
  envelope_id: string;
  delivery_channel: string | null;
  phone_e164: string;
  timezone: string | null;
  sms_otp_required: boolean;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface LedgerAppend {
  event_type: string;
  actor_type: 'SIGNER' | 'SYSTEM' | 'SERVICE';
  actor_ref?: string;
  payload: Record<string, unknown>;
}

export interface NewDelivery {
  /** Generated when absent. Given when the vendor was sent our reference first. */
  id?: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string | null;
  channel: MessagingChannel;
  purpose: MessagePurpose;
  status: DeliveryStatus;
  suppressed_reason?: SuppressedReason | null;
  provider?: string | null;
  provider_message_id?: string | null;
  phone_hash: string | null;
  phone_masked: string | null;
  error_code?: string | null;
  sent_at?: Date | null;
}

@Injectable()
export class SignMessagingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly esign: EsignRepository,
  ) {}

  // ── The sender's per-recipient choice ─────────────────────────────────────
  async settingsFor(tenant_id: string, envelope_id: string): Promise<RecipientMessagingRow[]> {
    return this.prisma.signRecipientMessaging.findMany({ where: { tenant_id, envelope_id }, orderBy: { created_at: 'asc' } });
  }

  async settingFor(tenant_id: string, signer_id: string): Promise<RecipientMessagingRow | null> {
    return this.prisma.signRecipientMessaging.findFirst({ where: { tenant_id, signer_id } });
  }

  async upsertSetting(row: Omit<RecipientMessagingRow, 'created_at' | 'updated_at'>, now: Date = new Date()): Promise<RecipientMessagingRow> {
    const data = {
      tenant_id: row.tenant_id,
      envelope_id: row.envelope_id,
      delivery_channel: row.delivery_channel,
      phone_e164: row.phone_e164,
      timezone: row.timezone,
      sms_otp_required: row.sms_otp_required,
      updated_by: row.updated_by,
    };
    return this.prisma.signRecipientMessaging.upsert({
      where: { signer_id: row.signer_id },
      create: { signer_id: row.signer_id, ...data, created_at: now, updated_at: now },
      update: { ...data, updated_at: now },
    });
  }

  async deleteSetting(tenant_id: string, signer_id: string): Promise<void> {
    await this.prisma.signRecipientMessaging.deleteMany({ where: { tenant_id, signer_id } });
  }

  /** The envelope's status and creator, and (when given) one of its recipients. */
  async envelopeAndSigner(tenant_id: string, envelope_id: string, signer_id?: string) {
    const envelope = await this.prisma.signatureEnvelope.findFirst({ where: { id: envelope_id, tenant_id }, select: { status: true, created_by: true } });
    const signer =
      signer_id === undefined ? null : await this.prisma.signer.findFirst({ where: { id: signer_id, tenant_id, envelope_id }, select: { id: true, recipient_kind: true } });
    return { envelope, signer };
  }

  // ── Delivery records ──────────────────────────────────────────────────────
  async deliveriesFor(tenant_id: string, envelope_id: string, take = 200) {
    return this.prisma.signMessageDelivery.findMany({
      where: { tenant_id, envelope_id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        signer_id: true,
        channel: true,
        purpose: true,
        status: true,
        suppressed_reason: true,
        phone_masked: true,
        error_code: true,
        created_at: true,
        sent_at: true,
        status_updated_at: true,
      },
    });
  }

  /** Messages actually sent by the tenant since each instant (the rate-limit counters). */
  async sentCounts(tenant_id: string, now: Date): Promise<{ last_hour: number; last_day: number }> {
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const [last_hour, last_day] = await Promise.all([
      this.prisma.signMessageDelivery.count({ where: { tenant_id, sent_at: { gte: hourAgo } } }),
      this.prisma.signMessageDelivery.count({ where: { tenant_id, sent_at: { gte: dayAgo } } }),
    ]);
    return { last_hour, last_day };
  }

  /**
   * Insert one delivery record and, when the envelope is still open, its ledger event —
   * in one transaction under the envelope row lock. Returns the delivery id and whether
   * the ledger event was appended.
   */
  async recordDelivery(delivery: NewDelivery, ledger: LedgerAppend | null): Promise<{ id: string; ledgered: boolean }> {
    const id = delivery.id ?? randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const status = await this.esign.lockEnvelope(tx as unknown as LockingTx, delivery.tenant_id, delivery.envelope_id);
      await tx.signMessageDelivery.create({
        data: {
          id,
          tenant_id: delivery.tenant_id,
          envelope_id: delivery.envelope_id,
          signer_id: delivery.signer_id,
          channel: delivery.channel,
          purpose: delivery.purpose,
          status: delivery.status,
          suppressed_reason: delivery.suppressed_reason ?? null,
          provider: delivery.provider ?? null,
          provider_message_id: delivery.provider_message_id ?? null,
          phone_hash: delivery.phone_hash,
          phone_masked: delivery.phone_masked,
          error_code: delivery.error_code?.slice(0, 64) ?? null,
          sent_at: delivery.sent_at ?? null,
        },
      });
      const ledgered = ledger !== null && !isTerminalEnvelopeStatus(status);
      if (ledgered) await this.appendIn(tx as unknown as LockingTx, delivery.tenant_id, delivery.envelope_id, delivery.signer_id, { ...ledger, payload: { ...ledger.payload, delivery_id: id } });
      return { id, ledgered };
    });
  }

  /**
   * A vendor status callback (delivered / read / failed) for a message we sent. Updates the
   * record (a status never moves back to SENT) and appends SIGNER_MESSAGE_STATUS when the
   * envelope is open. Unknown references are ignored (null).
   */
  async applyProviderStatus(
    provider: string,
    provider_message_id: string,
    status: 'DELIVERED' | 'READ' | 'UNDELIVERED',
    eventType: string,
    now: Date = new Date(),
  ): Promise<{ delivery_id: string; ledgered: boolean } | null> {
    const found = await this.prisma.signMessageDelivery.findFirst({
      where: { provider, provider_message_id },
      select: { id: true, tenant_id: true, envelope_id: true, signer_id: true, channel: true, purpose: true, status: true },
    });
    if (found === null) return null;
    // READ comes after DELIVERED; a final status is never replaced by an earlier one.
    const order: Record<string, number> = { SENT: 1, DELIVERED: 2, UNDELIVERED: 2, READ: 3 };
    if ((order[found.status] ?? 0) >= (order[status] ?? 0)) return { delivery_id: found.id, ledgered: false };
    return this.prisma.$transaction(async (tx) => {
      const envStatus = await this.esign.lockEnvelope(tx as unknown as LockingTx, found.tenant_id, found.envelope_id);
      await tx.signMessageDelivery.update({ where: { id: found.id }, data: { status, status_updated_at: now } });
      const ledgered = !isTerminalEnvelopeStatus(envStatus);
      if (ledgered) {
        await this.appendIn(tx as unknown as LockingTx, found.tenant_id, found.envelope_id, found.signer_id, {
          event_type: eventType,
          actor_type: 'SYSTEM',
          payload: { channel: found.channel, purpose: found.purpose, status, delivery_id: found.id },
        });
      }
      return { delivery_id: found.id, ledgered };
    });
  }

  // ── Opt-out list ──────────────────────────────────────────────────────────
  async isOptedOut(phone_hash: string, channel: MessagingChannel): Promise<boolean> {
    const row = await this.prisma.signMessagingOptOut.findUnique({ where: { phone_hash_channel: { phone_hash, channel } }, select: { opted_out: true } });
    return row?.opted_out === true;
  }

  async setOptOut(phone_hash: string, channel: MessagingChannel, opted_out: boolean, source: 'INBOUND_KEYWORD' | 'PROVIDER', now: Date = new Date()): Promise<void> {
    await this.prisma.signMessagingOptOut.upsert({
      where: { phone_hash_channel: { phone_hash, channel } },
      create: { phone_hash, channel, opted_out, source, updated_at: now },
      update: { opted_out, source, updated_at: now },
    });
  }

  // ── SMS one-time codes ────────────────────────────────────────────────────
  async otpHistory(tenant_id: string, signer_id: string, since: Date) {
    return this.prisma.signRecipientOtpChallenge.findMany({
      where: { tenant_id, signer_id, created_at: { gte: since } },
      orderBy: { created_at: 'desc' },
      select: { id: true, status: true, created_at: true },
    });
  }

  async lockedChallengeCount(tenant_id: string, envelope_id: string, signer_id: string): Promise<number> {
    return this.prisma.signRecipientOtpChallenge.count({ where: { tenant_id, envelope_id, signer_id, status: 'LOCKED' } });
  }

  async activeChallenge(tenant_id: string, session_id: string) {
    return this.prisma.signRecipientOtpChallenge.findFirst({
      where: { tenant_id, session_id, status: 'ACTIVE' },
      orderBy: { created_at: 'desc' },
    });
  }

  async isSessionVerified(tenant_id: string, session_id: string): Promise<boolean> {
    const n = await this.prisma.signRecipientOtpChallenge.count({ where: { tenant_id, session_id, status: 'VERIFIED' } });
    return n > 0;
  }

  /** A new code for the session: earlier ACTIVE codes of this signer are SUPERSEDED. */
  async createChallenge(input: {
    id: string;
    tenant_id: string;
    envelope_id: string;
    signer_id: string;
    session_id: string;
    phone_hash: string;
    phone_masked: string;
    code_hash: string;
    expires_at: Date;
    now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.signRecipientOtpChallenge.updateMany({
        where: { tenant_id: input.tenant_id, signer_id: input.signer_id, status: 'ACTIVE' },
        data: { status: 'SUPERSEDED' },
      });
      await tx.signRecipientOtpChallenge.create({
        data: {
          id: input.id,
          tenant_id: input.tenant_id,
          envelope_id: input.envelope_id,
          signer_id: input.signer_id,
          session_id: input.session_id,
          phone_hash: input.phone_hash,
          phone_masked: input.phone_masked,
          code_hash: input.code_hash,
          expires_at: input.expires_at,
          created_at: input.now,
        },
      });
    });
  }

  /** Withdraw a code that could not be delivered (never left ACTIVE without an SMS). */
  async withdrawChallenge(id: string): Promise<void> {
    await this.prisma.signRecipientOtpChallenge.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
  }

  /**
   * Record one checked attempt (compare-and-set on the attempt count, so two concurrent
   * attempts cannot both use the same count) and move the challenge to its new status,
   * appending the ledger event in the same transaction when the envelope is open.
   * Returns false when the challenge changed underneath (the caller re-reads).
   */
  async recordOtpAttempt(input: {
    challenge_id: string;
    tenant_id: string;
    envelope_id: string;
    signer_id: string;
    expected_attempts: number;
    outcome: 'VERIFIED' | 'MISMATCH' | 'LOCKED' | 'EXPIRED';
    now: Date;
    ledger: LedgerAppend[];
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const envStatus = await this.esign.lockEnvelope(tx as unknown as LockingTx, input.tenant_id, input.envelope_id);
      const counts = input.outcome !== 'EXPIRED';
      const data =
        input.outcome === 'VERIFIED'
          ? { status: 'VERIFIED', verified_at: input.now, attempts: { increment: 1 } }
          : input.outcome === 'LOCKED'
            ? { status: 'LOCKED', locked_at: input.now, attempts: { increment: 1 } }
            : input.outcome === 'EXPIRED'
              ? { status: 'EXPIRED' }
              : { attempts: { increment: 1 } };
      const updated = await tx.signRecipientOtpChallenge.updateMany({
        where: { id: input.challenge_id, status: 'ACTIVE', ...(counts ? { attempts: input.expected_attempts } : {}) },
        data,
      });
      if (updated.count === 0) return false;
      if (!isTerminalEnvelopeStatus(envStatus)) {
        for (const e of input.ledger) await this.appendIn(tx as unknown as LockingTx, input.tenant_id, input.envelope_id, input.signer_id, e);
      }
      return true;
    });
  }

  /** Append ledger events for an open envelope, under its row lock. */
  async appendLedger(tenant_id: string, envelope_id: string, signer_id: string | null, events: LedgerAppend[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const status = await this.esign.lockEnvelope(tx as unknown as LockingTx, tenant_id, envelope_id);
      if (isTerminalEnvelopeStatus(status)) return false;
      for (const e of events) await this.appendIn(tx as unknown as LockingTx, tenant_id, envelope_id, signer_id, e);
      return true;
    });
  }

  private async appendIn(tx: LockingTx, tenant_id: string, envelope_id: string, signer_id: string | null, e: LedgerAppend): Promise<void> {
    await this.esign.appendEvent(tx, {
      tenant_id,
      envelope_id,
      ...(signer_id !== null ? { signer_id } : {}),
      event_type: e.event_type,
      actor_type: e.actor_type,
      ...(e.actor_ref !== undefined ? { actor_ref: e.actor_ref } : {}),
      payload: e.payload,
    });
  }
}
