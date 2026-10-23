import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';

// ATI-SEP-1 A2 (Addendum A2 A-a) — Draft → Human Review → SAVE, unit level. A
// stateful in-memory world stands in for the two stores so the ordering,
// validation-first, dedupe and resume-after-failure contracts are exercised
// exactly as the service drives them. The real-database proof (one record, one
// talent.created, no duplicated evidence, concurrency) is the
// ati-sep-1-intake-save.integration.spec.ts.

const TENANT = '11111111-1111-7111-8111-111111111111';
const AUTH = { tenant_id: TENANT, sub: 'actor-1', consumer_type: 'recruiter' } as unknown as AuthContextType;

const ADMISSIBLE: Record<string, string> = {
  first_name: 'Uma',
  last_name: 'Maheshwari',
  email1: 'uma@example.com',
  phone_cell: '(571) 435-5777',
};

function review(fields: Record<string, unknown>) {
  return {
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, origin: 'RECRUITER' }])),
    work_history: [{ employer_name: 'Northstar', role_title: 'Engineer', source_refs: ['B1'] }],
  };
}

type Step = 'materialize' | 'create' | 'workAuth' | 'complete';

function world(opts: {
  fields?: Record<string, unknown>;
  duplicate?: { id: string; reason: 'email' | 'phone' } | null;
  failOnce?: Step;
  storageKey?: string | null;
} = {}) {
  const state = {
    reserved: null as string | null,
    materializedAt: null as Date | null,
    promoted: null as string | null,
    records: new Map<string, { id: string }>(),
    evidenceWrites: 0,
    workAuthIds: new Set<string>(),
  };
  const failed = new Set<Step>();
  const maybeFail = (step: Step): void => {
    if (opts.failOnce === step && !failed.has(step)) {
      failed.add(step);
      throw new Error(`injected ${step} failure`);
    }
  };
  const intake = () => ({
    id: 'intake-1',
    tenant_id: TENANT,
    created_by: AUTH.sub,
    source_type: 'RESUME_UPLOAD',
    storage_key: opts.storageKey === undefined ? 't/intake-1/r.pdf' : opts.storageKey,
    source_filename: 'r.pdf',
    mime_type: 'application/pdf',
    size_bytes: 10,
    artifact_sha256: 'sha-1',
    resume_extraction_draft_id: null,
    review_status: state.promoted !== null ? 'PROMOTED' : 'IN_REVIEW',
    promoted_talent_record_id: state.promoted,
    save_reserved_talent_record_id: state.reserved,
    save_evidence_materialized_at: state.materializedAt,
    review_payload: review(opts.fields ?? ADMISSIBLE),
  });
  const talentExtraction = {
    findTalentIntakeDraftById: vi.fn(async () => intake()),
    reserveTalentIntakeDraftSave: vi.fn(async (i: { reserved_talent_record_id: string }) => {
      if (state.reserved !== null) return 0;
      state.reserved = i.reserved_talent_record_id;
      return 1;
    }),
    materializeIntakeSaveEvidence: vi.fn(async (i: { talent_id: string }) => {
      maybeFail('materialize');
      if (state.materializedAt !== null || i.talent_id !== state.reserved) {
        return { materialized: false, document_id: null, edition_id: null };
      }
      state.materializedAt = new Date();
      state.evidenceWrites += 1;
      return { materialized: true, document_id: 'doc-1', edition_id: null };
    }),
    getDefaultResumeEdition: vi.fn(async () => null),
    recordDeclaredWorkAuthorization: vi.fn(async (i: { id: string }) => {
      maybeFail('workAuth');
      state.workAuthIds.add(i.id);
    }),
    completeTalentIntakeDraftSave: vi.fn(async (i: { talent_record_id: string }) => {
      maybeFail('complete');
      if (state.reserved !== i.talent_record_id) return 0;
      state.promoted = i.talent_record_id;
      return 1;
    }),
  };
  const repo = {
    findById: vi.fn(async (a: { id: string }) => state.records.get(a.id) ?? null),
    findActiveDuplicate: vi.fn(async () => opts.duplicate ?? null),
    create: vi.fn(async (a: { id: string }) => {
      maybeFail('create');
      const rec = { id: a.id };
      state.records.set(a.id, rec);
      return rec;
    }),
  };
  const svc = new TalentIntakePromotionService(talentExtraction as never, repo as never);
  return { svc, state, talentExtraction, repo };
}

