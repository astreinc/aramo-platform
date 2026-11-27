import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  IDENTITY_DEPENDENCY_CODES,
  IdentityDependencyInspector,
  PRIVACY_CHANNELS,
  PrivacyRequestService,
  PrivacySubjectService,
  isPrivacyRequestStatus,
  isPrivacyRequestType,
  isPrivacySubjectKind,
  isRetiredEmailTombstone,
  normalizePrivacyReference,
  privacyDeletionExecutionEnabled,
  privacyEmailKeyAvailable,
  type PrivacyActor,
  type IdentityDependencyReport,
  type PrivacyChannel,
  type PrivacyRequestRecord,
} from '@aramo/identity';
import { SignPrivacyRepository } from '@aramo/sign';

import { AssignPrivacyRequestDto, PrivacyNoteDto, RecordPrivacyRequestDto, ReferPrivacyRequestDto } from './dto/privacy-request.request.dto.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — the Aramo privacy team's queue (operator
// channel + the lifecycle actions). Lifecycle power (platform:tenant:lifecycle:manage),
// platform consumer only (the DDR §13.1 tripwire), every action recorded with the
// operator as actor in the append-only history.
//
//   GET  /platform/privacy-requests                     open queue by due date (?status, ?request_type, ?include_closed,
//                                                        ?limit, ?channel, ?subject_kind, ?assigned=me, ?overdue=true,
//                                                        ?reference); each item carries `failing`
//   GET  /platform/privacy-requests/:id                 detail + events + contact_present + attempts (never the email)
//   GET  /platform/privacy-requests/:id/preview         read-only impact preview of a DELETION (no write)
//   POST /platform/privacy-requests/:id/reveal-contact  the contact email; writes CONTACT_REVEALED
//   POST /platform/privacy-requests/:id/note            operator note (NOTE; never shown to the requester)
//   POST /platform/privacy-requests/:id/return-to-queue EXECUTING → DATA_INVENTORY (RETURNED_TO_QUEUE)
//   POST /platform/privacy-requests                     operator-recorded request (agent proof checked)
//   POST /platform/privacy-requests/:id/assign          responsible operator
//   POST /platform/privacy-requests/:id/validate        RECEIVED → IDENTITY_VALIDATED (operator-recorded)
//   POST /platform/privacy-requests/:id/inventory       IDENTITY_VALIDATED → DATA_INVENTORY (counts only)
//   POST /platform/privacy-requests/:id/refer           → REFERRED_TO_ORGANIZATION
//   POST /platform/privacy-requests/:id/execute         → EXECUTING (Sign DELETION; staged flag must be on;
//                                                        never under legal hold); sign-service executes
//   POST /platform/privacy-requests/:id/complete        → COMPLETED (operator-handled outcome; never a DELETION)
//   POST /platform/privacy-requests/:id/deny            → DENIED_WITH_REASON
//   POST /platform/privacy-requests/:id/cancel          → CANCELLED

// PRIV-ADMIN-1 (LOCKED): OD-1 a DELETION completes only by execution; OD-2 ACCESS /
// EXPORT / CORRECTION complete from DATA_INVENTORY or REFERRED_TO_ORGANIZATION; OD-4
// failing attempts + return to queue; OD-8 the contact email only through an audited
// reveal; §1.1 refer only to the subject's own organization.

export const PRIVACY_QUEUE_DEFAULT_LIMIT = 200;
export const PRIVACY_QUEUE_MAX_LIMIT = 500;

export type PrivacyPreviewPath = 'personal_full' | 'personal_retain' | 'member' | 'not_executable';

export interface PrivacyImpactPreview {
  path: PrivacyPreviewPath;
  reasons: string[];
  /** Inspector codes present; `unknown` when a source could not be read. */
  dependencies: string[];
  /** The codes (or `inspector`) whose source could not be read. */
  unknown_sources: string[];
  execution_enabled: boolean;
}

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
    private readonly inspector: IdentityDependencyInspector,
  ) {}

  @Get()
  @RequireScopes('platform:tenant:lifecycle:manage')
  async list(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Query('status') status?: string,
    @Query('request_type') request_type?: string,
    @Query('include_closed') include_closed?: string,
    @Query('limit') limit?: string,
    @Query('channel') channel?: string,
    @Query('subject_kind') subject_kind?: string,
    @Query('assigned') assigned?: string,
    @Query('overdue') overdue?: string,
    @Query('reference') reference?: string,
  ) {
    assertPlatform(auth, requestId);
    if (status !== undefined && !isPrivacyRequestStatus(status)) throw bad(requestId, 'Unknown status', 'invalid_status');
    if (request_type !== undefined && !isPrivacyRequestType(request_type)) throw bad(requestId, 'Unknown request type', 'invalid_request_type');
    let take = PRIVACY_QUEUE_DEFAULT_LIMIT;
    if (limit !== undefined) {
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > PRIVACY_QUEUE_MAX_LIMIT) throw bad(requestId, `limit must be 1 to ${PRIVACY_QUEUE_MAX_LIMIT}`, 'invalid_limit');
      take = Number(limit);
    }
    if (channel !== undefined && !(PRIVACY_CHANNELS as readonly string[]).includes(channel)) throw bad(requestId, 'Unknown channel', 'invalid_channel');
    if (subject_kind !== undefined && !isPrivacySubjectKind(subject_kind)) throw bad(requestId, 'Unknown subject kind', 'invalid_subject_kind');
    if (assigned !== undefined && assigned !== 'me') throw bad(requestId, 'assigned accepts only me', 'invalid_assigned');
    if (overdue !== undefined && overdue !== 'true' && overdue !== 'false') throw bad(requestId, 'overdue accepts true or false', 'invalid_overdue');
    let ref: string | undefined;
    if (reference !== undefined && reference.trim() !== '') {
      const normalized = normalizePrivacyReference(reference);
      // An exact reference that cannot exist matches nothing.
      if (normalized === null) return { items: [], execution_enabled: privacyDeletionExecutionEnabled() };
      ref = normalized;
    }
    const rows = await this.requests.listQueue({
      ...(status !== undefined ? { status } : {}),
      ...(request_type !== undefined ? { request_type } : {}),
      ...(channel !== undefined ? { channel: channel as PrivacyChannel } : {}),
      ...(subject_kind !== undefined && isPrivacySubjectKind(subject_kind) ? { subject_kind } : {}),
      ...(assigned === 'me' ? { assigned_operator_id: auth.sub } : {}),
      ...(overdue === 'true' ? { overdue: true } : {}),
      ...(ref !== undefined ? { reference: ref } : {}),
      // A reference search finds the request whatever its status.
      include_closed: include_closed === 'true' || ref !== undefined,
      limit: take,
    });
    const attempts = await this.requests.executionAttempts(rows.filter((r) => r.status === 'EXECUTING').map((r) => r.id));
    return { items: rows.map((r) => ({ ...this.summary(r), failing: attempts.get(r.id)?.attempts ?? 0 })), execution_enabled: privacyDeletionExecutionEnabled() };
  }

  @Get(':id')
  @RequireScopes('platform:tenant:lifecycle:manage')
  async detail(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    // OD-8 — the contact email is never part of the detail; see reveal-contact.
    return {
      ...this.summary(r),
      contact_present: r.contact_email_ciphertext !== null,
      attempts: await this.attemptsOf(r),
      events: await this.requests.events(id),
      execution_enabled: privacyDeletionExecutionEnabled(),
    };
  }

  // OD-8 — the contact email, revealed by an explicit, audited action.
  @Post(':id/reveal-contact')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async revealContact(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ contact_email: string | null }> {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    const contact_email = this.requests.contactEmail(r);
    await this.requests.recordEvent(id, 'CONTACT_REVEALED', operator(auth), { revealed: contact_email !== null });
    return { contact_email };
  }

  // An operator note: recorded in the history, never shown to the requester.
  @Post(':id/note')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async note(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: PrivacyNoteDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    await this.must(id, requestId);
    await this.requests.recordEvent(id, 'NOTE', operator(auth), { note: body.note });
    return this.summary(await this.must(id, requestId));
  }

  // Read-only impact preview of a DELETION (the same rules execution applies; no write).
  @Get(':id/preview')
  @RequireScopes('platform:tenant:lifecycle:manage')
  async preview(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<PrivacyImpactPreview> {
    assertPlatform(auth, requestId);
    const r = await this.must(id, requestId);
    const execution_enabled = privacyDeletionExecutionEnabled();
    const reasons: string[] = [];
    if (r.request_type !== 'DELETION') reasons.push('not_a_deletion');
    const ctx = r.subject_user_id === null || r.subject_tenant_id === null ? null : await this.subjects.context(r.subject_user_id, r.subject_tenant_id);
    if (r.subject_user_id === null || r.subject_tenant_id === null) reasons.push('no_account_subject');
    else if (ctx === null) reasons.push('subject_mismatch');
    else if (ctx.legal_hold) reasons.push('legal_hold');
    if (reasons.length > 0 || ctx === null) return { path: 'not_executable', reasons, dependencies: [], unknown_sources: [], execution_enabled };
    if (!(ctx.tenant_kind === 'PERSONAL' && ctx.role_keys.includes('tenant_owner'))) return { path: 'member', reasons, dependencies: [], unknown_sources: [], execution_enabled };
    let report: IdentityDependencyReport;
    try {
      report = await this.inspector.inspect(ctx.user_id, ctx.tenant_id, { scope: 'sign' });
    } catch {
      // A source that cannot be read is reported, never fails the preview; the path shown
      // is the one that deletes the most.
      return { path: 'personal_full', reasons, dependencies: ['unknown'], unknown_sources: ['inspector'], execution_enabled };
    }
    if (report.legal_hold) return { path: 'not_executable', reasons: ['legal_hold'], dependencies: [], unknown_sources: [], execution_enabled };
    const cognitoUnknown = report.e_cognito.status === 'unverified';
    const known = report.dependencies.filter((c) => !(cognitoUnknown && c === IDENTITY_DEPENDENCY_CODES.e));
    const unknown_sources = cognitoUnknown ? [IDENTITY_DEPENDENCY_CODES.e] : [];
    const alreadyRetired = !ctx.user_active && isRetiredEmailTombstone(ctx.user_id, ctx.email);
    // Unknown sources do not count: the preview shows the path that deletes the most.
    const path: PrivacyPreviewPath = alreadyRetired || known.length === 0 ? 'personal_full' : 'personal_retain';
    return { path, reasons, dependencies: [...known, ...(unknown_sources.length > 0 ? ['unknown'] : [])], unknown_sources, execution_enabled };
  }

  // OD-4 — an operator returns an executing request to the queue (e.g. a failing one).
  @Post(':id/return-to-queue')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async returnToQueue(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: PrivacyNoteDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const moved = await this.requests.transition(id, 'DATA_INVENTORY', operator(auth), { requestId, from: ['EXECUTING'], payload: { returned_because: 'RETURNED_TO_QUEUE', note: body.note } });
    await this.requests.recordEvent(id, 'RETURNED_TO_QUEUE', operator(auth), { note: body.note });
    return this.summary(moved);
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
    // §1.1 / OD-6 — one referral, to the subject's own organization only.
    if (org !== r.subject_tenant_id) throw conflict(requestId, 'A request is referred only to the subject’s own organization', 'privacy_referral_tenant_mismatch');
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
    // OD-1 — a DELETION reaches COMPLETED only by execution (EXECUTING → COMPLETED, by the
    // system, with completion evidence); a referred one closes by execute or deny.
    if (r.request_type === 'DELETION') throw conflict(requestId, 'A deletion completes only by execution; execute or deny it', 'privacy_deletion_completes_by_execution');
    // OD-2 — the operator-handled outcome of ACCESS / EXPORT / CORRECTION.
    return this.summary(
      await this.requests.transition(id, 'COMPLETED', operator(auth), {
        requestId,
        from: ['DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION'],
        patch: { outcome_code: 'operator_completed', outcome_text: body.note },
        payload: { note: body.note },
      }),
    );
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

  private async attemptsOf(r: PrivacyRequestRecord): Promise<number> {
    if (r.status !== 'EXECUTING') return 0;
    return (await this.requests.executionAttempts([r.id])).get(r.id)?.attempts ?? 0;
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
