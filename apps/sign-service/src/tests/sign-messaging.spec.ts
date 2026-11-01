import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import type { AuthContextType } from '@aramo/auth';
import type {
  DocumentSourceProviderPort,
  EsignRepository,
  EsignService,
  LedgerAppend,
  NewDelivery,
  OutboundMessage,
  OutboundMessagingPort,
  OutboundSendResult,
  RecipientMessagingRow,
  SessionContext,
  SignMessagingRepository,
  SignUsageRecord,
} from '@aramo/sign';
import { phoneHash } from '@aramo/sign';

import {
  AwsEndUserMessagingSmsAdapter,
  DisabledOutboundMessaging,
  LogChannelAdapter,
  MetaWhatsAppAdapter,
  MSG91_DLT_ENTITY_FIELD,
  MSG91_SENDER_FIELD,
  Msg91SmsAdapter,
  RoutingOutboundMessaging,
  msg91ConfigFromEnv,
  outboundMessagingFromEnv,
  smsText,
  type FetchLike,
} from '../app/messaging/messaging-adapters.js';
import { SignMessagingService } from '../app/messaging/sign-messaging.service.js';
import { RecipientOtpService } from '../app/messaging/recipient-otp.service.js';
import { SenderMessagingService } from '../app/messaging/sender-messaging.service.js';
import { SignSmsInboundWebhookController, SignWhatsAppWebhookController, verifyMetaSignature } from '../app/messaging/sign-messaging.controller.js';
import { SnsInboundRejectedError, SnsMessageVerifier, isSnsHostUrl, parseSnsMessage, snsStringToSign, type SnsHttpGet, type SnsMessage } from '../app/messaging/aws-sns-inbound.js';
import { SignFeatureGate } from '../app/sign-feature.gate.js';
import { EsignSignerController } from '../app/esign-http.controller.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';
import type { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 SMS / §1.8 WhatsApp / §1.9 SMS
// OTP, Amendment A1 — stubs only: no test calls a live vendor.

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENVELOPE = '22222222-2222-7222-8222-222222222222';
const SIGNER = '33333333-3333-7333-8333-333333333333';
const SESSION = '44444444-4444-7444-8444-444444444444';
const US = '+14155550123';
const IN = '+919876543210';

const ALL_ON = { ...FEATURE_AVAILABILITY, 'sign.sms_delivery': 'AVAILABLE', 'sign.whatsapp_delivery': 'AVAILABLE', 'sign.sms_otp': 'AVAILABLE' } as const;
const onGate = () => new SignFeatureGate(ALL_ON);
const offGate = () => new SignFeatureGate();
const NO_QUIET = { SIGN_MESSAGING_QUIET_HOURS: 'off' } as NodeJS.ProcessEnv;

// ── An in-memory SignMessagingRepository ─────────────────────────────────────
type Challenge = { id: string; tenant_id: string; envelope_id: string; signer_id: string; session_id: string; phone_hash: string | null; phone_masked: string | null; code_hash: string; status: string; attempts: number; expires_at: Date; created_at: Date };

class FakeRepo {
  settings = new Map<string, RecipientMessagingRow>();
  deliveries: Array<NewDelivery & { id: string }> = [];
  ledger: Array<LedgerAppend & { signer_id: string | null }> = [];
  optOuts = new Map<string, { opted_out: boolean; source: string }>();
  challenges: Challenge[] = [];
  sent = { last_hour: 0, last_day: 0 };
  terminal = false;
  envelope: { status: string; created_by: string } | null = { status: 'SENT', created_by: SIGNER };
  signerKind = 'SIGNER';
  private n = 0;

  async envelopeAndSigner(_t: string, _e: string, signer_id?: string) {
    return { envelope: this.envelope, signer: signer_id === undefined ? null : { id: signer_id, recipient_kind: this.signerKind } };
  }

  setSetting(row: Partial<RecipientMessagingRow>) {
    const now = new Date();
    this.settings.set(SIGNER, { signer_id: SIGNER, tenant_id: TENANT, envelope_id: ENVELOPE, delivery_channel: null, phone_e164: US, timezone: null, sms_otp_required: false, updated_by: SIGNER, created_at: now, updated_at: now, ...row });
  }
  async settingFor(_t: string, signer_id: string) {
    return this.settings.get(signer_id) ?? null;
  }
  async settingsFor() {
    return [...this.settings.values()];
  }
  async upsertSetting(row: Omit<RecipientMessagingRow, 'created_at' | 'updated_at'>) {
    const r = { ...row, created_at: new Date(), updated_at: new Date() };
    this.settings.set(row.signer_id, r);
    return r;
  }
  async deleteSetting(_t: string, signer_id: string) {
    this.settings.delete(signer_id);
  }
  async deliveriesFor() {
    return this.deliveries.map((d) => ({ ...d, suppressed_reason: d.suppressed_reason ?? null, error_code: d.error_code ?? null, created_at: new Date(), sent_at: d.sent_at ?? null, status_updated_at: null }));
  }
  async sentCounts() {
    return this.sent;
  }
  async recordDelivery(d: NewDelivery, ledger: LedgerAppend | null) {
    const id = d.id ?? `d${++this.n}`;
    this.deliveries.push({ ...d, id });
    const ledgered = ledger !== null && !this.terminal;
    if (ledgered) this.ledger.push({ ...ledger, payload: { ...ledger.payload, delivery_id: id }, signer_id: d.signer_id });
    return { id, ledgered };
  }
  async isOptedOut(hash: string, channel: string) {
    return this.optOuts.get(`${hash}:${channel}`)?.opted_out === true;
  }
  async setOptOut(hash: string, channel: string, opted_out: boolean, source: string) {
    this.optOuts.set(`${hash}:${channel}`, { opted_out, source });
  }
  async otpHistory(_t: string, signer_id: string, since: Date) {
    return this.challenges.filter((c) => c.signer_id === signer_id && c.created_at >= since).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }
  async lockedChallengeCount() {
    return this.challenges.filter((c) => c.status === 'LOCKED').length;
  }
  async activeChallenge(_t: string, session_id: string) {
    return [...this.challenges].reverse().find((c) => c.session_id === session_id && c.status === 'ACTIVE') ?? null;
  }
  async isSessionVerified(_t: string, session_id: string) {
    return this.challenges.some((c) => c.session_id === session_id && c.status === 'VERIFIED');
  }
  async createChallenge(i: Omit<Challenge, 'status' | 'attempts' | 'created_at'> & { now: Date }) {
    for (const c of this.challenges) if (c.signer_id === i.signer_id && c.status === 'ACTIVE') c.status = 'SUPERSEDED';
    this.challenges.push({ id: i.id, tenant_id: i.tenant_id, envelope_id: i.envelope_id, signer_id: i.signer_id, session_id: i.session_id, phone_hash: i.phone_hash, phone_masked: i.phone_masked, code_hash: i.code_hash, status: 'ACTIVE', attempts: 0, expires_at: i.expires_at, created_at: i.now });
  }
  async withdrawChallenge(id: string) {
    const c = this.challenges.find((x) => x.id === id);
    if (c?.status === 'ACTIVE') c.status = 'SUPERSEDED';
  }
  async recordOtpAttempt(i: { challenge_id: string; expected_attempts: number; outcome: string; ledger: LedgerAppend[]; signer_id: string }) {
    const c = this.challenges.find((x) => x.id === i.challenge_id);
    if (c === undefined || c.status !== 'ACTIVE') return false;
    if (i.outcome !== 'EXPIRED' && c.attempts !== i.expected_attempts) return false;
    if (i.outcome !== 'EXPIRED') c.attempts += 1;
    if (i.outcome === 'VERIFIED') c.status = 'VERIFIED';
    if (i.outcome === 'LOCKED') c.status = 'LOCKED';
    if (i.outcome === 'EXPIRED') c.status = 'EXPIRED';
    for (const e of i.ledger) this.ledger.push({ ...e, signer_id: i.signer_id });
    return true;
  }
  async appendLedger(_t: string, _e: string, signer_id: string | null, events: LedgerAppend[]) {
    for (const e of events) this.ledger.push({ ...e, signer_id });
    return true;
  }
}

class StubPort implements OutboundMessagingPort {
  readonly channels: ReadonlySet<'SMS' | 'WHATSAPP'> = new Set(['SMS', 'WHATSAPP'] as const);
  readonly sent: OutboundMessage[] = [];
  constructor(private readonly result: (m: OutboundMessage) => OutboundSendResult = () => ({ outcome: 'sent', provider: 'stub', provider_message_id: 'pm-1' })) {}
  canSend(): boolean {
    return true;
  }
  async send(m: OutboundMessage): Promise<OutboundSendResult> {
    this.sent.push(m);
    return this.result(m);
  }
}

function service(repo: FakeRepo, port: OutboundMessagingPort, gate = onGate(), env: NodeJS.ProcessEnv = NO_QUIET, usage?: { record: (u: SignUsageRecord) => Promise<void> }) {
  return new SignMessagingService(repo as unknown as SignMessagingRepository, port, gate, undefined, usage, env);
}

const link = { tenant_id: TENANT, envelope_id: ENVELOPE, signer_id: SIGNER, purpose: 'INVITATION' as const, signing_url: 'https://sign.example/s/RAW-TOKEN' };

// ── Feature availability ─────────────────────────────────────────────────────
describe('feature availability — dark', () => {
  it('sign.sms_delivery, sign.whatsapp_delivery and sign.sms_otp are NOT_AVAILABLE', () => {
    expect(FEATURE_AVAILABILITY['sign.sms_delivery']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.whatsapp_delivery']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.sms_otp']).toBe('NOT_AVAILABLE');
  });
});

