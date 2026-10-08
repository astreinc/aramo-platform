import { describe, expect, it } from 'vitest';
import type { TalentIntakeDraftRow } from '@aramo/talent-evidence';

import {
  talentIntakeActions,
  toTalentIntakeDraftView,
  type TalentIntakeDuplicateView,
} from '../lib/dto/talent-intake.dto.js';

// Talent Draft Recovery §10/§15 — backend-owned action availability + the
// draft-level duplicate projection. Pure projection logic (no DB): proves the
// PO duplicate-authority ruling is encoded in the view — an active-email
// duplicate blocks create (promote is NOT offered) and Continue anyway is never
// authorized.

function mkRow(over: Partial<TalentIntakeDraftRow> = {}): TalentIntakeDraftRow {
  const base: TalentIntakeDraftRow = {
    id: '00000000-0000-7000-8000-000000000001',
    tenant_id: '00000000-0000-7000-8000-0000000000aa',
    created_by: '00000000-0000-7000-8000-0000000000bb',
    source_type: 'RESUME_UPLOAD',
    source_ref: null,
    source_event_id: null,
    source_filename: 'resume.pdf',
    storage_key: 'k',
    artifact_sha256: null,
    mime_type: 'application/pdf',
    size_bytes: 1,
    processing_status: 'READY',
    review_status: 'IN_REVIEW',
    structured_payload: null,
    review_payload: null,
    warning_code: null,
    failure_code: null,
    failure_detail: null,
    extraction_provider: null,
    extraction_model: null,
    extraction_contract_version: null,
    resume_extraction_draft_id: '00000000-0000-7000-8000-0000000000cc',
    promoted_talent_record_id: null,
    promoted_at: null,
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    processing_started_at: null,
    processing_completed_at: new Date(),
    last_opened_at: null,
    last_touched_at: new Date(),
  };
  return { ...base, ...over };
}

const DUP: TalentIntakeDuplicateView = {
  talent_record_id: '00000000-0000-7000-8000-0000000000dd',
  display_name: 'Uma Maheshwari',
  title: 'Agile Coach',
  location: 'Centreville, VA',
  reason: 'email',
  continue_anyway: false,
};

describe('talent intake draft view — actions + duplicate projection', () => {
  it('READY with no duplicate offers promote_to_talent + discard, no retry/replace', () => {
    const v = toTalentIntakeDraftView(mkRow({ processing_status: 'READY' }));
    expect(v.duplicate).toBeNull();
    expect(v.actions).toContain('promote_to_talent');
    expect(v.actions).toContain('edit_draft');
    expect(v.actions).toContain('discard');
    expect(v.actions).not.toContain('retry_extraction');
  });

  it('active-email duplicate blocks create: promote_to_talent is withheld, Continue anyway never offered', () => {
    const v = toTalentIntakeDraftView(mkRow({ processing_status: 'READY' }), { duplicate: DUP });
    expect(v.duplicate).toEqual(DUP);
    expect(v.duplicate?.continue_anyway).toBe(false);
    expect(v.actions).not.toContain('promote_to_talent'); // the 409 is preserved
    expect(v.actions).toContain('discard'); // Open existing (FE nav) + Discard remain
  });

  it('FAILED offers retry_extraction + replace_resume + discard, and still allows create (§13 — failure does not block creation)', () => {
    const v = toTalentIntakeDraftView(mkRow({ processing_status: 'FAILED' }));
    expect(v.actions).toContain('retry_extraction');
    expect(v.actions).toContain('replace_resume');
    expect(v.actions).toContain('discard');
    // Extraction failure must NOT block creation — a terminal draft is promotable
    // (once admissible); only an active-email duplicate withholds promote.
    expect(v.actions).toContain('promote_to_talent');
  });

  it('a promoted draft exposes no actions', () => {
    const v = toTalentIntakeDraftView(
      mkRow({ review_status: 'PROMOTED', promoted_talent_record_id: '00000000-0000-7000-8000-0000000000ee' }),
    );
    expect(v.actions).toEqual([]);
  });

  it('talentIntakeActions honors duplicateBlocksCreate independently', () => {
    const row = mkRow({ processing_status: 'READY' });
    expect(talentIntakeActions(row)).toContain('promote_to_talent');
    expect(talentIntakeActions(row, { duplicateBlocksCreate: true })).not.toContain('promote_to_talent');
  });
});
