import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { SignMessagingRepository, isE164, isTimeZone, maskPhone, recipientKindOf, type MessagingChannel } from '@aramo/sign';

import { SIGN_SMS_DELIVERY_FEATURE, SIGN_SMS_OTP_FEATURE, SIGN_WHATSAPP_DELIVERY_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';
import { SenderContextService } from '../sender/sender-context.service.js';
import { SenderEnvelopeService } from '../sender/sender-envelope.service.js';

import { SignMessagingService } from './sign-messaging.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8 / §1.9 — the sender's
// per-recipient messaging choice (Amendment A1: dark). In a DRAFT the sender chooses, for a
// signer who receives a link (recipient_kind SIGNER):
//   delivery_channel  SMS | WHATSAPP | null — the signing link ALSO goes to the phone
//                     (email is always sent);                 feature sign.sms_delivery /
//                                                             sign.whatsapp_delivery
//   sms_otp_required  the recipient enters an SMS code first;  feature sign.sms_otp
//   phone_e164        E.164 (required when either is set); timezone an optional IANA zone
//                     for quiet hours.
// Each choice is refused with ESIGN_FEATURE_NOT_AVAILABLE (403) while its feature is
// NOT_AVAILABLE, and with 503 messaging_provider_not_configured when no provider can reach
// the number. Clearing both removes the row. Same authority as every draft write.

export interface RecipientMessagingBody {
  delivery_channel?: unknown;
  sms_otp_required?: unknown;
  phone_e164?: unknown;
  timezone?: unknown;
}

function bad(requestId: string, message: string, details: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details });
}

@Injectable()
export class SenderMessagingService {
  constructor(
    private readonly repo: SignMessagingRepository,
    private readonly messaging: SignMessagingService,
    private readonly context: SenderContextService,
    private readonly envelopes: SenderEnvelopeService,
    private readonly features: SignFeatureGate,
  ) {}

  private availability() {
    return {
      sms_delivery: this.features.isAvailable(SIGN_SMS_DELIVERY_FEATURE),
      whatsapp_delivery: this.features.isAvailable(SIGN_WHATSAPP_DELIVERY_FEATURE),
      sms_otp: this.features.isAvailable(SIGN_SMS_OTP_FEATURE),
    };
  }

