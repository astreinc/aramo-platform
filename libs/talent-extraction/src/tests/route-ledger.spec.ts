import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';

// TR-4 B2 (§5c/§5d) — the reconcile's idempotence + loud-fail posture, unit-level
// with controllable stubs (no DB). The real ledger behavior is proven in the
// apps/api integration spec; here we prove the CONTROL FLOW: skip-when-present,
// propagate-on-failure, exactly-once-on-retry.

function makeService(opts: {
  skills: Array<{ id: string; surface_form: string; skill_id: string }>;
  work: Array<{
    id: string;
    employer_name: string;
    role_title: string;
    start_date: Date | null;
    end_date: Date | null;
    employment_type: string | null;
  }>;
  // TALENT-INTEL-1 TI-1C — declared work-authorization rows (default empty).
  workAuth?: Array<{
    id: string;
    work_authorization_status: string;
    authorized_to_work_in: string[];
    visa_type: string | null;
    requires_sponsorship: boolean;
  }>;
  record: (input: { assertion_type: string; source_ref: { talent_evidence_id: string } }) => Promise<{
    written: boolean;
    evidence_id?: string;
  }>;
}): { service: TalentExtractionService; record: ReturnType<typeof vi.fn> } {
  const evidence = {
    listSkillEvidenceForLedger: vi.fn().mockResolvedValue(opts.skills),
    listWorkHistoryForLedger: vi.fn().mockResolvedValue(opts.work),
    // TR-7 B1 — the two new credential reads (empty for these control-flow cases).
    listEducationForLedger: vi.fn().mockResolvedValue([]),
    listCertificationForLedger: vi.fn().mockResolvedValue([]),
    // TALENT-INTEL-1 TI-1C — the declared work-authorization read.
    listWorkAuthorizationForLedger: vi.fn().mockResolvedValue(opts.workAuth ?? []),
  };
  const record = vi.fn(opts.record);
  const trust = { recordDeclaredClaimIfAbsent: record };
  const aiDraft = { generateDraft: vi.fn() };
  const service = new TalentExtractionService(
    aiDraft as never,
    evidence as never,
    trust as never,
    // HF1 — structured-generation port; the ledger path never invokes it.
    {} as never,
  );
  return { service, record };
}

const SKILLS = [
  { id: 's1', surface_form: 'TypeScript', skill_id: 'k1' },
  { id: 's2', surface_form: 'Go', skill_id: 'k2' },
];

describe('routeDeclaredEvidenceToLedger — idempotence (§5c)', () => {
  it('skips rows whose ledger counterpart already exists (writes zero)', async () => {
    const { service, record } = makeService({
      skills: SKILLS,
      work: [],
      // Existence check → already present for every row.
      record: () => Promise.resolve({ written: false }),
    });
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r).toEqual({ skills_written: 0, work_history_written: 0, education_written: 0, certification_written: 0, work_authorization_written: 0, skipped: 2 });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('writes only the absent rows', async () => {
    const { service } = makeService({
      skills: SKILLS,
      work: [],
      record: (input) => Promise.resolve({ written: input.source_ref.talent_evidence_id === 's2' }),
    });
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r).toEqual({ skills_written: 1, work_history_written: 0, education_written: 0, certification_written: 0, work_authorization_written: 0, skipped: 1 });
  });
});

// TALENT-INTEL-1 (TI-1C §step-5) — declared work-authorization rows route to the
// ledger as RIGHT_TO_WORK claims, deterministically + idempotently (writes only
// rows lacking a ledger counterpart; source_ref keys the typed row). The route is
// via recordDeclaredClaimIfAbsent (THIRD_PARTY_UNVERIFIED — cannot elevate).
describe('routeDeclaredEvidenceToLedger — RIGHT_TO_WORK routing (TI-1C)', () => {
  const WORK_AUTH = [
    {
      id: 'wa1',
      work_authorization_status: 'VISA_HOLDER',
      authorized_to_work_in: ['US'],
      visa_type: 'H-1B',
      requires_sponsorship: true,
    },
  ];

  it('routes a declared work-authorization row as a RIGHT_TO_WORK claim (writes 1)', async () => {
    const { service, record } = makeService({
      skills: [],
      work: [],
      workAuth: WORK_AUTH,
      record: () => Promise.resolve({ written: true }),
    });
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r.work_authorization_written).toBe(1);
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0][0];
    expect(call.assertion_type).toBe('RIGHT_TO_WORK');
    expect(call.source_ref.talent_evidence_id).toBe('wa1');
  });

  it('is idempotent — an already-present work-authorization row writes zero', async () => {
    const { service } = makeService({
      skills: [],
      work: [],
      workAuth: WORK_AUTH,
      record: () => Promise.resolve({ written: false }),
    });
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r).toEqual({ skills_written: 0, work_history_written: 0, education_written: 0, certification_written: 0, work_authorization_written: 0, skipped: 1 });
  });
});

