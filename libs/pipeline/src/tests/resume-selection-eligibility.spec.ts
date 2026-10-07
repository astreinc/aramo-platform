import { describe, expect, it } from 'vitest';

import { resumeSelectionEligibility } from '../lib/resume-selection-eligibility.js';

// Resume Revision Lifecycle §9 — the SINGLE eligibility rule consumed by BOTH the
// Pipeline resume view (FE "requires attention" banner) and the Submittal authority
// (hard submit refusal). One interpretation of "archived", never two.
describe('§9 — resumeSelectionEligibility (single owner)', () => {
  it('ACTIVE selection → eligible', () => {
    expect(resumeSelectionEligibility('ed-1', 'active')).toEqual({
      status: 'eligible',
      lifecycle_status: 'active',
    });
  });

  it('ARCHIVED selection → ineligible (requires replacement, §9)', () => {
    expect(resumeSelectionEligibility('ed-1', 'archived')).toEqual({
      status: 'ineligible',
      lifecycle_status: 'archived',
    });
  });

  it('retracted selection → ineligible', () => {
    expect(resumeSelectionEligibility('ed-1', 'retracted')).toEqual({
      status: 'ineligible',
      lifecycle_status: 'retracted',
    });
  });

  it('no selection → none (a distinct "selection required" condition)', () => {
    expect(resumeSelectionEligibility(null, null)).toEqual({
      status: 'none',
      lifecycle_status: null,
    });
  });

  it('selected but edition unresolvable → ineligible (never silently eligible)', () => {
    expect(resumeSelectionEligibility('ed-1', null)).toEqual({
      status: 'ineligible',
      lifecycle_status: 'unknown',
    });
  });
});
