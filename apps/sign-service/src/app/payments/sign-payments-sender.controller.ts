import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';

import { ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';
import { SenderEnvelopeService } from '../sender/sender-envelope.service.js';

import { SignPaymentService } from './sign-payment.service.js';

// Aramo Sign 1.14 — the sender console's payment routes (Feature-Parity directive §1.14):
//   GET  payments/account                         any workspace reader (can_manage tells the UI)
//   POST payments/account/onboarding-link         sign:settings:manage (Sign Admin)
//   POST payments/account/refresh                 sign:settings:manage
//   POST payments/account/disconnect              sign:settings:manage
//   GET  envelopes/:id/payments                   sign:envelope:read + visibility of the envelope
//   POST envelopes/:id/payments/:paymentId/refund sign:settings:manage + visibility
// DARK: Connect writes answer 403 ESIGN_FEATURE_NOT_AVAILABLE (details.reason) until
// sign.payments is AVAILABLE, Connect is configured and the plan is Professional/Enterprise.

const MAX_REASON = 500;

@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class SignPaymentsSenderController {
  constructor(
    private readonly payments: SignPaymentService,
    private readonly envelopes: SenderEnvelopeService,
  ) {}

  @Get('payments/account')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  async account(@AuthContext() auth: AuthContextType) {
    return { ...(await this.payments.account(auth)), can_manage: auth.scopes.includes(ESIGN_SCOPE.SETTINGS_MANAGE) };
  }

  @Post('payments/account/onboarding-link')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async onboardingLink(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.payments.onboardingLink(auth, requestId);
  }

  @Post('payments/account/refresh')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async refresh(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return { ...(await this.payments.refreshAccount(auth, requestId)), can_manage: true };
  }

  @Post('payments/account/disconnect')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async disconnect(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return { ...(await this.payments.disconnect(auth, requestId)), can_manage: true };
  }

  @Get('envelopes/:id/payments')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  async list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    await this.envelopes.assertVisible(auth, id, requestId);
    return { items: await this.payments.envelopePayments(auth.tenant_id, id), can_refund: auth.scopes.includes(ESIGN_SCOPE.SETTINGS_MANAGE) };
  }

  @Post('envelopes/:id/payments/:paymentId/refund')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async refund(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() body: { amount_minor?: unknown; reason?: unknown },
  ) {
    const amount = body?.amount_minor;
    if (!(amount === undefined || amount === null || (typeof amount === 'number' && Number.isInteger(amount) && amount > 0))) {
      throw bad(requestId, 'amount_minor must be a positive whole number of cents (or omitted for the full remaining amount)', 'refund_amount_invalid');
    }
    const reason = body?.reason;
    if (!(reason === undefined || reason === null || (typeof reason === 'string' && reason.trim().length <= MAX_REASON))) {
      throw bad(requestId, `reason must be at most ${MAX_REASON} characters`, 'refund_reason_invalid');
    }
    await this.envelopes.assertVisible(auth, id, requestId);
    const trimmed = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null;
    return this.payments.refund(auth, id, paymentId, { amount_minor: typeof amount === 'number' ? amount : null, reason: trimmed }, requestId);
  }
}

function bad(requestId: string, message: string, reason: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason } });
}