// ── Adapters ─────────────────────────────────────────────────────────────────
describe('outbound messaging adapters (env unset = off)', () => {
  it('no provider configured ⇒ disabled, no channel', async () => {
    const p = outboundMessagingFromEnv({});
    expect(p).toBeInstanceOf(DisabledOutboundMessaging);
    expect(p.channels.size).toBe(0);
    expect(await p.send({ channel: 'SMS', purpose: 'INVITATION', to_e164: US, variables: {}, reference: 'r' })).toEqual({ outcome: 'failed', provider: 'none', error_code: 'sms_not_configured' });
  });

  it('a provider with incomplete settings is left out, never fatal', () => {
    expect(outboundMessagingFromEnv({ SIGN_SMS_PROVIDER: 'aws' }).channels.size).toBe(0);
    expect(outboundMessagingFromEnv({ SIGN_SMS_PROVIDER: 'msg91', SIGN_SMS_MSG91_AUTH_KEY: 'k' }).channels.size).toBe(0);
    expect(outboundMessagingFromEnv({ SIGN_WHATSAPP_PROVIDER: 'meta', SIGN_WHATSAPP_ACCESS_TOKEN: 't' }).channels.size).toBe(0);
  });

  it('routes +91 to MSG91 (DLT) and every other number to AWS', () => {
    const p = outboundMessagingFromEnv({
      SIGN_SMS_PROVIDER: 'aws,msg91',
      SIGN_SMS_AWS_ORIGINATION_IDENTITY: 'pool-1',
      SIGN_SMS_AWS_REGION: 'us-east-1',
      SIGN_SMS_MSG91_AUTH_KEY: 'k',
      SIGN_SMS_MSG91_TEMPLATE_INVITATION: 'dlt-1',
    });
    expect(p).toBeInstanceOf(RoutingOutboundMessaging);
    expect(p.canSend('SMS', US)).toBe(true);
    expect(p.canSend('SMS', IN)).toBe(true);
    expect(p.canSend('WHATSAPP', US)).toBe(false);
    const awsOnly = outboundMessagingFromEnv({ SIGN_SMS_PROVIDER: 'aws', SIGN_SMS_AWS_ORIGINATION_IDENTITY: 'pool-1', SIGN_SMS_AWS_REGION: 'us-east-1' });
    expect(awsOnly.canSend('SMS', IN)).toBe(false);
  });

  it('the SMS text carries the link and STOP wording; the OTP text carries the code', () => {
    expect(smsText({ channel: 'SMS', purpose: 'INVITATION', to_e164: US, reference: 'r', variables: { sender_name: 'Acme', signing_url: 'https://x/s/T' } })).toBe('Acme sent you a document to sign with Aramo Sign: https://x/s/T Reply STOP to opt out.');
    expect(smsText({ channel: 'SMS', purpose: 'OTP', to_e164: US, reference: 'r', variables: { code: '123456', ttl_minutes: 10 } })).toContain('123456');
  });

  it('AWS End User Messaging: sends a TRANSACTIONAL text from the origination identity; maps the opt-out refusal', async () => {
    const calls: unknown[] = [];
    const client = { send: vi.fn(async (cmd: { input: unknown }) => { calls.push(cmd.input); return { MessageId: 'aws-1' }; }) };
    const a = new AwsEndUserMessagingSmsAdapter({ region: 'us-east-1', origination_identity: 'pool-1', configuration_set: 'cs' }, client as never);
    const out = await a.send({ channel: 'SMS', purpose: 'INVITATION', to_e164: US, reference: 'ref-1', variables: { signing_url: 'https://x/s/T' } });
    expect(out).toEqual({ outcome: 'sent', provider: 'aws-end-user-messaging', provider_message_id: 'aws-1' });
    expect(calls[0]).toMatchObject({ DestinationPhoneNumber: US, OriginationIdentity: 'pool-1', MessageType: 'TRANSACTIONAL', ConfigurationSetName: 'cs', Context: { aramo_ref: 'ref-1' } });
    expect(a.canSend(IN)).toBe(false);

    const optedOut = new AwsEndUserMessagingSmsAdapter({ region: 'us-east-1', origination_identity: 'pool-1' }, { send: async () => { throw Object.assign(new Error('x'), { name: 'ConflictException', Reason: 'DESTINATION_PHONE_NUMBER_OPTED_OUT' }); } } as never);
    expect(await optedOut.send({ channel: 'SMS', purpose: 'INVITATION', to_e164: US, reference: 'r', variables: {} })).toEqual({ outcome: 'opted_out', provider: 'aws-end-user-messaging' });
    const failing = new AwsEndUserMessagingSmsAdapter({ region: 'us-east-1', origination_identity: 'pool-1' }, { send: async () => { throw Object.assign(new Error('x'), { name: 'ThrottlingException' }); } } as never);
    expect(await failing.send({ channel: 'SMS', purpose: 'INVITATION', to_e164: US, reference: 'r', variables: {} })).toEqual({ outcome: 'failed', provider: 'aws-end-user-messaging', error_code: 'ThrottlingException' });
  });

  it('MSG91: sends the DLT template with variables; refuses a purpose without a template id', async () => {
    let req: { url: string; body: string; headers: Record<string, string> } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      req = { url, body: init.body, headers: init.headers };
      return { ok: true, status: 200, json: async () => ({ type: 'success', message: 'req-9' }) };
    };
    const a = new Msg91SmsAdapter({ auth_key: 'AUTH', templates: { INVITATION: 'dlt-inv' }, base_url: 'https://msg91.test/flow' }, fetchImpl);
    expect(await a.send({ channel: 'SMS', purpose: 'INVITATION', to_e164: IN, reference: 'r', variables: { sender_name: 'Acme', signing_url: 'https://x/s/T' } })).toEqual({ outcome: 'sent', provider: 'msg91', provider_message_id: 'req-9' });
    expect(req?.headers['authkey']).toBe('AUTH');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ template_id: 'dlt-inv', short_url: '0', recipients: [{ mobiles: '919876543210', sender: 'Acme', link: 'https://x/s/T' }] });
    expect(await a.send({ channel: 'SMS', purpose: 'OTP', to_e164: IN, reference: 'r', variables: { code: '1' } })).toEqual({ outcome: 'failed', provider: 'msg91', error_code: 'dlt_template_not_configured' });
    expect(a.canSend(US)).toBe(false);
  });

  it('Meta WhatsApp: sends only the approved template; never an OTP', async () => {
    let req: { url: string; body: string } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      req = { url, body: init.body };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
    };
    const a = new MetaWhatsAppAdapter({ phone_number_id: 'PN', access_token: 'T', templates: { INVITATION: 'sign_invite', REMINDER: 'sign_invite' }, language: 'en_US', graph_version: 'v21.0' }, fetchImpl);
    expect(await a.send({ channel: 'WHATSAPP', purpose: 'INVITATION', to_e164: US, reference: 'ref', variables: { sender_name: 'Acme', signing_url: 'https://x/s/T' } })).toEqual({ outcome: 'sent', provider: 'meta-whatsapp', provider_message_id: 'wamid.1' });
    expect(req?.url).toBe('https://graph.facebook.com/v21.0/PN/messages');
    const body = JSON.parse(req?.body ?? '{}');
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '14155550123', type: 'template', template: { name: 'sign_invite', language: { code: 'en_US' } } });
    expect(await a.send({ channel: 'WHATSAPP', purpose: 'OTP', to_e164: US, reference: 'r', variables: {} })).toEqual({ outcome: 'failed', provider: 'meta-whatsapp', error_code: 'purpose_not_supported' });
  });

  it('log adapters are recognised for dev / test', () => {
    const p = outboundMessagingFromEnv({ SIGN_SMS_PROVIDER: 'log', SIGN_WHATSAPP_PROVIDER: 'log' });
    expect([...p.channels].sort()).toEqual(['SMS', 'WHATSAPP']);
    expect(new LogChannelAdapter('SMS').canSend()).toBe(true);
  });
});

