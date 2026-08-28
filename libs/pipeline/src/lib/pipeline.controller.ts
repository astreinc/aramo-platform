import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId, hashCanonicalizedBody } from '@aramo/common';
import { IdempotencyService } from '@aramo/consent';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { CreatePipelineRequestDto } from './dto/create-pipeline-request.dto.js';
import type { PipelineStatusHistoryView } from './dto/pipeline-status-history.view.js';
import type { PipelineView } from './dto/pipeline.view.js';
import type { TransitionPipelineRequestDto } from './dto/transition-pipeline-request.dto.js';
import { PipelineRepository } from './pipeline.repository.js';
import { AddTalentPolicyService } from './policy/add-talent-policy.service.js';
import { resolveAddTalentOutcome } from './policy/override-resolution.js';

// PipelineController — PR-A5a Gate 5 ATS Batch 4a (the state machine).
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// === Scope gating (HK-IDENT-SCOPES — proper scopes seeded) ===
// Seeded catalog (recruiter+ unless noted):
//   - pipeline:read (HK-IDENT-SCOPES)
//   - pipeline:add
//   - pipeline:change-status   ← THE transition scope
//   - pipeline:add-activity
//   - pipeline:remove (tenant_admin only)
//
// Read routes (list/get/history) now key on the proper `pipeline:read`
// scope, replacing the A5a `pipeline:add` superset expedient.
// L2-B — the Idempotency-Key header must be a v4-shaped UUID (mirrors
// libs/selection SelectionController.assertIdempotencyKeyRequired). A
// missing or malformed key is a client contract error (400 VALIDATION_ERROR),
// distinct from a downstream mutation conflict.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/pipelines')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class PipelineController {
  constructor(
    private readonly pipelineRepository: PipelineRepository,
    private readonly addTalentPolicy: AddTalentPolicyService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('talent_record_id') talentRecordId: string | undefined,
    @Req() req: Request,
  ): Promise<{ items: PipelineView[] }> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const items = await this.pipelineRepository.listForActor({
      tenant_id: authContext.tenant_id,
      visible_requisition_ids: visibleReqIds,
      ...(requisitionId === undefined ? {} : { requisition_id: requisitionId }),
      ...(talentRecordId === undefined
        ? {}
        : { talent_record_id: talentRecordId }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<PipelineView> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.pipelineRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Get(':id/history')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async listHistory(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<{ items: PipelineStatusHistoryView[] }> {
    // L2-A — read-visibility parity: history of a non-visible pipeline conceals as 404.
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const items = await this.pipelineRepository.listHistory({
      tenant_id: authContext.tenant_id,
      pipeline_id: id,
      requestId,
      visible_requisition_ids: visibleReqIds,
    });
    return { items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('pipeline:add')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreatePipelineRequestDto,
    @RequestId() requestId: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
  ): Promise<PipelineView> {
    // L2-B — the create command is idempotency-gated (mirrors libs/selection
    // SelectionController.create). A required v4-shaped Idempotency-Key is the
    // client's replay token: an identical retry (same key + same canonical
    // body) returns the FIRST committed response verbatim rather than birthing
    // a second episode. The lookup runs BEFORE the policy call + mutation so a
    // replay short-circuits the whole command.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    const requestHash = hashCanonicalizedBody(body as unknown);
    const replay = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (replay.kind === 'replay') {
      return replay.response_body as PipelineView;
    }

    // ADR-0024 §D10 — the policy call runs AFTER authorization (the guard chain
    // above) and BEFORE the write. It is placed at the CONTROLLER, never the
    // repository: a repository-level call would also gate repointTalentRecordRefs
    // (identity-merge reconciliation), which must not be recruiter-policy-gated.
    const outcome = await this.addTalentPolicy.decide({
      tenant_id: authContext.tenant_id,
      requisition_id: body.requisition_id,
      scopes: authContext.scopes,
      actor_id: authContext.sub,
      origin: 'ui',
      correlation_id: requestId,
    });

    // ADR-0024 §D11 (PR-4b) — two-pass override resolution: membership test
    // against the FROZEN scope set + reason capture. Same original proposal
    // (§D6 — no new action identifier); this endpoint is unchanged for ALLOW.
    const resolution = resolveAddTalentOutcome(
      outcome,
      authContext.scopes,
      body.override_reason_code,
    );

    if (resolution.kind === 'DENY') {
      // DENY, or REQUIRES_OVERRIDE with the capability absent: no mutation.
      // Record provenance standalone (the attempt), then refuse with the
      // reason_code ONLY — never rule_id / policy_version / any engine internal.
      await this.pipelineRepository.recordDecision(resolution.provenance);
      throw new AramoError(
        'POLICY_DENIED',
        'The requisition lifecycle policy denied this command',
        403,
        { requestId, details: { reason_code: resolution.reason_code } },
      );
    }
    if (resolution.kind === 'REASON_REQUIRED') {
      throw new AramoError(
        'OVERRIDE_INVALID',
        'This command requires an override reason',
        422,
        { requestId, details: { reason: 'override_reason_required' } },
      );
    }
    if (resolution.kind === 'REASON_INVALID') {
      throw new AramoError(
        'OVERRIDE_INVALID',
        'Unrecognised override reason code',
        422,
        {
          requestId,
          details: { reason: 'override_reason_code_invalid', value: resolution.value },
        },
      );
    }

    // ALLOW or OVERRIDE — the pipeline row and its provenance record (for an
    // OVERRIDE, provenance carries the reason_code + satisfying capability)
    // commit atomically.
    const created = await this.pipelineRepository.create({
      tenant_id: authContext.tenant_id,
      input: body,
      requestId,
      provenance: resolution.provenance,
      created_by_id: authContext.sub,
    });

    // L2-B — persist the idempotency record AFTER the mutation commits so a
    // failed create leaves no cached response (IdempotencyService contract).
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.CREATED,
      response_body: created,
    });

    return created;
  }

  // L2-B — the Idempotency-Key contract for POST /v1/pipelines. A missing or
  // non-UUID header is a client error (400 VALIDATION_ERROR), never a silent
  // pass-through (mirrors libs/selection SelectionController).
  private assertIdempotencyKeyRequired(
    idempotencyKey: string | undefined,
    requestId: string,
  ): string {
    if (
      idempotencyKey === undefined ||
      idempotencyKey === '' ||
      !UUID_REGEX.test(idempotencyKey)
    ) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'A valid Idempotency-Key header (UUID) is required',
        400,
        { requestId, details: { header: 'Idempotency-Key' } },
      );
    }
    return idempotencyKey;
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:change-status')
  @RequireSiteMatch()
  async transition(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: TransitionPipelineRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<PipelineView> {
    // L2-A — expected_version is REQUIRED; a missing/non-numeric value is
    // rejected here (422), never silently treated as 0.
    if (typeof body.expected_version !== 'number') {
      throw new AramoError(
        'VALIDATION_ERROR',
        'expected_version is required for a pipeline transition',
        422,
        { requestId, details: { field: 'expected_version' } },
      );
    }
    // L2-A — write-visibility parity: a transition on a non-visible pipeline
    // conceals as 404 (same as the read paths).
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.pipelineRepository.transition({
      tenant_id: authContext.tenant_id,
      id,
      to_status: body.to_status,
      changed_by_id: authContext.sub,
      ...(body.note === undefined ? {} : { note: body.note }),
      requestId,
      expected_version: body.expected_version,
      visible_requisition_ids: visibleReqIds,
    });
  }

  // Lane 2 / L2-B — DELETE /v1/pipelines/:id is WITHDRAWN. A durable recruiting
  // audit must not be casually destructible: the DB-layer append-only trigger on
  // PipelineStatusHistory rejects the cascade delete outside a governed
  // tenant-reset, and re-entry uses a fresh episode (a terminal episode already
  // releases the live slot). Legal/privacy erasure remains the tenant-reset
  // service's authorized-GUC purge path (its exact-value reset escape, set only
  // by that service).
}
