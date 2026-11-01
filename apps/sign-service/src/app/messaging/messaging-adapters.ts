import { Logger } from '@nestjs/common';
import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import {
  type MessagingChannel,
  type OutboundMessage,
  type OutboundMessagingPort,
  type OutboundSendResult,
  maskPhone,
} from '@aramo/sign';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8, Amendment A1 §A1.1 —
// OUTBOUND_MESSAGING_PORT bindings. Default vendors per §5 D-3: AWS End User Messaging SMS
// (US, 10DLC), MSG91 (India, DLT) and the Meta WhatsApp Cloud API. Configured from the
// environment; UNSET = OFF (A1.1: "configured off (env unset)"). A vendor whose settings are
// incomplete is left out (logged), never fatal. No secret is in code; none is ever logged,
// and neither is a signing link or a code (production).
//
//   SIGN_SMS_PROVIDER        unset ⇒ no SMS | log | aws | msg91 | aws,msg91
//                            (the same variable Personal phone verification reads; only
//                            `log` turns that on — aws / msg91 leave it disabled)
//     aws    SIGN_SMS_AWS_ORIGINATION_IDENTITY (required: the 10DLC number / pool id or ARN),
//            SIGN_SMS_AWS_REGION (else AWS_REGION), SIGN_SMS_AWS_CONFIGURATION_SET (optional),
//            SIGN_SMS_AWS_ACCESS_KEY_ID / SIGN_SMS_AWS_SECRET_ACCESS_KEY (optional; else the
//            SDK default chain). Sends to every number except +91.
//     msg91  SIGN_SMS_MSG91_AUTH_KEY + the DLT template id of each purpose:
//            SIGN_SMS_MSG91_TEMPLATE_INVITATION / _REMINDER / _OTP (a purpose without a
//            template id is not sent). Sends to +91 numbers only.
//   SIGN_WHATSAPP_PROVIDER   unset ⇒ no WhatsApp | log | meta
//     meta   SIGN_WHATSAPP_PHONE_NUMBER_ID, SIGN_WHATSAPP_ACCESS_TOKEN,
//            SIGN_WHATSAPP_TEMPLATE_INVITATION (approved template name; REMINDER falls back
//            to it unless SIGN_WHATSAPP_TEMPLATE_REMINDER is set), SIGN_WHATSAPP_TEMPLATE_LANGUAGE
//            (default en_US), SIGN_WHATSAPP_GRAPH_VERSION (default v21.0).

const log = new Logger('SignMessaging');

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One vendor for one channel. */
export interface ChannelAdapter {
  readonly provider: string;
  canSend(to_e164: string): boolean;
  send(message: OutboundMessage): Promise<OutboundSendResult>;
}

// ── The texts (free-text SMS only; template vendors carry the same variables) ─
export function smsText(message: OutboundMessage): string {
  const v = message.variables;
  const who = v.sender_name !== undefined && v.sender_name.trim() !== '' ? v.sender_name.trim().slice(0, 60) : 'Someone';
  switch (message.purpose) {
    case 'INVITATION':
      return `${who} sent you a document to sign with Aramo Sign: ${v.signing_url ?? ''} Reply STOP to opt out.`;
    case 'REMINDER':
      return `Reminder: ${who} is waiting for your signature in Aramo Sign: ${v.signing_url ?? ''} Reply STOP to opt out.`;
    case 'OTP':
      return `Your Aramo Sign verification code is ${v.code ?? ''}. It expires in ${v.ttl_minutes ?? 10} minutes. Do not share it.`;
  }
}

// ── Off / log ───────────────────────────────────────────────────────────────
export class DisabledOutboundMessaging implements OutboundMessagingPort {
  readonly channels: ReadonlySet<MessagingChannel> = new Set();
  canSend(): boolean {
    return false;
  }
  async send(message: OutboundMessage): Promise<OutboundSendResult> {
    return { outcome: 'failed', provider: 'none', error_code: `${message.channel.toLowerCase()}_not_configured` };
  }
}

