import type { GoldenProfileContent } from '@aramo/job-domain';
import { describe, expect, it, vi } from 'vitest';

import { RequisitionProfileService } from '../lib/requisition-profile.service.js';

// Gate-1 G1-B keying correction — confirmProfile shared-UUID alignment
// (service tier). The RULED axis: Job.id = GoldenProfile.job_id =
// examination.job_id = the ATS requisition id (R). This spec proves the
// three load-bearing facts of the mint seam:
//
//   1. MINT-R — on a fresh confirm (golden_profile_id === null) the seam
//      mints Job.id = R and GoldenProfile.job_id = R (R === the ATS
//      requisition id passed in), NOT a random J. The examine loop keys
//      examination.job_id = golden.job_id, so this is what lands the
//      minted examination on R and makes it FE-visible via GET matches.
//   2. REQUISITION MIRROR — the seam also creates the job-domain
//      Requisition the Live List resolves through: id = R, job_id = R,
//      state = 'active', recruiter_id non-null (from the ATS req, falling
//      back to the confirming actor).
//   3. IDEMPOTENT — the defensive re-mint / re-confirm path is skip-if-
//      exists: when Job R / Requisition R already exist, createJob /
//      createRequisition are NOT called again (no PK conflict).

const REQUEST_ID = 'req-test-g1b-keying-correction';
const TENANT = '11111111-1111-1111-1111-111111111111';
const REQ_ID = '22222222-2222-2222-2222-222222222222'; // R — the ATS requisition id
const GP_ID = '33333333-3333-3333-3333-333333333333';
const RECRUITER_ID = '44444444-4444-4444-4444-444444444444';
const ACTOR_ID = '55555555-5555-5555-5555-555555555555';

const VISIBILITY = { kind: 'all', actor_user_id: ACTOR_ID } as never;

const MANUAL_CONTENT: GoldenProfileContent = {
  role_family: 'software_engineering',
  seniority_level: 'senior',
  jd_text: 'Senior backend engineer.',
  generated_by: 'manual',
  required_skills: [{ name: 'TypeScript' }],
  preferred_skills: [{ name: 'PostgreSQL' }],
  critical_skills: [{ name: 'TypeScript' }],
  experience: { industries: [] },
  constraints: {},
};

type Repos = {
  findByIdForActor: ReturnType<typeof vi.fn>;
  stampGoldenProfileId: ReturnType<typeof vi.fn>;
  findJobById: ReturnType<typeof vi.fn>;
  createJob: ReturnType<typeof vi.fn>;
  findRequisitionById: ReturnType<typeof vi.fn>;
  createRequisition: ReturnType<typeof vi.fn>;
  createGoldenProfile: ReturnType<typeof vi.fn>;
  updateGoldenProfile: ReturnType<typeof vi.fn>;
};

