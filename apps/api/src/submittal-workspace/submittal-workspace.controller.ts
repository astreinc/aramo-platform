import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { SubmittalWorkspaceView } from './submittal-workspace.view.js';
import { SubmittalWorkspaceService } from './submittal-workspace.service.js';

// SW-4 — GET /v1/submittals/:submittal_id/workspace. The submittal-centric recruiter
// workspace READ composition (talent-360 precedent). One route, one tenant- +
// visibility-scoped payload the FE renders without re-deriving business meaning. READ
// PROJECTION ONLY — no mutation, no new authority, no persistence. Classified AP;
// documented in OpenAPI. Base scope `talent:read` mirrors the talent-centric reads it
// sits alongside; the commercial section additionally honours the caller's
// compensation scope INSIDE the service, so composition never broadens access. Tenant
// + visibility are resolved server-side from the principal — no client-supplied
// tenant/requisition id is trusted. Lives in apps/api because only apps/api may know
// all owners (libs boundaries forbid a cross-domain composition in a single lib).
@Controller('v1/submittals')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class SubmittalWorkspaceController {
  constructor(private readonly service: SubmittalWorkspaceService) {}

  @Get(':submittal_id/workspace')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async getWorkspace(
    @AuthContext() authContext: AuthContextType,
    @Param('submittal_id', ParseUUIDPipe) submittalId: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<SubmittalWorkspaceView> {
    const visible_requisition_ids = await req.resolveVisibleRequisitionIds!();
    // SW-5/D-6 — submit authority is EXACTLY what the submit command enforces
    // (`submittal:approve` scope + recruiter consumer). Resolved here from the
    // principal and passed into the projection so `actions.can_submit_to_client` is
    // the single server-owned CTA authority; the FE never reconstructs it.
    const scopes = authContext.scopes ?? [];
    const submit_authority =
      scopes.includes('submittal:approve') && authContext.consumer_type === 'recruiter';
    return this.service.compose(
      {
        tenant_id: authContext.tenant_id,
        visible_requisition_ids,
        scopes: new Set(scopes),
        submit_authority,
        request_id: requestId,
      },
      submittalId,
    );
  }
}
