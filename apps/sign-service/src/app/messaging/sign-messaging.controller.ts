import { createHmac, timingSafeEqual } from 'node:crypto';

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Logger, Param, Post, Put, Query, Req, type RawBodyRequest, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { EsignSenderBoundary } from '@aramo/identity';
import { EsignService, isE164 } from '@aramo/sign';

import { toHttp } from '../esign-http.controller.js';
import { SIGN_WHATSAPP_DELIVERY_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';
import { senderHttp } from '../sender/envelope-contracts.js';
import { ESIGN_CREATE_SCOPE, ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';

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
      throw new AramoError('AUTH_REQUIRED', 'The signature is missing or invalid', 401, { requestId });
    }
    const body = (req.body ?? {}) as MetaWebhookBody;
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
