import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import type { TalentIntakeDraftRow } from '@aramo/talent-evidence';

import {
  intakeFailureMessage,
  talentIntakeActions,
  toTalentIntakeDraftView,
} from '../lib/dto/talent-intake.dto.js';
import { TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY } from '../lib/talent-intake/talent-intake.constants.js';
import { TalentIntakeService } from '../lib/talent-intake/talent-intake.service.js';

// ATI-SEP-1 A5 — Add Talent as designed:
//   • POST /v1/talent-intake-drafts/manual creates an artifact-less draft settled
//     READY at once — NO outbox event, NO extraction request, NO object storage;
//   • retry from UPLOADED (the browser's complete-upload failed) re-runs the
//     complete-upload semantics (headObject → commit tag → guarded QUEUE +
//     outbox); a missing object is a 422 object_missing; an in-flight / promoted
//     draft is never re-driven;
//   • FAILED copy is specialised per internal failure_code (never projected).

const AUTH = { tenant_id: 'tenant-1', sub: 'actor-1' } as unknown as AuthContextType;

function mkRow(over: Partial<TalentIntakeDraftRow> = {}): TalentIntakeDraftRow {
  const base: TalentIntakeDraftRow = {
    id: 'draft-1',
    tenant_id: 'tenant-1',
    created_by: 'actor-1',
    source_type: 'RESUME_UPLOAD',
    source_ref: null,
    source_event_id: null,
    source_filename: 'ada.pdf',
    storage_key: 'tenant-1/talent/draft-1/resume/obj.pdf',
    artifact_sha256: null,
    mime_type: 'application/pdf',
    size_bytes: 10,
    processing_status: 'UPLOADED',
    review_status: 'NOT_STARTED',
    structured_payload: null,
    review_payload: null,
    warning_code: null,
    failure_code: null,
    failure_detail: null,
    extraction_provider: null,
    extraction_model: null,
    extraction_contract_version: null,
    resume_extraction_draft_id: null,
    promoted_talent_record_id: null,
    promoted_at: null,
    version: 0,
    created_at: new Date(),
    updated_at: new Date(),
    processing_started_at: null,
    processing_completed_at: null,
    last_opened_at: null,
    last_touched_at: new Date(),
  };
  return { ...base, ...over };
}

function makeService(opts: { row?: TalentIntakeDraftRow | null; head?: unknown } = {}) {
  let current: TalentIntakeDraftRow | null = opts.row ?? null;
  const extraction = {
    createTalentIntakeDraft: vi.fn(async (input: Record<string, unknown>) => {
      current = mkRow({
        ...(input as Partial<TalentIntakeDraftRow>),
        processing_status: 'UPLOADED',
      });
      return current;
    }),
    markTalentIntakeDraftProcessed: vi.fn(async (input: { processing_status: string }) => {
      if (current !== null) {
        current = {
          ...current,
          processing_status: input.processing_status,
          processing_completed_at: new Date(),
          version: current.version + 1,
        };
      }
    }),
    findTalentIntakeDraftById: vi.fn(async () => current),
    completeTalentIntakeUploadWithOutbox: vi.fn(async () => {
      if (current !== null && current.processing_status === 'UPLOADED') {
        current = { ...current, processing_status: 'QUEUED', version: current.version + 1 };
        return { enqueued: true, draft: current };
      }
      return { enqueued: false, draft: current };
    }),
    requeueTalentIntakeDraftWithOutbox: vi.fn(async () => ({ enqueued: false, draft: current })),
    createOrRecoverSourceIntakeWithOutbox: vi.fn(),
  };
  const storage = {
    headObject: vi.fn(async () =>
      opts.head === undefined ? { content_type: 'application/pdf', byte_length: 10 } : opts.head,
    ),
    markResumeCommitted: vi.fn(async () => undefined),
    createResumePresignedPut: vi.fn(),
  };
  const talentRecord = { findDuplicateByEmail: vi.fn(async () => null) };
  const service = new TalentIntakeService(
    storage as never,
    extraction as never,
    talentRecord as never,
  );
  return { service, extraction, storage };
}

describe('ATI-SEP-1 A5 — manual entry intake', () => {
  it('creates an artifact-less MANUAL_ENTRY draft settled READY with no outbox / extraction / storage', async () => {
    const { service, extraction, storage } = makeService();
    const view = await service.createManualIntake(AUTH, 'req-1');

    expect(extraction.createTalentIntakeDraft).toHaveBeenCalledTimes(1);
    const created = extraction.createTalentIntakeDraft.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created).toMatchObject({
      tenant_id: 'tenant-1',
      created_by: 'actor-1',
      source_type: TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY,
      storage_key: null,
      source_filename: null,
    });
    expect(extraction.markTalentIntakeDraftProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ processing_status: 'READY', warning_code: null, failure_code: null }),
    );
    // No extraction is ever requested and no object storage is touched.
    expect(extraction.completeTalentIntakeUploadWithOutbox).not.toHaveBeenCalled();
    expect(extraction.requeueTalentIntakeDraftWithOutbox).not.toHaveBeenCalled();
    expect(extraction.createOrRecoverSourceIntakeWithOutbox).not.toHaveBeenCalled();
    expect(storage.createResumePresignedPut).not.toHaveBeenCalled();
    expect(storage.headObject).not.toHaveBeenCalled();

    expect(view.processing_status).toBe('READY');
    expect(view.source_filename).toBeNull();
    expect(view.failure).toBeNull();
    expect(view.actions).toEqual(['edit_draft', 'promote_to_talent', 'discard']);
  });

  it('MANUAL_ENTRY is refused as a producer source_type', async () => {
    const { service } = makeService();
    await expect(
      service.createSourceIntake(
        AUTH,
        { source_type: TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY, source_event_id: 'e1' },
        'req-1',
      ),
    ).rejects.toBeInstanceOf(AramoError);
  });
});