// ── Delivery policy ──────────────────────────────────────────────────────────
describe('SignMessagingService — signing-link delivery policy', () => {
  it('no channel chosen, or the feature NOT_AVAILABLE ⇒ nothing is sent or recorded', async () => {
    const repo = new FakeRepo();
    const port = new StubPort();
    await service(repo, port).deliverSigningLink(link);
    repo.setSetting({ delivery_channel: 'SMS' });
    await service(repo, port, offGate()).deliverSigningLink(link);
    expect(port.sent).toHaveLength(0);
    expect(repo.deliveries).toHaveLength(0);
  });

  it('sends the link, records SENT, appends SIGNER_MESSAGE_SENT (masked number) and one usage record', async () => {
    const repo = new FakeRepo();
    repo.setSetting({ delivery_channel: 'SMS' });
    const port = new StubPort();
    const usage: SignUsageRecord[] = [];
    await service(repo, port, onGate(), NO_QUIET, { record: async (u) => void usage.push(u) }).deliverSigningLink(link);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ channel: 'SMS', purpose: 'INVITATION', to_e164: US, variables: { signing_url: link.signing_url } });
    expect(repo.deliveries[0]).toMatchObject({ status: 'SENT', provider: 'stub', provider_message_id: 'pm-1', phone_hash: phoneHash(US) });
    expect(repo.ledger[0]).toMatchObject({ event_type: 'SIGNER_MESSAGE_SENT', payload: { channel: 'SMS', purpose: 'INVITATION', phone: `+1${'•'.repeat(8)}23` } });
    expect(JSON.stringify(repo.ledger)).not.toContain('RAW-TOKEN');
    expect(JSON.stringify(repo.deliveries)).not.toContain(US);
    expect(usage).toEqual([expect.objectContaining({ tenant_id: TENANT, unit: 'sign.sms_message', quantity: 1, idempotency_key: `sign-message:${repo.deliveries[0]?.id}` })]);
  });

  it('WhatsApp uses its own feature and usage unit', async () => {
    const repo = new FakeRepo();
    repo.setSetting({ delivery_channel: 'WHATSAPP' });
    const usage: SignUsageRecord[] = [];
    await service(repo, new StubPort(), new SignFeatureGate({ ...FEATURE_AVAILABILITY, 'sign.whatsapp_delivery': 'AVAILABLE' }), NO_QUIET, { record: async (u) => void usage.push(u) }).deliverSigningLink(link);
    expect(usage[0]?.unit).toBe('sign.whatsapp_message');
  });

  it('STOP: an opted-out number is SUPPRESSED (opted_out), never sent', async () => {
    const repo = new FakeRepo();
    repo.setSetting({ delivery_channel: 'SMS' });
    const port = new StubPort();
    const svc = service(repo, port);
    expect(await svc.inboundMessage('SMS', US, 'STOP')).toBe('OPT_OUT');
    await svc.deliverSigningLink(link);
    expect(port.sent).toHaveLength(0);
    expect(repo.deliveries[0]).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'opted_out' });
    expect(repo.ledger[0]).toMatchObject({ event_type: 'SIGNER_MESSAGE_SUPPRESSED', payload: { reason: 'opted_out' } });
    expect(await svc.inboundMessage('SMS', US, 'start')).toBe('OPT_IN');
    await svc.deliverSigningLink(link);
    expect(port.sent).toHaveLength(1);
  });

  it('quiet hours in the recipient zone ⇒ SUPPRESSED (quiet_hours)', async () => {
    const repo = new FakeRepo();
    const hour = new Date().getUTCHours();
    repo.setSetting({ delivery_channel: 'SMS', timezone: 'UTC' });
    const port = new StubPort();
    await service(repo, port, onGate(), { SIGN_MESSAGING_QUIET_HOURS: `${hour}-${(hour + 1) % 24}` }).deliverSigningLink(link);
    expect(port.sent).toHaveLength(0);
    expect(repo.deliveries[0]).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'quiet_hours' });
  });

  it('per-tenant rate limit ⇒ SUPPRESSED (rate_limited)', async () => {
    const repo = new FakeRepo();
    repo.setSetting({ delivery_channel: 'SMS' });
    repo.sent = { last_hour: 3, last_day: 3 };
    const port = new StubPort();
    await service(repo, port, onGate(), { ...NO_QUIET, SIGN_MESSAGING_TENANT_HOURLY_LIMIT: '3' }).deliverSigningLink(link);
    expect(port.sent).toHaveLength(0);
    expect(repo.deliveries[0]).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'rate_limited' });
  });

  it('a vendor opt-out is added to the list; a vendor failure is FAILED; neither throws', async () => {
    const repo = new FakeRepo();
    repo.setSetting({ delivery_channel: 'SMS' });
    await service(repo, new StubPort(() => ({ outcome: 'opted_out', provider: 'stub' }))).deliverSigningLink(link);
    expect(repo.optOuts.get(`${phoneHash(US)}:SMS`)).toEqual({ opted_out: true, source: 'PROVIDER' });
    const repo2 = new FakeRepo();
    repo2.setSetting({ delivery_channel: 'SMS' });
    await service(repo2, new StubPort(() => ({ outcome: 'failed', provider: 'stub', error_code: 'boom' }))).deliverSigningLink(link);
    expect(repo2.deliveries[0]).toMatchObject({ status: 'FAILED', error_code: 'boom' });
    expect(repo2.ledger[0]).toMatchObject({ event_type: 'SIGNER_MESSAGE_FAILED' });
    const throwing = new StubPort(() => { throw new Error('network'); });
    await expect(service(new FakeRepo(), throwing).deliverSigningLink(link)).resolves.toBeUndefined();
  });

  it('no provider can reach the number ⇒ SUPPRESSED (channel_unavailable)', async () => {
    const repo = new FakeRepo();
    repo.setSetting({ delivery_channel: 'SMS' });
    await service(repo, new DisabledOutboundMessaging()).deliverSigningLink(link);
    expect(repo.deliveries[0]).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'channel_unavailable' });
  });

  it('a terminal envelope gets a delivery row but no ledger event', async () => {
    const repo = new FakeRepo();
    repo.terminal = true;
    repo.setSetting({ delivery_channel: 'SMS' });
    await service(repo, new StubPort()).deliverSigningLink(link);
    expect(repo.deliveries).toHaveLength(1);
    expect(repo.ledger).toHaveLength(0);
  });
});