  private assertAnyAvailable(requestId: string) {
    const a = this.availability();
    if (!a.sms_delivery && !a.whatsapp_delivery && !a.sms_otp) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is not available in Aramo Sign yet', 403, {
        requestId,
        details: { feature_key: SIGN_SMS_DELIVERY_FEATURE, feature_keys: [SIGN_SMS_DELIVERY_FEATURE, SIGN_WHATSAPP_DELIVERY_FEATURE, SIGN_SMS_OTP_FEATURE] },
      });
    }
    return a;
  }

  async get(auth: AuthContextType, envelope_id: string, requestId: string) {
    const features = this.assertAnyAvailable(requestId);
    await this.envelopes.assertVisible(auth, envelope_id, requestId);
    const [settings, deliveries] = await Promise.all([this.repo.settingsFor(auth.tenant_id, envelope_id), this.repo.deliveriesFor(auth.tenant_id, envelope_id)]);
    return {
      envelope_id,
      features,
      recipients: settings.map((s) => ({
        signer_id: s.signer_id,
        delivery_channel: s.delivery_channel,
        sms_otp_required: s.sms_otp_required,
        phone_e164: s.phone_e164,
        phone_masked: maskPhone(s.phone_e164),
        timezone: s.timezone,
        updated_at: s.updated_at.toISOString(),
      })),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        signer_id: d.signer_id,
        channel: d.channel,
        purpose: d.purpose,
        status: d.status,
        suppressed_reason: d.suppressed_reason,
        phone_masked: d.phone_masked,
        error_code: d.error_code,
        created_at: d.created_at.toISOString(),
        sent_at: d.sent_at?.toISOString() ?? null,
        status_updated_at: d.status_updated_at?.toISOString() ?? null,
      })),
    };
  }

  async put(auth: AuthContextType, envelope_id: string, signer_id: string, body: RecipientMessagingBody, requestId: string) {
    this.assertAnyAvailable(requestId);
    await this.context.assertCanAuthor(auth, requestId);
    await this.envelopes.assertMayChange(auth, envelope_id, requestId);

    const channelRaw = body?.delivery_channel ?? null;
    if (channelRaw !== null && channelRaw !== 'SMS' && channelRaw !== 'WHATSAPP') throw bad(requestId, 'delivery_channel must be SMS, WHATSAPP or null', { field: 'delivery_channel' });
    const channel = channelRaw as MessagingChannel | null;
    const otpRaw = body?.sms_otp_required ?? false;
    if (typeof otpRaw !== 'boolean') throw bad(requestId, 'sms_otp_required must be true or false', { field: 'sms_otp_required' });
    const tzRaw = body?.timezone ?? null;
    if (tzRaw !== null && !isTimeZone(tzRaw)) throw bad(requestId, 'timezone must be an IANA time zone such as America/Chicago', { field: 'timezone', reason: 'invalid_timezone' });

    const { envelope: env, signer } = await this.repo.envelopeAndSigner(auth.tenant_id, envelope_id, signer_id);
    if (env === null) throw new AramoError('ENVELOPE_NOT_FOUND', 'Envelope not found', 404, { requestId });
    if (env.status !== 'DRAFT') throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', `envelope is ${env.status}`, 409, { requestId, details: { reason: 'envelope_not_draft' } });
    if (signer === null) throw new AramoError('SIGNER_NOT_FOUND', 'Recipient not found', 404, { requestId, details: { reason: 'signer_not_found' } });

    if (channel === null && !otpRaw) {
      await this.repo.deleteSetting(auth.tenant_id, signer_id);
      return { signer_id, delivery_channel: null, sms_otp_required: false, phone_e164: null, phone_masked: null, timezone: null };
    }
    if (recipientKindOf(signer) !== 'SIGNER') {
      throw bad(requestId, 'Text delivery and phone codes apply only to a signer who receives a link', { reason: 'recipient_kind_not_supported' });
    }
    const phone = body?.phone_e164;
    if (!isE164(phone)) throw bad(requestId, 'phone_e164 must be an E.164 number such as +14155550123', { field: 'phone_e164', reason: 'invalid_phone' });

    const notAvailable = (feature_key: string) =>
      new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is not available in Aramo Sign yet', 403, { requestId, details: { feature_key } });
    if (channel === 'SMS' && !this.features.isAvailable(SIGN_SMS_DELIVERY_FEATURE)) throw notAvailable(SIGN_SMS_DELIVERY_FEATURE);
    if (channel === 'WHATSAPP' && !this.features.isAvailable(SIGN_WHATSAPP_DELIVERY_FEATURE)) throw notAvailable(SIGN_WHATSAPP_DELIVERY_FEATURE);
    if (otpRaw && !this.features.isAvailable(SIGN_SMS_OTP_FEATURE)) throw notAvailable(SIGN_SMS_OTP_FEATURE);
    const unreachable = (ch: MessagingChannel) =>
      new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', `No ${ch === 'SMS' ? 'SMS' : 'WhatsApp'} provider can reach this number`, 503, {
        requestId,
        details: { reason: 'messaging_provider_not_configured', channel: ch },
      });
    if (channel !== null && !this.messaging.canReach(channel, phone)) throw unreachable(channel);
    if (otpRaw && !this.messaging.canReach('SMS', phone)) throw unreachable('SMS');

    const row = await this.repo.upsertSetting({
      signer_id,
      tenant_id: auth.tenant_id,
      envelope_id,
      delivery_channel: channel,
      phone_e164: phone,
      timezone: tzRaw as string | null,
      sms_otp_required: otpRaw,
      updated_by: auth.sub,
    });
    return {
      signer_id,
      delivery_channel: row.delivery_channel,
      sms_otp_required: row.sms_otp_required,
      phone_e164: row.phone_e164,
      phone_masked: maskPhone(row.phone_e164),
      timezone: row.timezone,
    };
  }
}
