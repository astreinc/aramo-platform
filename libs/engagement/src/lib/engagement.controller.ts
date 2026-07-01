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
  Query,
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
import { ConsentService, IdempotencyService } from '@aramo/consent';
import { AiDraftService } from '@aramo/ai-draft';

import type { CreateEngagementRequestDto } from './dto/create-engagement-request.dto.js';
import type { CreateEngagementResponseDto } from './dto/create-engagement-response.dto.js';
import type { EngagementListResponseDto } from './dto/engagement-list-response.dto.js';
import type { TransitionEngagementRequestDto } from './dto/transition-engagement-request.dto.js';
import type { TransitionEngagementResponseDto } from './dto/transition-engagement-response.dto.js';
import type { EngagementListEventsResponseDto } from './dto/engagement-list-events-response.dto.js';
import { OutreachDraftRequestDto } from './dto/outreach-draft-request.dto.js';
import type { OutreachDraftResponseDto } from './dto/outreach-draft-response.dto.js';
import { OutreachSendRequestDto } from './dto/outreach-send-request.dto.js';
import type { OutreachSendResponseDto } from './dto/outreach-send-response.dto.js';
import type { OutreachDraftedPayload } from './dto/outreach-drafted-payload.js';
import type { OutreachSentPayload } from './dto/outreach-sent-payload.js';
import { RecordResponseRequestDto } from './dto/record-response-request.dto.js';
import type { RecordResponseResponseDto } from './dto/record-response-response.dto.js';
import { RecordConversationStartedRequestDto } from './dto/record-conversation-started-request.dto.js';
import type { RecordConversationStartedResponseDto } from './dto/record-conversation-started-response.dto.js';
import type { TalentJobEngagementView } from './dto/talent-job-engagement.view.js';
import type {
  DeliveryProvider,
  DeliveryResult,
} from './delivery/delivery-provider.interface.js';
import { DELIVERY_PROVIDER_TOKEN } from './delivery/tokens.js';
import { EngagementEventRepository } from './engagement-event.repository.js';
import { EngagementRepository } from './engagement.repository.js';
import { canTransition } from './engagement-state.js';

// M5 PR-4 §4.1 — EngagementController.
//
// First HTTP-bearing surface in libs/engagement. Endpoints (9 total
// after the Outreach Draft/Preview split replaces the atomic outreach
// endpoint with draft + send):
//   - GET  /v1/engagements                              (LIST — R7 BE-prereq)
//   - POST /v1/engagements                              (create)
//   - POST /v1/engagements/{id}/transitions             (state transition)
//   - POST /v1/engagements/{id}/outreach/draft          (AI draft + persist PENDING — NO delivery)
//   - POST /v1/engagements/{id}/outreach/send           (deliver approved draft + consent-at-send)
//   - POST /v1/engagements/{id}/response                (record response)
//   - POST /v1/engagements/{id}/conversation            (record conversation)
//   - GET  /v1/engagements/{id}                         (read engagement)
//   - GET  /v1/engagements/{id}/events                  (read event log)
//
// The atomic POST /v1/engagements/{id}/outreach (prompt→draft→send in one
// call, no preview) was REMOVED by the Outreach Draft/Preview Directive
// v1.0 — leaving it live would let a caller send without preview, a hole
// in the human-in-the-loop guarantee. The split makes draft→preview→send
// the ONLY outreach path (a compliance requirement, not cleanup).
//
// Auth posture (Ruling 8 + R7 BE-prereq Amendment v1.1 §1+§5):
// class-level JwtAuthGuard + RolesGuard (the submittal precedent —
// scope-gated, recruiter-only, no @RequireCapability since the
// engagement endpoints have no per-tenant entitlement axis); per-route
// @RequireScopes(engagement:read / engagement:write / engagement:outreach)
// + per-route consumer_type === 'recruiter' assertion (defense in
// depth: the scope gate is the primary check; the consumer_type
// assertion stays as a belt-and-suspenders constraint that platform
// tokens never satisfy). Non-recruiter consumers 403 with
// INSUFFICIENT_PERMISSIONS.
//
// === D4b visibility (R7 BE-prereq Amendment v1.1 §3 Ruling 3 D) ===
// Engagement is visible iff its requisition_id is in the actor's
// visible-requisition set (req.resolveVisibleRequisitionIds!() —
// null = see-all). The controller threads the resolved set through:
//   - Reads (LIST + GET /:id + GET /:id/events): composed at the repo's
//     findByTenant{,AndId,AndTalent,AndRequisition} (single source of
//     truth — invisible-requisition engagement returns null → 404).
//   - Writes (transitions / outreach / response / conversation): the
//     repo's write methods accept the same visibility set and pass it
//     to their internal findByTenantAndId pre-read (uniform inheritance).
//   - Create: assertRequisitionVisible(body.requisition_id, visibleReqIds)
//     fires BEFORE repo.createEngagement — 404 if the requisition the
//     engagement would attach to isn't visible.
// Not-visible response code is 404 NOT_FOUND uniformly (the non-leak
// posture, matching the requisition precedent); the scope-gate 403
// INSUFFICIENT_PERMISSIONS stays distinct (no-capability vs not-this-
// record).
//
// POST endpoint pattern (Ruling 4 — 9-step):
//   1. consumer_type check (assertConsumerIsRecruiter)
//   2. Idempotency-Key required + UUID-shaped (assertIdempotencyKeyRequired)
//   3. id UUID validation (transition only — path param)
//   4. body hash for replay-vs-conflict (hashCanonicalizedBody)
//   5. idempotencyService.lookup (replay-or-conflict-or-proceed)
//   6. repository call with requestId re-binding (try/catch AramoError)
//   7. response compose
//   8. idempotencyService.persist (post-mutation success only)
//   9. return
//
// GET endpoint pattern (Ruling 5 + M4 PR-6 precedent — 5-step):
//   1. consumer_type check
//   2. id UUID validation
//   3. repository call (tenant-scoped via findByTenantAndId)
//   4. null → NOT_FOUND 404
//   5. return (no idempotency, no body hash, no logger refusal — GETs
//      are side-effect-free)
//
// Create-response shape (Ruling 9): { engagement } only. Repository-
// layer CreateEngagementResult returns { engagement, event }; the
// controller projects to entity-only. The initial event row is
// accessible via GET /v1/engagements/{id}/events.
//
// Transition body shape (Ruling 10): { to_state, event_id }. id of the
// parent engagement comes from the URL path. NO per-verb endpoints; a
// single /transitions sub-resource handles all 10 legal transitions.
//
// NO engagement_unrelated_columns_mutated literal field (Ruling 11) —
// DB-trigger enforces the invariant; HTTP contract affirmation omitted.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// R7 BE-prereq §3 — null-safe resolver for the actor's visible-requisition
// set. The VisibilityInterceptor (apps/api APP_INTERCEPTOR) attaches
// `req.resolveVisibleRequisitionIds()` to every authenticated request
// (see libs/visibility/src/lib/visibility.interceptor.ts). Returns:
//   - ReadonlySet<string> → narrow visibility filter (A3-OR-D4b composed).
//   - null                → see-all (callers w/ requisition:read:all OR
//                            the back-compat unit-test path where no Request
//                            is injected; visibility check trivially passes).
async function resolveVisibleReqIds(
  req: Request | undefined,
): Promise<ReadonlySet<string> | null> {
  if (req?.resolveVisibleRequisitionIds === undefined) return null;
  return req.resolveVisibleRequisitionIds();
}

