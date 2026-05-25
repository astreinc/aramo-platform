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
  UseGuards,
} from '@nestjs/common';
import {
  AramoError,
  type AramoLogger,
  RequestId,
  hashCanonicalizedBody,
} from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { IdempotencyService } from '@aramo/consent';
import { AiDraftService } from '@aramo/ai-draft';

import type { CreateEngagementRequestDto } from './dto/create-engagement-request.dto.js';
import type { CreateEngagementResponseDto } from './dto/create-engagement-response.dto.js';
import type { TransitionEngagementRequestDto } from './dto/transition-engagement-request.dto.js';
import type { TransitionEngagementResponseDto } from './dto/transition-engagement-response.dto.js';
import type { EngagementListEventsResponseDto } from './dto/engagement-list-events-response.dto.js';
import { OutreachSendRequestDto } from './dto/outreach-send-request.dto.js';
import type { OutreachSendResponseDto } from './dto/outreach-send-response.dto.js';
import type { OutreachSentPayload } from './dto/outreach-sent-payload.js';
import type { TalentJobEngagementView } from './dto/talent-job-engagement.view.js';
import type {
  DeliveryProvider,
  DeliveryResult,
} from './delivery/delivery-provider.interface.js';
import { DELIVERY_PROVIDER_TOKEN } from './delivery/tokens.js';
import { EngagementEventRepository } from './engagement-event.repository.js';
import { EngagementRepository } from './engagement.repository.js';

// M5 PR-4 §4.1 — EngagementController.
//
// First HTTP-bearing surface in libs/engagement. Four endpoints:
//   - POST /v1/engagements                              (create)
//   - POST /v1/engagements/{id}/transitions             (state transition)
//   - GET  /v1/engagements/{id}                         (read engagement)
//   - GET  /v1/engagements/{id}/events                  (read event log)
//
// Auth posture (Ruling 8): class-level JwtAuthGuard + per-route
// consumer_type === 'recruiter' assertion. Non-recruiter consumers
// (portal, ingestion) 403'd at the route with INSUFFICIENT_PERMISSIONS.
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

@Controller('v1/engagements')
@UseGuards(JwtAuthGuard)
export class EngagementController {
  constructor(
    private readonly engagementRepository: EngagementRepository,
    private readonly engagementEventRepository: EngagementEventRepository,
    private readonly idempotencyService: IdempotencyService,
    @Inject('EngagementControllerLogger')
    private readonly logger: AramoLogger,
    // M5 PR-6 §4.1 — AiDraftService dep for outreach LLM drafts.
    private readonly aiDraftService: AiDraftService,
    // M5 PR-6 §4.3 — DeliveryProvider port (SendStub at PR-6).
    @Inject(DELIVERY_PROVIDER_TOKEN)
    private readonly deliveryProvider: DeliveryProvider,
  ) {}