/** Dev / test: records the message; logs only the masked number and the purpose. */
export class LogChannelAdapter implements ChannelAdapter {
  readonly provider = 'log';
  readonly sent: Array<{ channel: MessagingChannel; to: string; purpose: string; text: string }> = [];
  private n = 0;
  constructor(private readonly channel: MessagingChannel) {}
  canSend(): boolean {
    return true;
  }
  async send(message: OutboundMessage): Promise<OutboundSendResult> {
    this.n += 1;
    this.sent.push({ channel: this.channel, to: message.to_e164, purpose: message.purpose, text: smsText(message) });
    log.log(`${this.channel} (log) to ${maskPhone(message.to_e164)} purpose=${message.purpose}`);
    return { outcome: 'sent', provider: 'log', provider_message_id: `log-${this.n}` };
  }
}

// ── AWS End User Messaging SMS (US) ───────────────────────────────────────────
export interface AwsSmsConfig {
  region: string;
  origination_identity: string;
  configuration_set?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function awsSmsConfigFromEnv(env: NodeJS.ProcessEnv): AwsSmsConfig | null {
  const origination = env['SIGN_SMS_AWS_ORIGINATION_IDENTITY']?.trim();
  const region = (env['SIGN_SMS_AWS_REGION'] ?? env['AWS_REGION'])?.trim();
  if (!origination || !region) return null;
  const key = env['SIGN_SMS_AWS_ACCESS_KEY_ID']?.trim();
  const secret = env['SIGN_SMS_AWS_SECRET_ACCESS_KEY']?.trim();
  const set = env['SIGN_SMS_AWS_CONFIGURATION_SET']?.trim();
  return {
    region,
    origination_identity: origination,
    ...(set ? { configuration_set: set } : {}),
    ...(key && secret ? { credentials: { accessKeyId: key, secretAccessKey: secret } } : {}),
  };
}

export interface SmsClientLike {
  send(command: SendTextMessageCommand): Promise<{ MessageId?: string }>;
}

export class AwsEndUserMessagingSmsAdapter implements ChannelAdapter {
  readonly provider = 'aws-end-user-messaging';
  private readonly client: SmsClientLike;
  constructor(
    private readonly config: AwsSmsConfig,
    client?: SmsClientLike,
  ) {
    this.client = client ?? new PinpointSMSVoiceV2Client({ region: config.region, ...(config.credentials ? { credentials: config.credentials } : {}) });
  }
  /** India needs DLT: those numbers go to MSG91, never here. */
  canSend(to_e164: string): boolean {
    return !to_e164.startsWith('+91');
  }
  async send(message: OutboundMessage): Promise<OutboundSendResult> {
    try {
      const out = await this.client.send(
        new SendTextMessageCommand({
          DestinationPhoneNumber: message.to_e164,
          OriginationIdentity: this.config.origination_identity,
          MessageBody: smsText(message),
          MessageType: 'TRANSACTIONAL',
          ...(this.config.configuration_set ? { ConfigurationSetName: this.config.configuration_set } : {}),
          Context: { aramo_ref: message.reference },
        }),
      );
      return { outcome: 'sent', provider: this.provider, provider_message_id: out.MessageId ?? null };
    } catch (err) {
      const e = err as { name?: string; Reason?: string };
      if (e.Reason === 'DESTINATION_PHONE_NUMBER_OPTED_OUT') return { outcome: 'opted_out', provider: this.provider };
      return { outcome: 'failed', provider: this.provider, error_code: (e.Reason ?? e.name ?? 'send_failed').slice(0, 64) };
    }
  }
}

// ── MSG91 (India, DLT) ──────────────────────────────────────────────────────
// The Flow API sends a DLT-registered template; the template defines the text and its
// variables (##sender##, ##link##, ##otp##, ##minutes##). Without a template id for a
// purpose, that purpose is not sent (TRAI: unregistered content is blocked).
export interface Msg91Config {
  auth_key: string;
  templates: Partial<Record<OutboundMessage['purpose'], string>>;
  base_url: string;
}

export function msg91ConfigFromEnv(env: NodeJS.ProcessEnv): Msg91Config | null {
  const auth_key = env['SIGN_SMS_MSG91_AUTH_KEY']?.trim();
  if (!auth_key) return null;
  const templates: Msg91Config['templates'] = {};
  for (const p of ['INVITATION', 'REMINDER', 'OTP'] as const) {
    const t = env[`SIGN_SMS_MSG91_TEMPLATE_${p}`]?.trim();
    if (t) templates[p] = t;
  }
  if (Object.keys(templates).length === 0) return null;
  return { auth_key, templates, base_url: 'https://control.msg91.com/api/v5/flow' };
}

export class Msg91SmsAdapter implements ChannelAdapter {
  readonly provider = 'msg91';
  constructor(
    private readonly config: Msg91Config,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}
  canSend(to_e164: string): boolean {
    return to_e164.startsWith('+91');
  }
  async send(message: OutboundMessage): Promise<OutboundSendResult> {
    const template_id = this.config.templates[message.purpose];
    if (template_id === undefined) return { outcome: 'failed', provider: this.provider, error_code: 'dlt_template_not_configured' };
    const v = message.variables;
    const recipient: Record<string, string> = { mobiles: message.to_e164.slice(1) };
    if (v.sender_name !== undefined) recipient['sender'] = v.sender_name.slice(0, 30);
    if (v.signing_url !== undefined) recipient['link'] = v.signing_url;
    if (v.code !== undefined) recipient['otp'] = v.code;
    if (v.ttl_minutes !== undefined) recipient['minutes'] = String(v.ttl_minutes);
    try {
      const res = await this.fetchImpl(this.config.base_url, {
        method: 'POST',
        headers: { authkey: this.config.auth_key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ template_id, short_url: '0', recipients: [recipient] }),
      });
      const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
      if (!res.ok || body.type !== 'success') return { outcome: 'failed', provider: this.provider, error_code: `http_${res.status}` };
      return { outcome: 'sent', provider: this.provider, provider_message_id: typeof body.message === 'string' ? body.message.slice(0, 128) : null };
    } catch (err) {
      return { outcome: 'failed', provider: this.provider, error_code: ((err as Error).name ?? 'network_error').slice(0, 64) };
    }
  }
}

