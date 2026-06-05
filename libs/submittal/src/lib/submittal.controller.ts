import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AramoError,
  type AramoLogger,
  RequestId,
  hashCanonicalizedBody,
} from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { IdempotencyService } from '@aramo/consent';
import {
  EvidenceRepository,
  type TalentJobEvidencePackageView,
} from '@aramo/evidence';

import type { ConfirmAtsResponseDto } from './dto/confirm-ats-request.dto.js';
import type {
  ConfirmSubmittalRequestDto,
  ConfirmSubmittalResponseDto,
} from './dto/confirm-submittal-request.dto.js';
import type {
  CreateSubmittalRequestDto,
  CreateSubmittalResponseDto,
} from './dto/create-submittal-request.dto.js';
import type { MarkReadyResponseDto } from './dto/mark-ready-request.dto.js';
import { RevokeSubmittalRequestDto } from './dto/revoke-submittal-request.dto.js';
import type { RevokeSubmittalResponseDto } from './dto/revoke-submittal-response.dto.js';
import type { SubmitToAtsResponseDto } from './dto/submit-to-ats-request.dto.js';
import type { TalentSubmittalRecordView } from './dto/talent-submittal-record.view.js';
import { SubmittalRepository } from './submittal.repository.js';

// M4 PR-3 §4.4 — POST /v1/submittals controller.
//
// Recruiter-facing endpoint that takes a CreateSubmittalRequestDto + an
// Idempotency-Key header, builds the immutable TalentJobEvidencePackage
// via SubmittalRepository.createSubmittal (which orchestrates PR-2's
// EvidenceRepository.buildPackage), persists the workflow
// TalentSubmittalRecord in state='created' (M5 PR-8b2 rename), and returns the submittal +
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

