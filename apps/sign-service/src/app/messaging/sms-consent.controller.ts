import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';
import type { SmsCertificationView, UserSmsCodeSent, UserSmsConsentView } from '@aramo/sign-client';

import { RecipientInboxBoundary } from '../inbox/recipient-inbox.controller.js';
import { ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';

import { SmsCertificationService } from './sms-certification.service.js';
import { UserSmsConsentService } from './user-sms-consent.service.js';

// SMS-CONSENT-1 (LOCKED 2026-11-28) — consent for texts to signers. DARK (R-8): `available` is
// false while sign.sms_delivery and sign.sms_otp are NOT_AVAILABLE or no SMS provider is set.
//
//   ORGANIZATION (EsignSenderBoundary) — R-2
//     GET    v1/sign/sender/sms-certification   sign:envelope:read
//     POST   v1/sign/sender/sms-certification   sign:settings:manage (owner / admin) { wording_version }
//     DELETE v1/sign/sender/sms-certification   sign:settings:manage
//   THE USER (session + the `sign` consumer, keyed by the token's user) — R-3
//     GET    v1/sign/me/sms-consent
//     POST   v1/sign/me/sms-consent/phone       { phone_e164 }   texts a code
//     POST   v1/sign/me/sms-consent/verify      { code }
//     PUT    v1/sign/me/sms-consent             { consented, wording_version, channel }
//     DELETE v1/sign/me/sms-consent             removes the number and the consent

@Controller('v1/sign/sender/sms-certification')
@UseFilters(AramoExceptionFilter)
export class SignSmsCertificationController {
  constructor(private readonly certification: SmsCertificationService) {}

  @Get()
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  get(@AuthContext() auth: AuthContextType): Promise<SmsCertificationView> {
    return this.certification.view(auth.tenant_id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  certify(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { wording_version?: unknown }): Promise<SmsCertificationView> {
    return this.certification.certify(auth, body, requestId);
  }

  @Delete()
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  withdraw(@AuthContext() auth: AuthContextType): Promise<SmsCertificationView> {
    return this.certification.withdraw(auth);
  }
}

@Controller('v1/sign/me/sms-consent')
@UseFilters(AramoExceptionFilter)
export class SignUserSmsConsentController {
  constructor(private readonly consent: UserSmsConsentService) {}

  @Get()
  @RecipientInboxBoundary()
  get(@AuthContext() auth: AuthContextType): Promise<UserSmsConsentView> {
    return this.consent.view(auth.sub);
  }

  @Post('phone')
  @HttpCode(HttpStatus.OK)
  @RecipientInboxBoundary()
  phone(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { phone_e164?: unknown }): Promise<UserSmsCodeSent> {
    return this.consent.sendCode(auth, body, requestId);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @RecipientInboxBoundary()
  verify(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { code?: unknown }): Promise<UserSmsConsentView> {
    return this.consent.verify(auth, body, requestId);
  }

  @Put()
  @RecipientInboxBoundary()
  put(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { consented?: unknown; wording_version?: unknown; channel?: unknown }): Promise<UserSmsConsentView> {
    return this.consent.setConsent(auth, body, requestId);
  }

  @Delete()
  @RecipientInboxBoundary()
  remove(@AuthContext() auth: AuthContextType): Promise<UserSmsConsentView> {
    return this.consent.remove(auth);
  }
}