// ── SMS one-time code ────────────────────────────────────────────────────────
describe('RecipientOtpService — SMS one-time code (§1.9)', () => {
  const ctx: SessionContext = { session_id: SESSION, tenant_id: TENANT, envelope_id: ENVELOPE, signer_id: SIGNER };

  function setup(result?: (m: OutboundMessage) => OutboundSendResult) {
    const repo = new FakeRepo();
    repo.setSetting({ sms_otp_required: true });
    const port = new StubPort(result);
    const otp = new RecipientOtpService(repo as unknown as SignMessagingRepository, service(repo, port));
    const lastCode = () => port.sent.at(-1)?.variables.code ?? '';
    return { repo, port, otp, lastCode };
  }

  async function reason(p: Promise<unknown>): Promise<{ status: number; reason: unknown; details: Record<string, unknown> }> {
    try {
      await p;
    } catch (e) {
      const err = e as AramoError;
      const details = (err.context?.details ?? {}) as Record<string, unknown>;
      return { status: err.statusCode, reason: details['reason'], details };
    }
    throw new Error('expected a refusal');
  }

  it('not required ⇒ the gate passes', async () => {
    const repo = new FakeRepo();
    const otp = new RecipientOtpService(repo as unknown as SignMessagingRepository, service(repo, new StubPort()));
    await expect(otp.assertVerified(ctx, 'r')).resolves.toBeUndefined();
    expect(await otp.status(ctx)).toMatchObject({ required: false });
  });

  it('required ⇒ the gate refuses until a sent code is verified; every step is a ledger event', async () => {
    const { repo, otp, lastCode } = setup();
    expect((await reason(otp.assertVerified(ctx, 'r'))).reason).toBe('recipient_verification_required');

    const sent = await otp.send(ctx, 'r');
    expect(sent).toMatchObject({ sent: true, verified: false });
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(repo.challenges[0]?.code_hash).not.toContain(lastCode());
    expect(repo.ledger.map((e) => e.event_type)).toEqual(['RECIPIENT_OTP_SENT']);
    expect(JSON.stringify(repo.ledger)).not.toContain(lastCode());

    const wrong = lastCode() === '000000' ? '111111' : '000000';
    const r1 = await reason(otp.verify(ctx, wrong, 'r'));
    expect(r1.reason).toBe('otp_mismatch');
    expect(r1.details['attempts_remaining']).toBe(4);

    expect(await otp.verify(ctx, lastCode(), 'r')).toEqual({ verified: true });
    await expect(otp.assertVerified(ctx, 'r')).resolves.toBeUndefined();
    expect(repo.ledger.map((e) => e.event_type)).toEqual(['RECIPIENT_OTP_SENT', 'RECIPIENT_OTP_FAILED', 'RECIPIENT_OTP_VERIFIED']);
    expect(repo.ledger[2]?.payload).toMatchObject({ method: 'SMS_OTP', phone: `+1${'•'.repeat(8)}23` });
    // The verification belongs to this session only.
    await expect(otp.assertVerified({ ...ctx, session_id: '55555555-5555-7555-8555-555555555555' }, 'r')).rejects.toBeInstanceOf(AramoError);
  });

  it('a second code within 60 s is refused (429 otp_resend_cooldown)', async () => {
    const { otp } = setup();
    await otp.send(ctx, 'r');
    expect((await reason(otp.send(ctx, 'r'))).reason).toBe('otp_resend_cooldown');
  });

  it('five wrong codes lock the code; three locked codes lock the recipient out (RECIPIENT_OTP_LOCKED)', async () => {
    const { repo, otp, lastCode } = setup();
    for (let round = 1; round <= 3; round += 1) {
      // allow a new send: age the earlier challenges past the resend gap
      for (const c of repo.challenges) c.created_at = new Date(c.created_at.getTime() - 120_000);
      await otp.send(ctx, 'r');
      const wrong = lastCode() === '000000' ? '111111' : '000000';
      for (let i = 1; i <= 4; i += 1) expect((await reason(otp.verify(ctx, wrong, 'r'))).reason).toBe('otp_mismatch');
      expect((await reason(otp.verify(ctx, wrong, 'r'))).reason).toBe(round < 3 ? 'otp_code_locked' : 'otp_locked');
    }
    expect(repo.ledger.filter((e) => e.event_type === 'RECIPIENT_OTP_LOCKED')).toHaveLength(1);
    expect((await reason(otp.send(ctx, 'r'))).reason).toBe('otp_locked');
    expect((await reason(otp.assertVerified(ctx, 'r'))).reason).toBe('recipient_verification_locked');
  });

  it('an undeliverable code is withdrawn and refused (503 otp_delivery_failed)', async () => {
    const { repo, otp } = setup(() => ({ outcome: 'failed', provider: 'stub', error_code: 'x' }));
    expect((await reason(otp.send(ctx, 'r'))).reason).toBe('otp_delivery_failed');
    expect(repo.challenges[0]?.status).toBe('SUPERSEDED');
    expect(repo.ledger).toHaveLength(0);
  });

  it('a code past its 10 minutes is refused as expired', async () => {
    const { repo, otp, lastCode } = setup();
    await otp.send(ctx, 'r');
    const c = repo.challenges[0];
    if (c !== undefined) c.expires_at = new Date(Date.now() - 1000);
    expect((await reason(otp.verify(ctx, lastCode(), 'r'))).reason).toBe('otp_expired');
  });
});

