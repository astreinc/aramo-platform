import { createHmac, timingSafeEqual } from 'node:crypto';

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Logger, Optional, Param, Post, Put, Query, Req, type RawBodyRequest, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { EsignSenderBoundary } from '@aramo/identity';
import { EsignService, isE164 } from '@aramo/sign';

import { toHttp } from '../esign-http.controller.js';
import { logWebhookFailed, logWebhookRejected } from '../webhook-log.js';
import { SIGN_SMS_DELIVERY_FEATURE, SIGN_WHATSAPP_DELIVERY_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';
import { senderHttp } from '../sender/envelope-contracts.js';
import { ESIGN_CREATE_SCOPE, ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';

import { SnsInboundRejectedError, SnsMessageVerifier, parseAwsInboundSms, parseSnsMessage, snsTopicArnFromEnv, type SnsHttpGet } from './aws-sns-inbound.js';
import { awsSmsConfigFromEnv, smsProvidersWanted } from './messaging-adapters.js';
import { RecipientOtpService } from './recipient-otp.service.js';
import { SenderMessagingService, type RecipientMessagingBody } from './sender-messaging.service.js';
import { SignMessagingService } from './sign-messaging.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8 / §1.9 (Amendment A1:
// dark behind NOT_AVAILABLE, configured off). Three zones, never merged:
//
//   SENDER (EsignSenderBoundary)
//     GET  v1/sign/sender/envelopes/:id/messaging                       sign:envelope:read
//     PUT  v1/sign/sender/envelopes/:id/recipients/:signerId/messaging  sign:envelope:create
//   SIGNER (capability token, like every v1/sign/signing route)
//     POST v1/sign/signing/verification                 the recipient-verification status
//     POST v1/sign/signing/verification/sms-otp/send    send a one-time code
//     POST v1/sign/signing/verification/sms-otp/verify  check it
//   PROVIDER (no session; the Meta X-Hub-Signature-256 over the raw body)
//     GET  v1/sign/messaging/whatsapp/webhook           Meta's subscription check
//     POST v1/sign/messaging/whatsapp/webhook           inbound STOP / START + delivery statuses
//   PROVIDER (no session; the Amazon SNS message signature over the raw body)
//     POST v1/sign/messaging/sms/inbound/aws             inbound SMS STOP / START (AWS two-way SMS)

@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class SignSenderMessagingController {
  constructor(private readonly settings: SenderMessagingService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw senderHttp(e, requestId);
    }
  }

  @Get('envelopes/:id/messaging')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  get(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.settings.get(auth, id, requestId));
  }

  @Put('envelopes/:id/recipients/:signerId/messaging')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  put(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('signerId') signerId: string, @Body() body: RecipientMessagingBody) {
    return this.run(requestId, () => this.settings.put(auth, id, signerId, body ?? {}, requestId));
  }
}

function requireToken(token: unknown, requestId: string): string {
  if (typeof token !== 'string' || token.length === 0) throw new AramoError('VALIDATION_ERROR', 'token is required', 400, { requestId });
  return token;
}

@Controller('v1/sign/signing/verification')
@UseFilters(AramoExceptionFilter)
export class SignRecipientVerificationController {
  constructor(
    private readonly service: EsignService,
    private readonly otp: RecipientOtpService,
  ) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  status(@Body() body: { token?: unknown }, @RequestId() requestId: string) {
    const token = requireToken(body?.token, requestId);
    return this.run(requestId, async () => this.otp.status(await this.service.resolveSession(token)));
  }

  @Post('sms-otp/send')
  @HttpCode(HttpStatus.OK)
  send(@Body() body: { token?: unknown }, @RequestId() requestId: string) {
    const token = requireToken(body?.token, requestId);
    return this.run(requestId, async () => this.otp.send(await this.service.resolveSession(token), requestId));
  }

  @Post('sms-otp/verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() body: { token?: unknown; code?: unknown }, @RequestId() requestId: string) {
    const token = requireToken(body?.token, requestId);
    return this.run(requestId, async () => this.otp.verify(await this.service.resolveSession(token), body?.code, requestId));
  }
}

