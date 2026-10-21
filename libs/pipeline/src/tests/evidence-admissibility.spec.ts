import { describe, expect, it } from 'vitest';

import { ADMISSIBLE_EVIDENCE_BY_STAGE, isEvidenceAdmissible } from '../lib/evidence-admissibility.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §7.2 (S4, A1 AM-4) — the per-stage evidence
// allowlist as a pure rule, asserted cell by cell.
describe('isEvidenceAdmissible — the v1.2 §7.2 allowlist', () => {
  it('contacted: communication_interaction, recruiter_response_confirmation, provider_observation', () => {
    for (const kind of ['communication_interaction', 'recruiter_response_confirmation', 'provider_observation']) {
      expect(isEvidenceAdmissible('contacted', kind), kind).toBe(true);
    }
  });

  it('talent_responded: recruiter_response_confirmation ONLY', () => {
    expect(isEvidenceAdmissible('talent_responded', 'recruiter_response_confirmation')).toBe(true);
    for (const kind of ['communication_interaction', 'provider_observation']) {
      expect(isEvidenceAdmissible('talent_responded', kind), kind).toBe(false);
    }
  });

  it('inbound_application is not admissible (S5 deferred); unknown kinds and non-evidence stages are refused', () => {
    expect(isEvidenceAdmissible('contacted', 'inbound_application')).toBe(false);
    expect(isEvidenceAdmissible('talent_responded', 'inbound_application')).toBe(false);
    expect(isEvidenceAdmissible('contacted', 'zoom_call')).toBe(false);
    expect(isEvidenceAdmissible('qualified', 'recruiter_response_confirmation')).toBe(false);
  });

  it('the table has exactly the two evidence-backed stages', () => {
    expect(Object.keys(ADMISSIBLE_EVIDENCE_BY_STAGE).sort()).toEqual(['contacted', 'talent_responded']);
  });
});