// ── Signer surface gate ──────────────────────────────────────────────────────
describe('EsignSignerController — the SMS-code gate in front of signer actions', () => {
  it('refuses document / fill / complete while unverified; unchanged when no gate is bound', async () => {
    const ctx: SessionContext = { session_id: SESSION, tenant_id: TENANT, envelope_id: ENVELOPE, signer_id: SIGNER };
    const svc = { resolveSession: vi.fn(async () => ctx), getSignerDocumentView: vi.fn(async () => ({ documents: [], fields: [], message: null })), fillField: vi.fn(), completeSigner: vi.fn() } as unknown as EsignService;
    const gate = { assertVerified: vi.fn(async () => { throw new AramoError('INSUFFICIENT_PERMISSIONS', 'code required', 403, { requestId: 'r', details: { reason: 'recipient_verification_required' } }); }) };
    const guarded = new EsignSignerController(svc, {} as EsignRepository, {} as DocumentSourceProviderPort, undefined, undefined, undefined, gate as unknown as RecipientOtpService);
    await expect(guarded.document({ token: 't' }, 'r')).rejects.toThrow(/code required/);
    await expect(guarded.fill('f1', { token: 't', value: 'x' }, 'r')).rejects.toThrow(/code required/);
    await expect(guarded.complete({ token: 't' }, 'r')).rejects.toThrow(/code required/);
    expect(svc.fillField).not.toHaveBeenCalled();
    const open = new EsignSignerController(svc, {} as EsignRepository, {} as DocumentSourceProviderPort);
    await expect(open.document({ token: 't' }, 'r')).resolves.toMatchObject({ documents: [] });
  });
});

