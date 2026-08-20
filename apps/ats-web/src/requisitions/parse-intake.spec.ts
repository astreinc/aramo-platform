import { describe, expect, it } from 'vitest';

import { parseRequisitionIntake } from './parse-intake';

// A well-defined client requirement, pasted verbatim by the recruiter (the
// non-VMS email lane). The parser reads it deterministically — no AI, no
// network — and prefills the manual form. It NEVER invents an enum value and
// NEVER alters the client's text: the full paste is preserved in jd_text.
const EMAIL = [
  'Need a Senior Backend Engineer for the payments team.',
  'Strong Go + distributed systems, comfortable on AWS/Kubernetes.',
  'Nice to have gRPC.',
  'Contract, Austin, TX or mostly remote.',
  'Bill rate up to $85/hr C2C. USC or GC only. 2 openings.',
].join(' ');

describe('parseRequisitionIntake — deterministic (non-AI) intake parse', () => {
  it('extracts the stated fields from a representative client email', () => {
    const { fields } = parseRequisitionIntake(EMAIL);
    expect(fields.title).toBe('Senior Backend Engineer');
    expect(fields.role_family).toBe('backend_engineer');
    expect(fields.seniority_level).toBe('senior');
    expect(fields.job_type).toBe('contract');
    expect(fields.work_arrangement).toBe('remote');
    expect(fields.city).toBe('Austin');
    expect(fields.state).toBe('TX');
    expect(fields.bill_rate).toBe('85');
    expect(fields.rate_type).toBe('C2C');
    expect(fields.allow_subcontractors).toBe(true);
    expect(fields.openings).toBe(2);
  });

  it('splits required vs nice-to-have skills on their stated markers', () => {
    const { required_skills, nice_to_have_skills } = parseRequisitionIntake(EMAIL);
    const req = required_skills.map((s) => s.name);
    expect(req).toContain('Go');
    expect(req).toContain('Kubernetes');
    expect(req).toContain('AWS');
    expect(req).toContain('distributed systems');
    expect(nice_to_have_skills.map((s) => s.name)).toEqual(['gRPC']);
    // A nice-to-have is never double-counted as required.
    expect(req).not.toContain('gRPC');
  });

  it('preserves the client text verbatim in jd_text (we alter nothing)', () => {
    expect(parseRequisitionIntake(EMAIL).jd_text).toBe(EMAIL);
  });

  it('leaves an AMBIGUOUS work authorization blank rather than guess', () => {
    // "USC or GC only" is a disjunction our single-select cannot represent —
    // honest posture is to leave it unset (the constraint stays in jd_text).
    expect(parseRequisitionIntake(EMAIL).fields.work_authorization).toBeUndefined();
  });

  it('maps an UNAMBIGUOUS work authorization to its locked-set member', () => {
    expect(parseRequisitionIntake('US citizens only.').fields.work_authorization).toBe('us_citizen');
    expect(parseRequisitionIntake('Green card holders only.').fields.work_authorization).toBe('gc');
    expect(parseRequisitionIntake('H-1B ok.').fields.work_authorization).toBe('h1b_ok');
  });

  it('NEVER fabricates a closed-vocab value it cannot recognise', () => {
    const { fields } = parseRequisitionIntake('We need a Rockstar Ninja for good vibes.');
    expect(fields.job_type).toBeUndefined();
    expect(fields.role_family).toBeUndefined();
    expect(fields.seniority_level).toBeUndefined();
    expect(fields.work_arrangement).toBeUndefined();
  });

  it('returns an empty result for empty input (no throw)', () => {
    const out = parseRequisitionIntake('   ');
    expect(out.fields).toEqual({});
    expect(out.required_skills).toEqual([]);
    expect(out.nice_to_have_skills).toEqual([]);
    expect(out.jd_text).toBe('');
  });
});
