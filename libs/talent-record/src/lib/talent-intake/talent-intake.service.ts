import { Injectable, type MessageEvent } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Observable, concat, from, interval, of } from 'rxjs';
import { switchMap, take, takeWhile } from 'rxjs/operators';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { ObjectStorageService } from '@aramo/object-storage';
import { TalentExtractionService } from '@aramo/talent-extraction';
import type { TalentIntakeDraftRow } from '@aramo/talent-evidence';

import {
  type CompleteTalentIntakeUploadRequestDto,
  type CreateTalentIntakeDraftRequestDto,
  type CreateTalentIntakeDraftResponse,
  type PatchTalentIntakeReviewRequestDto,
  type TalentIntakeAcceptedView,
  type TalentIntakeDraftListView,
  type TalentIntakeDraftView,
  type TalentIntakeDuplicateView,
  toTalentIntakeDraftListItemView,
  toTalentIntakeDraftView,
} from '../dto/talent-intake.dto.js';
import { TalentRecordRepository } from '../talent-record.repository.js';

import { applyRecruiterReview, asReviewPayload, reviewValuesChanged } from './talent-intake-review.js';
import {
  TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
  TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY,
  TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD,
  TALENT_INTAKE_EVENT_SOURCE,
  TALENT_INTAKE_EVENT_VERSION,
  TALENT_INTAKE_SUBJECT_TYPE,
} from './talent-intake.constants.js';

// Durable Async Résumé-First Talent Intake — the HTTP intake lifecycle (create →
// complete-upload → read/list → patch-review → retry). Promotion lives in
// TalentIntakePromotionService. All operations are tenant-scoped; the tenant +
// actor are always derived from the auth context, never the client body.
@Injectable()
export class TalentIntakeService {
  constructor(
    private readonly objectStorage: ObjectStorageService,
    private readonly talentExtraction: TalentExtractionService,
    private readonly talentRecord: TalentRecordRepository,
  ) {}

  private notFound(id: string, requestId: string): AramoError {
    return new AramoError('NOT_FOUND', 'Talent intake draft not found.', 404, {
      requestId,
      details: { id },
    });
  }

  // Compose the authoritative read model with the draft-level duplicate
  // projection (§15). The duplicate reuses the SAME active-email authority as
  // the create-time 409; it is surfaced at review time so the recruiter is not
  // surprised at promote. An already-promoted draft never carries a duplicate.
  private async buildView(
    authContext: AuthContextType,
    row: TalentIntakeDraftRow,
  ): Promise<TalentIntakeDraftView> {
    const duplicate = await this.computeDuplicate(authContext, row);
    return toTalentIntakeDraftView(row, { duplicate });
  }

  private async computeDuplicate(
    authContext: AuthContextType,
    row: TalentIntakeDraftRow,
  ): Promise<TalentIntakeDuplicateView | null> {
    if (row.promoted_talent_record_id !== null) {
      return null;
    }
    const review = asReviewPayload(row.review_payload);
    const value = (key: string): string => {
      const field = review.fields[key];
      return field !== undefined && typeof field.value === 'string' ? field.value.trim() : '';
    };
    const email = value('email1');
    const phone = value('phone_cell');
    // ATI-SEP-1 A2 — the SAME authority as the Save-time 409: email1 first, then
    // the normalized cell phone. A resumed Save's own reserved record is not a
    // duplicate of itself.
    const own = row.save_reserved_talent_record_id ?? null;
    let match: Awaited<ReturnType<TalentRecordRepository['findDuplicateByEmail']>> = null;
    let reason: 'email' | 'phone' = 'email';
    if (email !== '') {
      match = await this.talentRecord.findDuplicateByEmail({ tenant_id: authContext.tenant_id, email });
    }
    if ((match === null || match.id === own) && phone !== '') {
      match = await this.talentRecord.findDuplicateByPhone({ tenant_id: authContext.tenant_id, phone });
      reason = 'phone';
    }
    if (match === null || match.id === own) {
      return null;
    }
    const location =
      [match.city, match.state].filter((x) => x !== null && x.trim() !== '').join(', ') || null;
    return {
      talent_record_id: match.id,
      display_name: `${match.first_name} ${match.last_name}`.trim(),
      title: match.title,
      location,
      reason,
      // V1 (PO ruling): an active-email / cell-phone duplicate is a hard create
      // block — the 409 is preserved — so Continue anyway is never authorized.
      continue_anyway: false,
    };
  }

