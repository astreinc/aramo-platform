import { describe, expect, it } from 'vitest';

import { deriveSkillTimeline } from '../lib/skill-usage-timeline.js';
import { parseResumeDate, type ResumeDate } from '../lib/resume-date.js';

// HF2 R14/R15 + R27 — interval-union derivation over NORMALIZED precision-carrying
// dates only. Helpers build ResumeDate via the strict parser (never new Date()).
const y = (year: string): ResumeDate => parseResumeDate(year) as ResumeDate;
const ASOF = parseResumeDate('2026-01') as ResumeDate;

describe('deriveSkillTimeline — union, not sum, precision-carried (R14/R27)', () => {
  it('unions overlapping/adjacent year intervals (R14 example: ~6y not 7)', () => {
    const t = deriveSkillTimeline(
      [
        { start: y('2018'), end: y('2020'), ongoing: false },
        { start: y('2020'), end: y('2023'), ongoing: false },
        { start: y('2022'), end: y('2024'), ongoing: false },
      ],
      ASOF,
    );
    // 2018-Jan → 2024-Dec union = 83 months (~6.9y); NOT the 7×12 naive sum.
    expect(t.supported_months).toBe(83);
    expect(t.precision).toBe('YEAR'); // honestly approximate — year-only inputs
    expect(t.current_usage).toBe(false);
  });

  it('ongoing interval extends to asOf and flags current_usage', () => {
    const t = deriveSkillTimeline(
      [{ start: parseResumeDate('2024-01') as ResumeDate, end: null, ongoing: true }],
      ASOF,
    );
    expect(t.current_usage).toBe(true);
    expect(t.supported_months).toBe(24); // 2024-01 → 2026-01
    expect(t.precision).toBe('MONTH');
  });

  it('disjoint spans summed separately', () => {
    const t = deriveSkillTimeline(
      [
        { start: y('2010'), end: y('2011'), ongoing: false }, // 2010-Jan→2011-Dec = 23
        { start: y('2020'), end: y('2020'), ongoing: false }, // 2020-Jan→2020-Dec = 11
      ],
      ASOF,
    );
    expect(t.supported_months).toBe(34);
  });

  it('no start (unknown/unparseable, Level C) contributes nothing; empty → zeros', () => {
    expect(deriveSkillTimeline([{ start: null, end: null, ongoing: false }], ASOF)).toEqual({
      first_used: null, last_used: null, current_usage: false, supported_months: 0, precision: null,
    });
    expect(deriveSkillTimeline([], ASOF).supported_months).toBe(0);
  });

  it('mixed precision degrades to the COARSEST (a year input makes the whole derivation year-approximate)', () => {
    const t = deriveSkillTimeline(
      [
        { start: parseResumeDate('2020-03-01') as ResumeDate, end: parseResumeDate('2021-06') as ResumeDate, ongoing: false },
        { start: y('2022'), end: y('2023'), ongoing: false }, // YEAR precision
      ],
      ASOF,
    );
    expect(t.precision).toBe('YEAR');
  });
});

describe('parseResumeDate — canonical strict normalization (R27)', () => {
  it('parses the confidence-safe shapes with correct precision', () => {
    expect(parseResumeDate('2021-03-01')).toEqual({ year: 2021, month: 3, day: 1, precision: 'EXACT' });
    expect(parseResumeDate('2021-03')).toEqual({ year: 2021, month: 3, day: null, precision: 'MONTH' });
    expect(parseResumeDate('Mar 2020')).toEqual({ year: 2020, month: 3, day: null, precision: 'MONTH' });
    expect(parseResumeDate('March 2020')).toEqual({ year: 2020, month: 3, day: null, precision: 'MONTH' });
    expect(parseResumeDate('03/2020')).toEqual({ year: 2020, month: 3, day: null, precision: 'MONTH' });
    expect(parseResumeDate('2021')).toEqual({ year: 2021, month: null, day: null, precision: 'YEAR' });
  });

  it('REFUSES ambiguous / unparseable text (never a guessed date)', () => {
    for (const bad of ['Summer 2021', 'early 2020', 'sometime 2019', '', 'Q3 2021', 'yesterday', 'Spring']) {
      expect(parseResumeDate(bad)).toBeNull();
    }
  });

  it('"present"/"current" are NOT dates (ongoing tokens, parsed as null)', () => {
    expect(parseResumeDate('present')).toBeNull();
    expect(parseResumeDate('Current')).toBeNull();
  });
});