describe('ATI-SEP-1 A5 — retry from UPLOADED', () => {
  it('re-runs complete-upload: headObject, commit tag, then QUEUE + outbox', async () => {
    const { service, extraction, storage } = makeService({ row: mkRow() });
    const view = await service.retry(AUTH, 'draft-1', 'req-2');
    expect(storage.headObject).toHaveBeenCalledTimes(1);
    expect(storage.markResumeCommitted).toHaveBeenCalledTimes(1);
    expect(extraction.completeTalentIntakeUploadWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        id: 'draft-1',
        created_by: 'actor-1',
        event_payload: { draft_id: 'draft-1', correlation_id: 'req-2' },
      }),
    );
    expect(extraction.requeueTalentIntakeDraftWithOutbox).not.toHaveBeenCalled();
    expect(view.processing_status).toBe('QUEUED');
  });

  it('a missing object is a 422 object_missing and nothing is queued', async () => {
    const { service, extraction } = makeService({ row: mkRow(), head: null });
    await expect(service.retry(AUTH, 'draft-1', 'req-3')).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(extraction.completeTalentIntakeUploadWithOutbox).not.toHaveBeenCalled();
  });

  it('is idempotent: a second retry after QUEUED takes the guarded requeue path (no-op)', async () => {
    const { service, extraction } = makeService({ row: mkRow() });
    await service.retry(AUTH, 'draft-1', 'req-4');
    await service.retry(AUTH, 'draft-1', 'req-5');
    expect(extraction.completeTalentIntakeUploadWithOutbox).toHaveBeenCalledTimes(1);
    // The second call is the existing FAILED/PARTIAL-guarded requeue → no-op on QUEUED.
    expect(extraction.requeueTalentIntakeDraftWithOutbox).toHaveBeenCalledTimes(1);
  });

  it('a promoted draft stuck UPLOADED is never re-driven', async () => {
    const { service, extraction, storage } = makeService({
      row: mkRow({ promoted_talent_record_id: 'tr-1', review_status: 'PROMOTED' }),
    });
    await service.retry(AUTH, 'draft-1', 'req-6');
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(extraction.completeTalentIntakeUploadWithOutbox).not.toHaveBeenCalled();
  });

  it('a manual-entry draft stranded UPLOADED is settled READY (no storage, no outbox)', async () => {
    const { service, extraction, storage } = makeService({
      row: mkRow({
        source_type: TALENT_INTAKE_SOURCE_TYPE_MANUAL_ENTRY,
        storage_key: null,
        source_filename: null,
      }),
    });
    const view = await service.retry(AUTH, 'draft-1', 'req-7');
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(extraction.completeTalentIntakeUploadWithOutbox).not.toHaveBeenCalled();
    expect(view.processing_status).toBe('READY');
  });
});

describe('ATI-SEP-1 A5 — truthful view projection', () => {
  it('UPLOADED with an artifact offers retry + replace; a manual draft does not', () => {
    expect(talentIntakeActions(mkRow())).toEqual([
      'edit_draft',
      'retry_extraction',
      'replace_resume',
      'discard',
    ]);
    expect(
      talentIntakeActions(mkRow({ storage_key: null, processing_status: 'READY' })),
    ).not.toContain('retry_extraction');
  });

  it('FAILED copy is specific per failure_code and the code itself is never projected', () => {
    const truncated = mkRow({
      processing_status: 'FAILED',
      failure_code: 'provider_truncated',
      failure_detail: 'orchestrator prose',
    });
    expect(intakeFailureMessage(truncated)).toBe(
      'This resume was too long to read in one pass. Enter the details below — the resume stays attached.',
    );
    const unreadable = mkRow({ processing_status: 'FAILED', failure_code: 'RESUME_UNREADABLE' });
    expect(intakeFailureMessage(unreadable)).toMatch(/couldn’t read any text in this file/);
    const view = toTalentIntakeDraftView(truncated);
    expect(JSON.stringify(view)).not.toContain('provider_truncated');
  });

  it('an unknown failure_code falls back to the recorded failure_detail', () => {
    expect(
      intakeFailureMessage(
        mkRow({ processing_status: 'FAILED', failure_code: 'SOMETHING_NEW', failure_detail: 'x' }),
      ),
    ).toBe('x');
  });
});
