import { applyDecorators, Body, Controller, Get, HttpStatus, Param, Post, Res, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import type { Response } from 'express';

import { SignPrivacyRequestService, type SignPrivacyRequestView } from './sign-privacy-request.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — the signed-in privacy requests (app and
// workspace), for EVERY account type (Personal and Business):
//
//   GET  /v1/sign/me/privacy-requests              { items: [view] } (the caller's own)
//   POST /v1/sign/me/privacy-requests              { request_type?, confirm? } → 201 new | 200 the open one
//   GET  /v1/sign/me/privacy-requests/:reference   view (the caller's own only; else 404)
//
// Same boundary as v1/sign/account: an Aramo SSO / native `sign` session of a tenant
// entitled to `sign`. The tenant and user come only from the verified auth context.

function MeBoundary(): MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard), RequireCapability('sign'));
}

@Controller('v1/sign/me/privacy-requests')
@UseFilters(AramoExceptionFilter)
export class SignPrivacyRequestController {
  constructor(private readonly privacy: SignPrivacyRequestService) {}

  @Get()
  @MeBoundary()
  list(@AuthContext() auth: AuthContextType): Promise<{ items: SignPrivacyRequestView[] }> {
    return this.privacy.listMine(auth);
  }

  @Post()
  @MeBoundary()
  async create(
    @AuthContext() auth: AuthContextType,
    @Body() body: { request_type?: unknown; confirm?: unknown },
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignPrivacyRequestView> {
    const out = await this.privacy.createInApp(auth, body, requestId);
    res.status(out.created ? HttpStatus.CREATED : HttpStatus.OK);
    return out.request;
  }

  @Get(':reference')
  @MeBoundary()
  get(@AuthContext() auth: AuthContextType, @Param('reference') reference: string, @RequestId() requestId: string): Promise<SignPrivacyRequestView> {
    return this.privacy.getMine(auth, reference, requestId);
  }
}
