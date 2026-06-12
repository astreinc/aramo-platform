import { AramoError } from '@aramo/common';
import { goldenProfileContentToStorage } from '@aramo/job-domain';
import { describe, expect, it, vi } from 'vitest';

import { RequisitionProfileService } from '../lib/requisition-profile.service.js';

// PR-A2 P3 — the profile READ path (GET /v1/requisitions/:id/profile),
// service tier. Proves the three load-bearing facts (gate §4 P3):
//   1. visibility 404 — an invisible requisition yields 404 (no profile leak)
//   2. profile-less → the empty-shaped DTO (has_profile false), NOT 404/500
//   3. reshape-on-read — jd_text + structured profile un-nested from the
//      GoldenProfile.skills Json blob (the recon C finding: it's buried)

const REQUEST_ID = 'req-test-pr-a2-profile-read';
const TENANT = '11111111-1111-1111-1111-111111111111';
const REQ_ID = '22222222-2222-2222-2222-222222222222';
const GP_ID = '33333333-3333-3333-3333-333333333333';
const VISIBILITY = { kind: 'all' } as never;

function makeService(overrides: {
  findByIdForActor: ReturnType<typeof vi.fn>;
  findGoldenProfileById?: ReturnType<typeof vi.fn>;
}): RequisitionProfileService {
  const requisitionRepository = {
    findByIdForActor: overrides.findByIdForActor,
  } as never;
  const jobDomainRepository = {
    findGoldenProfileById:
      overrides.findGoldenProfileById ?? vi.fn().mockResolvedValue(null),
  } as never;
  const aiDraftService = {} as never;
  return new RequisitionProfileService(
    aiDraftService,
    requisitionRepository,
    jobDomainRepository,
  );
}

describe('PR-A2 profile read (readProfile)', () => {
  it('invisible requisition → 404 (NOT_FOUND), no profile leak', async () => {
    const svc = makeService({
      findByIdForActor: vi.fn().mockResolvedValue(null),
    });
    await expect(
      svc.readProfile({
        tenant_id: TENANT,
        requisition_id: REQ_ID,
        visibility: VISIBILITY,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      svc.readProfile({
        tenant_id: TENANT,
        requisition_id: REQ_ID,
        visibility: VISIBILITY,
        requestId: REQUEST_ID,
      }),
    ).rejects.toBeInstanceOf(AramoError);
  });

  it('requisition with no linked profile → profile-less shape (has_profile false), not an error', async () => {
    const findGp = vi.fn();
    const svc = makeService({
      findByIdForActor: vi
        .fn()
        .mockResolvedValue({ id: REQ_ID, golden_profile_id: null }),
      findGoldenProfileById: findGp,
    });
    const out = await svc.readProfile({
      tenant_id: TENANT,
      requisition_id: REQ_ID,
      visibility: VISIBILITY,
      requestId: REQUEST_ID,
    });
    expect(out).toMatchObject({
      requisition_id: REQ_ID,
      golden_profile_id: null,
      has_profile: false,
      jd_text: '',
      generated_by: null,
      required_skills: [],
      preferred_skills: [],
      critical_skills: [],
    });
    // golden_profile_id was null → the GoldenProfile repo is never hit.
    expect(findGp).not.toHaveBeenCalled();
  });

  it('linked profile → jd_text + structured profile un-nested from the skills Json blob', async () => {
    // Round-trip through the SAME storage projection the confirm path uses,
    // proving the read reshape un-nests what the write nests.
    const storage = goldenProfileContentToStorage({
      role_family: 'backend_engineer',
      seniority_level: 'senior',
      jd_text: 'Senior backend engineer JD body.',
      generated_by: 'ai_draft',
      required_skills: [{ name: 'TypeScript', min_years: 5 }],
      preferred_skills: [{ name: 'Kafka' }],
      critical_skills: [{ name: 'TypeScript' }],
      experience: { total_years: 8, domain: 'fintech', industries: ['banking'] },
      constraints: { location: 'NYC', work_mode: 'hybrid' },
    });
    const svc = makeService({
      findByIdForActor: vi
        .fn()
        .mockResolvedValue({ id: REQ_ID, golden_profile_id: GP_ID }),
      findGoldenProfileById: vi.fn().mockResolvedValue({
        id: GP_ID,
        tenant_id: TENANT,
        job_id: 'job-1',
        skills: storage.skills,
        experience: storage.experience,
        constraints: storage.constraints,
        critical_skills: storage.critical_skills,
      }),
    });
    const out = await svc.readProfile({
      tenant_id: TENANT,
      requisition_id: REQ_ID,
      visibility: VISIBILITY,
      requestId: REQUEST_ID,
    });
    expect(out.has_profile).toBe(true);
    expect(out.golden_profile_id).toBe(GP_ID);
    expect(out.jd_text).toBe('Senior backend engineer JD body.');
    expect(out.role_family).toBe('backend_engineer');
    expect(out.seniority_level).toBe('senior');
    expect(out.generated_by).toBe('ai_draft');
    expect(out.required_skills).toEqual([{ name: 'TypeScript', min_years: 5 }]);
    expect(out.preferred_skills).toEqual([{ name: 'Kafka' }]);
    expect(out.experience).toMatchObject({ total_years: 8, domain: 'fintech' });
    expect(out.constraints).toMatchObject({ location: 'NYC', work_mode: 'hybrid' });
  });

  it('linked profile whose GoldenProfile row vanished → profile-less shape (defensive, not 500)', async () => {
    const svc = makeService({
      findByIdForActor: vi
        .fn()
        .mockResolvedValue({ id: REQ_ID, golden_profile_id: GP_ID }),
      findGoldenProfileById: vi.fn().mockResolvedValue(null),
    });
    const out = await svc.readProfile({
      tenant_id: TENANT,
      requisition_id: REQ_ID,
      visibility: VISIBILITY,
      requestId: REQUEST_ID,
    });
    expect(out.has_profile).toBe(false);
    expect(out.golden_profile_id).toBe(null);
  });
});