// ── Meta WhatsApp Cloud API ─────────────────────────────────────────────────
// Business-initiated messages must be PRE-APPROVED templates. The template's body takes
// two text parameters in this order: {{1}} the sender's name, {{2}} the signing link.
export interface MetaWhatsAppConfig {
  phone_number_id: string;
  access_token: string;
  templates: Partial<Record<'INVITATION' | 'REMINDER', string>>;
  language: string;
  graph_version: string;
}

export function metaWhatsAppConfigFromEnv(env: NodeJS.ProcessEnv): MetaWhatsAppConfig | null {
  const phone_number_id = env['SIGN_WHATSAPP_PHONE_NUMBER_ID']?.trim();
  const access_token = env['SIGN_WHATSAPP_ACCESS_TOKEN']?.trim();
  const invitation = env['SIGN_WHATSAPP_TEMPLATE_INVITATION']?.trim();
  if (!phone_number_id || !access_token || !invitation) return null;
  const reminder = env['SIGN_WHATSAPP_TEMPLATE_REMINDER']?.trim();
  return {
    phone_number_id,
    access_token,
    templates: { INVITATION: invitation, REMINDER: reminder || invitation },
    language: env['SIGN_WHATSAPP_TEMPLATE_LANGUAGE']?.trim() || 'en_US',
    graph_version: env['SIGN_WHATSAPP_GRAPH_VERSION']?.trim() || 'v21.0',
  };
}

