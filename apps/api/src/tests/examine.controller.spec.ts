import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, REQUIRES_SITE_MATCH_KEY } from '@aramo/authorization';
import { REQUIRED_CAPABILITIES_KEY } from '@aramo/entitlement';

import { ExamineController } from '../controllers/examine.controller.js';

// Gate-1 G1-B — examine controller orchestration (mocked deps). Proves the
// LAZY + IDEMPOTENT extraction guard (exists-check, not upsert), the sync mint
// via evaluateAndPersist, shared-UUID keying (job_id = GoldenProfile.job_id), and
// the auth / 404 / 422 error surface. The deterministic derivation itself is
// covered by derive-matching-input.spec.ts; the DB wiring by AppModule boot in
// the integration suite.
//
// INC-1a (TIP-E2E) — authorization hardening negative controls:
//   - requisition actor-visibility: findByIdForActor returns null for an
//     out-of-visibility requisition → 404 (Ruling 2: never 403).
//   - server-resolved site: a site-scoped principal examining a requisition in a
//     DIFFERENT site → 403; same-site or tenant-wide (null site claim) proceeds.
// The tenant-capability (@RequireCapability('ats')), scope
// (@RequireScopes('examination:create')) and site-decorator (@RequireSiteMatch)
// axes are ENFORCED at runtime by the guard chain (EntitlementGuard/RolesGuard),
// which is exercised end-to-end by the PG integration suite. The DECORATOR
// METADATA those guards read is asserted directly below (INC-1a guard-metadata
// controls) so a missing/weakened capability or scope is caught at unit speed.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const GP = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const JOB = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

function recruiterAuth(over: Record<string, unknown> = {}): AuthContextType {
  return {
    sub: TALENT,
    tenant_id: TENANT,
    consumer_type: 'recruiter',
    scopes: ['examination:create'],
    site_id: null,
    ...over,
  } as unknown as AuthContextType;
}

// INC-1a — req.resolveVisibility() is attached by the global VisibilityInterceptor;
// the controller passes its result opaquely to findByIdForActor (mocked here), so
// a minimal fake suffices for the unit.
function reqFake() {
  return { resolveVisibility: vi.fn().mockResolvedValue({ actor_user_id: TALENT, scopes: ['examination:create'] }) } as never;
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
    findResumeRedactedText: vi.fn().mockResolvedValue('Redacted resume body. Skills: aws, postgresql.'),
  };
  // INC-1a — visibility-gated read (replaces findByIdAdmin). The RequisitionView
  // projection is identical, so golden_profile_id + site_id are preserved.
  const requisitionRepository = {
    findByIdForActor: vi.fn().mockResolvedValue(
      opts.requisition === undefined ? { id: REQ, golden_profile_id: GP, site_id: null } : opts.requisition,
    ),
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
  const talentExtractionService = {
    extractDeclaredEvidence: extract,
  };
  const matchingService = { evaluateAndPersist };
  const canonicalMatchShadow = { observe: vi.fn().mockResolvedValue(0) };
  const ctl = new ExamineController(
    talentRecordRepository as never,
    requisitionRepository as never,
    jobDomainRepository as never,
    talentEvidenceRepository as never,
    talentExtractionService as never,
    matchingService as never,
    canonicalMatchShadow as never,
  );
  return { ctl, extract, evaluateAndPersist, talentEvidenceRepository, talentRecordRepository, requisitionRepository, canonicalMatchShadow };
}

describe('ExamineController — mint + lazy/idempotent orchestration', () => {
  it('no declared evidence → runs extraction (lazy), then mints; shared-UUID keying job_id = GoldenProfile.job_id', async () => {
    const { ctl, extract, evaluateAndPersist } = make({ evidenceCount: 0 });
    const res = await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq-1', reqFake());
    expect(extract).toHaveBeenCalledTimes(1);
    expect(evaluateAndPersist).toHaveBeenCalledTimes(1);
    expect(res.job_id).toBe(JOB);
    expect(res.examination_id).toBe('exam-1');
    expect(res.tier).toBe('WORTH_CONSIDERING');
    expect(res.live_list_visible).toBe(true);
  });

  it('IDEMPOTENT: declared evidence already exists → extraction SKIPPED (guard is the exists-check, not an upsert)', async () => {
    const { ctl, extract, evaluateAndPersist } = make({ evidenceCount: 3 });
    await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq-2', reqFake());
    expect(extract).not.toHaveBeenCalled();
    expect(evaluateAndPersist).toHaveBeenCalledTimes(1);
  });

  it('ATI-SEP-1 T10 WP1 — no trust-ledger routing: the controller takes no legacy projection dependency', () => {
    const src = readFileSync(resolve(__dirname, '../controllers/examine.controller.ts'), 'utf8');
    expect(src).not.toContain('LegacyTrustProjection');
    expect(src).not.toContain('routeDeclaredEvidenceToLedger');
  });

  it('passes resume redacted_text + key_skills into extraction', async () => {
    const { ctl, extract } = make({ evidenceCount: 0 });
    await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq-3', reqFake());
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, talent_id: TALENT, resume_text: expect.any(String), key_skills: 'aws, postgresql' }),
    );
  });
});

