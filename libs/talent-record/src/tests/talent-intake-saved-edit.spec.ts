import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentIntakeService } from '../lib/talent-intake/talent-intake.service.js';
import { reviewValuesChanged } from '../lib/talent-intake/talent-intake-review.js';

// ATI-SEP-1 D6 — recruiter edits are never silently lost. Once a draft's Save
// has created its TalentRecord (the Save is finishing its follow-ups), a review
// PATCH that changes a value is refused 409 INTAKE_DRAFT_SAVED_EDIT_ON_TALENT
// (the resumed Save never rewrites a created record or its evidence). Before
// the record exists the edit is accepted — the resumed Save re-materializes it
// (talent-intake-save.spec.ts / the integration spec).

const TENANT = '11111111-1111-7111-8111-111111111111';
const AUTH = { tenant_id: TENANT, sub: 'actor-1', consumer_type: 'recruiter' } as unknown as AuthContextType;

const PAYLOAD = {
  fields: { first_name: { value: 'Uma', origin: 'RECRUITER' } },
  work_history: [{ employer_name: 'Northstar', role_title: 'Engineer' }],
  array_origin: { work_history: 'RESUME_EXTRACTION' },
};

function world(opts: { reserved: string | null; recordExists: boolean }) {
  const row = {
    id: 'intake-1',
    tenant_id: TENANT,
    created_by: AUTH.sub,
    review_status: 'IN_REVIEW',
    processing_status: 'READY',
    promoted_talent_record_id: null,
    save_reserved_talent_record_id: opts.reserved,
    save_evidence_materialized_at: opts.reserved !== null ? new Date() : null,
    review_payload: PAYLOAD,
    version: 3,
  };
  const talentExtraction = {
    findTalentIntakeDraftById: vi.fn(async () => row),
    saveTalentIntakeDraftReview: vi.fn(async () => 1),
  };
  const talentRecord = {
    findById: vi.fn(async (a: { id: string }) => (opts.recordExists ? { id: a.id } : null)),
    findActiveDuplicate: vi.fn(async () => null),
  };
  const svc = new TalentIntakeService({} as never, talentExtraction as never, talentRecord as never);
  // The read-model composition is not under test here.
  vi.spyOn(svc as unknown as { buildView: () => unknown }, 'buildView').mockResolvedValue({ id: 'intake-1' });
  return { svc, talentExtraction, talentRecord };
}

const editWorkHistory = {
  review: { fields: {}, work_history: [{ employer_name: 'Northstar', role_title: 'Staff Engineer' }] },
  expected_version: 3,
};

describe('ATI-SEP-1 D6 — draft edits after the Save created the Talent', () => {
  it('record exists + an array edit → 409 INTAKE_DRAFT_SAVED_EDIT_ON_TALENT { talent_record_id }, nothing written', async () => {
    const w = world({ reserved: 'talent-9', recordExists: true });
    await expect(w.svc.patchReview(AUTH, 'intake-1', editWorkHistory as never, 'rq')).rejects.toMatchObject({
      statusCode: 409,
      code: 'INTAKE_DRAFT_SAVED_EDIT_ON_TALENT',
      context: { details: { reason: 'saved_edit_on_talent', talent_record_id: 'talent-9' } },
    });
    expect(w.talentExtraction.saveTalentIntakeDraftReview).not.toHaveBeenCalled();
  });

  it('record exists + a scalar value edit → 409 as well (it could no longer reach the Talent)', async () => {
    const w = world({ reserved: 'talent-9', recordExists: true });
    const body = { review: { fields: { first_name: { value: 'Umi', origin: 'RECRUITER' } } }, expected_version: 3 };
    await expect(w.svc.patchReview(AUTH, 'intake-1', body as never, 'rq')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('record exists + an unchanged autosave → accepted (no spurious refusal)', async () => {
    const w = world({ reserved: 'talent-9', recordExists: true });
    const body = { review: { fields: { first_name: { value: 'Uma', origin: 'RECRUITER' } } }, expected_version: 3 };
    await w.svc.patchReview(AUTH, 'intake-1', body as never, 'rq');
    expect(w.talentExtraction.saveTalentIntakeDraftReview).toHaveBeenCalledTimes(1);
  });

  it('reserved but the record NOT yet created → the edit is accepted (the resumed Save re-materializes it)', async () => {
    const w = world({ reserved: 'talent-9', recordExists: false });
    await w.svc.patchReview(AUTH, 'intake-1', editWorkHistory as never, 'rq');
    expect(w.talentRecord.findById).toHaveBeenCalledWith({ tenant_id: TENANT, id: 'talent-9' });
    expect(w.talentExtraction.saveTalentIntakeDraftReview).toHaveBeenCalledTimes(1);
  });

  it('no Save started → no record lookup at all', async () => {
    const w = world({ reserved: null, recordExists: false });
    await w.svc.patchReview(AUTH, 'intake-1', editWorkHistory as never, 'rq');
    expect(w.talentRecord.findById).not.toHaveBeenCalled();
    expect(w.talentExtraction.saveTalentIntakeDraftReview).toHaveBeenCalledTimes(1);
  });

  it('reviewValuesChanged ignores origin-only changes and object key order', () => {
    expect(
      reviewValuesChanged(PAYLOAD, {
        fields: { first_name: { value: 'Uma', origin: 'RESUME_EXTRACTION' } },
        work_history: [{ role_title: 'Engineer', employer_name: 'Northstar' }],
      }),
    ).toBe(false);
    expect(reviewValuesChanged(PAYLOAD, { fields: PAYLOAD.fields as never, work_history: [] })).toBe(true);
  });
});