// ── Sender settings ──────────────────────────────────────────────────────────
describe('SenderMessagingService — the sender sets SMS / WhatsApp / SMS_OTP per recipient', () => {
  const auth = { sub: '66666666-6666-7666-8666-666666666666', tenant_id: TENANT, scopes: [] } as unknown as AuthContextType;

  function setup(gate: SignFeatureGate, status = 'DRAFT', kind = 'SIGNER', port: OutboundMessagingPort = new StubPort()) {
    const repo = new FakeRepo();
    repo.envelope = { status, created_by: auth.sub };
    repo.signerKind = kind;
    const context = { assertCanAuthor: vi.fn(async () => undefined) } as unknown as SenderContextService;
    const envelopes = { assertMayChange: vi.fn(async () => undefined), assertVisible: vi.fn(async () => undefined) } as unknown as SenderEnvelopeService;
    const svc = new SenderMessagingService(repo as unknown as SignMessagingRepository, service(repo, port, gate), context, envelopes, gate);
    return { repo, svc };
  }

  async function code(p: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
    try {
      await p;
    } catch (e) {
      const err = e as AramoError;
      return { code: err.code, reason: ((err.context?.details ?? {}) as Record<string, unknown>)['reason'] };
    }
    throw new Error('expected a refusal');
  }

  it('every route is refused while all three features are NOT_AVAILABLE', async () => {
    const { svc } = setup(offGate());
    expect((await code(svc.get(auth, ENVELOPE, 'r'))).code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
    expect((await code(svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: US }, 'r'))).code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
  });

  it('each choice needs its own feature', async () => {
    const { svc } = setup(new SignFeatureGate({ ...FEATURE_AVAILABILITY, 'sign.sms_delivery': 'AVAILABLE' }));
    expect((await code(svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'WHATSAPP', phone_e164: US }, 'r'))).code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
    expect((await code(svc.put(auth, ENVELOPE, SIGNER, { sms_otp_required: true, phone_e164: US }, 'r'))).code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
    await expect(svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: US }, 'r')).resolves.toMatchObject({ delivery_channel: 'SMS' });
  });

  it('validates the number, the zone, the envelope state and the recipient kind', async () => {
    expect((await code(setup(onGate()).svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: '4155550123' }, 'r'))).reason).toBe('invalid_phone');
    expect((await code(setup(onGate()).svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: US, timezone: 'Nope/Zone' }, 'r'))).reason).toBe('invalid_timezone');
    expect((await code(setup(onGate(), 'SENT').svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: US }, 'r'))).reason).toBe('envelope_not_draft');
    expect((await code(setup(onGate(), 'DRAFT', 'RECEIVES_COPY').svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: US }, 'r'))).reason).toBe('recipient_kind_not_supported');
    expect((await code(setup(onGate(), 'DRAFT', 'SIGNER', new DisabledOutboundMessaging()).svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: US }, 'r'))).reason).toBe('messaging_provider_not_configured');
  });

  it('stores, reads back (with masked number) and clears the choice', async () => {
    const { repo, svc } = setup(onGate());
    await svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', sms_otp_required: true, phone_e164: US, timezone: 'America/Chicago' }, 'r');
    const got = await svc.get(auth, ENVELOPE, 'r');
    expect(got.features).toEqual({ sms_delivery: true, whatsapp_delivery: true, sms_otp: true });
    expect(got.recipients[0]).toMatchObject({ signer_id: SIGNER, delivery_channel: 'SMS', sms_otp_required: true, phone_e164: US, timezone: 'America/Chicago' });
    await svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: null, sms_otp_required: false }, 'r');
    expect(repo.settings.size).toBe(0);
  });
});

