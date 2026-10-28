import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  PrivacyRequestService,
  PrivacySubjectService,
  isPrivacyRequestStatus,
  isPrivacyRequestType,
  privacyDeletionExecutionEnabled,
  privacyEmailKeyAvailable,
  type PrivacyActor,
  type PrivacyRequestRecord,
} from '@aramo/identity';
import { SignPrivacyRepository } from '@aramo/sign';

import { AssignPrivacyRequestDto, PrivacyNoteDto, RecordPrivacyRequestDto, ReferPrivacyRequestDto } from './dto/privacy-request.request.dto.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — the Aramo privacy team's queue (operator
// channel + the lifecycle actions). Lifecycle power (platform:tenant:lifecycle:manage),
// platform consumer only (the DDR §13.1 tripwire), every action recorded with the
// operator as actor in the append-only history.
//
//   GET  /platform/privacy-requests                     open queue by due date (?status, ?request_type, ?include_closed)
//   GET  /platform/privacy-requests/:id                 detail + events + contact email
//   POST /platform/privacy-requests                     operator-recorded request (agent proof checked)
//   POST /platform/privacy-requests/:id/assign          responsible operator
//   POST /platform/privacy-requests/:id/validate        RECEIVED → IDENTITY_VALIDATED (operator-recorded)
//   POST /platform/privacy-requests/:id/inventory       IDENTITY_VALIDATED → DATA_INVENTORY (counts only)
//   POST /platform/privacy-requests/:id/refer           → REFERRED_TO_ORGANIZATION
//   POST /platform/privacy-requests/:id/execute         → EXECUTING (Sign DELETION; staged flag must be on;
//                                                        never under legal hold); sign-service executes
//   POST /platform/privacy-requests/:id/complete        → COMPLETED (operator-handled outcome)
//   POST /platform/privacy-requests/:id/deny            → DENIED_WITH_REASON
//   POST /platform/privacy-requests/:id/cancel          → CANCELLED

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

const operator = (auth: AuthContextType): PrivacyActor => ({ actor_type: 'OPERATOR', actor_id: auth.sub });

@Controller('platform/privacy-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformPrivacyRequestsController {
  constructor(
    private readonly requests: PrivacyRequestService,
    private readonly subjects: PrivacySubjectService,
    private readonly sign: SignPrivacyRepository,
  ) {}

  @Get()
  @RequireScopes('platform:tenant:lifecycle:manage')
  async list(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Query('status') status?: string,
    @Query('request_type') request_type?: string,
    @Query('include_closed') include_closed?: string,
  ) {
    assertPlatform(auth, requestId);
    if (status !== undefined && !isPrivacyRequestStatus(status)) throw bad(requestId, 'Unknown status', 'invalid_status');
    if (request_type !== undefined && !isPrivacyRequestType(request_type)) throw bad(requestId, 'Unknown request type', 'invalid_request_type');
    const rows = await this.requests.listQueue({ ...(status !== undefined ? { status } : {}), ...(request_type !== undefined ? { request_type } : {}), include_closed: include_closed === 'true' });
    return { items: rows.map((r) => this.summary(r)), execution_enabled: privacyDeletionExecutionEnabled() };
  }

  @Get(':id')
  @RequireScopes('platform:tenant:lifecycle:manage')
  async detail(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    return { ...this.summary(r), contact_email: this.requests.contactEmail(r), events: await this.requests.events(id), execution_enabled: privacyDeletionExecutionEnabled() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async record(@Body() body: RecordPrivacyRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    if (!privacyEmailKeyAvailable()) throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'PRIVACY_REQUEST_EMAIL_KEY is not configured', 503, { requestId, details: { reason: 'privacy_requests_unavailable' } });
    const r = await this.requests.create({
      product: 'SIGN',
      request_type: body.request_type,
      subject_kind: body.subject_kind,
      channel: 'OPERATOR',
      contact_email: body.email,
      actor: operator(auth),
      payload: { verification_note: body.verification_note },
    });
    return this.summary(await this.requests.assign(r.id, auth.sub, operator(auth), requestId));
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async assign(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: AssignPrivacyRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    return this.summary(await this.requests.assign(id, body.operator_id ?? auth.sub, operator(auth), requestId));
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async validate(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: PrivacyNoteDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    return this.summary(await this.requests.transition(id, 'IDENTITY_VALIDATED', operator(auth), { requestId, payload: { method: 'operator_verified', note: body.note } }));
  }

  @Post(':id/inventory')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async inventory(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    const email = this.requests.contactEmail(r);
    const account = email === null ? null : await this.subjects.findAccountByEmail(email);
    const ctx = account === null ? null : await this.subjects.context(account.user_id, account.tenant_id);
    const counts = await this.sign.inventory({ subject: ctx === null ? null : { tenant_id: ctx.tenant_id, user_id: ctx.user_id }, email });
    return this.summary(
      await this.requests.transition(id, 'DATA_INVENTORY', operator(auth), {
        requestId,
        from: ['IDENTITY_VALIDATED'],
        patch: { subject_user_id: ctx?.user_id ?? null, subject_tenant_id: ctx?.tenant_id ?? null, inventory: { ...counts, account_found: ctx !== null, legal_hold: ctx?.legal_hold ?? false } },
      }),
    );
  }

  @Post(':id/refer')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async refer(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: ReferPrivacyRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    const org = body.organization_tenant_id ?? r.subject_tenant_id;
    if (org === null) throw bad(requestId, 'Name the organization to refer to', 'organization_required');
    return this.summary(await this.requests.transition(id, 'REFERRED_TO_ORGANIZATION', operator(auth), { requestId, patch: { referred_tenant_id: org }, payload: { note: body.note, aramo_fallback: true } }));
  }

  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async execute(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: PrivacyNoteDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    if (r.request_type !== 'DELETION') throw conflict(requestId, 'Only a deletion is executed automatically; record the outcome with complete', 'privacy_not_executable');
    if (!privacyDeletionExecutionEnabled()) throw conflict(requestId, 'Deletion execution is not enabled (SIGN_PRIVACY_DELETION_EXECUTION_ENABLED)', 'privacy_execution_disabled');
    if (r.subject_user_id === null || r.subject_tenant_id === null) throw conflict(requestId, 'No Aramo Sign account was found for this request', 'privacy_no_account_subject');
    const ctx = await this.subjects.context(r.subject_user_id, r.subject_tenant_id);
    if (ctx === null) throw conflict(requestId, 'The subject no longer belongs to the inventoried organization', 'privacy_subject_mismatch');
    if (ctx.legal_hold) throw conflict(requestId, 'The organization is under legal hold; nothing can be deleted', 'privacy_legal_hold');
    return this.summary(await this.requests.transition(id, 'EXECUTING', operator(auth), { requestId, from: ['DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION'], payload: { note: body.note, authorized_by: 'operator' } }));
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async complete(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: PrivacyNoteDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    // An automated Sign deletion completes itself (counts-only evidence); the operator
    // completes only what it handled (access, export, correction, a referral outcome).
    if (r.request_type === 'DELETION' && r.status === 'EXECUTING') throw conflict(requestId, 'The deletion is being executed; it completes itself', 'privacy_execution_in_progress');
    return this.summary(await this.requests.transition(id, 'COMPLETED', operator(auth), { requestId, patch: { outcome_code: 'operator_completed', outcome_text: body.note }, payload: { note: body.note } }));
  }

  @Post(':id/deny')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async deny(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: PrivacyNoteDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    return this.summary(await this.requests.transition(id, 'DENIED_WITH_REASON', operator(auth), { requestId, patch: { outcome_code: 'denied', outcome_text: body.note }, payload: { reason: body.note } }));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: PrivacyNoteDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    return this.summary(await this.requests.transition(id, 'CANCELLED', operator(auth), { requestId, patch: { outcome_code: 'cancelled', outcome_text: body.note }, payload: { reason: body.note } }));
  }

  private async must(id: string, requestId: string): Promise<PrivacyRequestRecord> {
    const r = await this.requests.findById(id);
    if (r === null) throw new AramoError('NOT_FOUND', 'Privacy request not found', 404, { requestId, details: { reason: 'privacy_request_not_found' } });
    return r;
  }

  private summary(r: PrivacyRequestRecord) {
    return {
      id: r.id,
      ...this.requests.view(r),
      product: r.product,
      subject_user_id: r.subject_user_id,
      subject_tenant_id: r.subject_tenant_id,
      referred_tenant_id: r.referred_tenant_id,
      assigned_operator_id: r.assigned_operator_id,
      overdue: r.completed_at === null && r.due_at.getTime() < Date.now(),
      inventory: r.inventory,
      completion_evidence: r.completion_evidence,
    };
  }
}

function bad(requestId: string, message: string, reason: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason } });
}

function conflict(requestId: string, message: string, reason: string): AramoError {
  return new AramoError('IDEMPOTENCY_KEY_CONFLICT', message, 409, { requestId, details: { reason } });
}
