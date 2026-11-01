import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Optional, Post, type RawBodyRequest, Req, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { IdentityVerificationService, IdentityVerificationWebhookSignatureError } from '@aramo/sign';

import { toHttp } from '../esign-http.controller.js';
import { SIGN_ID_VERIFICATION_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.9 + Amendment A1
// (dc95b283…) — recipient identity verification. DARK: sign.id_verification is NOT_AVAILABLE
// (start refused 403) and SIGN_ID_VERIFICATION_PROVIDER is unset (every vendor call refused 503).
//
//   POST v1/sign/signing/identity-verification/status   signer, capability token
//   POST v1/sign/signing/identity-verification/start    signer, capability token → the vendor's
//                                                        hosted page (opened in a new tab)
//   POST v1/sign/identity-verification/webhook/stripe   vendor → Aramo; NO session: authenticity
//                                                        is the Stripe-Signature over the raw body
//
// The vendor URL is returned to the signer only, never stored or logged.

function validToken(body: { token?: unknown } | undefined, requestId: string): string {
  if (typeof body?.token !== 'string' || body.token.length === 0) throw new AramoError('VALIDATION_ERROR', 'token is required', 400, { requestId });
  return body.token;
}

@Controller('v1/sign')
@UseFilters(AramoExceptionFilter)
export class SignIdentityVerificationController {
  private readonly log = new Logger('SignIdentityVerification');

  constructor(
    private readonly service: IdentityVerificationService,
    @Optional() private readonly features?: SignFeatureGate,
  ) {}

  @Post('signing/identity-verification/status')
  @HttpCode(HttpStatus.OK)
  async status(@Body() body: { token?: unknown }, @RequestId() requestId: string) {
    const token = validToken(body, requestId);
    try {
      return await this.service.status(token);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('signing/identity-verification/start')
  @HttpCode(HttpStatus.OK)
  async start(@Body() body: { token?: unknown }, @Req() req: Request, @RequestId() requestId: string, @Headers('user-agent') userAgent?: string) {
    const token = validToken(body, requestId);
    (this.features ?? new SignFeatureGate()).assertAvailable(SIGN_ID_VERIFICATION_FEATURE, requestId);
    try {
      return await this.service.start(token, { ip_address: req.ip, user_agent: userAgent });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('identity-verification/webhook/stripe')
  @HttpCode(HttpStatus.OK)
  async stripeWebhook(@Req() req: RawBodyRequest<Request>, @RequestId() requestId: string, @Headers('stripe-signature') signature?: string) {
    try {
      if (req.rawBody === undefined) throw new IdentityVerificationWebhookSignatureError('MISSING');
      const outcome = await this.service.handleWebhook(req.rawBody, signature, Math.floor(Date.now() / 1000));
      return { received: true, outcome };
    } catch (e) {
      if (e instanceof IdentityVerificationWebhookSignatureError) {
        this.log.warn(`identity verification webhook rejected: ${e.reason}`);
        throw new AramoError('AUTH_REQUIRED', 'Webhook signature verification failed', 401, { requestId, details: { reason: e.reason } });
      }
      // A vendor read failure answers 5xx so the vendor redelivers; nothing was recorded.
      throw toHttp(e, requestId);
    }
  }
}
