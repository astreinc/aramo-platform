import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { ClientSelectionProcessView } from './dto/client-selection-process.view.js';
import type { TransitionClientSelectionRequestDto } from './dto/client-selection-request.dto.js';
import { ClientSelectionProcessRepository } from './client-selection.repository.js';

// Lane 2 / L2-F (F1) — the Client-Selection process command/read surface. Guard
// chain mirrors the ATS norm: JwtAuthGuard → RolesGuard (scopes) → EntitlementGuard
// (ats capability). Reads/writes are visibility-concealed (404, never 403) via the
// process's requisition_id lineage (resolved by the VisibilityInterceptor).
@Controller('v1/client-selection')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequireCapability('ats')
export class ClientSelectionController {
  constructor(
    private readonly repository: ClientSelectionProcessRepository,
  ) {}

  @Get(':id')
  @RequireScopes('client-selection:read')
  async findOne(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ClientSelectionProcessView> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.repository.findById({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Client-selection process not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-selection:transition')
  async transition(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: TransitionClientSelectionRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ClientSelectionProcessView> {
    if (typeof body.expected_version !== 'number') {
      throw new AramoError(
        'VALIDATION_ERROR',
        'expected_version is required for a client-selection transition',
        422,
        { requestId, details: { field: 'expected_version' } },
      );
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.repository.transition({
      tenant_id: authContext.tenant_id,
      id,
      to_state: body.to_state,
      expected_version: body.expected_version,
      changed_by_id: authContext.sub,
      requestId,
      visible_requisition_ids: visibleReqIds,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
  }
}