// ── WhatsApp webhook ─────────────────────────────────────────────────────────
describe('WhatsApp webhook — signature, STOP and statuses', () => {
  it('verifies X-Hub-Signature-256 over the raw body', () => {
    const raw = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac('sha256', 'SECRET').update(raw).digest('hex')}`;
    expect(verifyMetaSignature(raw, sig, 'SECRET')).toBe(true);
    expect(verifyMetaSignature(raw, sig, 'OTHER')).toBe(false);
    expect(verifyMetaSignature(raw, undefined, 'SECRET')).toBe(false);
  });

  it('is not found while unconfigured or NOT_AVAILABLE', () => {
    const c = new SignWhatsAppWebhookController({} as SignMessagingService, offGate());
    expect(() => c.subscribe('r', 'subscribe', 'x', 'challenge')).toThrow(/Not found/);
  });

  it('records STOP and delivery statuses from a signed callback', async () => {
    const prev = { secret: process.env['SIGN_WHATSAPP_APP_SECRET'], verify: process.env['SIGN_WHATSAPP_VERIFY_TOKEN'] };
    process.env['SIGN_WHATSAPP_APP_SECRET'] = 'SECRET';
    process.env['SIGN_WHATSAPP_VERIFY_TOKEN'] = 'VT';
    try {
      const messaging = { inboundMessage: vi.fn(async () => 'OPT_OUT'), providerStatus: vi.fn(async () => ({ delivery_id: 'd', ledgered: true })) };
      const c = new SignWhatsAppWebhookController(messaging as unknown as SignMessagingService, new SignFeatureGate({ ...FEATURE_AVAILABILITY, 'sign.whatsapp_delivery': 'AVAILABLE' }));
      expect(c.subscribe('r', 'subscribe', 'VT', 'ch-1')).toBe('ch-1');
      const body = { entry: [{ changes: [{ value: { messages: [{ from: '14155550123', type: 'text', text: { body: 'STOP' } }], statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] };
      const raw = Buffer.from(JSON.stringify(body));
      const sig = `sha256=${createHmac('sha256', 'SECRET').update(raw).digest('hex')}`;
      const out = await c.receive({ rawBody: raw, body } as never, sig, 'r');
      expect(out).toEqual({ received: true, keywords: 1, statuses: 1 });
      expect(messaging.inboundMessage).toHaveBeenCalledWith('WHATSAPP', US, 'STOP');
      expect(messaging.providerStatus).toHaveBeenCalledWith('meta-whatsapp', 'wamid.1', 'DELIVERED');
      await expect(c.receive({ rawBody: raw, body } as never, 'sha256=bad', 'r')).rejects.toThrow(/signature/);
    } finally {
      if (prev.secret === undefined) delete process.env['SIGN_WHATSAPP_APP_SECRET'];
      else process.env['SIGN_WHATSAPP_APP_SECRET'] = prev.secret;
      if (prev.verify === undefined) delete process.env['SIGN_WHATSAPP_VERIFY_TOKEN'];
      else process.env['SIGN_WHATSAPP_VERIFY_TOKEN'] = prev.verify;
    }
  });
});

// ── MSG91 DLT header and Principal Entity id (Remaining-Work Directive §3 B5) ──
describe('MSG91 — DLT sender header and entity id from settings', () => {
  const base = { SIGN_SMS_PROVIDER: 'msg91', SIGN_SMS_MSG91_AUTH_KEY: 'AUTH', SIGN_SMS_MSG91_TEMPLATE_INVITATION: 'dlt-inv' };

  it('unset ⇒ the request carries neither (the MSG91 account mapping applies, as before)', () => {
    expect(msg91ConfigFromEnv(base)).toEqual({ auth_key: 'AUTH', templates: { INVITATION: 'dlt-inv' }, base_url: 'https://control.msg91.com/api/v5/flow' });
  });

  it('sends the header and the entity id with every request', async () => {
    const cfg = msg91ConfigFromEnv({ ...base, SIGN_SMS_MSG91_SENDER_ID: 'aramos', SIGN_SMS_MSG91_DLT_ENTITY_ID: '1201160000000012345' });
    expect(cfg).toMatchObject({ sender_id: 'ARAMOS', dlt_entity_id: '1201160000000012345' });
    let body = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200, json: async () => ({ type: 'success', message: 'req-1' }) };
    };
    if (cfg === null) throw new Error('MSG91 config expected');
    const a = new Msg91SmsAdapter(cfg, fetchImpl);
    expect(await a.send({ channel: 'SMS', purpose: 'INVITATION', to_e164: IN, reference: 'r', variables: { sender_name: 'Acme', signing_url: 'https://x/s/T' } })).toMatchObject({ outcome: 'sent' });
    expect(JSON.parse(body)).toEqual({
      template_id: 'dlt-inv',
      short_url: '0',
      [MSG91_SENDER_FIELD]: 'ARAMOS',
      [MSG91_DLT_ENTITY_FIELD]: '1201160000000012345',
      recipients: [{ mobiles: '919876543210', sender: 'Acme', link: 'https://x/s/T' }],
    });
  });

  it('an invalid header or entity id leaves MSG91 off (logged), never fatal', () => {
    expect(() => msg91ConfigFromEnv({ ...base, SIGN_SMS_MSG91_SENDER_ID: 'ARAMO1' })).toThrow(/6-letter/);
    expect(() => msg91ConfigFromEnv({ ...base, SIGN_SMS_MSG91_DLT_ENTITY_ID: 'abc' })).toThrow(/Principal Entity/);
    expect(outboundMessagingFromEnv({ ...base, SIGN_SMS_MSG91_SENDER_ID: 'TOOLONGX' }).channels.size).toBe(0);
    expect(outboundMessagingFromEnv({ ...base, SIGN_SMS_MSG91_SENDER_ID: 'ARAMOS' }).channels.has('SMS')).toBe(true);
  });
});

// ── Inbound SMS STOP through Amazon SNS (Remaining-Work Directive §3 B5) ─────
describe('Inbound SMS (AWS two-way SMS → SNS) — signature, topic, STOP', () => {
  const TOPIC = 'arn:aws:sns:us-east-1:123456789012:aramo-sign-inbound-sms';
  const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000.pem';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const NOW = new Date('2026-11-01T12:00:00.000Z');

  function signed(m: Omit<SnsMessage, 'Signature' | 'SignatureVersion' | 'SigningCertURL'> & { SigningCertURL?: string }, version: '1' | '2' = '2'): SnsMessage {
    const full = { ...m, SignatureVersion: version, SigningCertURL: m.SigningCertURL ?? CERT_URL, Signature: '' } as SnsMessage;
    full.Signature = cryptoSign(version === '1' ? 'sha1' : 'sha256', Buffer.from(snsStringToSign(full), 'utf8'), privateKey).toString('base64');
    return full;
  }
  const notification = (text: string, from = US, extra: Partial<SnsMessage> = {}) =>
    signed({
      Type: 'Notification',
      MessageId: 'm-1',
      TopicArn: TOPIC,
      Timestamp: '2026-11-01T11:59:00.000Z',
      Message: JSON.stringify({ originationNumber: from, destinationNumber: '+18885550100', messageKeyword: 'KEYWORD_1', messageBody: text, inboundMessageId: 'in-1' }),
      ...extra,
    });

  function fakeGet(): SnsHttpGet & { calls: string[] } {
    const calls: string[] = [];
    const get = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => PEM };
    }) as SnsHttpGet & { calls: string[] };
    get.calls = calls;
    return get;
  }

  it('the canonical string and the SNS host check follow the AWS rules', () => {
    const m = notification('STOP');
    expect(snsStringToSign(m).startsWith('Message\n')).toBe(true);
    expect(snsStringToSign(m)).toContain('\nTopicArn\n' + TOPIC + '\nType\nNotification\n');
    expect(isSnsHostUrl(CERT_URL, '.pem')).toBe(true);
    expect(isSnsHostUrl('http://sns.us-east-1.amazonaws.com/x.pem', '.pem')).toBe(false);
    expect(isSnsHostUrl('https://sns.us-east-1.amazonaws.com.evil.test/x.pem', '.pem')).toBe(false);
    expect(isSnsHostUrl('https://evil.test/sns.us-east-1.amazonaws.com.pem', '.pem')).toBe(false);
    expect(() => parseSnsMessage(Buffer.from('not json'))).toThrow(SnsInboundRejectedError);
    expect(() => parseSnsMessage(Buffer.from(JSON.stringify({ Type: 'Notification' })))).toThrow(SnsInboundRejectedError);
  });

  it('verifies SignatureVersion 1 and 2; refuses a tampered body, a wrong topic, an untrusted certificate URL and a stale message', async () => {
    const get = fakeGet();
    const v = new SnsMessageVerifier(TOPIC, get, () => NOW);
    await expect(v.verify(notification('STOP'))).resolves.toBeUndefined();
    await expect(v.verify(signed({ ...notification('STOP') }, '1'))).resolves.toBeUndefined();
    expect(get.calls).toEqual([CERT_URL]); // the certificate is cached
    const reason = async (m: SnsMessage) => v.verify(m).then(() => 'OK', (e: SnsInboundRejectedError) => e.reason);
    expect(await reason({ ...notification('STOP'), Message: '{"originationNumber":"+14155550123","messageBody":"START"}' })).toBe('BAD_SIGNATURE');
    expect(await reason(notification('STOP', US, { TopicArn: 'arn:aws:sns:us-east-1:123456789012:other' }))).toBe('WRONG_TOPIC');
    expect(await reason(signed({ ...notification('STOP'), SigningCertURL: 'https://evil.test/cert.pem' }))).toBe('UNTRUSTED_CERT_URL');
    expect(await reason(notification('STOP', US, { Timestamp: '2026-10-30T00:00:00.000Z' }))).toBe('STALE');
    const down = new SnsMessageVerifier(TOPIC, async () => ({ ok: false, status: 503, text: async () => '' }), () => NOW);
    expect(await down.verify(notification('STOP')).then(() => 'OK', (e: SnsInboundRejectedError) => e.reason)).toBe('CERT_UNAVAILABLE');
  });

  const ENV = { SIGN_SMS_PROVIDER: 'aws', SIGN_SMS_AWS_ORIGINATION_IDENTITY: 'pool-1', SIGN_SMS_AWS_REGION: 'us-east-1', SIGN_SMS_AWS_INBOUND_TOPIC_ARN: TOPIC };
  async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(ENV)) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, env);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const req = (m: unknown) => ({ rawBody: Buffer.from(JSON.stringify(m)) }) as never;

  it('is not found while the topic, the aws provider or sign.sms_delivery is missing (dark)', async () => {
    const messaging = { inboundMessage: vi.fn() };
    const on = new SignSmsInboundWebhookController(messaging as unknown as SignMessagingService, onGate(), fakeGet());
    const off = new SignSmsInboundWebhookController(messaging as unknown as SignMessagingService, offGate(), fakeGet());
    await withEnv(ENV, async () => {
      await expect(off.aws(req(notification('STOP')), 'r')).rejects.toThrow(/Not found/);
    });
    await withEnv({ ...ENV, SIGN_SMS_AWS_INBOUND_TOPIC_ARN: '' }, async () => {
      await expect(on.aws(req(notification('STOP')), 'r')).rejects.toThrow(/Not found/);
    });
    await withEnv({ ...ENV, SIGN_SMS_PROVIDER: 'msg91' }, async () => {
      await expect(on.aws(req(notification('STOP')), 'r')).rejects.toThrow(/Not found/);
    });
    await withEnv({ ...ENV, SIGN_SMS_AWS_INBOUND_TOPIC_ARN: 'not-an-arn' }, async () => {
      await expect(on.aws(req(notification('STOP')), 'r')).rejects.toThrow(/Not found/);
    });
    expect(messaging.inboundMessage).not.toHaveBeenCalled();
  });

  it('records STOP from a signed notification into the opt-out list; refuses a bad signature (401) and a missing certificate (503)', async () => {
    const messaging = { inboundMessage: vi.fn(async () => 'OPT_OUT') };
    const c = new SignSmsInboundWebhookController(messaging as unknown as SignMessagingService, onGate(), fakeGet());
    await withEnv(ENV, async () => {
      expect(await c.aws(req(notification('STOP')), 'r')).toEqual({ received: true, type: 'Notification', keywords: 1 });
      expect(messaging.inboundMessage).toHaveBeenCalledWith('SMS', US, 'STOP');
      const forged = { ...notification('STOP'), Message: JSON.stringify({ originationNumber: IN, messageBody: 'STOP' }) };
      await expect(c.aws(req(forged), 'r')).rejects.toMatchObject({ statusCode: 401 });
      // A sender that is not E.164 is ignored (no keyword recorded).
      expect(await c.aws(req(notification('STOP', '5551234')), 'r')).toEqual({ received: true, type: 'Notification', keywords: 0 });
      const noCert = new SignSmsInboundWebhookController(messaging as unknown as SignMessagingService, onGate(), async () => ({ ok: false, status: 500, text: async () => '' }));
      await expect(noCert.aws(req(notification('STOP')), 'r')).rejects.toMatchObject({ statusCode: 503 });
    });
    expect(messaging.inboundMessage).toHaveBeenCalledTimes(1);
  });

  it('reads the text/plain body SNS sends (no body parser) from the request stream', async () => {
    const messaging = { inboundMessage: vi.fn(async () => 'OPT_OUT') };
    const c = new SignSmsInboundWebhookController(messaging as unknown as SignMessagingService, onGate(), fakeGet());
    const body = Buffer.from(JSON.stringify(notification('stop')));
    const stream = Object.assign((async function* () {
      yield body.subarray(0, 10);
      yield body.subarray(10);
    })(), { readableEnded: false });
    await withEnv(ENV, async () => {
      expect(await c.aws(stream as never, 'r')).toMatchObject({ keywords: 1 });
    });
    expect(messaging.inboundMessage).toHaveBeenCalledWith('SMS', US, 'stop');
  });

  it('confirms the SNS subscription only through an Amazon SNS https link', async () => {
    const get = fakeGet();
    const c = new SignSmsInboundWebhookController({ inboundMessage: vi.fn() } as unknown as SignMessagingService, onGate(), get);
    const confirm = (url: string) =>
      signed({ Type: 'SubscriptionConfirmation', MessageId: 'm-2', TopicArn: TOPIC, Timestamp: '2026-11-01T11:59:00.000Z', Message: 'You have chosen to subscribe', SubscribeURL: url, Token: 'tok' });
    const SUBSCRIBE = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=tok';
    await withEnv(ENV, async () => {
      expect(await c.aws(req(confirm(SUBSCRIBE)), 'r')).toEqual({ received: true, type: 'SubscriptionConfirmation', keywords: 0 });
      expect(get.calls).toContain(SUBSCRIBE);
      await expect(c.aws(req(confirm('https://evil.test/confirm')), 'r')).rejects.toThrow(/confirmation failed/);
    });
    expect(get.calls).not.toContain('https://evil.test/confirm');
  });
});