  // ---- POST /v1/engagements --------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createEngagement(
    @Body() body: CreateEngagementRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CreateEngagementResponseDto> {
    // Step 1 — auth posture (recruiter-only).
    this.assertConsumerIsRecruiter(authContext, requestId);

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
  async transitionEngagement(
    @Param('id') id: string,
    @Body() body: TransitionEngagementRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
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
    let engagement: TalentJobEngagementView;
    try {
      const result = await this.engagementRepository.transitionState({
        engagement_id: id,
        event_id: body.event_id,
        tenant_id: authContext.tenant_id,
        to_state: body.to_state,
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

  // ---- POST /v1/engagements/{id}/outreach ------------------------------
  //
  // M5 PR-6 §4.1 — 9-step idempotency flow extended with AI draft +
  // delivery side-effects BEFORE the repository write:
  //   1. assertConsumerIsRecruiter (recruiter-only per Ruling 8).
  //   2. assertIdempotencyKeyRequired.
  //   3. assertEngagementIdIsUuid.
  //   4. hashCanonicalizedBody.
  //   5. idempotencyService.lookup (replay-or-conflict-or-proceed).
  //   6. aiDraftService.generateDraft + error-code remap.
  //   7. deliveryProvider.deliver (SendStub pass-through).
  //   8. engagementRepository.sendOutreach (atomic 3-write).
  //   9. response compose + idempotencyService.persist + return.
  //
  // Ordering rationale (per directive §4.1 + Rulings 1 + 11):
  // AI + delivery happen BEFORE the DB write. If either fails, the
  // engagement state column + event log are unchanged (no partial-
  // state observability). The repository.sendOutreach atomic
  // transaction guarantees that all 3 writes (engagement update +
  // outreach_sent event + state_transition event) commit together OR
  // none commit.
  //
  // Error-code remapping (Ruling 6):
  //   AiDraftService.generateDraft INTERNAL_ERROR throws are remapped:
  //     - kind ∈ {provider_unavailable, provider_internal_error}
  //         → AI_PROVIDER_UNAVAILABLE 502
  //     - kind === 'provider_rate_limited' → AI_RATE_LIMITED 429
  //     - any other kind → pass-through (e.g. provider_auth_failed
  //       remains INTERNAL_ERROR 500; secret-cache errors pass through).
  //   DeliveryProvider AramoError throws pass through. The SendStub
  //   adapter at PR-6 never fails; real adapters at future PRs may
  //   surface delivery-layer codes.
  //
  // Structured logging discipline (Ruling 10): entry / success / refusal
  // paths log audit_record_id + delivery_id + model_used + token counts
  // + duration_ms + delivery_channel + engagement_id + tenant_id. NEVER
  // raw prompt, raw completion, recipient_handle.

  @Post(':id/outreach')
  @HttpCode(HttpStatus.OK)
  async sendOutreach(
    @Param('id') id: string,
    @Body() body: OutreachSendRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<OutreachSendResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — Idempotency-Key required.
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Step 3 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 4 — body hash.
    const requestHash = hashCanonicalizedBody(body as unknown);

    // Step 5 — idempotency lookup (replay short-circuit).
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
      event: 'engagement.outreach_endpoint_started',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      request_id: requestId,
    });

    // Step 6 — AI draft (with error-code remap).
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
            event: 'engagement.outreach_refused',
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
        if (
          err.code === 'INTERNAL_ERROR' &&
          kind === 'provider_rate_limited'
        ) {
          this.logger.log({
            event: 'engagement.outreach_refused',
            error_code: 'AI_RATE_LIMITED',
            tenant_id: authContext.tenant_id,
            engagement_id: id,
            kind,
          });
          throw new AramoError(
            'AI_RATE_LIMITED',
            'AI provider rate-limited',
            429,
            {
              requestId,
              details: { kind },
            },
          );
        }
        // Pass-through with requestId re-binding.
        throw new AramoError(err.code, err.message, err.statusCode, {
          ...err.context,
          requestId,
        });
      }
      throw err;
    }

    // Step 7 — delivery (SendStub at PR-6; never fails).
    let deliveryResult: DeliveryResult;
    try {
      deliveryResult = await this.deliveryProvider.deliver({
        completion: draftResult.completion,
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

    // Step 8 — repository write (atomic 3-write transaction).
    const outreachPayload: OutreachSentPayload = {
      ai_draft_audit_record_id: draftResult.audit_record_id,
      model_used: draftResult.model_used,
      input_tokens: draftResult.input_tokens,
      output_tokens: draftResult.output_tokens,
      duration_ms: draftResult.duration_ms,
      delivered_at: deliveryResult.delivered_at.toISOString(),
      delivery_channel: 'email',
      delivery_id: deliveryResult.delivery_id,
    };

    let repoResult;
    try {
      repoResult = await this.engagementRepository.sendOutreach({
        engagement_id: id,
        tenant_id: authContext.tenant_id,
        outreach_event_id: randomUUID(),
        transition_event_id: randomUUID(),
        outreach_payload: outreachPayload,
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

    // Step 9 — response compose.
    const response: OutreachSendResponseDto = {
      engagement: repoResult.engagement,
      outreach_event: repoResult.outreach_event,
      delivery_id: deliveryResult.delivery_id,
    };

    // Step 10 — persist idempotency record (post-mutation success only).
    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });

    this.logger.log({
      event: 'engagement.outreach_endpoint_succeeded',
      tenant_id: authContext.tenant_id,
      engagement_id: id,
      audit_record_id: draftResult.audit_record_id,
      delivery_id: deliveryResult.delivery_id,
      delivery_channel: 'email',
      model_used: draftResult.model_used,
      input_tokens: draftResult.input_tokens,
      output_tokens: draftResult.output_tokens,
      duration_ms: draftResult.duration_ms,
    });

    return response;
  }

  // ---- GET /v1/engagements/{id} ----------------------------------------

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getEngagement(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TalentJobEngagementView> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 3 — repository read (tenant-scoped).
    const engagement = await this.engagementRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id,
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
  async getEngagementEvents(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<EngagementListEventsResponseDto> {
    // Step 1 — auth.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — id UUID validation.
    this.assertEngagementIdIsUuid(id, requestId);

    // Step 3 — engagement existence check (tenant-scoped). The events
    // endpoint is a chained read: confirm the parent engagement is
    // visible in the tenant BEFORE returning events. Without this
    // pre-check, a non-existent engagement_id would return an empty
    // events array (information-leak path: same response shape as a
    // newly-created engagement with no events yet).
    const engagement = await this.engagementRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id,
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
}
