import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';

import { SignAccountService, type SignAccountClosed, type SignAccountStatus } from './sign-account.service.js';

// Aramo Sign Personal (Free) — the Sign workspace's account surface (v1/sign/account).
//
//   GET  status  { closable, closed, closed_at }
//   POST close   { confirm: 'CLOSE', reason? } → { state: 'closed', closed_at }
//
// Same boundary as the workspace's legal and billing routes: an Aramo SSO `sign`
// session (EsignSenderConsumerGuard) of a tenant entitled to `sign`. The tenant and
// the acting user come only from the verified auth context; the owner check, the
// PERSONAL-only rule and the close itself are SignAccountService's.

function AccountBoundary(): MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard), RequireCapability('sign'));
}

@Controller('v1/sign/account')
@UseFilters(AramoExceptionFilter)
export class SignAccountController {
  constructor(private readonly account: SignAccountService) {}

  @Get('status')
  @AccountBoundary()
  async status(@AuthContext() auth: AuthContextType): Promise<SignAccountStatus> {
    return this.account.status(auth);
  }

  @Post('close')
  @HttpCode(HttpStatus.OK)
  @AccountBoundary()
  async close(
    @AuthContext() auth: AuthContextType,
    @Body() body: { confirm?: unknown; reason?: unknown },
    @RequestId() requestId: string,
  ): Promise<SignAccountClosed> {
    return this.account.close(auth, body, requestId);
  }
}
