import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  OUTBOUND_MESSAGING_PORT,
  SENDER_DIRECTORY_PORT,
  SIGNER_MESSAGE_FAILED_EVENT,
  SIGNER_MESSAGE_SENT_EVENT,
  SIGNER_MESSAGE_STATUS_EVENT,
  SIGNER_MESSAGE_SUPPRESSED_EVENT,
  SIGN_USAGE_RECORDER_PORT,
  SignMessagingRepository,
  isQuietHours,
  maskPhone,
  parseInboundKeyword,
  phoneHash,
  quietHoursFromEnv,
  rateLimitExceeded,
  recipientTimeZones,
  tenantMessagingLimitsFromEnv,
  type InboundKeyword,
  type MessagePurpose,
  type MessagingChannel,
  type OutboundMessagingPort,
  type SenderDirectoryPort,
  type SignUsageRecorderPort,
  type SignUsageUnit,
  type SignerLinkMessage,
  type SignerLinkMessagingPort,
  type SuppressedReason,
} from '@aramo/sign';

import { SIGN_SMS_DELIVERY_FEATURE, SIGN_WHATSAPP_DELIVERY_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 SMS delivery / §1.8 WhatsApp
// delivery (Amendment A1: dark, configured off). The policy in front of the vendor port:
//
//   1. the sender chose a channel for this recipient (SignRecipientMessaging) and the
//      channel's feature is AVAILABLE (sign.sms_delivery / sign.whatsapp_delivery) —
//      otherwise nothing happens and nothing is recorded (email only, today's behaviour);
//   2. a provider can reach the number (else SUPPRESSED channel_unavailable);
//   3. the number has not opted out (STOP) on that channel (else SUPPRESSED opted_out);
//   4. it is not quiet hours where the recipient is (else SUPPRESSED quiet_hours — the
//      email still went out, and a reminder after quiet hours sends the text);
//   5. the tenant is under its hourly / daily message limits (else SUPPRESSED rate_limited);
//   6. send; SENT / FAILED (a vendor-reported opt-out is added to the list and SUPPRESSED).
//
// Every outcome is a SignMessageDelivery row and, while the envelope is open, a ledger
// event (SIGNER_MESSAGE_SENT / _FAILED / _SUPPRESSED) appended through the existing hash
// chain. A sent message reports one usage record (SIGN_USAGE_RECORDER_PORT, when bound).
// Nothing here ever throws into the send / reminder flow, and the signing link and the
// full number are never logged or stored outside SignRecipientMessaging.

export const SIGN_MESSAGING_ENV = 'SIGN_MESSAGING_ENV';

const FEATURE_OF: Record<MessagingChannel, string> = { SMS: SIGN_SMS_DELIVERY_FEATURE, WHATSAPP: SIGN_WHATSAPP_DELIVERY_FEATURE };
const UNIT_OF: Record<MessagingChannel, SignUsageUnit> = { SMS: 'sign.sms_message', WHATSAPP: 'sign.whatsapp_message' };

export type SendOutcome =
  | { status: 'SENT'; delivery_id: string }
  | { status: 'SUPPRESSED'; reason: SuppressedReason; delivery_id: string }
  | { status: 'FAILED'; error_code: string; delivery_id: string };

@Injectable()
export class SignMessagingService implements SignerLinkMessagingPort {
  private readonly logger = new Logger('SignMessagingService');
  private readonly features: SignFeatureGate;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly repo: SignMessagingRepository,
    @Inject(OUTBOUND_MESSAGING_PORT) private readonly outbound: OutboundMessagingPort,
    @Optional() features?: SignFeatureGate,
    @Optional() @Inject(SENDER_DIRECTORY_PORT) private readonly senders?: SenderDirectoryPort,
    @Optional() @Inject(SIGN_USAGE_RECORDER_PORT) private readonly usage?: SignUsageRecorderPort,
    // Tests only: the quiet-hours / rate-limit settings. Production reads process.env.
    @Optional() @Inject(SIGN_MESSAGING_ENV) env?: NodeJS.ProcessEnv,
  ) {
    this.features = features ?? new SignFeatureGate();
    this.env = env ?? process.env;
  }

  channelAvailable(channel: MessagingChannel): boolean {
    return this.features.isAvailable(FEATURE_OF[channel]);
  }

  /** A configured provider can reach this number on this channel. */
  canReach(channel: MessagingChannel, to_e164: string): boolean {
    return this.outbound.channels.has(channel) && this.outbound.canSend(channel, to_e164);
  }

  // SIGNER_LINK_MESSAGING_PORT — called after the email with the same freshly issued link.
  async deliverSigningLink(message: SignerLinkMessage): Promise<void> {
    try {
      const setting = await this.repo.settingFor(message.tenant_id, message.signer_id);
      if (setting === null || setting.envelope_id !== message.envelope_id) return;
      const channel = setting.delivery_channel;
      if (channel !== 'SMS' && channel !== 'WHATSAPP') return;
      if (!this.channelAvailable(channel)) return;
      const now = new Date();
      const zones = recipientTimeZones(setting.phone_e164, setting.timezone, this.env);
      await this.send(
        {
          tenant_id: message.tenant_id,
          envelope_id: message.envelope_id,
          signer_id: message.signer_id,
          channel,
          purpose: message.purpose,
          to_e164: setting.phone_e164,
          signing_url: message.signing_url,
          quiet: isQuietHours(now, zones, quietHoursFromEnv(this.env)),
        },
        now,
      );
    } catch (err) {
      this.logger.warn(`signing-link message failed — envelope ${message.envelope_id} signer ${message.signer_id}: ${(err as Error).message}`);
    }
  }

  /**
   * The SMS carrying a one-time code (§1.9). Quiet hours do not apply (the recipient asked
   * for it now); the opt-out list and the tenant limits do. No ledger event here — the
   * caller appends RECIPIENT_OTP_SENT. Never throws.
   */
  async sendOneTimeCode(input: { tenant_id: string; envelope_id: string; signer_id: string; to_e164: string; code: string; ttl_minutes: number }): Promise<SendOutcome> {
    return this.send(
      {
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        signer_id: input.signer_id,
        channel: 'SMS',
        purpose: 'OTP',
        to_e164: input.to_e164,
        code: input.code,
        ttl_minutes: input.ttl_minutes,
        quiet: false,
      },
      new Date(),
    );
  }

  private async send(
    m: {
      tenant_id: string;
      envelope_id: string;
      signer_id: string;
      channel: MessagingChannel;
      purpose: MessagePurpose;
      to_e164: string;
      signing_url?: string;
      code?: string;
      ttl_minutes?: number;
      quiet: boolean;
    },
    now: Date,
  ): Promise<SendOutcome> {
    const hash = phoneHash(m.to_e164);
    const masked = maskPhone(m.to_e164);
    const ledgered = m.purpose !== 'OTP';
    const base = { tenant_id: m.tenant_id, envelope_id: m.envelope_id, signer_id: m.signer_id, channel: m.channel, purpose: m.purpose, phone_hash: hash, phone_masked: masked };
    const eventPayload = { channel: m.channel, purpose: m.purpose, phone: masked };

    const suppress = async (reason: SuppressedReason): Promise<SendOutcome> => {
      const r = await this.repo.recordDelivery(
        { ...base, status: 'SUPPRESSED', suppressed_reason: reason },
        ledgered ? { event_type: SIGNER_MESSAGE_SUPPRESSED_EVENT, actor_type: 'SYSTEM', payload: { ...eventPayload, reason } } : null,
      );
      return { status: 'SUPPRESSED', reason, delivery_id: r.id };
    };

    if (!this.canReach(m.channel, m.to_e164)) return suppress('channel_unavailable');
    if (await this.repo.isOptedOut(hash, m.channel)) return suppress('opted_out');
    if (m.quiet) return suppress('quiet_hours');
    if (rateLimitExceeded(await this.repo.sentCounts(m.tenant_id, now), tenantMessagingLimitsFromEnv(this.env))) return suppress('rate_limited');

    const id = randomUUID();
    const sender_name = await this.senderName(m.tenant_id, m.envelope_id);
    const result = await this.outbound.send({
      channel: m.channel,
      purpose: m.purpose,
      to_e164: m.to_e164,
      reference: id,
      variables: {
        ...(sender_name !== null ? { sender_name } : {}),
        ...(m.signing_url !== undefined ? { signing_url: m.signing_url } : {}),
        ...(m.code !== undefined ? { code: m.code } : {}),
        ...(m.ttl_minutes !== undefined ? { ttl_minutes: m.ttl_minutes } : {}),
      },
    });

    if (result.outcome === 'opted_out') {
      await this.repo.setOptOut(hash, m.channel, true, 'PROVIDER', now);
      const r = await this.repo.recordDelivery(
        { ...base, id, status: 'SUPPRESSED', suppressed_reason: 'opted_out', provider: result.provider },
        ledgered ? { event_type: SIGNER_MESSAGE_SUPPRESSED_EVENT, actor_type: 'SYSTEM', payload: { ...eventPayload, reason: 'opted_out' } } : null,
      );
      return { status: 'SUPPRESSED', reason: 'opted_out', delivery_id: r.id };
    }
    if (result.outcome === 'failed') {
      // The production probe's alert line (Remaining-Work Directive §3 B9): never the number or the link.
      this.logger.warn(`sign_messaging.send_failed channel=${m.channel} purpose=${m.purpose} provider=${result.provider} error=${result.error_code}`);
      const r = await this.repo.recordDelivery(
        { ...base, id, status: 'FAILED', provider: result.provider, error_code: result.error_code },
        ledgered ? { event_type: SIGNER_MESSAGE_FAILED_EVENT, actor_type: 'SYSTEM', payload: { ...eventPayload, error_code: result.error_code } } : null,
      );
      return { status: 'FAILED', error_code: result.error_code, delivery_id: r.id };
    }
    const r = await this.repo.recordDelivery(
      { ...base, id, status: 'SENT', provider: result.provider, provider_message_id: result.provider_message_id, sent_at: now },
      ledgered ? { event_type: SIGNER_MESSAGE_SENT_EVENT, actor_type: 'SYSTEM', payload: { ...eventPayload, provider: result.provider } } : null,
    );
    await this.recordUsage(m.tenant_id, m.envelope_id, m.purpose === 'OTP' ? 'sign.sms_otp' : UNIT_OF[m.channel], r.id, now, result.provider);
    return { status: 'SENT', delivery_id: r.id };
  }

  private async recordUsage(tenant_id: string, envelope_id: string, unit: SignUsageUnit, delivery_id: string, now: Date, provider: string): Promise<void> {
    if (this.usage === undefined) return;
    try {
      await this.usage.record({ tenant_id, unit, quantity: 1, idempotency_key: `sign-message:${delivery_id}`, occurred_at: now, envelope_id, provider });
    } catch (err) {
      this.logger.warn(`usage not recorded for message ${delivery_id}: ${(err as Error).message}`);
    }
  }

  private async senderName(tenant_id: string, envelope_id: string): Promise<string | null> {
    if (this.senders === undefined) return null;
    const { envelope } = await this.repo.envelopeAndSigner(tenant_id, envelope_id);
    if (envelope === null) return null;
    const contact = await this.senders.findSender(tenant_id, envelope.created_by).catch(() => null);
    return contact?.name?.trim() ? contact.name.trim() : null;
  }

  // ── Inbound (WhatsApp webhook; SMS STOP is kept by the AWS opt-out list) ────
  /** A message from a recipient: STOP / START update the opt-out list. */
  async inboundMessage(channel: MessagingChannel, from_e164: string, text: unknown, now: Date = new Date()): Promise<InboundKeyword | null> {
    const keyword = parseInboundKeyword(text);
    if (keyword === 'OPT_OUT') await this.repo.setOptOut(phoneHash(from_e164), channel, true, 'INBOUND_KEYWORD', now);
    if (keyword === 'OPT_IN') await this.repo.setOptOut(phoneHash(from_e164), channel, false, 'INBOUND_KEYWORD', now);
    return keyword;
  }

  /** A vendor status callback for a message we sent. */
  async providerStatus(provider: string, provider_message_id: string, status: 'DELIVERED' | 'READ' | 'UNDELIVERED', now: Date = new Date()) {
    return this.repo.applyProviderStatus(provider, provider_message_id, status, SIGNER_MESSAGE_STATUS_EVENT, now);
  }
}