  // 1 — Create intake: mint the object key, persist a durable UPLOADED draft, and
  // return the presigned upload target. NO LLM work on this request.
  async createIntake(
    authContext: AuthContextType,
    body: CreateTalentIntakeDraftRequestDto,
    requestId: string,
  ): Promise<CreateTalentIntakeDraftResponse> {
    const filename = (body.filename ?? '').trim();
    const contentType = (body.content_type ?? '').trim();
    if (filename === '') {
      throw new AramoError('VALIDATION_ERROR', 'filename must be a non-empty string', 422, {
        requestId,
        details: { field: 'filename' },
      });
    }
    if (contentType === '') {
      throw new AramoError('VALIDATION_ERROR', 'content_type must be a non-empty string', 422, {
        requestId,
        details: { field: 'content_type' },
      });
    }

    const draftId = uuidv7();
    // The intake draft id scopes the tenant object key (pre-Talent — no
    // TalentRecord id exists yet). The client receives only the opaque key.
    const presign = await this.objectStorage.createResumePresignedPut({
      tenant_id: authContext.tenant_id,
      talent_record_id: draftId,
      filename,
      content_type: contentType,
      requestId,
    });

    await this.talentExtraction.createTalentIntakeDraft({
      id: draftId,
      tenant_id: authContext.tenant_id,
      created_by: authContext.sub,
      source_type: TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD,
      source_filename: filename,
      storage_key: presign.storage_key,
      mime_type: contentType,
    });

    return {
      draft_id: draftId,
      upload_url: presign.presigned_url,
      storage_key: presign.storage_key,
      processing_status: 'UPLOADED',
      expires_at: String(presign.expires_at),
    };
  }