describe('ATI-SEP-1 A2 — intake Save (unit)', () => {
  it('happy path: reserve → evidence → record (reserved id, dedupe, talent.created context) → PROMOTED last', async () => {
    const w = world({ fields: { ...ADMISSIBLE, work_authorization: 'US_CITIZEN' } });
    const rec = await w.svc.promote(AUTH, 'intake-1', 'rq-1');

    expect(rec.id).toBe(w.state.reserved);
    expect(w.state.promoted).toBe(rec.id);
    expect(w.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: rec.id, dedupe: true, event: expect.objectContaining({ intake_draft_id: 'intake-1' }) }),
    );
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] as number;
    expect(order(w.talentExtraction.reserveTalentIntakeDraftSave)).toBeLessThan(order(w.talentExtraction.materializeIntakeSaveEvidence));
    expect(order(w.talentExtraction.materializeIntakeSaveEvidence)).toBeLessThan(order(w.repo.create));
    expect(order(w.repo.create)).toBeLessThan(order(w.talentExtraction.recordDeclaredWorkAuthorization));
    expect(order(w.talentExtraction.recordDeclaredWorkAuthorization)).toBeLessThan(
      order(w.talentExtraction.completeTalentIntakeDraftSave),
    );
  });

  it('VALIDATION FIRST: an out-of-vocabulary stated field → 400, nothing reserved or written, draft re-savable', async () => {
    const w = world({ fields: { ...ADMISSIBLE, availability_status: 'whenever' } });
    await expect(w.svc.promote(AUTH, 'intake-1', 'rq-1')).rejects.toMatchObject({ statusCode: 400 });
    expect(w.talentExtraction.reserveTalentIntakeDraftSave).not.toHaveBeenCalled();
    expect(w.talentExtraction.materializeIntakeSaveEvidence).not.toHaveBeenCalled();
    expect(w.repo.create).not.toHaveBeenCalled();
    expect(w.state.promoted).toBeNull();
  });

  it('VALIDATION FIRST: an unparseable date_available → 400 (the pre-A2 stuck-PROMOTED trigger)', async () => {
    const w = world({ fields: { ...ADMISSIBLE, date_available: 'next spring' } });
    await expect(w.svc.promote(AUTH, 'intake-1', 'rq-1')).rejects.toMatchObject({
      statusCode: 400,
      context: { details: { field: 'date_available' } },
    });
    expect(w.state.reserved).toBeNull();
    expect(w.state.promoted).toBeNull();
  });

  it('missing admission field → 422 field-keyed, no state change', async () => {
    const { phone_cell: _omit, ...noPhone } = ADMISSIBLE;
    const w = world({ fields: noPhone });
    await expect(w.svc.promote(AUTH, 'intake-1', 'rq-1')).rejects.toMatchObject({
      statusCode: 422,
      context: { details: { missing: ['phone_cell'] } },
    });
    expect(w.state.reserved).toBeNull();
  });

  it('cell-phone duplicate → 409 TALENT_RECORD_DUPLICATE { reason: phone } before any reservation', async () => {
    const w = world({ duplicate: { id: 'someone-else', reason: 'phone' } });
    await expect(w.svc.promote(AUTH, 'intake-1', 'rq-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'TALENT_RECORD_DUPLICATE',
      context: { details: { reason: 'phone', existing_id: 'someone-else' } },
    });
    expect(w.state.reserved).toBeNull();
  });

  for (const step of ['materialize', 'create', 'workAuth', 'complete'] as const) {
    it(`injected failure at ${step} → draft NOT promoted; re-Save resumes on the SAME id → one record, evidence once`, async () => {
      const w = world({ failOnce: step, fields: { ...ADMISSIBLE, work_authorization: 'US_CITIZEN' } });
      await expect(w.svc.promote(AUTH, 'intake-1', 'rq-1')).rejects.toThrow(`injected ${step} failure`);
      expect(w.state.promoted).toBeNull(); // never PROMOTED without every step
      const reservedAfterFailure = w.state.reserved;

      const rec = await w.svc.promote(AUTH, 'intake-1', 'rq-2');
      expect(rec.id).toBe(reservedAfterFailure);
      expect(w.state.promoted).toBe(rec.id);
      expect(w.state.records.size).toBe(1);
      expect(w.state.evidenceWrites).toBe(1);
      expect(w.state.workAuthIds.size).toBe(1);
    });
  }

  it('replay of a saved draft returns the record and writes nothing', async () => {
    const w = world();
    const first = await w.svc.promote(AUTH, 'intake-1', 'rq-1');
    w.repo.create.mockClear();
    w.talentExtraction.materializeIntakeSaveEvidence.mockClear();
    const again = await w.svc.promote(AUTH, 'intake-1', 'rq-2');
    expect(again).toEqual(first);
    expect(w.repo.create).not.toHaveBeenCalled();
    expect(w.talentExtraction.materializeIntakeSaveEvidence).not.toHaveBeenCalled();
  });

  it('a non-upload source saves with no résumé document', async () => {
    const w = world({ storageKey: null });
    await w.svc.promote(AUTH, 'intake-1', 'rq-1');
    expect(w.talentExtraction.materializeIntakeSaveEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ resume_document: null }),
    );
  });

  it('lost reservation race → resumes on the winner id (no second reservation)', async () => {
    const w = world();
    w.talentExtraction.reserveTalentIntakeDraftSave.mockImplementationOnce(async () => {
      w.state.reserved = 'winner-id';
      return 0;
    });
    const rec = await w.svc.promote(AUTH, 'intake-1', 'rq-1');
    expect(rec.id).toBe('winner-id');
  });
});
