import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import type {
  ClientSelectionProcessView,
  CreateClientSelectionRequestDto,
} from '@aramo/client-selection';

import { ClientSelectionCreateFromSubmittalService } from './client-selection-create.service.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Lane 2 / L2-F (F1) — the ClientSelectionProcess CREATE surface (apps/api
// composition root). Kept OUT of the owner lib's controller because creation resolves
// the foreign Submittal + Pipeline aggregates (I15 / SB-7: the lib must not import
// them). Shares the owner's public prefix `v1/client-selection` (Nest composes the two
// controllers) and the same ATS guard chain: JwtAuthGuard → RolesGuard (scopes) →
// EntitlementGuard (ats capability). The create scope is dedicated:
// `client-selection:create` (granted to the ATS delivery matrix). The Submittal
// lineage is visibility-concealed via the VisibilityInterceptor's resolver.
@Controller('v1/client-selection')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequireCapability('ats')
export class ClientSelectionOrchestrationController {
  constructor(
    private readonly command: ClientSelectionCreateFromSubmittalService,
  ) {}

  @Post()
  @RequireScopes('client-selection:create')
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateClientSelectionRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ClientSelectionProcessView> {
    if (typeof body.submittal_id !== 'string' || !UUID_REGEX.test(body.submittal_id)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'submittal_id is required and must be a UUID',
        422,
        { requestId, details: { field: 'submittal_id' } },
      );
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.command.createFromSubmittal({
      tenant_id: authContext.tenant_id,
      submittal_id: body.submittal_id,
      created_by_id: authContext.sub,
      visible_requisition_ids: visibleReqIds,
      requestId,
    });
  }
}
