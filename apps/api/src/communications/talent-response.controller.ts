import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TalentResponseService } from './talent-response.service.js';
import { RecordTalentResponseDto } from './dto/record-talent-response-request.dto.js';

export interface RecordTalentResponseViewDto {
  interaction_id: string;
  deduped: boolean;
  pipeline_stage: string;
  pipeline_version: number;
}

// Recruiting-Journey §7/§15 — the canonical "Record Talent response" command. The
// recruiter attests a Talent response for a bound Pipeline; the backend persists
// durable recruiter-attested evidence and advances the milestone through canonical
// Pipeline authority. Governed by pipeline:change-status (the authority to move the
// journey); the Talent/Requisition context is resolved server-side from the pipeline.
// A required Idempotency-Key makes a retried recorder a no-op while distinct
// responses (distinct keys) each persist.
@Controller('v1/communications')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentResponseController {
  constructor(private readonly responses: TalentResponseService) {}

  @Post('talent-responses')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:change-status')
  async record(
    @Body() dto: RecordTalentResponseDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<RecordTalentResponseViewDto> {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required for recording a Talent response',
        422,
        { requestId, details: { field: 'Idempotency-Key' } },
      );
    }
    // Thread the caller's visible requisition set (global VisibilityInterceptor) so
    // the resolve/advance honours the same concealment as the Pipeline surface.
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const result = await this.responses.recordResponse({
      auth,
      pipelineId: dto.pipeline_id,
      channel: dto.channel,
      occurredAt: new Date(dto.occurred_at),
      note: dto.note ?? null,
      idempotencyKey,
      requestId,
      visibleRequisitionIds: visibleReqIds,
    });
    return {
      interaction_id: result.interaction_id,
      deduped: result.deduped,
      pipeline_stage: result.pipeline.status,
      pipeline_version: result.pipeline.version,
    };
  }
}
