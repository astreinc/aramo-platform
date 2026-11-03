import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { ActivityView } from './dto/activity.view.js';
// Value import (NOT `import type`) — the global ValidationPipe needs the class
// as the runtime route metatype to validate/whitelist the body (RN-1 D-6).
import { CreateActivityRequestDto } from './dto/create-activity-request.dto.js';
import type { RedactActivityRequestDto } from './dto/redact-activity-request.dto.js';
import { isRedactionReasonCode } from './dto/redaction-reason.js';
import { ActivityRepository } from './activity.repository.js';
import {
  ACTIVITY_CONTACT_SUBJECT,
  CONTACT_SUBJECT_TYPE,
  type ActivityContactSubjectPort,
} from './contact-subject.port.js';

// ActivityController — PR-A5a Gate 5 ATS Batch 4a (sidecar to pipeline).
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// === Scope gating (HK-IDENT-SCOPES — proper scopes seeded) ===
// The seeded catalog includes `activity:read` (back_office+) and now
// `activity:create` (recruiter+). The POST route keys on the proper
// `activity:create` scope (superseding an earlier pipeline-scope borrow).
@Controller('v1/activities')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ActivityController {
  private readonly logger = new Logger(ActivityController.name);

  constructor(
    private readonly activityRepository: ActivityRepository,
    // CONTACTS-1 §8 — contact-subject checks + recency, bound by apps/api.
    // Optional so the lib stays standalone; when it is absent every
    // subject_type='contact' write is refused and contact rows stay hidden.
    @Optional()
    @Inject(ACTIVITY_CONTACT_SUBJECT)
    private readonly contactSubject?: ActivityContactSubjectPort,
  ) {}

  // H-3 — the contact ids this actor may read, for the repository's contact
  // visibility branch. Only the one requested contact is ever resolved.
  private async visibleContactIds(args: {
    tenant_id: string;
    subject_type: string | null | undefined;
    subject_id: string | null | undefined;
    req: Request;
  }): Promise<ReadonlySet<string> | undefined> {
    if (
      args.subject_type !== CONTACT_SUBJECT_TYPE ||
      args.subject_id === undefined ||
      args.subject_id === null ||
      this.contactSubject === undefined
    ) {
      return undefined;
    }
    const visible = await this.contactSubject.isVisible({
      tenant_id: args.tenant_id,
      contact_id: args.subject_id,
      visibility: await args.req.resolveVisibility!(),
    });
    return visible ? new Set([args.subject_id]) : undefined;
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('activity:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('subject_type') subjectType: string | undefined,
    @Query('subject_id') subjectId: string | undefined,
    @Req() req: Request,
  ): Promise<{ items: ActivityView[] }> {
    const visibility = await req.resolveVisibility!();
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const visiblePipelineIds = await req.resolveVisiblePipelineIds!();
    const visibleContactIds = await this.visibleContactIds({
      tenant_id: authContext.tenant_id,
      subject_type: subjectType,
      subject_id: subjectId,
      req,
    });
    const items = await this.activityRepository.listForActor({
      tenant_id: authContext.tenant_id,
      actor_user_id: authContext.sub,
      visibility,
      visible_requisition_ids: visibleReqIds,
      visible_pipeline_ids: visiblePipelineIds,
      ...(visibleContactIds === undefined
        ? {}
        : { visible_contact_ids: visibleContactIds }),
      ...(subjectType === undefined ? {} : { subject_type: subjectType }),
      ...(subjectId === undefined ? {} : { subject_id: subjectId }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('activity:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ActivityView> {
    const visibility = await req.resolveVisibility!();
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const visiblePipelineIds = await req.resolveVisiblePipelineIds!();
    // A contact-subject row needs its contact resolved first (H-3); the
    // tenant-only peek decides nothing on its own — the scoped read below does.
    const peek = await this.activityRepository.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    const visibleContactIds = await this.visibleContactIds({
      tenant_id: authContext.tenant_id,
      subject_type: peek?.subject_type,
      subject_id: peek?.subject_id,
      req,
    });
    const view = await this.activityRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      actor_user_id: authContext.sub,
      visibility,
      visible_requisition_ids: visibleReqIds,
      visible_pipeline_ids: visiblePipelineIds,
      ...(visibleContactIds === undefined
        ? {}
        : { visible_contact_ids: visibleContactIds }),
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Activity not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('activity:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateActivityRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ActivityView> {
    if (body.subject_type !== CONTACT_SUBJECT_TYPE) {
      return this.activityRepository.create({
        tenant_id: authContext.tenant_id,
        created_by_id: authContext.sub,
        input: body,
        requestId,
      });
    }
    return this.createForContact(authContext, body, requestId, req);
  }

  // CONTACTS-1 §8 — record a note / call / email against a contact. The
  // contact must be visible (404 otherwise) and not deleted (CONTACT_DELETED,
  // H-4); a recorded row then moves the contact's last_activity_at forward
  // (H-2, later timestamp wins).
  private async createForContact(
    authContext: AuthContextType,
    body: CreateActivityRequestDto,
    requestId: string,
    req: Request,
  ): Promise<ActivityView> {
    const contactId = body.subject_id;
    if (contactId === undefined) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'subject_id is required when subject_type is contact',
        422,
        { requestId, details: { field: 'subject_id', reason: 'required' } },
      );
    }
    if (this.contactSubject === undefined) {
      // Fail closed: without the contact seam the contact cannot be checked.
      throw new AramoError(
        'VALIDATION_ERROR',
        'Recording activity against a contact is not available',
        422,
        {
          requestId,
          details: { field: 'subject_type', reason: 'subject_type_unsupported' },
        },
      );
    }
    await this.contactSubject.assertRecordable({
      tenant_id: authContext.tenant_id,
      contact_id: contactId,
      visibility: await req.resolveVisibility!(),
      requestId,
    });
    const view = await this.activityRepository.create({
      tenant_id: authContext.tenant_id,
      created_by_id: authContext.sub,
      input: body,
      requestId,
    });
    // The activity row is committed; a recency failure must not turn a
    // recorded interaction into an error response (a retry would record it
    // twice). Logged so a stale last_activity_at is traceable.
    try {
      await this.contactSubject.touchLastActivity({
        tenant_id: authContext.tenant_id,
        contact_id: contactId,
        at: new Date(view.created_at),
      });
    } catch (err) {
      this.logger.warn(
        `contact last_activity_at update failed for activity ${view.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return view;
  }

  // RN-1 (D-3) — pin / unpin a note to the requisition overview. Pin permission
  // follows note-write permission (D-9 — `activity:create`). Pin metadata
  // carries provenance and a PINNED/UNPINNED lifecycle event is appended
  // transactionally; a no-op transition appends nothing (RN-1-A1 rule 12).
  // PRIVATE notes are only visible to their author, so a non-author cannot pin
  // a note they cannot see (the repository privacy where-clause returns 404).
  @Post(':id/pin')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('activity:create')
  @RequireSiteMatch()
  async pin(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<ActivityView> {
    return this.activityRepository.setPinned({
      tenant_id: authContext.tenant_id,
      id,
      actor_user_id: authContext.sub,
      pinned: true,
      requestId,
    });
  }

  @Post(':id/unpin')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('activity:create')
  @RequireSiteMatch()
  async unpin(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<ActivityView> {
    return this.activityRepository.setPinned({
      tenant_id: authContext.tenant_id,
      id,
      actor_user_id: authContext.sub,
      pinned: false,
      requestId,
    });
  }

  // Charter §4 Amendment — redact a logged note (redact-never-delete).
  //
  // R1 authorization is author-OR-scope, which @RequireScopes cannot express
  // (it is scope-alone): the note's author may always redact their own, and an
  // `activity:redact` holder (a lead reviewing their pod's feed) may redact
  // another's. Neither → 403. R3 (type='note') and R5 (no re-redact) are
  // enforced in the repository, server-side. R2 (both reason fields mandatory,
  // code in the closed vocabulary) is validated here.
  @Post(':id/redact')
  @HttpCode(HttpStatus.OK)
  async redact(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: RedactActivityRequestDto,
    @RequestId() requestId: string,
  ): Promise<ActivityView> {
    const existing = await this.activityRepository.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (existing === null) {
      throw new AramoError('NOT_FOUND', 'Activity not found in tenant', 404, {
        requestId,
        details: { id },
      });
    }
    // R1 — author OR activity:redact scope. Never scope-alone.
    const isAuthor =
      existing.created_by_id !== null &&
      existing.created_by_id === authContext.sub;
    const hasRedactScope = authContext.scopes.includes('activity:redact');
    if (!isAuthor && !hasRedactScope) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'Redaction requires being the note author or holding activity:redact',
        403,
        { requestId, details: { id } },
      );
    }
    // R2 — both the code and the free text are mandatory; the code must be a
    // member of the §3 closed vocabulary.
    if (!isRedactionReasonCode(body?.redaction_reason_code)) {
      throw new AramoError(
        'INVALID_REQUEST',
        'redaction_reason_code must be a valid redaction reason',
        400,
        { requestId, details: { id } },
      );
    }
    if (
      typeof body.redaction_reason !== 'string' ||
      body.redaction_reason.trim() === ''
    ) {
      throw new AramoError(
        'INVALID_REQUEST',
        'redaction_reason free text is required',
        400,
        { requestId, details: { id } },
      );
    }
    return this.activityRepository.redact({
      tenant_id: authContext.tenant_id,
      id,
      redacted_by: authContext.sub,
      redaction_reason_code: body.redaction_reason_code,
      redaction_reason: body.redaction_reason.trim(),
      requestId,
    });
  }
}
