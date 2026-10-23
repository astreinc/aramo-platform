import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { EntitlementService, EntitlementSyncInvalidError, SourceSystemMismatchError, type ServicePrincipal } from '@aramo/intelligence-core';
import { INTELLIGENCE_ENTITLEMENTS_SCOPE, type EntitlementSyncResponse } from '@aramo/intelligence-contracts';

import { RequireScope, ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';

// ATI-SEP-1 T6 — POST /v1/entitlements/sync (scope intelligence:entitlements).
// The ATS keeps TI's EntitledTenant table current; reads and webhook fan-out
// require an ACTIVE row. 400 INVALID_REQUEST · 403 SOURCE_SYSTEM_MISMATCH.

@Controller('v1/entitlements')
@UseGuards(ServiceTokenGuard)
@RequireScope(INTELLIGENCE_ENTITLEMENTS_SCOPE)
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async sync(@Body() body: unknown, @Req() req: ServiceRequest): Promise<EntitlementSyncResponse> {
    try {
      return await this.entitlements.sync(body, req.servicePrincipal as ServicePrincipal);
    } catch (err) {
      if (err instanceof EntitlementSyncInvalidError) {
        throw new HttpException({ error: { code: 'INVALID_REQUEST', message: err.message, issues: err.issues } }, HttpStatus.BAD_REQUEST);
      }
      if (err instanceof SourceSystemMismatchError) {
        throw new HttpException({ error: { code: 'SOURCE_SYSTEM_MISMATCH', message: err.message } }, HttpStatus.FORBIDDEN);
      }
      throw err;
    }
  }
}
