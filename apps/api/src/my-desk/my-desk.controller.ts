import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { resolveAppTimeZone } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { MyDeskView } from './dto/my-desk.view.js';
import { MyDeskService } from './my-desk.service.js';

// The app timezone all urgency/aging is computed against (directive §38). A
// single configured zone for v1 (Astre / tenant-50 is US-East); per-tenant/site
// timezone is a future enhancement, called out honestly rather than guessed.
const APP_TIME_ZONE = resolveAppTimeZone();

// GET /v1/my-desk — the recruiter command-center READ composition.
//
// One route, one visibility-scoped payload (the FE derives every card and tab
// count from the returned arrays). This is a READ PROJECTION ONLY: no mutation,
// no snooze, no action execution, no workflow (directive §40; increment-1
// ruling). Guard chain + scope mirror DashboardController — My Desk IS the
// dashboard landing, so it reuses `dashboard:read` (no new scope, no seed
// churn). Tenant + visibility are resolved server-side from the principal;
// NO client-supplied tenant/user/requisition id is ever trusted (directive §24).
@Controller('v1/my-desk')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class MyDeskController {
  constructor(private readonly service: MyDeskService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('dashboard:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<MyDeskView> {
    const [visibility, visible_requisition_ids, visible_contact_ids] =
      await Promise.all([
        req.resolveVisibility!(),
        req.resolveVisibleRequisitionIds!(),
        req.resolveVisibleContactIds!(),
      ]);
    return this.service.compose(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
        visibility,
        visible_requisition_ids,
        visible_contact_ids,
      },
      Date.now(),
      APP_TIME_ZONE,
    );
  }
}
