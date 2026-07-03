import { describe, expect, it } from 'vitest';
import { evaluateEntrustability } from '@aramo/matching';

import {
  buildMatchingInput,
  isRoleFamily,
  type BuildMatchingInputParams,
  type DeclaredSkillEvidence,
} from '../matching-derivation/derive-matching-input.js';

// Gate-1 G1-B — deterministic derivation unit spec. Proves the name↔surface_form
// overlap, the R8 constraint mapping, HONEST confidence, and — fed into the
// engine — that a declared-only talent matching the critical skills lands at
// WORTH_CONSIDERING (never STRETCH, never ENTRUSTABLE): the intelligence-lite
// outcome the whole gate exists to produce.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GP = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

function declared(surface_form: string, source: DeclaredSkillEvidence['source'] = 'declared'): DeclaredSkillEvidence {
  return { surface_form, source, skill_id: 'skill-' + surface_form.toLowerCase() };
}

function params(over: Partial<BuildMatchingInputParams> = {}): BuildMatchingInputParams {
  return {
    examination_id: '00000000-0000-7000-8000-000000000001',
    tenant_id: TENANT,
    talent_id: TALENT,
    job_id: JOB,
    golden_profile_id: GP,
    computed_at: new Date('2026-07-03T00:00:00.000Z'),
    role_family: 'backend_engineer',
    critical_skill_names: ['AWS', 'PostgreSQL'],
    golden_constraints: {},
    declared_skills: [declared('aws'), declared(' Postgresql ')],
    talent: {
      city: 'Austin',
      state: 'TX',
      desired_pay: '$70/hr',
      work_authorization: 'US_CITIZEN',
      has_contact_channel: true,
    },
    ...over,
  };
}

describe('buildMatchingInput — skill overlap (name ↔ surface_form normalized)', () => {
  it('matches case/whitespace-insensitively → evidence_count; unmatched golden skill → gap', () => {
    const input = buildMatchingInput(
      params({
        critical_skill_names: ['AWS', 'Kubernetes'],
        declared_skills: [declared('aws'), declared('Java')],
      }),
    );
    const aws = input.critical_skills.find((s) => s.name === 'AWS');
    const k8s = input.critical_skills.find((s) => s.name === 'Kubernetes');
    expect(aws?.evidence_count).toBe(1);
    expect(k8s?.evidence_count).toBe(0);
    expect(input.gaps).toContain('Kubernetes');
    expect(input.strengths).toContain('AWS');
  });

  it('has_ingested_evidence: declared-only → false; an ingested row → true', () => {
    const declaredOnly = buildMatchingInput(params());
    expect(declaredOnly.critical_skills.every((s) => !s.has_ingested_evidence)).toBe(true);

    const withIngested = buildMatchingInput(
      params({ declared_skills: [declared('aws', 'ingested'), declared('postgresql')] }),
    );
    expect(withIngested.critical_skills.find((s) => s.name === 'AWS')?.has_ingested_evidence).toBe(true);
  });
});

describe('buildMatchingInput — R8 constraint mapping', () => {
  it('omitted golden constraint → pass (vacuous); work_mode set → unknown (no talent source)', () => {
    const input = buildMatchingInput(params({ golden_constraints: { work_mode: 'remote' } }));
    expect(input.constraint_checks_evaluated.location).toBe('pass'); // omitted
    expect(input.constraint_checks_evaluated.rate).toBe('pass'); // omitted
    expect(input.constraint_checks_evaluated.work_mode).toBe('unknown'); // no source
  });

  it('location match → pass; absent talent location → unknown', () => {
    const match = buildMatchingInput(params({ golden_constraints: { location: 'Austin' } }));
    expect(match.constraint_checks_evaluated.location).toBe('pass');
    const absent = buildMatchingInput(
      params({ golden_constraints: { location: 'Austin' }, talent: { city: null, state: null, desired_pay: null, work_authorization: null, has_contact_channel: true } }),
    );
    expect(absent.constraint_checks_evaluated.location).toBe('unknown');
  });

  it('work_authorization: REQUIRES_SPONSORSHIP vs a no-sponsorship requirement → fail; match → pass', () => {
    const conflict = buildMatchingInput(
      params({
        golden_constraints: { work_authorization: 'US citizen, no sponsorship' },
        talent: { city: null, state: null, desired_pay: null, work_authorization: 'REQUIRES_SPONSORSHIP', has_contact_channel: true },
      }),
    );
    expect(conflict.constraint_checks_evaluated.work_authorization).toBe('fail');

    const ok = buildMatchingInput(
      params({ golden_constraints: { work_authorization: 'US_CITIZEN' }, talent: { city: null, state: null, desired_pay: null, work_authorization: 'US_CITIZEN', has_contact_channel: true } }),
    );
    expect(ok.constraint_checks_evaluated.work_authorization).toBe('pass');
  });
});

describe('buildMatchingInput — HONEST confidence + blocking + keying', () => {
  it('declared-only → data_completeness low (no ingested); never faked high', () => {
    const input = buildMatchingInput(params());
    expect(input.confidence_indicators_evaluated.data_completeness).toBe('low');
  });

  it('consent_state_sufficient=true (examination is an internal assessment, not a contact action); contact channel passes through; job_id keyed', () => {
    const input = buildMatchingInput(params({ job_id: JOB }));
    expect(input.blocking_conditions.consent_state_sufficient).toBe(true);
    expect(input.blocking_conditions.has_verified_contact_channel).toBe(true);
    expect(input.job_id).toBe(JOB);
    expect(input.trigger).toBe('recruiter_requested');
  });
});

describe('derivation → engine — the intelligence-lite outcome', () => {
  it('declared-only, all critical skills matched, no constraint fail → WORTH_CONSIDERING (submittable, never STRETCH/ENTRUSTABLE)', () => {
    const input = buildMatchingInput(params());
    const result = evaluateEntrustability(input);
    expect(result.tier).toBe('WORTH_CONSIDERING');
  });

  it('a missing critical skill (evidence_count 0) → STRETCH (honest — genuinely lacks it)', () => {
    const input = buildMatchingInput(
      params({ critical_skill_names: ['AWS', 'Kubernetes'], declared_skills: [declared('aws')] }),
    );
    expect(evaluateEntrustability(input).tier).toBe('STRETCH');
  });

  it('a work_authorization conflict → STRETCH (hard, correct)', () => {
    const input = buildMatchingInput(
      params({
        golden_constraints: { work_authorization: 'citizen, no sponsorship' },
        talent: { city: 'Austin', state: 'TX', desired_pay: null, work_authorization: 'REQUIRES_SPONSORSHIP', has_contact_channel: true },
      }),
    );
    expect(evaluateEntrustability(input).tier).toBe('STRETCH');
  });
});

describe('isRoleFamily', () => {
  it('accepts a known family, rejects junk', () => {
    expect(isRoleFamily('backend_engineer')).toBe(true);
    expect(isRoleFamily('wizard')).toBe(false);
    expect(isRoleFamily(undefined)).toBe(false);
  });
});
