import { describe, expect, it } from 'vitest';

import { RECRUITING_STATUS_TONE } from './status-tone';
import { RECRUITING_STATUS_LABELS } from './types';

// T10-B4/F-028 — the RecruitingStatus → tone map is now a single source (was
// byte-duplicated across list/detail/dashboard). Presentation-only.
describe('RECRUITING_STATUS_TONE (single source)', () => {
  it('is deterministic and covers exactly the RecruitingStatus values (parity with the labels)', () => {
    expect(Object.keys(RECRUITING_STATUS_TONE).sort()).toEqual(
      Object.keys(RECRUITING_STATUS_LABELS).sort(),
    );
  });

  it('maps the governed tones', () => {
    expect(RECRUITING_STATUS_TONE.open).toBe('ok');
    expect(RECRUITING_STATUS_TONE.canceled).toBe('danger');
    expect(RECRUITING_STATUS_TONE.on_hold).toBe('warn');
    expect(RECRUITING_STATUS_TONE.submittals_closed).toBe('brand');
    expect(RECRUITING_STATUS_TONE.lead).toBe('neutral');
  });
});
