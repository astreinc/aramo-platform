import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import type { Request } from 'express';

import { clientIp } from '../personal/personal-send.gate.js';

import { PersonalUpgradeService, type PersonalUpgradeResult, type PersonalUpgradeStatus } from './personal-upgrade.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 — the Personal → Business
// upgrade (v1/sign/account/upgrade). Dark: 404 unless SIGN_PERSONAL_UPGRADE_ENABLED=1.
//
//   GET  upgrade  { eligible, reason, current_name, terms, subscription }
//   POST upgrade  { confirm: 'UPGRADE', organization_name, organization, accept_terms: true }
//                 → { state: 'upgraded', kind: 'BUSINESS', organization_name, upgraded_at }
//
// Same boundary as v1/sign/account: an Aramo SSO `sign` session (EsignSenderConsumerGuard)
// of a tenant entitled to `sign`. The tenant and the acting user come only from the
// verified auth context; the owner check and every rule are PersonalUpgradeService's.

function UpgradeBoundary(): MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard), RequireCapability('sign'));
}

@Controller('v1/sign/account')
@UseFilters(AramoExceptionFilter)
export class PersonalUpgradeController {
  constructor(private readonly upgrades: PersonalUpgradeService) {}

  @Get('upgrade')
  @UpgradeBoundary()
  async status(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<PersonalUpgradeStatus> {
    return this.upgrades.status(auth, requestId);
  }

  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  @UpgradeBoundary()
  async upgrade(
    @AuthContext() auth: AuthContextType,
    @Body() body: { confirm?: unknown; organization_name?: unknown; organization?: unknown; accept_terms?: unknown },
    @Req() req: Request,
    @RequestId() requestId: string,
  ): Promise<PersonalUpgradeResult> {
    return this.upgrades.upgrade(auth, body, { ip: clientIp(req), request_id: requestId });
  }
}
