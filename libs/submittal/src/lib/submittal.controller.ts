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
import { AramoError, RequestId, hashCanonicalizedBody } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { IdempotencyService } from '@aramo/consent';

import type {
  ConfirmSubmittalRequestDto,
  ConfirmSubmittalResponseDto,
} from './dto/confirm-submittal-request.dto.js';
import type {
  CreateSubmittalRequestDto,
  CreateSubmittalResponseDto,
} from './dto/create-submittal-request.dto.js';
import type { TalentSubmittalRecordView } from './dto/talent-submittal-record.view.js';
import { SubmittalRepository } from './submittal.repository.js';

// M4 PR-3 §4.4 — POST /v1/submittals controller.
//
// Recruiter-facing endpoint that takes a CreateSubmittalRequestDto + an
// Idempotency-Key header, builds the immutable TalentJobEvidencePackage
// via SubmittalRepository.createSubmittal (which orchestrates PR-2's
// EvidenceRepository.buildPackage), persists the workflow
// TalentSubmittalRecord in state='draft', and returns the submittal +
// evidence_package_id.
//
// Auth posture: class-level JwtAuthGuard + per-route
// consumer_type === 'recruiter' assertion (M3 PR-8 precedent).
//
// Idempotency-Key handling (Ruling 7):
//   - header missing → 400 VALIDATION_ERROR (consent grant/revoke precedent)
//   - header present, key matches prior request body → return prior response (replay)
//   - header present, key matches but body differs → 409 IDEMPOTENCY_KEY_CONFLICT
//   - header present, new key → process + persist
//
// Refusal codes flow through from SubmittalRepository:
//   - SUBMITTAL_STRETCH_BLOCKED (422) — buildPackage's tier check
//   - NOT_FOUND (404) — examination missing/archived/cross-tenant
//   - VALIDATION_ERROR (400) — caller bug (UUID malformed, etc.)

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/submittals')
@UseGuards(JwtAuthGuard)
export class SubmittalController {
  constructor(
    private readonly submittalRepository: SubmittalRepository,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSubmittal(
    @Body() body: CreateSubmittalRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CreateSubmittalResponseDto> {
    // Step 1 — auth posture.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required (consent grant/revoke precedent).
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — request body hash for replay-vs-conflict detection.
    const requestHash = hashCanonicalizedBody(body as unknown);

    // Step 4 — idempotency lookup (replay if matching, conflict if
    // hash differs, otherwise proceed).
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as CreateSubmittalResponseDto;
    }

    // Step 5 — actor identity. The directive specifies created_by is a
    // UUID derived from the JWT (the recruiter's actor id). The auth
    // context's `sub` claim carries the actor UUID per the M3 PR-9 / M3
    // PR-8 precedent (auth.consumer_type === 'recruiter' implies a
    // UUID sub for actor identification).
    const created_by = this.assertSubIsUuid(authContext, requestId);

    // Step 6 — call repository (which orchestrates buildPackage + write).
    //
    // The repository (and the buildPackage it calls into) constructs
    // AramoErrors with a non-HTTP-context requestId placeholder
    // ('builder'). The HTTP boundary owns the real request_id, so any
    // error bubbling up gets re-thrown with the controller's requestId
    // bound in. This keeps the locked Phase 5 error envelope's
    // request_id field consistent with the rest of the response.
    let submittal: TalentSubmittalRecordView;
    try {
      submittal = await this.submittalRepository.createSubmittal({
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
        ...(body.engagement_event_refs !== undefined
          ? { engagement_event_refs: body.engagement_event_refs }
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
        // Re-throw with the controller's requestId in the envelope.
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
        {
          requestId,
          details: { consumer_type: authContext.consumer_type },
        },
      );
    }
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

  // M4 PR-4 §4.3 — POST /v1/submittals/{submittal_id}/confirm.
  //
  // Recruiter-facing confirm flow that transitions a draft submittal to
  // 'submitted' state and stamps confirmed_at. Pre-write guards (in
  // order):
  //   1. consumer_type must be 'recruiter' (INSUFFICIENT_PERMISSIONS 403)
  //   2. Idempotency-Key header required (VALIDATION_ERROR 400)
  //   3. submittal_id path param must be a UUID (VALIDATION_ERROR 400)
  //   4. attestations manual check — all three must be literally true
  //      (ATTESTATION_MISSING 422); §11 self-audit resolution: NO
  //      @Equals(true) decorators on the DTO, because class-validator
  //      surfaces failures as VALIDATION_ERROR which collides with the
  //      directive-mandated ATTESTATION_MISSING code/status pair.
  //   5. Idempotency-Key lookup (replay-or-conflict-or-proceed).
  //   6. Repository confirm (the 8-step §4.2 flow).
  //   7. Persist idempotency record on success.
  //
  // Refusal codes that may flow up from the repository:
  //   - NOT_FOUND (404), SUBMITTAL_ALREADY_CONFIRMED (409),
  //     EXAMINATION_PINNED_OUTDATED (409), SUBMITTAL_STRETCH_BLOCKED (422),
  //     JUSTIFICATION_REQUIRED (422).
  // Each AramoError thrown by the repository already carries the bound
  // requestId via the ConfirmSubmittalInput.requestId — no re-wrapping
  // needed at this layer.
  @Post(':submittal_id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmSubmittal(
    @Param('submittal_id') submittal_id: string,
    @Body() body: ConfirmSubmittalRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ConfirmSubmittalResponseDto> {
    // Step 1 — auth posture (recruiter-only).
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — submittal_id UUID validation.
    if (!UUID_REGEX.test(submittal_id)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'submittal_id path parameter must be a UUID',
        400,
        { requestId, details: { invalid_field: 'submittal_id' } },
      );
    }

    // Step 4 — attestations manual check. The DTO documents the locked
    // `true` values via TS type literals + OpenAPI const; runtime
    // enforcement happens here so we can throw the directive-mandated
    // ATTESTATION_MISSING 422 rather than class-validator's
    // VALIDATION_ERROR 400 (§4.4 / §11 self-audit resolution).
    if (
      body.attestations.talent_evidence_reviewed !== true
      || body.attestations.constraints_reviewed !== true
      || body.attestations.submittal_risk_acknowledged !== true
    ) {
      throw new AramoError(
        'ATTESTATION_MISSING',
        'All three attestations must be true: talent_evidence_reviewed, constraints_reviewed, submittal_risk_acknowledged',
        422,
        {
          requestId,
          details: {
            submittal_id,
            talent_evidence_reviewed: body.attestations.talent_evidence_reviewed,
            constraints_reviewed: body.attestations.constraints_reviewed,
            submittal_risk_acknowledged: body.attestations.submittal_risk_acknowledged,
          },
        },
      );
    }

    // Step 5 — idempotency lookup. Replay returns the prior 200 body
    // without touching state; conflict throws 409 IDEMPOTENCY_KEY_CONFLICT;
    // proceed continues to repository call.
    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as ConfirmSubmittalResponseDto;
    }

    // Step 6 — repository confirm. AramoErrors raised by the 8-step
    // flow already carry the correct requestId (threaded via the input
    // shape), so they propagate unchanged.
    const submittal: TalentSubmittalRecordView =
      await this.submittalRepository.confirmSubmittal({
        tenant_id: authContext.tenant_id,
        submittal_id,
        attestations: body.attestations,
        requestId,
      });

    const response: ConfirmSubmittalResponseDto = { submittal };

    // Step 7 — persist idempotency record (post-mutation success only;
    // a failed confirm leaves no cached response).
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    return response;
  }
}
