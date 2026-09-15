import { describe, expect, it, vi } from 'vitest';

import {
  TalentExtractionService,
  deriveResumeSkillYears,
} from '../lib/talent-extraction.service.js';
import { deriveSkillId } from '../lib/skill-id.js';
import type { ResumeDate } from '../lib/resume-date.js';

// HF2 P6 — the confirmed-create persistence of Talent Experience Intelligence:
// WorkExperience (+experience_summary, company_id NULL seam) → per-role
// SkillUsage (+version/basis/activity/work_experience_id) + ProjectExperience +
// EXPERIENCE_CLAIM assertions, plus the union-based derived-years snapshot
// (R14/R27). All DETERMINISTIC — no model call is ever made on this path.

const TENANT = '01900000-0000-7000-8000-000000000001';
const TALENT = '01900000-0000-7000-8000-0000000000aa';
const ASOF: ResumeDate = { year: 2026, month: 1, day: 1, precision: 'EXACT' };

function makeService() {
  const createTalentWorkHistoryEntry = vi.fn().mockResolvedValue({ id: 'wh' });
  const createTalentSkillEvidence = vi.fn().mockResolvedValue({ id: 'sk' });
  const createTalentProjectExperience = vi.fn().mockResolvedValue({ id: 'pj' });
  const createTalentDerivedSnapshot = vi.fn().mockResolvedValue({ id: 'snap' });
  const createTalentEducationEntry = vi.fn().mockResolvedValue({ id: 'ed' });
  const createTalentCertificationEntry = vi.fn().mockResolvedValue({ id: 'cert' });
  const evidence = {
    createTalentWorkHistoryEntry,
    createTalentSkillEvidence,
    createTalentProjectExperience,
    createTalentDerivedSnapshot,
    createTalentEducationEntry,
    createTalentCertificationEntry,
  };
  const recordDeclaredClaimIfAbsent = vi.fn().mockResolvedValue({ written: true });
  const trust = { recordDeclaredClaimIfAbsent };
  const generateDraft = vi.fn();
  const generateStructured = vi.fn();
  const svc = new TalentExtractionService(
    { generateDraft } as never,
    evidence as never,
    trust as never,
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
  return {
    svc,
    createTalentWorkHistoryEntry,
    createTalentSkillEvidence,
    createTalentProjectExperience,
    createTalentDerivedSnapshot,
    createTalentEducationEntry,
    createTalentCertificationEntry,
    recordDeclaredClaimIfAbsent,
    generateDraft,
    generateStructured,
  };
}

describe('persistDeclaredWorkHistory — nested Experience Intelligence (P6, deterministic)', () => {
  it('persists WorkExperience + SkillUsage + Projects + assertions + snapshot; no model call', async () => {
    const s = makeService();
    await s.svc.persistDeclaredWorkHistory({
      talent_id: TALENT,
      tenant_id: TENANT,
      entries: [
        {
          employer_name: 'Northstar',
          role_title: 'Cloud Engineer',
          start_date: '2020',
          end_date: '2023',
          location: 'Austin, TX',
          experience_summary: 'Led the platform migration.',
          source_refs: ['B004'],
          skill_usage: [
            // EXPLICIT: the résumé stated the skill's own dates → carried.
            {
              surface_form: 'Kubernetes',
              version: '1.27',
              activity: 'DEPLOY',
              usage_period_basis: 'EXPLICIT',
              usage_start: '2021-03',
              usage_end: '2023',
              source_refs: ['B004'],
            },
            // WORK_EXPERIENCE_CONTEXT: dates NOT manufactured → stay NULL.
            {
              surface_form: 'Terraform',
              activity: 'DEVELOP',
              usage_period_basis: 'WORK_EXPERIENCE_CONTEXT',
              source_refs: ['B004'],
            },
          ],
          projects: [
            { project_name: 'Atlas', context: 'Zero-downtime cutover', domain: 'infra', source_refs: ['B004'] },
          ],
          assertions: [
            { type: 'DEPLOY', statement: 'Deployed to 40 clusters', metric: '40', grounding_class: 'SOURCE_ASSOCIATED_INTERPRETATION', source_refs: ['B004'] },
          ],
        },
      ],
    });

    // 1) WorkExperience row: summary carried; company_id NEVER set (null seam).
    const wh = s.createTalentWorkHistoryEntry.mock.calls[0][0];
    const workExperienceId = wh.id;
    expect(wh.experience_summary).toBe('Led the platform migration.');
    expect(wh.location).toBe('Austin, TX');
    expect(wh.company_id).toBeUndefined();
    expect(wh.source).toBe('resume');

    // 2) SkillUsage rows keyed to THIS role, with version/basis/activity.
    expect(s.createTalentSkillEvidence).toHaveBeenCalledTimes(2);
    const k8s = s.createTalentSkillEvidence.mock.calls.find(
      (c) => c[0].surface_form === 'Kubernetes',
    )![0];
    expect(k8s.work_experience_id).toBe(workExperienceId);
    expect(k8s.version).toBe('1.27');
    expect(k8s.usage_period_basis).toBe('EXPLICIT');
    expect(k8s.activity_context).toBe('DEPLOY');
    expect(k8s.source).toBe('declared');
    // EXPLICIT dates anchored to their month edge (2021-03 → start; 2023 → Dec).
    expect(k8s.usage_start?.toISOString().slice(0, 10)).toBe('2021-03-01');
    expect(k8s.usage_end?.toISOString().slice(0, 10)).toBe('2023-12-01');

    const tf = s.createTalentSkillEvidence.mock.calls.find(
      (c) => c[0].surface_form === 'Terraform',
    )![0];
    expect(tf.usage_period_basis).toBe('WORK_EXPERIENCE_CONTEXT');
    // WORK_EXPERIENCE_CONTEXT → usage dates NOT manufactured.
    expect(tf.usage_start).toBeUndefined();
    expect(tf.usage_end).toBeUndefined();

    // 3) ProjectExperience keyed to the role.
    const pj = s.createTalentProjectExperience.mock.calls[0][0];
    expect(pj.work_experience_id).toBe(workExperienceId);
    expect(pj.project_name).toBe('Atlas');
    expect(pj.domain).toBe('infra');

    // 4) Assertion routed to the trust ledger (EXPERIENCE_CLAIM).
    expect(s.recordDeclaredClaimIfAbsent).toHaveBeenCalledOnce();
    expect(s.recordDeclaredClaimIfAbsent.mock.calls[0][0].assertion_type).toBe('EXPERIENCE_CLAIM');

    // 5) Derived snapshot: declared (no confidence), with per-skill years.
    expect(s.createTalentDerivedSnapshot).toHaveBeenCalledOnce();
    const snap = s.createTalentDerivedSnapshot.mock.calls[0][0];
    expect(snap.skill_confidence_scores).toEqual({});
    expect(snap.estimated_years_experience_by_skill[deriveSkillId('Kubernetes')]).toBeDefined();
    expect(snap.estimated_years_experience_overall).toBeGreaterThan(0);

    // No model call anywhere on the persistence path.
    expect(s.generateDraft).not.toHaveBeenCalled();
    expect(s.generateStructured).not.toHaveBeenCalled();
  });

  it('an all-undatable history writes NO snapshot (never an all-null row)', async () => {
    const s = makeService();
    await s.svc.persistDeclaredWorkHistory({
      talent_id: TALENT,
      tenant_id: TENANT,
      entries: [{ employer_name: 'Acme', role_title: 'Engineer' }],
    });
    expect(s.createTalentWorkHistoryEntry).toHaveBeenCalledOnce();
    expect(s.createTalentDerivedSnapshot).not.toHaveBeenCalled();
  });
});

describe('deriveResumeSkillYears — union not sum, precision-carried (R14/R27, pure)', () => {
  it('unions a skill across overlapping roles (concurrent counted once)', () => {
    const d = deriveResumeSkillYears(
      [
        {
          employer_name: 'A',
          role_title: 'Eng',
          start_date: '2018',
          end_date: '2021',
          skill_usage: [{ surface_form: 'Go', usage_period_basis: 'WORK_EXPERIENCE_CONTEXT', source_refs: [] }],
        },
        {
          employer_name: 'B',
          role_title: 'Eng',
          start_date: '2020',
          end_date: '2023',
          skill_usage: [{ surface_form: 'Go', usage_period_basis: 'WORK_EXPERIENCE_CONTEXT', source_refs: [] }],
        },
      ],
      ASOF,
    );
    const go = d.by_skill[deriveSkillId('Go')];
    // 2018-Jan → 2023-Dec union = 71 months (edge-to-edge) = 5.9y; NOT 4+4=8y.
    expect(go.supported_months).toBe(71);
    expect(go.years).toBe(5.9);
    expect(go.precision).toBe('YEAR');
    // Overall career span is the same union.
    expect(d.overall_years).toBe(5.9);
  });

  it('EXPLICIT usage uses its OWN dates (not the enclosing role)', () => {
    const d = deriveResumeSkillYears(
      [
        {
          employer_name: 'A',
          role_title: 'Eng',
          start_date: '2015',
          end_date: '2025',
          skill_usage: [
            {
              surface_form: 'Rust',
              usage_period_basis: 'EXPLICIT',
              usage_start: '2022-01',
              usage_end: '2024-01',
              source_refs: [],
            },
          ],
        },
      ],
      ASOF,
    );
    const rust = d.by_skill[deriveSkillId('Rust')];
    expect(rust.supported_months).toBe(24); // 2022-01 → 2024-01 (edge-to-edge)
    expect(rust.precision).toBe('MONTH');
    // The role span (2015-Jan → 2025-Dec = 131mo) is the OVERALL, independent
    // of the skill's own EXPLICIT window.
    expect(d.overall_years).toBe(10.9);
  });

  it('an ongoing role extends to asOf and flags current', () => {
    const d = deriveResumeSkillYears(
      [
        {
          employer_name: 'A',
          role_title: 'Eng',
          start_date: '2024-01',
          end_date: 'present',
          skill_usage: [{ surface_form: 'SQL', usage_period_basis: 'WORK_EXPERIENCE_CONTEXT', source_refs: [] }],
        },
      ],
      ASOF,
    );
    const sql = d.by_skill[deriveSkillId('SQL')];
    expect(sql.current).toBe(true);
    expect(sql.supported_months).toBe(24); // 2024-01 → 2026-01
  });

  it('undatable roles → overall null, empty by_skill', () => {
    const d = deriveResumeSkillYears(
      [{ employer_name: 'A', role_title: 'Eng' }],
      ASOF,
    );
    expect(d.overall_years).toBeNull();
    expect(Object.keys(d.by_skill)).toHaveLength(0);
  });
});

describe('persistDeclaredEducation / Certifications — declared, provenance, strict dates', () => {
  it('persists education with strict conferred_date + provenance (institution/degree required)', async () => {
    const s = makeService();
    const ids = await s.svc.persistDeclaredEducation({
      talent_id: TALENT,
      tenant_id: TENANT,
      education: [
        { institution_name: 'MIT', degree_name: 'BSc', field_of_study: 'CS', conferred_date: 'May 2018', source_refs: ['B010'] },
        { institution_name: '', degree_name: 'BSc', source_refs: [] }, // missing institution → dropped
      ],
      provenance: { source_document_id: 'doc-1' },
    });
    expect(ids).toHaveLength(1);
    const ed = s.createTalentEducationEntry.mock.calls[0][0];
    expect(ed.source).toBe('resume');
    expect(ed.conferred_date?.toISOString().slice(0, 10)).toBe('2018-05-01');
    expect(ed.source_document_id).toBe('doc-1');
    expect(ed.source_refs).toEqual(['B010']);
  });

  it('persists certifications; unparseable expiry → NULL (never guessed)', async () => {
    const s = makeService();
    const ids = await s.svc.persistDeclaredCertifications({
      talent_id: TALENT,
      tenant_id: TENANT,
      certifications: [
        { certification_name: 'CKA', issuer_name: 'CNCF', issued_date: '2021-03', expiry_date: 'someday', source_refs: [] },
      ],
    });
    expect(ids).toHaveLength(1);
    const c = s.createTalentCertificationEntry.mock.calls[0][0];
    expect(c.issued_date?.toISOString().slice(0, 10)).toBe('2021-03-01');
    expect(c.expiry_date).toBeUndefined(); // 'someday' refused → no key
  });
});
