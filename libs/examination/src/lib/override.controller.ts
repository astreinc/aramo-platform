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

import {
  CreateOverrideRequestDto,
  isOverrideTypeValue,
  type CreateOverrideResponseDto,
  type ExaminationOverrideView,
} from './dto/create-override-request.dto.js';
import { ExaminationRepository } from './examination.repository.js';

// M4 PR-5 §4.4 — POST /v1/examinations/{examination_id}/overrides.
//
// Recruiter-facing endpoint that records a recruiter-authored override on
// an active examination WITHOUT mutating the immutable TalentJobExamination
// row (write-isolation contract per Group 2 §2.4-§2.5). The repository
// surface (ExaminationRepository.createOverride) holds the contract; the
// controller validates input shape, enforces auth posture, runs idempotency,
// then re-emits the literal { examination_mutated: false } invariant the
// API contract carries.
//
// Auth posture: class-level JwtAuthGuard + per-route consumer_type
// === 'recruiter' assertion inside the handler (M3 PR-8 / M4 PR-3 / M4 PR-4
// precedent — non-recruiter consumers are 403'd at the route, not just
// authenticated).
//
// Idempotency-Key handling (M4 PR-3 / PR-4 precedent):
//   - header missing → 400 VALIDATION_ERROR
//   - header non-UUID → 400 VALIDATION_ERROR
//   - header present, key matches prior request body → replay 201
//   - header present, key matches but body differs → 409
//     IDEMPOTENCY_KEY_CONFLICT (from IdempotencyService.lookup)
//   - header present, new key → process + persist
//
// Refusal codes that may surface from the repository:
//   - NOT_FOUND (404) — examination missing, archived/cold_storage, or
//     cross-tenant. AramoError comes back from the substrate with the
//     placeholder requestId='override' which the controller re-throws
//     with the bound requestId (PR-3 substrate-layer enrichment precedent).
//
// Response invariant: examination_mutated is hard-coded to the literal
// `false` — never derived from a row read. The TS literal type +
// OpenAPI const: false combination prevents accidental drift.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/examinations')
@UseGuards(JwtAuthGuard)
export class OverrideController {
  constructor(
    private readonly examinationRepository: ExaminationRepository,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post(':examination_id/overrides')
  @HttpCode(HttpStatus.CREATED)
  async createOverride(
    @Param('examination_id') examinationId: string,
    @Body() body: CreateOverrideRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CreateOverrideResponseDto> {
    // Step 1 — auth posture (recruiter-only).
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required + UUID-shaped.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — examination_id UUID validation.
    if (!UUID_REGEX.test(examinationId)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'examination_id path parameter must be a UUID',
        400,
        { requestId, details: { invalid_field: 'examination_id' } },
      );
    }

    // Step 4 — class-validator validates the trivial shape (strings,
    // non-empty, length) via the global ValidationPipe; an override_type
    // value outside the closed list is INTENTIONALLY checked here so the
    // refusal surfaces as OVERRIDE_INVALID 422 (directive §4.9), not as
    // class-validator's VALIDATION_ERROR 400. Mirrors M4 PR-4's
    // ATTESTATION_MISSING manual check (the locked code/status pair
    // bypass).
    if (!isOverrideTypeValue(body.override_type)) {
      throw new AramoError(
        'OVERRIDE_INVALID',
        'override_type is not in the closed list (tier, risk_flag, gap, constraint_check)',
        422,
        {
          requestId,
          details: {
            invalid_field: 'override_type',
            received: String(body.override_type),
          },
        },
      );
    }

    // Step 5 — idempotency lookup (replay-or-conflict-or-proceed).
    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as CreateOverrideResponseDto;
    }

    // Step 6 — actor identity. created_by is the recruiter's UUID
    // derived from the JWT's `sub` claim. Mirrors the PR-3
    // SubmittalController.assertSubIsUuid pattern.
    const created_by = this.assertSubIsUuid(authContext, requestId);

    // Step 7 — repository call. The substrate throws AramoError with a
    // placeholder requestId='override'; re-throw with the controller's
    // bound requestId so the locked Phase 5 envelope's request_id field
    // matches the rest of the response (PR-3 precedent).
    let view: ExaminationOverrideView;
    try {
      view = await this.examinationRepository.createOverride({
        tenant_id: authContext.tenant_id,
        examination_id: examinationId,
        override_type: body.override_type,
        target_field: body.target_field,
        justification: body.justification,
        created_by,
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

    // Step 8 — response with LITERAL examination_mutated: false. Hard-
    // coded per directive §4.4 step 8; never derived from a row read.
    const response: CreateOverrideResponseDto = {
      override: view,
      examination_mutated: false,
    };

    // Step 9 — persist idempotency record (post-mutation success only;
    // a failed create leaves no cached response).
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
        'examination-override endpoint is recruiter-only',
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
}