function makeService(overrides: Partial<Repos> = {}): {
  svc: RequisitionProfileService;
  repos: Repos;
} {
  const view = {
    id: REQ_ID,
    tenant_id: TENANT,
    golden_profile_id: null,
    recruiter_id: RECRUITER_ID,
    owner_id: null,
    entered_by_id: null,
  };
  const repos: Repos = {
    findByIdForActor: vi.fn().mockResolvedValue(view),
    stampGoldenProfileId: vi
      .fn()
      .mockImplementation(async (a: { golden_profile_id: string }) => ({
        ...view,
        golden_profile_id: a.golden_profile_id,
      })),
    findJobById: vi.fn().mockResolvedValue(null),
    createJob: vi.fn().mockResolvedValue({ id: REQ_ID }),
    findRequisitionById: vi.fn().mockResolvedValue(null),
    createRequisition: vi.fn().mockResolvedValue({ id: REQ_ID }),
    createGoldenProfile: vi.fn().mockResolvedValue({ id: GP_ID }),
    updateGoldenProfile: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  const requisitionRepository = {
    findByIdForActor: repos.findByIdForActor,
    stampGoldenProfileId: repos.stampGoldenProfileId,
  } as never;
  const jobDomainRepository = {
    findJobById: repos.findJobById,
    createJob: repos.createJob,
    findRequisitionById: repos.findRequisitionById,
    createRequisition: repos.createRequisition,
    createGoldenProfile: repos.createGoldenProfile,
    updateGoldenProfile: repos.updateGoldenProfile,
  } as never;
  const aiDraftService = {} as never;
  const svc = new RequisitionProfileService(
    aiDraftService,
    requisitionRepository,
    jobDomainRepository,
  );
  return { svc, repos };
}

function confirm(svc: RequisitionProfileService) {
  return svc.confirmProfile({
    tenant_id: TENANT,
    requisition_id: REQ_ID,
    jd_text: MANUAL_CONTENT.jd_text,
    golden_profile: MANUAL_CONTENT,
    visibility: VISIBILITY,
    requestId: REQUEST_ID,
  });
}

describe('G1-B keying correction — confirmProfile shared-UUID alignment', () => {
  it('mints Job.id = R and GoldenProfile.job_id = R (not a random J)', async () => {
    const { svc, repos } = makeService();
    await confirm(svc);

    expect(repos.createJob).toHaveBeenCalledOnce();
    expect(repos.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: REQ_ID, tenant_id: TENANT }),
    );
    expect(repos.createGoldenProfile).toHaveBeenCalledOnce();
    expect(repos.createGoldenProfile).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: REQ_ID, tenant_id: TENANT }),
    );
  });

  it('creates the active job-domain Requisition mirror (id = R, job_id = R)', async () => {
    const { svc, repos } = makeService();
    await confirm(svc);

    expect(repos.createRequisition).toHaveBeenCalledOnce();
    expect(repos.createRequisition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REQ_ID,
        job_id: REQ_ID,
        tenant_id: TENANT,
        state: 'active',
        recruiter_id: RECRUITER_ID,
      }),
    );
  });

  it('recruiter_id falls back to the confirming actor when the req has none', async () => {
    const view = {
      id: REQ_ID,
      tenant_id: TENANT,
      golden_profile_id: null,
      recruiter_id: null,
      owner_id: null,
      entered_by_id: null,
    };
    const { svc, repos } = makeService({
      findByIdForActor: vi.fn().mockResolvedValue(view),
    });
    await confirm(svc);

    expect(repos.createRequisition).toHaveBeenCalledWith(
      expect.objectContaining({ recruiter_id: ACTOR_ID }),
    );
  });

  it('is idempotent — Job R / Requisition R already present → no re-create (skip-if-exists)', async () => {
    const { svc, repos } = makeService({
      findJobById: vi.fn().mockResolvedValue({ id: REQ_ID }),
      findRequisitionById: vi.fn().mockResolvedValue({ id: REQ_ID }),
    });
    await confirm(svc);

    expect(repos.createJob).not.toHaveBeenCalled();
    expect(repos.createRequisition).not.toHaveBeenCalled();
    // The GoldenProfile is still minted + stamped (the defensive re-mint path).
    expect(repos.createGoldenProfile).toHaveBeenCalledOnce();
    expect(repos.stampGoldenProfileId).toHaveBeenCalledOnce();
  });

  it('re-confirm with an existing golden_profile_id UPDATEs in place — no mint', async () => {
    const view = {
      id: REQ_ID,
      tenant_id: TENANT,
      golden_profile_id: GP_ID,
      recruiter_id: RECRUITER_ID,
      owner_id: null,
      entered_by_id: null,
    };
    const { svc, repos } = makeService({
      findByIdForActor: vi.fn().mockResolvedValue(view),
      updateGoldenProfile: vi.fn().mockResolvedValue({ id: GP_ID }),
    });
    await confirm(svc);

    expect(repos.updateGoldenProfile).toHaveBeenCalledOnce();
    expect(repos.createJob).not.toHaveBeenCalled();
    expect(repos.createRequisition).not.toHaveBeenCalled();
    expect(repos.createGoldenProfile).not.toHaveBeenCalled();
  });
});