// ── Meta WhatsApp Cloud API webhook ─────────────────────────────────────────
// SIGN_WHATSAPP_VERIFY_TOKEN answers Meta's subscription check; SIGN_WHATSAPP_APP_SECRET
// verifies X-Hub-Signature-256 (HMAC-SHA256 of the raw body). Either unset, or the feature
// not AVAILABLE ⇒ 404 (the route does not exist for the outside world).

interface MetaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ from?: string; type?: string; text?: { body?: string }; button?: { text?: string } }>;
        statuses?: Array<{ id?: string; status?: string }>;
      };
    }>;
  }>;
}

export function verifyMetaSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'utf8');
  const got = Buffer.from(header.slice('sha256='.length), 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

const META_STATUS: Record<string, 'DELIVERED' | 'READ' | 'UNDELIVERED'> = { delivered: 'DELIVERED', read: 'READ', failed: 'UNDELIVERED' };

@Controller('v1/sign/messaging/whatsapp/webhook')
@UseFilters(AramoExceptionFilter)
export class SignWhatsAppWebhookController {
  private readonly logger = new Logger('SignWhatsAppWebhook');

  constructor(
    private readonly messaging: SignMessagingService,
    private readonly features: SignFeatureGate,
  ) {}

  private enabled(requestId: string): { secret: string; verify: string } {
    const secret = process.env['SIGN_WHATSAPP_APP_SECRET']?.trim();
    const verify = process.env['SIGN_WHATSAPP_VERIFY_TOKEN']?.trim();
    if (!secret || !verify || !this.features.isAvailable(SIGN_WHATSAPP_DELIVERY_FEATURE)) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
    return { secret, verify };
  }

  @Get()
  subscribe(
    @RequestId() requestId: string,
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const cfg = this.enabled(requestId);
    const want = Buffer.from(cfg.verify, 'utf8');
    const got = Buffer.from(token ?? '', 'utf8');
    if (mode !== 'subscribe' || want.length !== got.length || !timingSafeEqual(want, got) || typeof challenge !== 'string') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Verification failed', 403, { requestId });
    }
    return challenge;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @RequestId() requestId: string) {
    const cfg = this.enabled(requestId);
    if (req.rawBody === undefined || !verifyMetaSignature(req.rawBody, signature, cfg.secret)) {
      logWebhookRejected(this.logger, 'whatsapp', signature === undefined ? 'MISSING' : 'BAD_SIGNATURE');
      throw new AramoError('AUTH_REQUIRED', 'The signature is missing or invalid', 401, { requestId });
    }
    try {
      return await this.apply(req.body);
    } catch (e) {
      logWebhookFailed(this.logger, 'whatsapp', e);
      throw e;
    }
  }

  private async apply(rawJson: unknown): Promise<{ received: true; keywords: number; statuses: number }> {
    const body = (rawJson ?? {}) as MetaWebhookBody;
    let messages = 0;
    let statuses = 0;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          const from = `+${m.from ?? ''}`;
          if (!isE164(from)) continue;
          const text = m.text?.body ?? m.button?.text;
          if ((await this.messaging.inboundMessage('WHATSAPP', from, text)) !== null) messages += 1;
        }
        for (const s of change.value?.statuses ?? []) {
          const mapped = META_STATUS[s.status ?? ''];
          if (mapped === undefined || typeof s.id !== 'string') continue;
          if ((await this.messaging.providerStatus('meta-whatsapp', s.id, mapped)) !== null) statuses += 1;
        }
      }
    }
    if (messages + statuses > 0) this.logger.log(`whatsapp webhook: ${messages} keyword(s), ${statuses} status(es)`);
    return { received: true, keywords: messages, statuses };
  }
}