  // 1a — Manual entry (ATI-SEP-1 A5): the recruiter adds a Talent WITHOUT a
  // résumé. Persists an artifact-less draft and settles it terminal (READY)
  // immediately — there is nothing to extract, so NO outbox event and NO LLM
  // work. READY (not PARTIAL): PARTIAL means "a résumé was only partly read"
  // and carries retry/replace + Needs-attention semantics, none of which apply
  // when no résumé was supplied. The draft then follows the ordinary review →
  // PATCH → promote path (admission is the only create gate).
  async createManualIntake(
    authContext: AuthContextType,
    requestId: string,
  ): Promise<TalentIntakeDraftView> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const draftId = uuidv7();
    await this.talentExtraction.createTalentIntakeDraft({
      id: draftId,
      tenant_id,
      created_by,
      source_type: TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY,
      source_filename: null,
      storage_key: null,
      mime_type: null,
    });
    await this.settleManualIntake(tenant_id, draftId);
    const row = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id: draftId,
      created_by,
    });
    if (row === null) {
      throw this.notFound(draftId, requestId);
    }
    return this.buildView(authContext, row);
  }

  // Terminal settle for a manual-entry draft (no extraction child, no warning).
  private async settleManualIntake(tenant_id: string, id: string): Promise<void> {
    await this.talentExtraction.markTalentIntakeDraftProcessed({
      tenant_id,
      id,
      processing_status: 'READY',
      warning_code: null,
      failure_code: null,
      failure_detail: null,
      processing_completed_at: new Date(),
    });
  }

  // 1b — Source-agnostic admission (ADR-0033 Decision 5). A NON-upload producer
  // (job board / sourcing / agent / import / integration / external API) enters
  // the SAME Talent Intake authority WITHOUT fabricating an S3 upload. Idempotent
  // on (tenant_id, source_type, source_event_id): a producer that redelivers the
  // same source_event_id converges on the SAME draft and emits the canonical
  // event only once. The artifact is OPTIONAL. Only the Talent authority ever
  // promotes to a canonical TalentRecord — this just admits intake.
  async createSourceIntake(
    authContext: AuthContextType,
    body: {
      source_type: string;
      source_event_id: string;
      source_ref?: string | null;
      storage_key?: string | null;
      source_filename?: string | null;
      mime_type?: string | null;
      size_bytes?: number | null;
      structured_payload?: unknown;
    },
    requestId: string,
  ): Promise<{ draft_id: string; created: boolean; processing_status: string }> {
    const sourceType = (body.source_type ?? '').trim();
    const sourceEventId = (body.source_event_id ?? '').trim();
    // RESUME_UPLOAD and MANUAL_ENTRY are recruiter-surface intakes with their own
    // routes; neither is a producer source.
    if (
      sourceType === '' ||
      sourceType === TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD ||
      sourceType === TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY
    ) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'source_type must be a non-empty non-upload source.',
        422,
        { requestId, details: { field: 'source_type' } },
      );
    }
    if (sourceEventId === '') {
      throw new AramoError('VALIDATION_ERROR', 'source_event_id must be a non-empty string', 422, {
        requestId,
        details: { field: 'source_event_id' },
      });
    }
    const draftId = uuidv7();
    const { created, draft } = await this.talentExtraction.createOrRecoverSourceIntakeWithOutbox({
      id: draftId,
      tenant_id: authContext.tenant_id,
      created_by: authContext.sub,
      source_type: sourceType,
      source_event_id: sourceEventId,
      source_ref: body.source_ref ?? null,
      storage_key: body.storage_key ?? null,
      source_filename: body.source_filename ?? null,
      mime_type: body.mime_type ?? null,
      size_bytes: body.size_bytes ?? null,
      structured_payload: body.structured_payload,
      event_type: TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
      event_version: TALENT_INTAKE_EVENT_VERSION,
      source: TALENT_INTAKE_EVENT_SOURCE,
      subject_type: TALENT_INTAKE_SUBJECT_TYPE,
      correlation_id: requestId,
      event_payload: {
        draft_id: draftId,
        correlation_id: requestId,
        source_type: sourceType,
        source_event_id: sourceEventId,
      },
    });
    return { draft_id: draft.id, created, processing_status: draft.processing_status };
  }

  // 2 — Complete upload: verify the object exists, record authoritative metadata,
  // clear the orphan-sweep tag, then atomically QUEUE + write the outbox event.
  // Idempotent: a replay (already QUEUED/PROCESSING/…) enqueues nothing.
  async completeUpload(
    authContext: AuthContextType,
    id: string,
    body: CompleteTalentIntakeUploadRequestDto,
    requestId: string,
  ): Promise<TalentIntakeAcceptedView> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const draft = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id,
      created_by,
    });
    if (draft === null) {
      throw this.notFound(id, requestId);
    }
    if (draft.storage_key === null) {
      // complete-upload is the artifact-backed (RESUME_UPLOAD) path; a
      // non-upload source (ADR-0033 §5) has no object to commit.
      throw new AramoError(
        'VALIDATION_ERROR',
        'This intake has no uploaded artifact to complete.',
        422,
        { requestId, details: { reason: 'no_artifact' } },
      );
    }
    const storageKey = draft.storage_key;

    const head = await this.objectStorage.headObject({
      storage_key: storageKey,
      requestId,
    });
    if (head === null) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'The résumé upload was not found. Please re-upload.',
        422,
        { requestId, details: { reason: 'object_missing' } },
      );
    }
    // The object is now durable — clear the orphan-sweep pending tag.
    await this.objectStorage.markResumeCommitted({ storage_key: storageKey, requestId });

    const { draft: updated } = await this.talentExtraction.completeTalentIntakeUploadWithOutbox({
      tenant_id,
      id,
      created_by,
      artifact_sha256: body.artifact_sha256 ?? null,
      mime_type: head.content_type ?? draft.mime_type ?? null,
      size_bytes: head.byte_length,
      event_type: TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
      // correlation_id links the HTTP request → outbox → relay → BullMQ job →
      // worker logs for end-to-end traceability.
      event_payload: { draft_id: id, correlation_id: requestId },
    });

    return {
      draft_id: id,
      processing_status: updated?.processing_status ?? 'QUEUED',
    };
  }

  // 3 — Recovery: the recruiter's resumable drafts (tenant + creator scoped).
  async list(authContext: AuthContextType): Promise<TalentIntakeDraftListView> {
    const rows = await this.talentExtraction.listTalentIntakeDraftsForCreator({
      tenant_id: authContext.tenant_id,
      created_by: authContext.sub,
      limit: 100,
    });
    return { items: rows.map(toTalentIntakeDraftListItemView) };
  }

  // 4 — Read one draft (the authoritative GET recovery read model).
  async get(
    authContext: AuthContextType,
    id: string,
    requestId: string,
  ): Promise<TalentIntakeDraftView> {
    const row = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id: authContext.tenant_id,
      id,
      created_by: authContext.sub,
    });
    if (row === null) {
      throw this.notFound(id, requestId);
    }
    await this.talentExtraction.touchTalentIntakeDraftOpened({
      tenant_id: authContext.tenant_id,
      id,
      created_by: authContext.sub,
    });
    return this.buildView(authContext, row);
  }

  // 5 — Persist recruiter review edits (CAS on the exact version). A stale save
  // (older tab/device) returns 409 so the FE can reload the authoritative state.
  async patchReview(
    authContext: AuthContextType,
    id: string,
    body: PatchTalentIntakeReviewRequestDto,
    requestId: string,
  ): Promise<TalentIntakeDraftView> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const existing = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id,
      created_by,
    });
    if (existing === null) {
      throw this.notFound(id, requestId);
    }
    if (existing.review_status === 'PROMOTED') {
      throw new AramoError('VALIDATION_ERROR', 'This draft has already been promoted.', 422, {
        requestId,
        details: { review_status: existing.review_status },
      });
    }
    // Backend-owned merge (I7 / §8.5): only recruiter-origin fields and the
    // arrays the recruiter actually edited come from the client; everything
    // else keeps the persisted (extraction) value.
    const merged = applyRecruiterReview(existing.review_payload, body.review);
    // D6 — a partly saved draft whose TalentRecord already exists (the Save
    // committed the record and is finishing its follow-ups) can no longer carry
    // a changed value to the Talent: the resumed Save never rewrites a created
    // record or its evidence. Refuse the edit rather than lose it silently; the
    // FE directs the recruiter to the Talent record. An unchanged autosave
    // passes. (A Save committing the record between this check and the write
    // below is not fenced — the resumed Save would then skip the edit.)
    const reserved = existing.save_reserved_talent_record_id ?? null;
    if (reserved !== null && reviewValuesChanged(existing.review_payload, merged)) {
      const onTalent = await this.talentRecord.findById({ tenant_id, id: reserved });
      if (onTalent !== null) {
        throw new AramoError(
          'INTAKE_DRAFT_SAVED_EDIT_ON_TALENT',
          'This talent has already been created. Make further changes on the Talent record.',
          409,
          { requestId, details: { reason: 'saved_edit_on_talent', talent_record_id: reserved } },
        );
      }
    }
    const count = await this.talentExtraction.saveTalentIntakeDraftReview({
      tenant_id,
      id,
      created_by,
      expected_version: body.expected_version,
      // CAS on expected_version still rejects a stale tab.
      review_payload: merged,
      review_status: 'IN_REVIEW',
    });
    if (count === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'This draft was changed in another session. Reload and try again.',
        409,
        { requestId, details: { reason: 'version_conflict' } },
      );
    }
    const reloaded = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id,
      created_by,
    });
    return this.buildView(authContext, reloaded ?? existing);
  }

  // 6 — Retry extraction on the SAME stored artifact (no re-upload). A no-op when
  // the draft is not in a retryable (FAILED/PARTIAL) state.
  //
  // ATI-SEP-1 A5 — a draft left UPLOADED (the browser's complete-upload call
  // failed after the bytes landed) is retried by re-running the complete-upload
  // semantics: headObject check, commit tag, then the guarded UPLOADED → QUEUED
  // + outbox transition (itself idempotent — a replay enqueues nothing). A
  // missing object surfaces the same 422 object_missing so the FE offers
  // Replace. A manual-entry draft stranded UPLOADED is simply settled READY.
  async retry(
    authContext: AuthContextType,
    id: string,
    requestId: string,
  ): Promise<TalentIntakeDraftView> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const existing = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id,
      created_by,
    });
    if (existing === null) {
      throw this.notFound(id, requestId);
    }
    if (existing.processing_status === 'UPLOADED' && existing.promoted_talent_record_id === null) {
      if (existing.storage_key !== null) {
        await this.completeUpload(authContext, id, {}, requestId);
      } else if (existing.source_type === TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY) {
        await this.settleManualIntake(tenant_id, id);
      }
      const settled = await this.talentExtraction.findTalentIntakeDraftById({
        tenant_id,
        id,
        created_by,
      });
      return this.buildView(authContext, settled ?? existing);
    }
    await this.talentExtraction.requeueTalentIntakeDraftWithOutbox({
      tenant_id,
      id,
      created_by,
      event_type: TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
      event_payload: { draft_id: id, correlation_id: requestId },
    });
    const reloaded = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id,
      created_by,
    });
    return this.buildView(authContext, reloaded ?? existing);
  }

  // 6b — Discard (§18): explicit, actor-owned, hard delete of an unfinished draft
  // plus its uploaded résumé object. There is NO age-based auto-deletion — this
  // is the only deletion path. The row delete is authoritative; the object is
  // removed best-effort afterward (orphan-sweep is the backstop).
  async discard(authContext: AuthContextType, id: string, requestId: string): Promise<void> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const existing = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id,
      created_by,
    });
    if (existing === null) {
      throw this.notFound(id, requestId);
    }
    if (existing.review_status === 'PROMOTED') {
      throw new AramoError('VALIDATION_ERROR', 'A created talent cannot be discarded.', 422, {
        requestId,
        details: { review_status: existing.review_status },
      });
    }
    // ATI-SEP-1 A2 — a Save that already materialized evidence is resumed (Save
    // again), never discarded, so no evidence is orphaned.
    if (existing.save_evidence_materialized_at != null) {
      throw new AramoError('VALIDATION_ERROR', 'This draft is partly saved. Save it again to finish.', 422, {
        requestId,
        details: { reason: 'save_in_progress' },
      });
    }
    const count = await this.talentExtraction.deleteTalentIntakeDraft({ tenant_id, id, created_by });
    if (count === 0) {
      // Lost a race (promoted/discarded elsewhere between read and delete).
      throw this.notFound(id, requestId);
    }
    if (existing.storage_key !== null) {
      try {
        await this.objectStorage.deleteObjectByKey({ storage_key: existing.storage_key, requestId });
      } catch {
        // The row is already gone; a storage hiccup must not resurrect the draft.
        // The S3 orphan-sweep lifecycle rule reclaims the object.
      }
    }
  }

  // 6c — Replace résumé (§13): mint a NEW object key, re-point the owned draft to
  // it, reset to UPLOADED (clears prior failure) so the existing complete-upload
  // path re-queues a fresh extraction. The OLD object is deleted best-effort.
  // The browser uploads to the returned presigned URL, then calls complete-upload.
  async replaceResume(
    authContext: AuthContextType,
    id: string,
    body: CreateTalentIntakeDraftRequestDto,
    requestId: string,
  ): Promise<CreateTalentIntakeDraftResponse> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const filename = (body.filename ?? '').trim();
    const contentType = (body.content_type ?? '').trim();
    if (filename === '') {
      throw new AramoError('VALIDATION_ERROR', 'filename must be a non-empty string', 422, {
        requestId,
        details: { field: 'filename' },
      });
    }
    if (contentType === '') {
      throw new AramoError('VALIDATION_ERROR', 'content_type must be a non-empty string', 422, {
        requestId,
        details: { field: 'content_type' },
      });
    }
    const existing = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id,
      id,
      created_by,
    });
    if (existing === null) {
      throw this.notFound(id, requestId);
    }
    if (existing.review_status === 'PROMOTED') {
      throw new AramoError('VALIDATION_ERROR', 'A created talent cannot be edited here.', 422, {
        requestId,
        details: { review_status: existing.review_status },
      });
    }
    if (existing.save_evidence_materialized_at != null) {
      throw new AramoError('VALIDATION_ERROR', 'This draft is partly saved. Save it again to finish.', 422, {
        requestId,
        details: { reason: 'save_in_progress' },
      });
    }
    const presign = await this.objectStorage.createResumePresignedPut({
      tenant_id,
      talent_record_id: id,
      filename,
      content_type: contentType,
      requestId,
    });
    const count = await this.talentExtraction.replaceTalentIntakeDraftArtifact({
      tenant_id,
      id,
      created_by,
      storage_key: presign.storage_key,
      source_filename: filename,
      mime_type: contentType,
    });
    if (count === 0) {
      throw this.notFound(id, requestId);
    }
    // Best-effort delete of the superseded object (fresh uuid key → never the new
    // one). Orphan-sweep backstops a failure.
    const oldKey = existing.storage_key;
    if (oldKey !== null && oldKey !== presign.storage_key) {
      try {
        await this.objectStorage.deleteObjectByKey({ storage_key: oldKey, requestId });
      } catch {
        // Superseded object left for the orphan-sweep lifecycle rule.
      }
    }
    return {
      draft_id: id,
      upload_url: presign.presigned_url,
      storage_key: presign.storage_key,
      processing_status: 'UPLOADED',
      expires_at: String(presign.expires_at),
    };
  }

  // 7 — SSE NOTIFICATION. This is notification-only: GET remains authoritative.
  // The event carries ONLY small status/version identifiers (never the structured
  // extraction payload or any PII). It is built from the PERSISTED row, so an
  // event can never precede the state commit, and a reconnect simply re-reads the
  // current state (no server-side session). Tenant-scoped: a cross-tenant id reads
  // null → a 'not_found' event, never another tenant's state.
  async buildIntakeEvent(authContext: AuthContextType, id: string): Promise<MessageEvent> {
    const row = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id: authContext.tenant_id,
      id,
      created_by: authContext.sub,
    });
    if (row === null) {
      return { type: 'not_found', data: { id } };
    }
    return {
      type: 'draft',
      data: {
        id: row.id,
        processing_status: row.processing_status,
        review_status: row.review_status,
        version: row.version,
      },
    };
  }

  // The SSE stream: poll the persisted (status, version) and notify the browser to
  // refetch GET. Stops once processing reaches a terminal state (inclusive) or on
  // not_found, with a hard cap so a stream never runs unbounded. No structured
  // payload is ever streamed. A missed/dropped stream is harmless — the FE can GET
  // the authoritative state at any time.
  streamIntakeEvents(authContext: AuthContextType, id: string): Observable<MessageEvent> {
    const POLL_MS = 2000;
    const MAX_EMITS = 300; // ~10 min safety cap
    const terminal = new Set(['READY', 'PARTIAL', 'FAILED']);
    return concat(of(0), interval(POLL_MS)).pipe(
      switchMap(() => from(this.buildIntakeEvent(authContext, id))),
      // Emit while still processing; emit the FIRST terminal/not_found event too
      // (inclusive), then complete.
      takeWhile((ev) => {
        if (ev.type !== 'draft') {
          return false;
        }
        const status = (ev.data as { processing_status: string }).processing_status;
        return !terminal.has(status);
      }, true),
      take(MAX_EMITS),
    );
  }
}
