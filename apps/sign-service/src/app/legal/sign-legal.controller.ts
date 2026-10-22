import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import type { Request } from 'express';

import { clientIp } from '../personal/personal-send.gate.js';

import { PersonalLegalStatusService, type PendingLegalDocument } from './personal-legal-status.service.js';

// Aramo Sign Personal (Free) — legal re-acceptance in the Sign workspace
// (v1/sign/legal). The signed-in user of a PERSONAL tenant sees the current
// APPROVED Personal documents they have not accepted, and accepts them here.
//
//   GET  status   { pending: [{ key, version, url, title }] }  (Business: [])
//   POST accept   { accept: [{ key, version }] } → { pending }  (current versions only)
//
// Same boundary as the workspace's billing reads: an Aramo SSO `sign` session
// (EsignSenderConsumerGuard) of a tenant entitled to `sign`. tenant_id and the
// user come only from the verified auth context; the acceptance records the
// request's client address and user agent.

function LegalBoundary(): MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard), RequireCapability('sign'));
}

@Controller('v1/sign/legal')
@UseFilters(AramoExceptionFilter)
export class SignLegalController {
  constructor(private readonly legal: PersonalLegalStatusService) {}

  @Get('status')
  @LegalBoundary()
  async status(@AuthContext() auth: AuthContextType): Promise<{ pending: PendingLegalDocument[] }> {
    return { pending: await this.legal.pending(auth.tenant_id, auth.sub) };
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @LegalBoundary()
  async accept(
    @AuthContext() auth: AuthContextType,
    @Body() body: { accept?: unknown },
    @Req() req: Request,
    @RequestId() requestId: string,
  ): Promise<{ pending: PendingLegalDocument[] }> {
    const ua = req.headers['user-agent'];
    const pending = await this.legal.accept(auth.tenant_id, auth.sub, body?.accept, { ip: clientIp(req), user_agent: typeof ua === 'string' ? ua : null }, requestId);
    return { pending };
  }
}