// ── AWS End User Messaging two-way SMS (through Amazon SNS) ─────────────────
// Remaining-Work Directive §3 B5. Dark: 404 unless SIGN_SMS_AWS_INBOUND_TOPIC_ARN is a topic ARN,
// SIGN_SMS_PROVIDER includes a configured aws adapter, and sign.sms_delivery is AVAILABLE. SNS
// posts its JSON as text/plain, which no body parser reads, so the raw bytes are read here.

export const SIGN_SNS_HTTP_GET = 'SIGN_SNS_HTTP_GET';
const MAX_SNS_BODY_BYTES = 256 * 1024;

async function readRawBody(req: RawBodyRequest<Request>): Promise<Buffer | undefined> {
  if (req.rawBody !== undefined) return req.rawBody;
  if (req.readableEnded || typeof (req as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += b.length;
    if (size > MAX_SNS_BODY_BYTES) return undefined;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

@Controller('v1/sign/messaging/sms/inbound')
@UseFilters(AramoExceptionFilter)
export class SignSmsInboundWebhookController {
  private readonly logger = new Logger('SignSmsInboundWebhook');
  private verifier: SnsMessageVerifier | null = null;
  private verifierTopic: string | null = null;

  constructor(
    private readonly messaging: SignMessagingService,
    private readonly features: SignFeatureGate,
    // Tests only: the HTTP GET used for the SNS certificate and the subscribe link.
    @Optional() @Inject(SIGN_SNS_HTTP_GET) private readonly httpGet?: SnsHttpGet,
  ) {}

  private enabled(requestId: string): SnsMessageVerifier {
    const topic = snsTopicArnFromEnv(process.env);
    const aws = smsProvidersWanted(process.env).has('aws') && awsSmsConfigFromEnv(process.env) !== null;
    if (topic === null || !aws || !this.features.isAvailable(SIGN_SMS_DELIVERY_FEATURE)) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
    if (this.verifier === null || this.verifierTopic !== topic) {
      this.verifier = new SnsMessageVerifier(topic, this.httpGet);
      this.verifierTopic = topic;
    }
    return this.verifier;
  }

  @Post('aws')
  @HttpCode(HttpStatus.OK)
  async aws(@Req() req: RawBodyRequest<Request>, @RequestId() requestId: string): Promise<{ received: true; type: string; keywords: number }> {
    const verifier = this.enabled(requestId);
    let message;
    try {
      const raw = await readRawBody(req);
      if (raw === undefined) throw new SnsInboundRejectedError('MALFORMED');
      message = parseSnsMessage(raw);
      await verifier.verify(message);
    } catch (e) {
      if (!(e instanceof SnsInboundRejectedError)) throw e;
      logWebhookRejected(this.logger, 'sms_inbound_aws', e.reason);
      // A certificate that cannot be fetched is transient: 503 so SNS delivers again.
      if (e.reason === 'CERT_UNAVAILABLE') throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'Try again later', 503, { requestId });
      throw new AramoError('AUTH_REQUIRED', 'The SNS message signature is missing or invalid', 401, { requestId, details: { reason: e.reason } });
    }
    try {
      if (message.Type === 'SubscriptionConfirmation') {
        const ok = await verifier.confirmSubscription(message);
        if (!ok) throw Object.assign(new Error('SNS subscription confirmation failed'), { name: 'SnsSubscriptionConfirmError' });
        this.logger.log('sms inbound: SNS subscription confirmed');
        return { received: true, type: message.Type, keywords: 0 };
      }
      if (message.Type === 'UnsubscribeConfirmation') {
        this.logger.warn('sms inbound: SNS subscription removed (inbound STOP replies no longer arrive)');
        return { received: true, type: message.Type, keywords: 0 };
      }
      const sms = parseAwsInboundSms(message.Message);
      if (sms === null || !isE164(sms.originationNumber)) return { received: true, type: message.Type, keywords: 0 };
      const keyword = await this.messaging.inboundMessage('SMS', sms.originationNumber, sms.messageBody);
      return { received: true, type: message.Type, keywords: keyword === null ? 0 : 1 };
    } catch (e) {
      logWebhookFailed(this.logger, 'sms_inbound_aws', e);
      throw e;
    }
  }
}