export class MetaWhatsAppAdapter implements ChannelAdapter {
  readonly provider = 'meta-whatsapp';
  constructor(
    private readonly config: MetaWhatsAppConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}
  canSend(): boolean {
    return true;
  }
  async send(message: OutboundMessage): Promise<OutboundSendResult> {
    if (message.purpose === 'OTP') return { outcome: 'failed', provider: this.provider, error_code: 'purpose_not_supported' };
    const name = this.config.templates[message.purpose];
    if (name === undefined) return { outcome: 'failed', provider: this.provider, error_code: 'template_not_configured' };
    const v = message.variables;
    try {
      const res = await this.fetchImpl(`https://graph.facebook.com/${this.config.graph_version}/${this.config.phone_number_id}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: message.to_e164.slice(1),
          type: 'template',
          biz_opaque_callback_data: message.reference,
          template: {
            name,
            language: { code: this.config.language },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: (v.sender_name ?? 'Someone').slice(0, 60) },
                  { type: 'text', text: v.signing_url ?? '' },
                ],
              },
            ],
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }>; error?: { code?: number } };
      if (!res.ok) return { outcome: 'failed', provider: this.provider, error_code: body.error?.code !== undefined ? `meta_${body.error.code}` : `http_${res.status}` };
      return { outcome: 'sent', provider: this.provider, provider_message_id: body.messages?.[0]?.id ?? null };
    } catch (err) {
      return { outcome: 'failed', provider: this.provider, error_code: ((err as Error).name ?? 'network_error').slice(0, 64) };
    }
  }
}

// ── The routing port ────────────────────────────────────────────────────────
export class RoutingOutboundMessaging implements OutboundMessagingPort {
  readonly channels: ReadonlySet<MessagingChannel>;
  constructor(private readonly adapters: Partial<Record<MessagingChannel, readonly ChannelAdapter[]>>) {
    this.channels = new Set((Object.keys(adapters) as MessagingChannel[]).filter((c) => (adapters[c]?.length ?? 0) > 0));
  }
  private pick(channel: MessagingChannel, to_e164: string): ChannelAdapter | undefined {
    return this.adapters[channel]?.find((a) => a.canSend(to_e164));
  }
  canSend(channel: MessagingChannel, to_e164: string): boolean {
    return this.pick(channel, to_e164) !== undefined;
  }
  async send(message: OutboundMessage): Promise<OutboundSendResult> {
    const a = this.pick(message.channel, message.to_e164);
    if (a === undefined) return { outcome: 'failed', provider: 'none', error_code: 'no_provider_for_destination' };
    return a.send(message);
  }
}

function wanted(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '' && s !== 'disabled'));
}

export function outboundMessagingFromEnv(env: NodeJS.ProcessEnv = process.env): OutboundMessagingPort {
  const sms: ChannelAdapter[] = [];
  const whatsapp: ChannelAdapter[] = [];
  const smsWanted = wanted(env['SIGN_SMS_PROVIDER']);
  if (smsWanted.has('log')) sms.push(new LogChannelAdapter('SMS'));
  if (smsWanted.has('msg91')) {
    const cfg = msg91ConfigFromEnv(env);
    if (cfg === null) log.error('SIGN_SMS_PROVIDER includes msg91 but SIGN_SMS_MSG91_AUTH_KEY and at least one SIGN_SMS_MSG91_TEMPLATE_* DLT template id are not set; MSG91 is off');
    else sms.push(new Msg91SmsAdapter(cfg));
  }
  if (smsWanted.has('aws')) {
    const cfg = awsSmsConfigFromEnv(env);
    if (cfg === null) log.error('SIGN_SMS_PROVIDER includes aws but SIGN_SMS_AWS_ORIGINATION_IDENTITY / a region are not set; AWS SMS is off');
    else sms.push(new AwsEndUserMessagingSmsAdapter(cfg));
  }
  for (const w of smsWanted) if (!['log', 'aws', 'msg91'].includes(w)) log.error(`SIGN_SMS_PROVIDER: unknown provider "${w}" ignored`);

  const waWanted = wanted(env['SIGN_WHATSAPP_PROVIDER']);
  if (waWanted.has('log')) whatsapp.push(new LogChannelAdapter('WHATSAPP'));
  if (waWanted.has('meta')) {
    const cfg = metaWhatsAppConfigFromEnv(env);
    if (cfg === null) log.error('SIGN_WHATSAPP_PROVIDER is meta but SIGN_WHATSAPP_PHONE_NUMBER_ID / SIGN_WHATSAPP_ACCESS_TOKEN / SIGN_WHATSAPP_TEMPLATE_INVITATION are not all set; WhatsApp is off');
    else whatsapp.push(new MetaWhatsAppAdapter(cfg));
  }
  for (const w of waWanted) if (!['log', 'meta'].includes(w)) log.error(`SIGN_WHATSAPP_PROVIDER: unknown provider "${w}" ignored`);

  if (sms.length === 0 && whatsapp.length === 0) return new DisabledOutboundMessaging();
  return new RoutingOutboundMessaging({ ...(sms.length > 0 ? { SMS: sms } : {}), ...(whatsapp.length > 0 ? { WHATSAPP: whatsapp } : {}) });
}
