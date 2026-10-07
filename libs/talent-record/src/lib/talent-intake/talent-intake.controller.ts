import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  type MessageEvent,
  Param,
  Patch,
  Post,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { TalentRecordView } from '../dto/talent-record.view.js';
import {
  type CompleteTalentIntakeUploadRequestDto,
  type CreateTalentIntakeDraftRequestDto,
  type CreateTalentIntakeDraftResponse,
  type PatchTalentIntakeReviewRequestDto,
  type TalentIntakeAcceptedView,
  type TalentIntakeDraftListView,
  type TalentIntakeDraftView,
} from '../dto/talent-intake.dto.js';

import { TalentIntakePromotionService } from './talent-intake-promotion.service.js';
import { TalentIntakeService } from './talent-intake.service.js';

// Durable Async Résumé-First Talent Intake — the recruiter-facing intake surface.
// Tenant + actor are ALWAYS derived from the auth context (never the client body
// or a client-supplied tenant id). Gated: capability ats + the existing talent
// scopes (no new scope). The browser is never part of the durability boundary —
// every state is persisted and recoverable via GET.
@Controller('v1/talent-intake-drafts')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentIntakeController {
  constructor(
    private readonly intake: TalentIntakeService,
    private readonly promotion: TalentIntakePromotionService,
  ) {}

  // Create intake + return the presigned upload target. No LLM work.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('talent:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateTalentIntakeDraftRequestDto,
    @RequestId() requestId: string,
  ): Promise<CreateTalentIntakeDraftResponse> {
    return this.intake.createIntake(authContext, body, requestId);
  }

  // Complete upload → atomically QUEUE + outbox → 202. The governed extraction
  // runs asynchronously in the worker; the request never waits for the LLM.
  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('talent:create')
  @RequireSiteMatch()
  async completeUpload(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: CompleteTalentIntakeUploadRequestDto,
    @RequestId() requestId: string,
  ): Promise<TalentIntakeAcceptedView> {
    return this.intake.completeUpload(authContext, id, body, requestId);
  }

  // Recovery list — the recruiter's resumable drafts.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
  ): Promise<TalentIntakeDraftListView> {
    return this.intake.list(authContext);
  }

  // Authoritative read model for one draft.
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentIntakeDraftView> {
    return this.intake.get(authContext, id, requestId);
  }

  // Persist recruiter review edits (CAS on version).
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async patchReview(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: PatchTalentIntakeReviewRequestDto,
    @RequestId() requestId: string,
  ): Promise<TalentIntakeDraftView> {
    return this.intake.patchReview(authContext, id, body, requestId);
  }

  // Retry extraction on the same stored artifact (no re-upload).
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async retry(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentIntakeDraftView> {
    return this.intake.retry(authContext, id, requestId);
  }

  // Promote → create exactly one canonical TalentRecord (idempotent).
  @Post(':id/promote')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('talent:create')
  @RequireSiteMatch()
  async promote(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentRecordView> {
    return this.promotion.promote(authContext, id, requestId);
  }

  // SSE NOTIFICATION — notification-only; GET remains authoritative. Emits only
  // small {status, review_status, version} identifiers (no structured payload /
  // PII). Tenant-scoped: a cross-tenant id yields a 'not_found' event. The front
  // door gives THIS route (and only this route) SSE-friendly buffering/timeout —
  // never a /v1/ timeout change.
  @Sse(':id/events')
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  events(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
  ): Observable<MessageEvent> {
    return this.intake.streamIntakeEvents(authContext, id);
  }
}
