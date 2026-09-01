import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import type { ClientSelectionProcessView } from '@aramo/client-selection';

import { ClientDecisionOrchestrator } from './client-decision.orchestrator.js';

// L3-E(2) — the governed client-decision surface. DECLINE/WITHDRAW go THROUGH here (not
// the owner-lib transition route) so the Pipeline disposition happens in the same governed
// command. Composed onto the shared `v1/client-selection` prefix, same ATS guard chain +
// the client-selection:transition scope. Returns 200 with the updated process view and
// whether the linked Pipeline episode was dispositioned.
interface DecisionRequestBody {
  readonly to_state?: string;
  readonly expected_version?: number;
  readonly reason_code?: string;
  readonly note?: string;
}

@Controller('v1/client-selection')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequireCapability('ats')
export class ClientDecisionController {
  constructor(private readonly orchestrator: ClientDecisionOrchestrator) {}

  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-selection:transition')
  async decide(
    @AuthContext() auth: AuthContextType,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionRequestBody,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ClientSelectionProcessView & { pipeline_dispositioned: boolean }> {
    if (typeof body.expected_version !== 'number') {
      throw new AramoError(
        'VALIDATION_ERROR',
        'expected_version is required for a client-selection decision',
        422,
        { requestId, details: { field: 'expected_version' } },
      );
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const { process, pipeline_dispositioned } = await this.orchestrator.decide({
      tenant_id: auth.tenant_id,
      id,
      to_state: body.to_state ?? '',
      expected_version: body.expected_version,
      changed_by_id: auth.sub,
      visible_requisition_ids: visibleReqIds,
      requestId,
      ...(body.reason_code === undefined ? {} : { reason_code: body.reason_code }),
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    return { ...process, pipeline_dispositioned };
  }
}