describe('routeDeclaredEvidenceToLedger — loud fail then exactly-once on retry (§5d)', () => {
  it('propagates a ledger failure loudly, then the retry completes exactly once', async () => {
    // Track which source_refs have been "written" across runs (a stand-in for the
    // ledger's existence check).
    const written = new Set<string>();
    let failNext = true;

    const record = (input: { source_ref: { talent_evidence_id: string } }): Promise<{ written: boolean }> => {
      const id = input.source_ref.talent_evidence_id;
      if (written.has(id)) return Promise.resolve({ written: false }); // already present
      if (id === 's2' && failNext) {
        return Promise.reject(new Error('ledger down'));
      }
      written.add(id);
      return Promise.resolve({ written: true });
    };

    const evidence = {
      listSkillEvidenceForLedger: vi.fn().mockResolvedValue(SKILLS),
      listWorkHistoryForLedger: vi.fn().mockResolvedValue([]),
      listEducationForLedger: vi.fn().mockResolvedValue([]),
      listCertificationForLedger: vi.fn().mockResolvedValue([]),
      listWorkAuthorizationForLedger: vi.fn().mockResolvedValue([]),
    };
    const trust = { recordDeclaredClaimIfAbsent: vi.fn(record) };
    const service = new TalentExtractionService(
      { generateDraft: vi.fn() } as never,
      evidence as never,
      trust as never,
      {} as never,
    );

    // Run 1 — s1 writes, s2 throws → the whole call rejects LOUDLY.
    await expect(
      service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' }),
    ).rejects.toThrow(/ledger down/);
    expect(written.has('s1')).toBe(true);
    expect(written.has('s2')).toBe(false);

    // Retry — s1 already present (skip), s2 now writes → exactly once.
    failNext = false;
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r).toEqual({ skills_written: 1, work_history_written: 0, education_written: 0, certification_written: 0, work_authorization_written: 0, skipped: 1 });
    expect(written.has('s2')).toBe(true);
    // s1 was written exactly once (run 1), s2 exactly once (retry).
    expect([...written].sort()).toEqual(['s1', 's2']);
  });
});

// HF2 R1/R7 — persistExperienceAssertions routes activities/accomplishments to
// the EvidenceRecord ledger as EXPERIENCE_CLAIM, deterministically (no AI call),
// idempotent via the content source_ref, grounding_class carried.
describe('persistExperienceAssertions — EXPERIENCE_CLAIM routing (HF2)', () => {
  it('writes each assertion as EXPERIENCE_CLAIM; no model call; carries grounding_class', async () => {
    const seen = new Set<string>();
    const generateStructured = vi.fn();
    const generateDraft = vi.fn();
    const record = vi.fn(async (input: { assertion_type: string; assertion_payload: { grounding_class?: string }; source_ref: { talent_evidence_id: string } }) => {
      if (seen.has(input.source_ref.talent_evidence_id)) return { written: false };
      seen.add(input.source_ref.talent_evidence_id);
      return { written: true, evidence_id: 'ev' };
    });
    const svc = new TalentExtractionService(
      { generateDraft } as never,
      {} as never,
      { recordDeclaredClaimIfAbsent: record } as never,
      { generateStructured, providerKey: () => 'anthropic' } as never,
    );
    const written = await svc.persistExperienceAssertions({
      tenant_id: 't', talent_id: 'tr', work_experience_id: 'we-1',
      assertions: [
        { type: 'DEVELOP', statement: 'Built Java services', source_refs: ['B003'], grounding_class: 'SOURCE_ASSOCIATED_INTERPRETATION' },
        { type: 'DEPLOY', statement: 'Deployed to EKS', source_refs: ['B004'], grounding_class: 'SOURCE_ASSOCIATED_INTERPRETATION' },
      ],
    });
    expect(written).toBe(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0][0].assertion_type).toBe('EXPERIENCE_CLAIM');
    expect(record.mock.calls[0][0].assertion_payload.grounding_class).toBe('SOURCE_ASSOCIATED_INTERPRETATION');
    // Deterministic (R6/§26): no AI surface invoked by the persistence path.
    expect(generateStructured).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('is idempotent — a re-run of the same assertions writes nothing new', async () => {
    const seen = new Set<string>();
    const record = vi.fn(async (input: { source_ref: { talent_evidence_id: string } }) => {
      if (seen.has(input.source_ref.talent_evidence_id)) return { written: false };
      seen.add(input.source_ref.talent_evidence_id);
      return { written: true, evidence_id: 'ev' };
    });
    const svc = new TalentExtractionService(
      { generateDraft: vi.fn() } as never, {} as never,
      { recordDeclaredClaimIfAbsent: record } as never,
      { generateStructured: vi.fn(), providerKey: () => 'anthropic' } as never,
    );
    const args = {
      tenant_id: 't', talent_id: 'tr', work_experience_id: 'we-1',
      assertions: [{ type: 'DEVELOP', statement: 'Built services', source_refs: ['B003'] }],
    };
    expect(await svc.persistExperienceAssertions(args)).toBe(1);
    expect(await svc.persistExperienceAssertions(args)).toBe(0); // idempotent
  });
});