// PR-A1a §6 — route enforcement wired here. JwtAuthGuard runs first
// (AuthN); RolesGuard runs second (AuthZ) and is a no-op on any handler
// that does not carry @RequireScopes metadata (so existing routes on
// this controller are unaffected). @RequireScopes('submittal:create')
// is applied to the createSubmittal handler below; the recruiter role
// catalog is seeded with that scope (libs/identity/prisma/seed.ts).
@Controller('v1/submittals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SubmittalController {
  constructor(
    private readonly submittalRepository: SubmittalRepository,
    private readonly idempotencyService: IdempotencyService,
    // M4 PR-6 §4.2 — EvidenceRepository injected for the
    // GET /v1/submittals/{id}/evidence-package endpoint (chain:
    // submittal findById → evidence-package findById).
    private readonly evidenceRepository: EvidenceRepository,
    // M4 PR-9 §4.5 — structured logger injected via DI. Provider lives
    // in SubmittalModule keyed by the 'SubmittalControllerLogger' token;
    // factory context is SubmittalController.name. Available for future
    // HTTP-layer emit sites (PR-9 PoC adoption establishes the scaffold;
    // no controller emit sites in this PR per single-change discipline).
    @Inject('SubmittalControllerLogger')
    private readonly logger: AramoLogger,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('submittal:create')
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
  // 'handoff_draft' state (M5 PR-8b2 Ruling 12). Pre-write guards (in
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
  @RequireScopes('submittal:approve')
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
    //
    // M5 PR-8b2 §4.5 + Ruling 18: event_id minted controller-side via
    // crypto.randomUUID() and threaded through to the repository's
    // $transaction (mirrors engagement-side transitionState
    // event-id-minting pattern). The repository returns
    // { submittal, event }; the M4 client contract preserves the
    // { submittal } response shape so the `event` field is dropped at
    // the HTTP boundary (audit-event surfaces via the future
    // GET /v1/submittals/{id}/events read endpoint).
    const event_id = randomUUID();
    const { submittal } = await this.submittalRepository.confirmSubmittal({
      tenant_id: authContext.tenant_id,
      submittal_id,
      attestations: body.attestations,
      event_id,
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

  // M4 PR-6 §4.1 — GET /v1/submittals/{submittal_id}.
  //
  // Tenant-scoped read of a TalentSubmittalRecord. Five ordered steps:
  //   1. consumer_type must be 'recruiter' (INSUFFICIENT_PERMISSIONS 403)
  //   2. submittal_id path param must be a UUID (VALIDATION_ERROR 400)
  //   3. submittalRepository.findById tenant-scoped
  //   4. null → NOT_FOUND 404
  //   5. return the view directly
  //
  // No Idempotency-Key handling (Ruling 8 — GET routes don't require it).
  // No state mutation; no examination_mutated invariant.
  @Get(':submittal_id')
  @HttpCode(HttpStatus.OK)
  async getSubmittal(
    @Param('submittal_id') submittal_id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TalentSubmittalRecordView> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    this.assertSubmittalIdIsUuid(submittal_id, requestId);

    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const submittal = await this.submittalRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id: submittal_id,
      visible_requisition_ids: visibleReqIds,
    });
    if (submittal === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentSubmittalRecord not found (or not visible to actor)',
        404,
        { requestId, details: { submittal_id } },
      );
    }
    return submittal;
  }

  // M4 PR-6 §4.1 — GET /v1/submittals/{submittal_id}/evidence-package.
  //
  // Tenant-scoped chain lookup: load the submittal (verifying tenancy),
  // then load the linked TalentJobEvidencePackage by the submittal's
  // evidence_package_id (re-asserting tenancy in the second findById).
  // Seven ordered steps:
  //   1. consumer_type must be 'recruiter' (INSUFFICIENT_PERMISSIONS 403)
  //   2. submittal_id path param must be a UUID (VALIDATION_ERROR 400)
  //   3. submittalRepository.findById tenant-scoped
  //   4. null → NOT_FOUND 404 ('TalentSubmittalRecord not found')
  //   5. evidenceRepository.findById on submittal.evidence_package_id
  //   6. null → NOT_FOUND 404 ('TalentJobEvidencePackage not found
  //      (chain-break)') — defensive; should not happen given the
  //      cross-schema invariant (Architecture §7.3) that
  //      TalentSubmittalRecord.evidence_package_id always points to a
  //      live package row in the evidence schema. PR-6 surfaces this
  //      defensively rather than throwing 500.
  //   7. return the evidence-package view directly
  @Get(':submittal_id/evidence-package')
  @HttpCode(HttpStatus.OK)
  async getEvidencePackage(
    @Param('submittal_id') submittal_id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TalentJobEvidencePackageView> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    this.assertSubmittalIdIsUuid(submittal_id, requestId);

    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const submittal = await this.submittalRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id: submittal_id,
      visible_requisition_ids: visibleReqIds,
    });
    if (submittal === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentSubmittalRecord not found (or not visible to actor)',
        404,
        { requestId, details: { submittal_id } },
      );
    }

    const evidencePackage = await this.evidenceRepository.findById({
      tenant_id: authContext.tenant_id,
      id: submittal.evidence_package_id,
    });
    if (evidencePackage === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEvidencePackage not found (chain-break)',
        404,
        {
          requestId,
          details: {
            submittal_id,
            evidence_package_id: submittal.evidence_package_id,
          },
        },
      );
    }
    return evidencePackage;
  }

  private assertSubmittalIdIsUuid(submittal_id: string, requestId: string): void {
    if (!UUID_REGEX.test(submittal_id)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'submittal_id path parameter must be a UUID',
        400,
        { requestId, details: { invalid_field: 'submittal_id' } },
      );
    }
  }

  // M4 PR-7 §4.4 — POST /v1/submittals/{submittal_id}/revoke.
  //
  // Recruiter-facing revoke flow that transitions a submitted
  // submittal to 'revoked' state and stamps revoked_at / revoked_by /
  // revocation_justification atomically. The response carries the
  // LOCKED invariant `evidence_package_mutated: false` — every
  // successful revoke affirms that the referenced
  // TalentJobEvidencePackage row is byte-identical to its pre-revoke
  // snapshot (state-isolation contract verified end-to-end by the Pact
  // provider's seedSubmittalRevokeFixture + checkEvidencePackageState
  // Isolation hook per directive §4.9).
  //
  // Eight ordered steps (directive §4.4):
  //   1. assertConsumerIsRecruiter → INSUFFICIENT_PERMISSIONS 403.
  //   2. assertIdempotencyKeyRequired → VALIDATION_ERROR 400.
  //   3. assertSubmittalIdIsUuid → VALIDATION_ERROR 400.
  //   4. class-validator on RevokeSubmittalRequestDto body (run by the
  //      global ValidationPipe before this handler is invoked) →
  //      VALIDATION_ERROR 400 on shape failure (non-string, empty,
  //      >2000 chars). The DTO class import is necessary so reflect-
  //      metadata wires the validation decorators at boot.
  //   5. idempotencyService lookup (replay-or-conflict-or-proceed).
  //   6. submittalRepository.revokeSubmittal with bound requestId.
  //      AramoErrors raised by the 5-step flow already carry the
  //      input.requestId, so they propagate unchanged — but the catch
  //      below re-binds the controller's requestId defensively, mirroring
  //      the PR-3 substrate-layer error-catch pattern in
  //      createSubmittal step 6 (the repository may carry a placeholder
  //      requestId on errors thrown from helper layers).
  //   7. idempotencyService.persist (post-mutation success only).
  //   8. Return { submittal, evidence_package_mutated: false as const }
  //      LITERAL.
  //
  // @HttpCode(HttpStatus.OK) — 200, not 201 (state transition on an
  // existing resource, no new row created).
  @Post(':submittal_id/revoke')
  @RequireScopes('submittal:approve')
  @HttpCode(HttpStatus.OK)
  async revokeSubmittal(
    @Param('submittal_id') submittal_id: string,
    @Body() body: RevokeSubmittalRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RevokeSubmittalResponseDto> {
    // Step 1 — auth posture (recruiter-only).
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — submittal_id UUID validation.
    this.assertSubmittalIdIsUuid(submittal_id, requestId);

    // Step 4 — class-validator runs at the global ValidationPipe; the
    // DTO import threads its decorators through reflect-metadata.

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
      return lookup.response_body as RevokeSubmittalResponseDto;
    }

    // Step 5b — actor identity (revoked_by). The JWT sub is the
    // recruiter actor UUID; the same UUID_REGEX check used by
    // createSubmittal step 5 (assertSubIsUuid) is reused here.
    const revoked_by = this.assertSubIsUuid(authContext, requestId);

    // Step 6 — repository revoke. Any AramoError raised by the 5-step
    // flow carries the bound requestId already; the catch re-binds
    // defensively per the PR-3 substrate-layer error-catch pattern.
    //
    // M5 PR-8b2 §4.5 + Ruling 18: event_id minted controller-side;
    // repository returns { submittal, event } via $transaction; the M4
    // client contract preserves the { submittal, evidence_package_
    // mutated: false } response shape so the `event` field is dropped
    // at the HTTP boundary.
    const revoke_event_id = randomUUID();
    let submittal: TalentSubmittalRecordView;
    try {
      const result = await this.submittalRepository.revokeSubmittal({
        tenant_id: authContext.tenant_id,
        submittal_id,
        revoked_by,
        revocation_justification: body.revocation_justification,
        event_id: revoke_event_id,
        requestId,
      });
      submittal = result.submittal;
    } catch (err) {
      if (err instanceof AramoError) {
        throw new AramoError(err.code, err.message, err.statusCode, {
          ...err.context,
          requestId,
        });
      }
      throw err;
    }

    const response: RevokeSubmittalResponseDto = {
      submittal,
      // LOCKED literal per directive §4.4 — the response affirms the
      // write-isolation invariant (no evidence-package mutation
      // anywhere in the revoke flow). The TypeScript literal-type
      // `false` prevents accidental drift to `true`.
      evidence_package_mutated: false,
    };

    // Step 7 — persist idempotency record (post-mutation success only;
    // a failed revoke leaves no cached response).
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    // Step 8 — return.
    return response;
  }

  // M5 PR-8b2 §4.5 — POST /v1/submittals/{submittal_id}/mark-ready.
  //
  // Fires the canonical mainline transition handoff_draft ->
  // ready_for_review (mainline transition 2). 9-step idempotency flow:
  //   1. assertConsumerIsRecruiter -> INSUFFICIENT_PERMISSIONS 403
  //   2. assertIdempotencyKeyRequired -> VALIDATION_ERROR 400
  //   3. assertSubmittalIdIsUuid -> VALIDATION_ERROR 400
  //   4. Body validation (empty body per Ruling 13)
  //   5. Idempotency lookup (replay/conflict/proceed)
  //   6. Mint event_id (Ruling 18; crypto.randomUUID)
  //   7. Repository markReady ($transaction: update + appendEvent)
  //   8. Idempotency persist (post-success only)
  //   9. Return { submittal, event }
  @Post(':submittal_id/mark-ready')
  @RequireScopes('submittal:approve')
  @HttpCode(HttpStatus.OK)
  async markReady(
    @Param('submittal_id') submittal_id: string,
    @Body() body: Record<string, unknown>,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<MarkReadyResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    this.assertSubmittalIdIsUuid(submittal_id, requestId);

    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as MarkReadyResponseDto;
    }

    const event_id = randomUUID();
    const { submittal, event } = await this.submittalRepository.markReady({
      tenant_id: authContext.tenant_id,
      submittal_id,
      event_id,
      requestId,
    });

    const response: MarkReadyResponseDto = { submittal, event };

    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    return response;
  }

  // M5 PR-8b2 §4.5 — POST /v1/submittals/{submittal_id}/submit-to-ats.
  //
  // Fires the canonical mainline transition ready_for_review ->
  // submitted_to_ats (mainline transition 3). Per Ruling 6 this is the
  // transition that populates confirmed_at NULL -> non-NULL (preserving
  // M4 confirmed_at column semantic post-rename).
  //
  // 9-step idempotency flow per markReady precedent.
  @Post(':submittal_id/submit-to-ats')
  @RequireScopes('submittal:approve')
  @HttpCode(HttpStatus.OK)
  async submitToAts(
    @Param('submittal_id') submittal_id: string,
    @Body() body: Record<string, unknown>,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SubmitToAtsResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    this.assertSubmittalIdIsUuid(submittal_id, requestId);

    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as SubmitToAtsResponseDto;
    }

    const event_id = randomUUID();
    const { submittal, event } = await this.submittalRepository.submitToAts({
      tenant_id: authContext.tenant_id,
      submittal_id,
      event_id,
      requestId,
    });

    const response: SubmitToAtsResponseDto = { submittal, event };

    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    return response;
  }

  // M5 PR-8b2 §4.5 — POST /v1/submittals/{submittal_id}/confirm-ats.
  //
  // Fires the canonical mainline transition submitted_to_ats ->
  // confirmed (mainline transition 4; lifecycle terminal). `confirmed`
  // is fully terminal -- not even sibling-revoke applies (Ruling 5).
  //
  // 9-step idempotency flow per markReady precedent.
  @Post(':submittal_id/confirm-ats')
  @RequireScopes('submittal:approve')
  @HttpCode(HttpStatus.OK)
  async confirmAts(
    @Param('submittal_id') submittal_id: string,
    @Body() body: Record<string, unknown>,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ConfirmAtsResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    this.assertSubmittalIdIsUuid(submittal_id, requestId);

    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as ConfirmAtsResponseDto;
    }

    const event_id = randomUUID();
    const { submittal, event } = await this.submittalRepository.confirmAts({
      tenant_id: authContext.tenant_id,
      submittal_id,
      event_id,
      requestId,
    });

    const response: ConfirmAtsResponseDto = { submittal, event };

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
