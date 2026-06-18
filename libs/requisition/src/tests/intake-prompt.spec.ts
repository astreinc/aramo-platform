import { describe, expect, it } from 'vitest';

import {
  INTAKE_TEXT_MAX_CHARS,
  buildIntakePrompt,
  parseIntakeCompletion,
} from '../lib/intake-prompt.js';

// New Requisition AI intake (charter §7.3, Lead ruling Tab 1) — the bounded,
// task-scoped prompt + the tolerant completion parser.

describe('intake prompt — bounded + R10-clean', () => {
  it('carries the intake text and a fixed task-scoped system message', () => {
    const { prompt, system_message } = buildIntakePrompt(
      'Need a senior backend engineer, Go + AWS, Austin hybrid, C2C.',
    );
    expect(prompt).toContain('Intake text:');
    expect(prompt).toContain('senior backend engineer');
    // It is NOT a general passthrough — it instructs extraction + a JD draft.
    expect(system_message).toContain('EXTRACT');
    expect(system_message).toMatch(/job\s+description/);
    expect(system_message).toContain('required_skills');
  });

  it('the system message forbids assessing/ordering people (R10)', () => {
    const { system_message } = buildIntakePrompt('anything');
    expect(system_message).toContain('describe the ROLE');
    expect(system_message.toLowerCase()).toContain('never');
    // The constraint copy itself stays clear of the banned R10 tokens.
    expect(system_message).not.toMatch(/\bscore\b/i);
    expect(system_message).not.toMatch(/\brank\b/i);
  });

  it('exposes a finite size cap', () => {
    expect(INTAKE_TEXT_MAX_CHARS).toBeGreaterThan(0);
  });
});

describe('parseIntakeCompletion — JSON envelope + tolerant fallback', () => {
  it('extracts fields, jd_text and both skill lists from a JSON envelope', () => {
    const completion = JSON.stringify({
      fields: {
        title: 'Senior Backend Engineer',
        company_name: 'Northwind Robotics',
        job_type: 'contract_to_hire',
        openings: 2,
        city: 'Austin',
        state: 'TX',
        work_arrangement: 'hybrid',
        bill_rate: '85',
        rate_type: 'C2C',
        allow_subcontractors: true,
        start_date: 'within 3 weeks',
      },
      jd_text: 'A great backend role.',
      required_skills: [{ name: 'Go' }, { name: 'Kubernetes' }],
      nice_to_have_skills: ['gRPC', { name: 'Terraform' }],
    });
    const out = parseIntakeCompletion(`Here you go: ${completion}`);
    expect(out.fields.title).toBe('Senior Backend Engineer');
    expect(out.fields.company_name).toBe('Northwind Robotics');
    expect(out.fields.openings).toBe(2);
    expect(out.fields.rate_type).toBe('C2C');
    expect(out.fields.allow_subcontractors).toBe(true);
    expect(out.jd_text).toBe('A great backend role.');
    expect(out.required_skills).toEqual([{ name: 'Go' }, { name: 'Kubernetes' }]);
    // Normalizes bare strings + {name} objects in the skill list.
    expect(out.nice_to_have_skills).toEqual([{ name: 'gRPC' }, { name: 'Terraform' }]);
  });

  it('omits unstated/null fields (no guessed values)', () => {
    const completion = JSON.stringify({
      fields: { title: 'Data Engineer', bill_rate: null, openings: null },
      jd_text: 'Pipelines.',
      required_skills: [],
      nice_to_have_skills: [],
    });
    const out = parseIntakeCompletion(completion);
    expect(out.fields.title).toBe('Data Engineer');
    expect('bill_rate' in out.fields).toBe(false);
    expect('openings' in out.fields).toBe(false);
  });

  it('falls back to JD prose when the completion is not JSON', () => {
    const out = parseIntakeCompletion('Just some prose, no JSON here.');
    expect(out.jd_text).toContain('Just some prose');
    expect(out.fields).toEqual({});
    expect(out.required_skills).toEqual([]);
    expect(out.nice_to_have_skills).toEqual([]);
  });
});