@Controller('v1/engagements')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EngagementController {
  constructor(
    private readonly engagementRepository: EngagementRepository,
    private readonly engagementEventRepository: EngagementEventRepository,
    private readonly idempotencyService: IdempotencyService,
    // M5 PR-9b §4.1 / Ruling 1 — ConsentService injected for runtime
    // consent-at-send enforcement in sendOutreach() Step 5.5. Cross-lib
    // edge engagement → consent already established via IdempotencyService
    // (audit Axis D); this extension is purely additive.
    private readonly consentService: ConsentService,
    @Inject('EngagementControllerLogger')
    private readonly logger: AramoLogger,
    // M5 PR-6 §4.1 — AiDraftService dep for outreach LLM drafts.
    private readonly aiDraftService: AiDraftService,
    // M5 PR-6 §4.3 — DeliveryProvider port (SendStub at PR-6).
    @Inject(DELIVERY_PROVIDER_TOKEN)
    private readonly deliveryProvider: DeliveryProvider,
  ) {}

  // ---- GET /v1/engagements (LIST — R7 BE-prereq P1) --------------------
  //
  // The actor's visible engagements (D4b-composed). Filter semantics:
  //   - no filter   → all visible engagements in tenant
  //   - ?talent_id  → that talent's visible engagements
  //   - ?requisition_id → that requisition's engagements (empty if the
  //                  requisition itself is invisible to the actor)
  //   - both        → the intersection (at most one row by natural key)

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:read')
  async listEngagements(
    @AuthContext() authContext: AuthContextType,
    @Query('talent_id') talentIdFromQuery: string | undefined,
    @Query('requisition_id') requisitionIdFromQuery: string | undefined,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<EngagementListResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    const visibleReqIds = await resolveVisibleReqIds(req);
    let items: TalentJobEngagementView[];
    if (
      talentIdFromQuery !== undefined &&
      requisitionIdFromQuery !== undefined
    ) {
      // Both filters: intersection. The natural key (tenant, talent,
      // requisition) gives at most one row. Use the requisition-filtered
      // path (handles the invisible-requisition short-circuit) then
      // narrow by talent_id in-memory.
      const reqScoped = await this.engagementRepository.findByTenantAndRequisition({
        tenant_id: authContext.tenant_id,
        requisition_id: requisitionIdFromQuery,
        visible_requisition_ids: visibleReqIds,
      });
      items = reqScoped.filter((e) => e.talent_id === talentIdFromQuery);
    } else if (talentIdFromQuery !== undefined) {
      items = await this.engagementRepository.findByTenantAndTalent({
        tenant_id: authContext.tenant_id,
        talent_id: talentIdFromQuery,
        visible_requisition_ids: visibleReqIds,
      });
    } else if (requisitionIdFromQuery !== undefined) {
      items = await this.engagementRepository.findByTenantAndRequisition({
        tenant_id: authContext.tenant_id,
        requisition_id: requisitionIdFromQuery,
        visible_requisition_ids: visibleReqIds,
      });
    } else {
      items = await this.engagementRepository.findByTenant({
        tenant_id: authContext.tenant_id,
        visible_requisition_ids: visibleReqIds,
      });
    }
    return { items };
  }

  // ---- POST /v1/engagements --------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('engagement:write')
  async createEngagement(
    @Body() body: CreateEngagementRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<CreateEngagementResponseDto> {
    // Step 1 — auth posture (recruiter-only).
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 1.5 — R7 BE-prereq Amendment v1.1 §3 Ruling 3 — create is the
    // special case (no pre-existing engagement to gate via
    // findByTenantAndId). The visibility check is on the requisition the
    // engagement would attach to: 404 NOT_FOUND if invisible.
    const visibleReqIds = await resolveVisibleReqIds(req);
    this.assertRequisitionVisible(
      body.requisition_id,
      visibleReqIds,
      requestId,
    );

    // Step 2 — Idempotency-Key required + UUID-shaped.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 4 — body hash for replay-vs-conflict.
    const requestHash = hashCanonicalizedBody(body as unknown);

    // Step 5 — idempotency lookup.
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as CreateEngagementResponseDto;
    }

    // Step 6 — repository call. id + event_id generated server-side per
    // directive §4.2.
    let engagement: TalentJobEngagementView;
    try {
      const result = await this.engagementRepository.createEngagement({
        id: randomUUID(),
        event_id: randomUUID(),
        tenant_id: authContext.tenant_id,
        talent_id: body.talent_id,
        requisition_id: body.requisition_id,
        ...(body.examination_id !== undefined
          ? { examination_id: body.examination_id }
          : {}),
      });
      engagement = result.engagement;
    } catch (err) {
      if (err instanceof AramoError) {
        // Re-bind the controller's requestId.
        throw new AramoError(err.code, err.message, err.statusCode, {
          ...err.context,
          requestId,
        });
      }
      throw err;
    }

    // Step 7 — response compose (Ruling 9: { engagement } only).
    const response: CreateEngagementResponseDto = { engagement };

    // Step 8 — persist idempotency record (post-mutation success only).
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.CREATED,
      response_body: response,
    });

    return response;
  }

  // ---- POST /v1/engagements/{id}/transitions ---------------------------

  @Post(':id/transitions')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:write')
  async transitionEngagement(
    @Param('id') id: string,
    @Body() body: TransitionEngagementRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<TransitionEngagementResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 4 — body hash.
    const requestHash = hashCanonicalizedBody(body as unknown);

    // Step 5 — idempotency lookup.
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as TransitionEngagementResponseDto;
    }

    // Step 6 — repository call.
    // R7 BE-prereq §3 — visibility passed through to the repo's
    // internal findByTenantAndId pre-read (invisible requisition → 404).
    const visibleReqIds = await resolveVisibleReqIds(req);
    let engagement: TalentJobEngagementView;
    try {
      const result = await this.engagementRepository.transitionState({
        engagement_id: id,
        event_id: body.event_id,
        tenant_id: authContext.tenant_id,
        to_state: body.to_state,
        visible_requisition_ids: visibleReqIds,
      });
      engagement = result.engagement;
    } catch (err) {
      if (err instanceof AramoError) {
        throw new AramoError(err.code, err.message, err.statusCode, {
          ...err.context,
          requestId,
        });
      }
      throw err;
    }

    // Step 7 — response compose (Ruling 9 + Ruling 11).
    const response: TransitionEngagementResponseDto = { engagement };

    // Step 8 — persist.
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    return response;
  }

  // ---- POST /v1/engagements/{id}/outreach/draft ------------------------
  //
  // Outreach Draft/Preview Directive v1.0 / Amendment v1.1 §1 — the
  // GENERATION half of the human-in-the-loop split. Runs the LLM and
  // persists a PENDING outreach_drafted event; returns the drafted text +
  // the draft event id. NO delivery, NO outbox, NO state transition, NO
  // binding consent gate.
  //
  // Flow:
  //   1. assertConsumerIsRecruiter (recruiter-only).
  //   2. assertIdempotencyKeyRequired (draft key).
  //   3. assertEngagementIdIsUuid.
  //   4. hashCanonicalizedBody + idempotencyService.lookup (replay).
  //   5. pre-read engagement (visibility) → NOT_FOUND 404.
  //   6. DRAFT state-gate (Amendment v1.1 Ruling 2): canTransition(state,
  //      'awaiting_response') → 422 BEFORE generateDraft (no stranded
  //      drafts, no wasted LLM tokens on a non-engaged engagement).
  //   7. SOFT consent pre-check (Amendment v1.1 Ruling 1): NON-BLOCKING —
  //      on 'denied' attach consent_warning to the response but STILL
  //      draft. The binding consent gate is at SEND, not here.
  //   8. aiDraftService.generateDraft + error-code remap (Ruling 6).
  //   9. engagementRepository.draftOutreach (append outreach_drafted).
  //  10. response compose + idempotencyService.persist + return.
  //
  // Structured-logging discipline: NEVER raw prompt, raw completion, or
  // recipient_handle — only audit_record_id + model + token counts.

  @Post(':id/outreach/draft')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:outreach')
  async draftOutreach(
    @Param('id') id: string,
    @Body() body: OutreachDraftRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<OutreachDraftResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 4 — body hash + idempotency lookup (replay short-circuit).
    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as OutreachDraftResponseDto;
    }

    this.logger.log({
      event: 'engagement.outreach_draft_endpoint_started',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      request_id: requestId,
    });

    // Step 5 — pre-read engagement (visibility) → NOT_FOUND 404. Also
    // supplies talent_id for the soft consent check + state for the gate.
    const visibleReqIds = await resolveVisibleReqIds(req);
    const engagement = await this.engagementRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (engagement === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        { requestId, details: { engagement_id: id } },
      );
    }

    // Step 6 — DRAFT state-gate (Amendment v1.1 Ruling 2). Gate BEFORE
    // generateDraft so no LLM tokens are spent on a non-engaged
    // engagement. (The repository re-gates as single source of truth.)
    if (!canTransition(engagement.state, 'awaiting_response')) {
      this.logger.log({
        event: 'engagement.outreach_draft_refused',
        error_code: 'ENGAGEMENT_STATE_INVALID',
        tenant_id: authContext.tenant_id,
        engagement_id: id,
        from_state: engagement.state,
        to_state: 'awaiting_response',
      });
      throw new AramoError(
        'ENGAGEMENT_STATE_INVALID',
        `Illegal engagement state transition: ${engagement.state} -> awaiting_response`,
        422,
        {
          requestId,
          details: {
            engagement_id: id,
            from_state: engagement.state,
            to_state: 'awaiting_response',
          },
        },
      );
    }

    // Step 7 — SOFT consent pre-check (Amendment v1.1 Ruling 1).
    // NON-BLOCKING: on 'denied' we attach a warning but still draft. The
    // BINDING gate fires at SEND. A resolver 'error' is logged and
    // ignored here (it must not block drafting); the binding check at
    // SEND will surface it as 500 if it persists.
    let consentWarning: OutreachDraftResponseDto['consent_warning'];
    const consentDecision = await this.consentService.check(
      {
        // Post-#349 engagement.talent_id IS a TalentRecord.id; consent is now
        // TalentRecord-keyed (Step-5 re-key), so the gate meets the ledger.
        talent_record_id: engagement.talent_id,
        operation: 'engagement',
        channel: 'email',
      },
      undefined,
      authContext,
      requestId,
    );
    if (consentDecision.result === 'denied') {
      consentWarning = {
        ...(consentDecision.reason_code !== undefined
          ? { reason_code: consentDecision.reason_code }
          : {}),
        ...(consentDecision.display_message !== undefined
          ? { display_message: consentDecision.display_message }
          : {}),
      };
      this.logger.log({
        event: 'engagement.outreach_draft_consent_warning',
        tenant_id: authContext.tenant_id,
        engagement_id: id,
        reason_code: consentDecision.reason_code,
      });
    }

    // Step 8 — AI draft (with error-code remap, Ruling 6).
    let draftResult;
    try {
      draftResult = await this.aiDraftService.generateDraft({
        tenant_id: authContext.tenant_id,
        prompt: body.prompt,
        max_tokens: body.max_tokens ?? 512,
        ...(body.system_message !== undefined
          ? { system_message: body.system_message }
          : {}),
        requestId,
      });
    } catch (err) {
      if (err instanceof AramoError) {
        const kind = (err.context.details?.['kind'] as string | undefined) ?? null;
        if (
          err.code === 'INTERNAL_ERROR' &&
          (kind === 'provider_unavailable' || kind === 'provider_internal_error')
        ) {
          this.logger.log({
            event: 'engagement.outreach_draft_refused',
            error_code: 'AI_PROVIDER_UNAVAILABLE',
            tenant_id: authContext.tenant_id,
            engagement_id: id,
            kind,
          });
          throw new AramoError(
            'AI_PROVIDER_UNAVAILABLE',
            'AI provider unavailable',
            502,
            {
              requestId,
              details: { kind, original_message: err.message },
            },
          );
        }
        if (err.code === 'INTERNAL_ERROR' && kind === 'provider_rate_limited') {
          this.logger.log({
            event: 'engagement.outreach_draft_refused',
            error_code: 'AI_RATE_LIMITED',
            tenant_id: authContext.tenant_id,
            engagement_id: id,
            kind,
          });
          throw new AramoError('AI_RATE_LIMITED', 'AI provider rate-limited', 429, {
            requestId,
            details: { kind },
          });
        }
        throw new AramoError(err.code, err.message, err.statusCode, {
          ...err.context,
          requestId,
        });
      }
      throw err;
    }

    // Step 9 — persist the PENDING outreach_drafted event.
    const draftedPayload: OutreachDraftedPayload = {
      draft_text: draftResult.completion,
      ai_draft_audit_record_id: draftResult.audit_record_id,
      model_used: draftResult.model_used,
      input_tokens: draftResult.input_tokens,
      output_tokens: draftResult.output_tokens,
      duration_ms: draftResult.duration_ms,
      prompt: body.prompt,
      max_tokens: body.max_tokens ?? 512,
      ...(body.system_message !== undefined
        ? { system_message: body.system_message }
        : {}),
      ...(body.recipient_handle !== undefined
        ? { recipient_handle: body.recipient_handle }
        : {}),
    };

    let repoResult;
    try {
      repoResult = await this.engagementRepository.draftOutreach({
        engagement_id: id,
        tenant_id: authContext.tenant_id,
        draft_event_id: randomUUID(),
        drafted_payload: draftedPayload,
        visible_requisition_ids: visibleReqIds,
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

    // Step 10 — response compose.
    const response: OutreachDraftResponseDto = {
      draft_event_id: repoResult.draft_event.id,
      draft_text: draftResult.completion,
      ai_draft_audit_record_id: draftResult.audit_record_id,
      ...(consentWarning !== undefined ? { consent_warning: consentWarning } : {}),
    };

    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    this.logger.log({
      event: 'engagement.outreach_draft_endpoint_succeeded',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      draft_event_id: repoResult.draft_event.id,
      audit_record_id: draftResult.audit_record_id,
      model_used: draftResult.model_used,
      input_tokens: draftResult.input_tokens,
      output_tokens: draftResult.output_tokens,
      duration_ms: draftResult.duration_ms,
      consent_warned: consentWarning !== undefined,
    });

    return response;
  }

  // ---- POST /v1/engagements/{id}/outreach/send -------------------------
  //
  // Outreach Draft/Preview Directive v1.0 / Amendment v1.1 §2 — the
  // DELIVERY half of the split. Takes the source draft event id + the
  // recruiter-approved (possibly-edited) final text; runs the BINDING
  // consent-at-send check; delivers; then the existing atomic SEND
  // $transaction (state → awaiting_response + outreach_sent event [now
  // carrying final_text + source_draft_event_id] + state_transition event
  // + outbox emit + metered usage).
  //
  // Flow:
  //   1. assertConsumerIsRecruiter.
  //   2. assertIdempotencyKeyRequired (send key — independent of draft key).
  //   3. assertEngagementIdIsUuid.
  //   4. hashCanonicalizedBody + idempotencyService.lookup (replay).
  //   5. pre-read engagement (visibility) → NOT_FOUND 404.
  //   6. state pre-gate (canTransition → 422) BEFORE delivery — prevents
  //      double-send / wasted delivery (true single-send-per-engaged).
  //   7. source-draft cross-event-ref validation → 422 (also yields the
  //      draft payload's audit/token fields for the outreach_sent payload).
  //   8. BINDING consent-at-send (denied → 403 CONSENT_NOT_GRANTED_AT_SEND;
  //      resolver error → 500).
  //   9. deliveryProvider.deliver (final_text).
  //  10. engagementRepository.sendOutreach (re-validates ref + re-gates +
  //      atomic $transaction).
  //  11. response compose + idempotencyService.persist + return.

  @Post(':id/outreach/send')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:outreach')
  async sendOutreach(
    @Param('id') id: string,
    @Body() body: OutreachSendRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<OutreachSendResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 4 — body hash + idempotency lookup (replay short-circuit).
    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as OutreachSendResponseDto;
    }

    this.logger.log({
      event: 'engagement.outreach_send_endpoint_started',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      request_id: requestId,
    });

    // Step 5 — pre-read engagement (visibility) → NOT_FOUND 404.
    const visibleReqIds = await resolveVisibleReqIds(req);
    const engagement = await this.engagementRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (engagement === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        { requestId, details: { engagement_id: id } },
      );
    }

    // Step 6 — state pre-gate BEFORE delivery (true single-send: a second
    // send finds state 'awaiting_response' and 422s WITHOUT re-delivering).
    if (!canTransition(engagement.state, 'awaiting_response')) {
      this.logger.log({
        event: 'engagement.outreach_send_refused',
        error_code: 'ENGAGEMENT_STATE_INVALID',
        tenant_id: authContext.tenant_id,
        engagement_id: id,
        from_state: engagement.state,
        to_state: 'awaiting_response',
      });
      throw new AramoError(
        'ENGAGEMENT_STATE_INVALID',
        `Illegal engagement state transition: ${engagement.state} -> awaiting_response`,
        422,
        {
          requestId,
          details: {
            engagement_id: id,
            from_state: engagement.state,
            to_state: 'awaiting_response',
          },
        },
      );
    }

    // Step 7 — source-draft cross-event-ref validation BEFORE delivery.
    // Resolve the draft event; it must be an outreach_drafted event on
    // this engagement + tenant. Yields the draft payload's audit/token
    // fields for the outreach_sent payload (links sent → drafted → LLM).
    const draftRef = await this.engagementEventRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id: body.draft_event_id,
    });
    if (
      draftRef === null ||
      draftRef.engagement_id !== id ||
      draftRef.event_type !== 'outreach_drafted'
    ) {
      this.logger.log({
        event: 'engagement.outreach_send_refused',
        error_code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
        tenant_id: authContext.tenant_id,
        engagement_id: id,
        draft_event_id: body.draft_event_id,
        ref_resolved: draftRef !== null,
        ref_event_type: draftRef?.event_type ?? null,
      });
      throw new AramoError(
        'ENGAGEMENT_REFERENCE_NOT_FOUND',
        'draft_event_id not found, not in tenant, or not an outreach_drafted event',
        422,
        {
          requestId,
          details: {
            field: 'draft_event_id',
            draft_event_id: body.draft_event_id,
            engagement_id: id,
          },
        },
      );
    }
    const draftedPayload = draftRef.event_payload as OutreachDraftedPayload;

    // Step 8 — BINDING consent-at-send. Mirrors the relocated M5 PR-9b
    // gate. denied → 403 CONSENT_NOT_GRANTED_AT_SEND; resolver error →
    // 500 INTERNAL_ERROR (retry, not back-off).
    const consentDecision = await this.consentService.check(
      {
        // Post-#349 engagement.talent_id IS a TalentRecord.id; consent is now
        // TalentRecord-keyed (Step-5 re-key), so the gate meets the ledger.
        talent_record_id: engagement.talent_id,
        operation: 'engagement',
        channel: 'email',
      },
      undefined,
      authContext,
      requestId,
    );
    if (consentDecision.result === 'denied') {
      this.logger.log({
        event: 'engagement.outreach_send_refused',
        error_code: 'CONSENT_NOT_GRANTED_AT_SEND',
        tenant_id: authContext.tenant_id,
        engagement_id: id,
        reason_code: consentDecision.reason_code,
      });
      throw new AramoError(
        'CONSENT_NOT_GRANTED_AT_SEND',
        'consent denied at send time',
        403,
        {
          requestId,
          details: { consent_decision: consentDecision, engagement_id: id },
        },
      );
    }
    if (consentDecision.result === 'error') {
      throw new AramoError('INTERNAL_ERROR', 'consent check resolver failure', 500, {
        requestId,
        details: { consent_decision: consentDecision, engagement_id: id },
      });
    }

    // Step 9 — delivery (SendStub at PR-6; never fails). Delivers the
    // recruiter-approved final_text — NOT the raw draft (it may be edited).
    let deliveryResult: DeliveryResult;
    try {
      deliveryResult = await this.deliveryProvider.deliver({
        completion: body.final_text,
        delivery_channel: 'email',
        tenant_id: authContext.tenant_id,
        requestId,
        ...(body.recipient_handle !== undefined
          ? { recipient_handle: body.recipient_handle }
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

    // Step 10 — repository write (atomic 4-write transaction). The
    // outreach_sent payload carries the FINAL sent text + the source draft
    // back-reference + the AI-draft audit/token fields from the draft.
    const outreachPayload: OutreachSentPayload = {
      ai_draft_audit_record_id: draftedPayload.ai_draft_audit_record_id,
      model_used: draftedPayload.model_used,
      input_tokens: draftedPayload.input_tokens,
      output_tokens: draftedPayload.output_tokens,
      duration_ms: draftedPayload.duration_ms,
      delivered_at: deliveryResult.delivered_at.toISOString(),
      delivery_channel: 'email',
      delivery_id: deliveryResult.delivery_id,
      final_text: body.final_text,
      source_draft_event_id: body.draft_event_id,
    };

    let repoResult;
    try {
      repoResult = await this.engagementRepository.sendOutreach({
        engagement_id: id,
        tenant_id: authContext.tenant_id,
        source_draft_event_id: body.draft_event_id,
        outreach_event_id: randomUUID(),
        transition_event_id: randomUUID(),
        outreach_payload: outreachPayload,
        visible_requisition_ids: visibleReqIds,
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

    // Step 11 — response compose.
    const response: OutreachSendResponseDto = {
      engagement: repoResult.engagement,
      outreach_event: repoResult.outreach_event,
      delivery_id: deliveryResult.delivery_id,
    };

    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    this.logger.log({
      event: 'engagement.outreach_send_endpoint_succeeded',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      source_draft_event_id: body.draft_event_id,
      outreach_event_id: repoResult.outreach_event.id,
      delivery_id: deliveryResult.delivery_id,
      delivery_channel: 'email',
      model_used: draftedPayload.model_used,
    });

    return response;
  }

  // ---- POST /v1/engagements/{id}/response ------------------------------
  //
  // M5 PR-7 §4.1 — recruiter records a talent response to a prior
  // outreach. Compressed-scope mirror of PR-6 sendOutreach:
  //   - NO AI consumption (passive recruiter logging).
  //   - NO delivery side-effect (no outbound message).
  //   - NO new error codes (parity-quad stays at 24).
  //
  // 9-step idempotency flow:
  //   1. assertConsumerIsRecruiter (Ruling 8 + PR-6 precedent).
  //   2. assertIdempotencyKeyRequired.
  //   3. assertEngagementIdIsUuid.
  //   4. hashCanonicalizedBody.
  //   5. idempotencyService.lookup → replay short-circuit.
  //   6. engagementRepository.recordResponse — atomic 3-write +
  //      cross-event-ref validation (Ruling 4: outreach_event_ref_id
  //      must resolve to outreach_sent event in same tenant + same
  //      engagement).
  //   7. response compose ({engagement, response_event}; transition_event
  //      NOT projected — mirrors PR-6 OutreachSendResponseDto pattern).
  //   8. idempotencyService.persist.
  //   9. Return response.
  //
  // recorded_by_user_id is derived from authContext.sub at the
  // controller boundary (NOT in request body) per Ruling 3.

  @Post(':id/response')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:write')
  async recordResponse(
    @Param('id') id: string,
    @Body() body: RecordResponseRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<RecordResponseResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 4 — body hash.
    const requestHash = hashCanonicalizedBody(body as unknown);

    // Step 5 — idempotency lookup.
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as RecordResponseResponseDto;
    }

    this.logger.log({
      event: 'engagement.response_endpoint_started',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      outreach_event_ref_id: body.outreach_event_ref_id,
      request_id: requestId,
    });

    // Step 6 — repository call (atomic 3-write + cross-event-ref).
    // R7 BE-prereq §3 — visibility passed through to internal pre-read.
    const visibleReqIds = await resolveVisibleReqIds(req);
    let repoResult;
    try {
      repoResult = await this.engagementRepository.recordResponse({
        engagement_id: id,
        tenant_id: authContext.tenant_id,
        response_event_id: randomUUID(),
        transition_event_id: randomUUID(),
        response_payload: {
          response_received_at: body.response_received_at,
          recorded_by_user_id: authContext.sub,
          outreach_event_ref_id: body.outreach_event_ref_id,
        },
        visible_requisition_ids: visibleReqIds,
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

    // Step 7 — response compose (transition_event NOT projected).
    const response: RecordResponseResponseDto = {
      engagement: repoResult.engagement,
      response_event: repoResult.response_event,
    };

    // Step 8 — persist idempotency record.
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    this.logger.log({
      event: 'engagement.response_endpoint_succeeded',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      response_event_id: repoResult.response_event.id,
      outreach_event_ref_id: body.outreach_event_ref_id,
    });

    return response;
  }

  // ---- POST /v1/engagements/{id}/conversation --------------------------
  //
  // M5 PR-8a §4.1 — recruiter records that an in-bound conversation has
  // begun with a talent who previously responded. Compressed-scope
  // mirror of PR-7 recordResponse (which itself was compressed from
  // PR-6 sendOutreach):
  //   - NO AI consumption (passive recruiter logging).
  //   - NO delivery side-effect (no outbound message).
  //   - NO new error codes (parity-quad stays at 24).
  //   - NO cross-event reference validation (Ruling 3 — workflow
  //     invariant enforced by canTransition; the prior response_received
  //     event is implicit and not referenced in the payload).
  //
  // 9-step idempotency flow (5 controller + 4 repository internal steps):
  //   1. assertConsumerIsRecruiter (Ruling 7 + PR-4/PR-6/PR-7 precedent).
  //   2. assertIdempotencyKeyRequired.
  //   3. assertEngagementIdIsUuid.
  //   4. hashCanonicalizedBody.
  //   5. idempotencyService.lookup → replay short-circuit.
  //   6. engagementRepository.recordConversationStarted — atomic 3-write
  //      (engagement.update + conversation_started event +
  //      state_transition event); pass-through on AramoError catch with
  //      requestId re-binding.
  //   7. response compose ({engagement, conversation_event};
  //      transition_event NOT projected — mirrors PR-6/PR-7 response-
  //      shape convention).
  //   8. idempotencyService.persist.
  //   9. Return response.
  //
  // recorded_by_user_id is derived from authContext.sub at the
  // controller boundary (NOT in request body) per Ruling 2 + 3.

  @Post(':id/conversation')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:write')
  async recordConversationStarted(
    @Param('id') id: string,
    @Body() body: RecordConversationStartedRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<RecordConversationStartedResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 4 — body hash.
    const requestHash = hashCanonicalizedBody(body as unknown);

    // Step 5 — idempotency lookup.
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as RecordConversationStartedResponseDto;
    }

    this.logger.log({
      event: 'engagement.conversation_started_endpoint_started',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      request_id: requestId,
    });

    // Step 6 — repository call (atomic 3-write).
    // R7 BE-prereq §3 — visibility passed through to internal pre-read.
    const visibleReqIds = await resolveVisibleReqIds(req);
    let repoResult;
    try {
      repoResult = await this.engagementRepository.recordConversationStarted({
        engagement_id: id,
        tenant_id: authContext.tenant_id,
        conversation_event_id: randomUUID(),
        transition_event_id: randomUUID(),
        conversation_payload: {
          conversation_started_at: body.conversation_started_at,
          recorded_by_user_id: authContext.sub,
        },
        visible_requisition_ids: visibleReqIds,
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

    // Step 7 — response compose (transition_event NOT projected).
    const response: RecordConversationStartedResponseDto = {
      engagement: repoResult.engagement,
      conversation_event: repoResult.conversation_event,
    };

    // Step 8 — persist idempotency record.
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    this.logger.log({
      event: 'engagement.conversation_started_endpoint_succeeded',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      conversation_event_id: repoResult.conversation_event.id,
    });

    return response;
  }

  // ---- GET /v1/engagements/{id} ----------------------------------------

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:read')
  async getEngagement(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<TalentJobEngagementView> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 3 — repository read (tenant-scoped + D4b-composed).
    // R7 BE-prereq §3 — invisible-requisition engagement returns null →
    // the existing null→404 path fires (Amendment v1.1 Ruling 4 — 404
    // not 403, the non-leak posture).
    const visibleReqIds = await resolveVisibleReqIds(req);
    const engagement = await this.engagementRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });

    // Step 4 — null → 404.
    if (engagement === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        { requestId, details: { engagement_id: id } },
      );
    }

    // Step 5 — return.
    return engagement;
  }

  // ---- GET /v1/engagements/{id}/events ---------------------------------

  @Get(':id/events')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:read')
  async getEngagementEvents(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req?: Request,
  ): Promise<EngagementListEventsResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 3 — engagement existence check (tenant-scoped + D4b).
    // R7 BE-prereq §3 — visibility composed at the gate; without this
    // the events endpoint would leak parent-engagement existence via
    // empty-array vs 404 distinction.
    const visibleReqIds = await resolveVisibleReqIds(req);
    const engagement = await this.engagementRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (engagement === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        { requestId, details: { engagement_id: id } },
      );
    }

    // Step 4 — repository read (tenant-scoped events lookup).
    const events = await this.engagementEventRepository.findByTenantAndEngagementId({
      tenant_id: authContext.tenant_id,
      engagement_id: id,
    });

    // Step 5 — return.
    return { events };
  }

  // ---- Private helpers --------------------------------------------------

  private assertConsumerIsRecruiter(
    authContext: AuthContextType,
    requestId: string,
  ): void {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'engagement endpoints are recruiter-only',
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

  private assertEngagementIdIsUuid(id: string, requestId: string): void {
    if (!UUID_REGEX.test(id)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'engagement id path parameter must be a UUID',
        400,
        { requestId, details: { invalid_field: 'engagement_id' } },
      );
    }
  }

  // R7 BE-prereq Amendment v1.1 §3 Ruling 3 — create-time visibility
  // assertion. The create endpoint has no pre-existing engagement to
  // gate via findByTenantAndId; visibility is on the requisition the
  // engagement WOULD attach to. The not-visible response is 404
  // NOT_FOUND (Ruling 4 — uniform non-leak posture; mirrors the
  // requisition repo's invisible-but-existing behavior).
  //
  // visibleReqIds === null ⇒ see-all (requisition:read:all-tier or
  // back-compat callers — no check applied).
  private assertRequisitionVisible(
    requisitionId: string,
    visibleReqIds: ReadonlySet<string> | null,
    requestId: string,
  ): void {
    if (visibleReqIds === null) return;
    if (!visibleReqIds.has(requisitionId)) {
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant (or not visible to actor)',
        404,
        {
          requestId,
          details: { requisition_id: requisitionId },
        },
      );
    }
  }
}
