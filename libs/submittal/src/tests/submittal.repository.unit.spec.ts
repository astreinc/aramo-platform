import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvidenceRepository } from '@aramo/evidence';

import type { CreateSubmittalInput } from '../lib/dto/talent-submittal-record.view.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SubmittalRepository } from '../lib/submittal.repository.js';

// M4 PR-3 §4.11 — unit spec for SubmittalRepository.
//
// Mocks EvidenceRepository.buildPackage + Prisma create. Asserts the
// orchestration:
//   1. createSubmittal calls buildPackage with the input forwarded
//      (with id=generated evidence_package_id).
//   2. createSubmittal writes a TalentSubmittalRecord row with
//      state='draft', pinned_examination_id from input.examination_id,
//      evidence_package_id from step 1.
//   3. justification + failed_criterion_acknowledgments persist
//      verbatim when provided.
//   4. When buildPackage throws (Stretch / NOT_FOUND), no submittal row
//      is written.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const RECRUITER_ID = '00000000-0000-7000-8000-000000000bb1';

function makeInput(overrides: Partial<CreateSubmittalInput> = {}): CreateSubmittalInput {
  return {
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    examination_id: EXAM_ID,
    created_by: RECRUITER_ID,
    talent_identity: {
      full_name: 'Sample Talent',
      preferred_name: 'Sam',
      location: 'Remote (US)',
    },
    contact_summary: { contact_available: true, channels_verified: ['email'] },
    capability_summary_overrides: {
      key_work_history: [
        { employer_name: 'Acme', role_title: 'Senior Engineer', start_date: '2021-01-01' },
      ],
    },
    recruiter_contribution: {
      conversation_summary: { recruiter_summary: 'Discussed role.' },
      talent_confirmed: { spoken_to_recruiter: true },
    },
    ...overrides,
  };
}

interface MockPrisma {
  talentSubmittalRecord: { create: ReturnType<typeof vi.fn> };
}

describe('SubmittalRepository.createSubmittal (unit)', () => {
  let create: ReturnType<typeof vi.fn>;
  let buildPackage: ReturnType<typeof vi.fn>;
  let repo: SubmittalRepository;

  beforeEach(() => {
    create = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      created_at: new Date('2026-05-23T12:00:00Z'),
      confirmed_at: null,
      justification: data['justification'] ?? null,
      failed_criterion_acknowledgments: data['failed_criterion_acknowledgments'] ?? null,
    }));
    buildPackage = vi.fn().mockResolvedValue({ id: 'package-id-1' });
    const mockPrisma: MockPrisma = { talentSubmittalRecord: { create } };
    const mockEvidence = { buildPackage } as unknown as EvidenceRepository;
    repo = new SubmittalRepository(mockPrisma as unknown as PrismaService, mockEvidence);
  });

  it('1. successful create forwards input to buildPackage and writes draft submittal', async () => {
    const view = await repo.createSubmittal(makeInput());
    expect(buildPackage).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.state).toBe('draft');
    expect(view.tenant_id).toBe(TENANT_A);
    expect(view.talent_id).toBe(TALENT_A);
    expect(view.pinned_examination_id).toBe(EXAM_ID);
    expect(view.confirmed_at).toBeNull();
  });

  it('2. evidence_package_id flows from generated UUID into submittal row', async () => {
    const view = await repo.createSubmittal(makeInput());
    const buildPackageArg = buildPackage.mock.calls[0]?.[0] as { id: string };
    expect(buildPackageArg.id).toBe(view.evidence_package_id);
  });

  it('3. justification + failed_criterion_acknowledgments persist verbatim', async () => {
    const fca = [
      {
        criterion: 'rate_within_band',
        field_path: 'talent_rate.min_rate',
        observed_value: '150',
        expected_threshold: '<=180',
        acknowledged: true,
      },
    ];
    const view = await repo.createSubmittal(
      makeInput({
        justification: 'Strong soft skills despite missing certification',
        failed_criterion_acknowledgments: fca,
      }),
    );
    expect(view.justification).toBe('Strong soft skills despite missing certification');
    expect(view.failed_criterion_acknowledgments).toEqual(fca);
  });

  it('4. when buildPackage throws, no submittal row is written', async () => {
    buildPackage.mockRejectedValue(new Error('SUBMITTAL_STRETCH_BLOCKED'));
    await expect(repo.createSubmittal(makeInput())).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('5. justification absent → persisted as null', async () => {
    const view = await repo.createSubmittal(makeInput());
    expect(view.justification).toBeNull();
    expect(view.failed_criterion_acknowledgments).toBeNull();
  });
});
