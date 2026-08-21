import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, hashCanonicalizedBody, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { IdempotencyService } from '@aramo/consent';
import {
  SubmittalRepository,
  TalentSubmittalEventRepository,
  type TalentSubmittalRecordView,
  type TalentSubmittalEventView,
} from '@aramo/submittal';

import { SubmitTalentToClientService } from './submit-talent.service.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Lane L8-B1 (v1.2 + Amendment A2) — the re-pointed authoritative client-submittal
// route. The ONLY way a Talent is submitted to a client and the ONLY way a pipeline
// reaches `submitted` (the mirror). A thin adapter: it preserves the existing public
// contract (Idempotency-Key replay/conflict + the `{ submittal }` response envelope)
// and delegates the whole atomic write to SubmitTalentToClientService. The legacy
// submittal-repository submit-to-ats write path is removed (no parallel path); a
// pipeline-less submittal is refused (SUBMITTAL_PIPELINE_LINK_INVALID, R-REFUSAL).
export interface SubmitToAtsResponse {
  readonly submittal: TalentSubmittalRecordView;
  readonly event: TalentSubmittalEventView;
}

@Controller('v1/submittals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SubmitTalentController {
  constructor(
    private readonly command: SubmitTalentToClientService,
    private readonly submittalRepository: SubmittalRepository,
    private readonly eventRepository: TalentSubmittalEventRepository,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post(':submittal_id/submit-to-ats')
  @RequireScopes('submittal:approve')
  @HttpCode(HttpStatus.OK)
  async submitToAts(
    @Param('submittal_id') submittal_id: string,
    @Body() body: Record<string, unknown>,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SubmitToAtsResponse> {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'submit-to-ats endpoint is recruiter-only',
        403,
        { requestId, details: { consumer_type: authContext.consumer_type } },
      );
    }
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Idempotency-Key replay/conflict (preserved from the legacy route).
    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as SubmitToAtsResponse;
    }

    // The single atomic operation: submitted_to_ats (authoritative) + pipeline
    // `submitted` mirror + serialized slot consumption + provenance, all-or-nothing.
    const eventId = randomUUID();
    await this.command.submitToClient({
      tenant_id: authContext.tenant_id,
      submittal_id,
      event_id: eventId,
      actor_id: authContext.sub,
      requestId,
    });

    // Preserve the public `{ submittal, event }` envelope (Ruling 14) — the
    // authoritative result is the submittal now in submitted_to_ats plus the
    // state_transition event the command wrote; the pipeline mirror is internal.
    const submittal = await this.submittalRepository.findById({
      tenant_id: authContext.tenant_id,
      id: submittal_id,
    });
    const event = await this.eventRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id: eventId,
    });
    if (submittal === null || event === null) {
      throw new AramoError('NOT_FOUND', 'TalentSubmittalRecord not found', 404, {
        requestId,
        details: { submittal_id },
      });
    }
    const response: SubmitToAtsResponse = { submittal, event };

    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });
    return response;
  }

  private assertIdempotencyKeyRequired(
    idempotencyKey: string | undefined,
    requestId: string,
  ): string {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        400,
        { requestId, details: { missing_field: 'Idempotency-Key' } },
      );
    }
    if (!UUID_REGEX.test(idempotencyKey)) {
      throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key must be a UUID', 400, {
        requestId,
        details: { invalid_field: 'Idempotency-Key' },
      });
    }
    return idempotencyKey;
  }
}
