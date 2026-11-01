import { Body, Controller, Headers, HttpCode, HttpStatus, Post, type RawBodyRequest, Req, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { EsignService } from '@aramo/sign';

import { toHttp } from '../esign-http.controller.js';

import { SignPaymentService } from './sign-payment.service.js';

// Aramo Sign 1.14 — the session-less payment routes:
//   POST v1/sign/signing/payment/checkout   the signer's capability token: start (or resume)
//                                           the Stripe-hosted Checkout for a PAYMENT field
//   POST v1/sign/signing/payment/confirm    the signer's token: read the checkout through
//                                           after the payer returns from Stripe
//   POST v1/sign/payments/webhook/stripe    Stripe Connect → Aramo; authenticity is the
//                                           verified Stripe-Signature over the raw body only
// Tenant, envelope and signer come from the token (never the client). Dark: refused 403
// (signer) / 404 (webhook) until payments are available.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(cond: boolean, message: string, requestId: string): void {
  if (!cond) throw new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

@Controller('v1/sign')
@UseFilters(AramoExceptionFilter)
export class SignPaymentsPublicController {
  constructor(
    private readonly payments: SignPaymentService,
    private readonly esign: EsignService,
  ) {}

  @Post('signing/payment/checkout')
  @HttpCode(HttpStatus.OK)
  async checkout(@Body() body: { token?: unknown; field_id?: unknown }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string' && body.token.length > 0, 'token is required', requestId);
    validate(typeof body?.field_id === 'string' && UUID.test(body.field_id), 'field_id is required', requestId);
    try {
      const ctx = await this.esign.resolveSession(body.token as string);
      return await this.payments.startCheckout(ctx, body.field_id as string, requestId);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('signing/payment/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Body() body: { token?: unknown; field_id?: unknown }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string' && body.token.length > 0, 'token is required', requestId);
    validate(typeof body?.field_id === 'string' && UUID.test(body.field_id), 'field_id is required', requestId);
    try {
      const ctx = await this.esign.resolveSession(body.token as string);
      return await this.payments.confirm(ctx, body.field_id as string, requestId);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('payments/webhook/stripe')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined, @RequestId() requestId: string) {
    return this.payments.webhook(req.rawBody, signature, requestId);
  }
}
