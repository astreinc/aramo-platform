import { Injectable, type MessageEvent } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Observable, concat, from, interval, of } from 'rxjs';
import { switchMap, take, takeWhile } from 'rxjs/operators';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { ObjectStorageService } from '@aramo/object-storage';
import { TalentExtractionService } from '@aramo/talent-extraction';

import {
  type CompleteTalentIntakeUploadRequestDto,
  type CreateTalentIntakeDraftRequestDto,
  type CreateTalentIntakeDraftResponse,
  type PatchTalentIntakeReviewRequestDto,
  type TalentIntakeAcceptedView,
  type TalentIntakeDraftListView,
  type TalentIntakeDraftView,
  toTalentIntakeDraftListItemView,
  toTalentIntakeDraftView,
} from '../dto/talent-intake.dto.js';

import {
  TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
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
  ) {}

  private notFound(id: string, requestId: string): AramoError {
    return new AramoError('NOT_FOUND', 'Talent intake draft not found.', 404, {
      requestId,
      details: { id },
    });
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
    if (sourceType === '' || sourceType === TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD) {
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
    const draft = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id });
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
    });
    if (row === null) {
      throw this.notFound(id, requestId);
    }
    await this.talentExtraction.touchTalentIntakeDraftOpened({
      tenant_id: authContext.tenant_id,
      id,
    });
    return toTalentIntakeDraftView(row);
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
    const existing = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id });
    if (existing === null) {
      throw this.notFound(id, requestId);
    }
    if (existing.review_status === 'PROMOTED') {
      throw new AramoError('VALIDATION_ERROR', 'This draft has already been promoted.', 422, {
        requestId,
        details: { review_status: existing.review_status },
      });
    }
    const count = await this.talentExtraction.saveTalentIntakeDraftReview({
      tenant_id,
      id,
      expected_version: body.expected_version,
      review_payload: body.review,
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
    const reloaded = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id });
    return toTalentIntakeDraftView(reloaded ?? existing);
  }

  // 6 — Retry extraction on the SAME stored artifact (no re-upload). A no-op when
  // the draft is not in a retryable (FAILED/PARTIAL) state.
  async retry(
    authContext: AuthContextType,
    id: string,
    requestId: string,
  ): Promise<TalentIntakeDraftView> {
    const tenant_id = authContext.tenant_id;
    const existing = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id });
    if (existing === null) {
      throw this.notFound(id, requestId);
    }
    await this.talentExtraction.requeueTalentIntakeDraftWithOutbox({
      tenant_id,
      id,
      event_type: TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
      event_payload: { draft_id: id, correlation_id: requestId },
    });
    const reloaded = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id });
    return toTalentIntakeDraftView(reloaded ?? existing);
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
