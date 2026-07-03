import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { ExamineController } from '../controllers/examine.controller.js';

// Gate-1 G1-B — examine controller orchestration (mocked deps). Proves the
// LAZY + IDEMPOTENT extraction guard (exists-check, not upsert), the sync mint
// via evaluateAndPersist, shared-UUID keying (job_id = GoldenProfile.job_id), and
// the auth / 404 / 422 error surface. The deterministic derivation itself is
// covered by derive-matching-input.spec.ts; the DB wiring by AppModule boot in
// the integration suite.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const GP = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const JOB = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

function recruiterAuth(): AuthContextType {
  return { sub: TALENT, tenant_id: TENANT, consumer_type: 'recruiter', scopes: [] } as unknown as AuthContextType;
}

function talentView(over: Record<string, unknown> = {}) {
  return {
    id: TALENT, tenant_id: TENANT, city: 'Austin', state: 'TX', desired_pay: '$70/hr',
    work_authorization: 'US_CITIZEN', key_skills: 'aws, postgresql',
    email1: 'x@example.com', email2: null, phone_cell: null, phone_home: null, phone_work: null,
    ...over,
  };
}

function golden(over: Record<string, unknown> = {}) {
  return {
    id: GP, tenant_id: TENANT, job_id: JOB,
    skills: { role_family: 'backend_engineer' }, experience: {},
    constraints: {}, critical_skills: ['AWS', 'PostgreSQL'],
    ...over,
  };
}

function make(opts: {
  evidenceCount?: number;
  requisition?: unknown;
  goldenProfile?: unknown;
  talent?: unknown;
}) {
  const extract = vi.fn().mockResolvedValue({ skill_evidence_ids: ['s1', 's2'], work_history_ids: [], rejected_count: 0 });
  const evaluateAndPersist = vi.fn().mockResolvedValue({ id: 'exam-1', job_id: JOB, golden_profile_id: GP, tier: 'WORTH_CONSIDERING' });
  const talentRecordRepository = {
    findById: vi.fn().mockResolvedValue(opts.talent === undefined ? talentView() : opts.talent),
    findResumeRedactedText: vi.fn().mockResolvedValue('Redacted résumé body. Skills: aws, postgresql.'),
  };
  const requisitionRepository = {
    findByIdAdmin: vi.fn().mockResolvedValue(opts.requisition === undefined ? { id: REQ, golden_profile_id: GP } : opts.requisition),
  };
  const jobDomainRepository = {
    findGoldenProfileById: vi.fn().mockResolvedValue(opts.goldenProfile === undefined ? golden() : opts.goldenProfile),
  };
  const talentEvidenceRepository = {
    countTalentSkillEvidenceByTalent: vi.fn().mockResolvedValue(opts.evidenceCount ?? 0),
    findTalentSkillEvidenceByTalent: vi.fn().mockResolvedValue([
      { surface_form: 'aws', source: 'declared', skill_id: 's1' },
      { surface_form: 'postgresql', source: 'declared', skill_id: 's2' },
    ]),
  };
  const talentExtractionService = { extractDeclaredEvidence: extract };
  const matchingService = { evaluateAndPersist };
  const ctl = new ExamineController(
    talentRecordRepository as never,
    requisitionRepository as never,
    jobDomainRepository as never,
    talentEvidenceRepository as never,
    talentExtractionService as never,
    matchingService as never,
  );
  return { ctl, extract, evaluateAndPersist, talentEvidenceRepository, talentRecordRepository };
}

describe('ExamineController — mint + lazy/idempotent orchestration', () => {
  it('no declared evidence → runs extraction (lazy), then mints; shared-UUID keying job_id = GoldenProfile.job_id', async () => {
    const { ctl, extract, evaluateAndPersist } = make({ evidenceCount: 0 });
    const res = await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq-1');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(evaluateAndPersist).toHaveBeenCalledTimes(1);
    expect(res.job_id).toBe(JOB);
    expect(res.examination_id).toBe('exam-1');
    expect(res.tier).toBe('WORTH_CONSIDERING');
    // G1-B keying correction — under shared-UUID alignment the minted
    // examination IS visible via GET /v1/jobs/:id/matches.
    expect(res.live_list_visible).toBe(true);
  });

  it('IDEMPOTENT: declared evidence already exists → extraction SKIPPED (guard is the exists-check, not an upsert)', async () => {
    const { ctl, extract, evaluateAndPersist } = make({ evidenceCount: 3 });
    await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq-2');
    expect(extract).not.toHaveBeenCalled();
    expect(evaluateAndPersist).toHaveBeenCalledTimes(1);
  });

  it('passes resume redacted_text + key_skills into extraction', async () => {
    const { ctl, extract } = make({ evidenceCount: 0 });
    await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq-3');
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, talent_id: TALENT, resume_text: expect.any(String), key_skills: 'aws, postgresql' }),
    );
  });
});

describe('ExamineController — auth + not-found + validation', () => {
  it('non-recruiter consumer → 403', async () => {
    const { ctl } = make({});
    const auth = { ...recruiterAuth(), consumer_type: 'portal' } as unknown as AuthContextType;
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, auth, 'rq')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('bad UUID → 400', async () => {
    const { ctl } = make({});
    await expect(ctl.examine({ talent_id: 'nope', requisition_id: REQ }, recruiterAuth(), 'rq')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requisition not found → 404', async () => {
    const { ctl } = make({ requisition: null });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('requisition without a confirmed Golden Profile → 422', async () => {
    const { ctl } = make({ requisition: { id: REQ, golden_profile_id: null } });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq')).rejects.toMatchObject({ statusCode: 422 });
  });

  it('golden profile role_family invalid → 422', async () => {
    const { ctl } = make({ goldenProfile: golden({ skills: { role_family: 'wizard' } }) });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq')).rejects.toMatchObject({ statusCode: 422 });
  });

  it('talent not found → 404', async () => {
    const { ctl } = make({ talent: null });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq')).rejects.toMatchObject({ statusCode: 404 });
  });
});
