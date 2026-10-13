import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AramoError,
  hashCanonicalizedBody,
  RequestId,
} from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { IdempotencyService } from '@aramo/consent';
import { RequisitionRepository } from '@aramo/requisition';
import type {
  CreateSubmittalRequestDto,
  CreateSubmittalResponseDto,
  TalentSubmittalRecordView,
} from '@aramo/submittal';

import { CreateSubmittalOrchestrator } from './create-submittal.service.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SW-1 (Submittal Workspace, R1-A) — the re-pointed authoritative "create submittal"
// route. POST /v1/submittals now lives in apps/api (the composition-root pattern,
// mirroring the submit-to-client re-point) so the authoritative pipeline_id is derived
// SERVER-SIDE from the sole live Pipeline episode; the HTTP caller never supplies
// it. The legacy @Post() handler was removed from the libs/submittal
// SubmittalController (no parallel create path). Public contract preserved verbatim:
//   - Idempotency-Key required; replay-if-match / conflict-if-body-differs
//   - recruiter-only (consumer_type) + scope submittal:create
//   - 201 { submittal } response envelope
// Refusal codes flow up from the orchestrator/repository and are re-bound to the
// controller's request_id, including SUBMITTAL_NO_LIVE_PIPELINE_EPISODE (409) when
// there is no live pipeline episode to derive the link from.
// INC-1b (TIP-E2E) — tenant-capability parity with the canonical ATS stack:
// EntitlementGuard + @RequireCapability('ats'). The create mutation is further
// guarded by server-resolved requisition actor-visibility + site authorization
// (createSubmittal Step 1b): job_id IS the requisition id, resolved under the
// actor's visibility via RequisitionRepository.findVisibilityMetaById — a
// lightweight visibility/site read (NOT the detail-enriched findByIdForActor,
// which would drag capacity/placement reads into a pure authz gate). This runs
// BEFORE idempotency replay and before the
// orchestrator mutation, so neither a replayed key nor the create itself can
// bypass a site/visibility denial. @RequireSiteMatch() opts the route into the
// RolesGuard site axis; create is body-only (no path/query site_id) so that
// comparison is a no-op and the authoritative server-side assertion below is the
// effective site control.
@Controller('v1/submittals')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class CreateSubmittalController {
  constructor(
    private readonly orchestrator: CreateSubmittalOrchestrator,
    private readonly idempotencyService: IdempotencyService,
    private readonly requisitionRepository: RequisitionRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('submittal:create')
  @RequireSiteMatch()
  async createSubmittal(
    @Body() body: CreateSubmittalRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<CreateSubmittalResponseDto> {
    // Step 1 — auth posture (recruiter-only).
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required (consent grant/revoke precedent).
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — request body hash for replay-vs-conflict detection.
    const requestHash = hashCanonicalizedBody(body as unknown);

    // Step 4 — idempotency lookup (replay if matching, conflict if hash differs,
    // otherwise proceed).
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as CreateSubmittalResponseDto;
    }

    // Step 4b — INC-1b server-resolved requisition visibility + site authorization,
    // AFTER the idempotency replay/conflict short-circuit (a replay of a prior-authorized
    // create returns the cached response) and BEFORE the create mutation. job_id IS the
    // requisition id. findByIdForActor applies the A3 visibility predicate
    // (requisition:read:all -> unfiltered; else the assigned/visible-client union); an
    // out-of-visibility requisition yields null -> 404 (Ruling 2 parity), NEVER 403. The
    // site assertion compares the AUTHORITATIVE requisition.site_id to a site-scoped
    // principal's claim (null claim = tenant-wide, admitted on any site).
    const job_id = this.assertSubmittalJobIsUuid(body?.job_id, requestId);
    const visibility = await req.resolveVisibility!();
    const requisition = await this.requisitionRepository.findVisibilityMetaById({
      tenant_id: authContext.tenant_id,
      id: job_id,
      visibility,
    });
    if (requisition === null) {
      throw new AramoError('NOT_FOUND', 'Requisition not found in tenant', 404, {
        requestId,
        details: { requisition_id: job_id },
      });
    }
    if (
      authContext.site_id !== null &&
      authContext.site_id !== undefined &&
      requisition.site_id !== null &&
      requisition.site_id !== authContext.site_id
    ) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'Requisition belongs to a different site',
        403,
        { requestId, details: { reason: 'site_mismatch', requisition_id: job_id } },
      );
    }

    // Step 5 — actor identity (the recruiter's UUID sub claim).
    const created_by = this.assertSubIsUuid(authContext, requestId);

    // Step 6 — orchestrate: derive the live pipeline episode (server-side,
    // authoritative) + build the evidence package + persist the record. The
    // orchestrator (and the repository it calls) may construct AramoErrors with a
    // non-HTTP-context requestId placeholder; rebind the controller's request_id so
    // the locked error envelope stays consistent.
    let submittal: TalentSubmittalRecordView;
    try {
      submittal = await this.orchestrator.create({
        requestId,
        tenant_id: authContext.tenant_id,
        talent_id: body.talent_id,
        job_id: body.job_id,
        examination_id: body.examination_id,
        created_by,
        talent_identity: body.talent_identity,
        contact_summary: body.contact_summary,
        capability_summary_overrides: body.capability_summary_overrides,
        ...(body.match_justification_overrides !== undefined
          ? { match_justification_overrides: body.match_justification_overrides }
          : {}),
        recruiter_contribution: body.recruiter_contribution,
        ...(body.rate_expectation_id !== undefined
          ? { rate_expectation_id: body.rate_expectation_id }
          : {}),
        ...(body.selection_event_refs !== undefined
          ? { selection_event_refs: body.selection_event_refs }
          : {}),
        ...(body.justification !== undefined
          ? { justification: body.justification }
          : {}),
        ...(body.failed_criterion_acknowledgments !== undefined
          ? { failed_criterion_acknowledgments: body.failed_criterion_acknowledgments }
          : {}),
      });
    } catch (err) {
      if (err instanceof AramoError) {
        throw new AramoError(err.code, err.message, err.statusCode, {
          ...err.context,
          requestId,
        });
      }
      throw err;
    }

    const response: CreateSubmittalResponseDto = { submittal };

    // Step 7 — persist idempotency record (post-mutation success only).
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.CREATED,
      response_body: response,
    });

    return response;
  }

  private assertConsumerIsRecruiter(
    authContext: AuthContextType,
    requestId: string,
  ): void {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'submittal-create endpoint is recruiter-only',
        403,
        { requestId, details: { consumer_type: authContext.consumer_type } },
      );
    }
  }

  private assertSubmittalJobIsUuid(
    value: string | undefined,
    requestId: string,
  ): string {
    if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
      throw new AramoError('VALIDATION_ERROR', 'job_id must be a UUID', 400, {
        requestId,
        details: { invalid_field: 'job_id' },
      });
    }
    return value;
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
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a UUID',
        400,
        { requestId, details: { invalid_field: 'Idempotency-Key' } },
      );
    }
    return idempotencyKey;
  }

  private assertSubIsUuid(
    authContext: AuthContextType,
    requestId: string,
  ): string {
    const sub = authContext.sub;
    if (!UUID_REGEX.test(sub)) {
      throw new AramoError(
        'INVALID_REQUEST',
        'auth context sub claim must be a UUID',
        400,
        { requestId, details: { invalid_field: 'sub' } },
      );
    }
    return sub;
  }
}