describe('ExamineController — auth + not-found + validation', () => {
  it('non-recruiter consumer → 403', async () => {
    const { ctl } = make({});
    const auth = recruiterAuth({ consumer_type: 'portal' });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, auth, 'rq', reqFake())).rejects.toMatchObject({ statusCode: 403 });
  });

  it('bad UUID → 400', async () => {
    const { ctl } = make({});
    await expect(ctl.examine({ talent_id: 'nope', requisition_id: REQ }, recruiterAuth(), 'rq', reqFake())).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requisition not found → 404', async () => {
    const { ctl } = make({ requisition: null });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq', reqFake())).rejects.toMatchObject({ statusCode: 404 });
  });

  it('requisition without a confirmed Golden Profile → 422', async () => {
    const { ctl } = make({ requisition: { id: REQ, golden_profile_id: null, site_id: null } });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq', reqFake())).rejects.toMatchObject({ statusCode: 422 });
  });

  it('golden profile role_family invalid → 422', async () => {
    const { ctl } = make({ goldenProfile: golden({ skills: { role_family: 'wizard' } }) });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq', reqFake())).rejects.toMatchObject({ statusCode: 422 });
  });

  it('talent not found → 404', async () => {
    const { ctl } = make({ talent: null });
    await expect(ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq', reqFake())).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('ExamineController — INC-1a authorization hardening (negative controls)', () => {
  it('out-of-visibility requisition (findByIdForActor → null) → 404, never 403 (Ruling 2)', async () => {
    const { ctl, requisitionRepository } = make({ requisition: null });
    await expect(
      ctl.examine({ talent_id: TALENT, requisition_id: REQ }, recruiterAuth(), 'rq', reqFake()),
    ).rejects.toMatchObject({ statusCode: 404 });
    // The visibility-scoped read was used (not an admin/tenant-floor read).
    expect(requisitionRepository.findByIdForActor).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, id: REQ, visibility: expect.anything() }),
    );
  });

  it('cross-site: site-scoped actor + requisition in a DIFFERENT site → 403', async () => {
    const { ctl } = make({ requisition: { id: REQ, golden_profile_id: GP, site_id: 'site-B' } });
    const auth = recruiterAuth({ site_id: 'site-A' });
    await expect(
      ctl.examine({ talent_id: TALENT, requisition_id: REQ }, auth, 'rq', reqFake()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('same-site: site-scoped actor + requisition in the SAME site → proceeds (mints)', async () => {
    const { ctl, evaluateAndPersist } = make({ requisition: { id: REQ, golden_profile_id: GP, site_id: 'site-A' } });
    const auth = recruiterAuth({ site_id: 'site-A' });
    const res = await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, auth, 'rq', reqFake());
    expect(res.examination_id).toBe('exam-1');
    expect(evaluateAndPersist).toHaveBeenCalledTimes(1);
  });

  it('tenant-wide principal (null site claim) is admitted on any requisition site', async () => {
    const { ctl, evaluateAndPersist } = make({ requisition: { id: REQ, golden_profile_id: GP, site_id: 'site-Z' } });
    const auth = recruiterAuth({ site_id: null });
    const res = await ctl.examine({ talent_id: TALENT, requisition_id: REQ }, auth, 'rq', reqFake());
    expect(res.examination_id).toBe('exam-1');
    expect(evaluateAndPersist).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// INC-1a (TIP-E2E) — guard-metadata controls. The decorator values the guard
// chain (EntitlementGuard -> RolesGuard) reads MUST be present and exact; a
// missing capability or a widened/absent scope would silently open the route.
// A direct controller-method unit test bypasses the Nest guard pipeline, so the
// decorators are proven here at the metadata layer (enforcement is proven in the
// PG integration suite).
// =============================================================================
describe('ExamineController — INC-1a guard metadata (capability + scope + site)', () => {
  it('class requires the ATS tenant capability (@RequireCapability("ats"))', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, ExamineController)).toEqual(['ats']);
  });

  it('examine handler requires EXACTLY the examination:create scope', () => {
    expect(
      Reflect.getMetadata(REQUIRED_SCOPES_KEY, ExamineController.prototype.examine),
    ).toEqual(['examination:create']);
  });

  it('examine handler opts into the site axis (@RequireSiteMatch)', () => {
    expect(
      Reflect.getMetadata(REQUIRES_SITE_MATCH_KEY, ExamineController.prototype.examine),
    ).toBe(true);
  });

  it('examine scope is not widened to a blanket examination:* / read scope', () => {
    const scopes =
      (Reflect.getMetadata(REQUIRED_SCOPES_KEY, ExamineController.prototype.examine) as string[]) ??
      [];
    expect(scopes).not.toContain('examination:read');
    expect(scopes).not.toContain('examination:*');
  });
});
