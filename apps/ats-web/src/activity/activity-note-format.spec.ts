import { describe, expect, it } from 'vitest';

import { formatActivityNote } from './activity-note-format';

describe('formatActivityNote — system transition notes read as recruiter-facing stages', () => {
  it.each([
    ['pipeline no_contact -> contacted', 'No contact → Contacted'],
    ['pipeline contacted -> talent_responded', 'Contacted → Talent responded'],
    ['pipeline talent_responded -> qualifying', 'Talent responded → Qualifying'],
    ['pipeline qualifying -> qualified', 'Qualifying → Qualified'],
    ['pipeline qualified -> not_in_consideration', 'Qualified → Not in consideration'],
  ])('%s', (raw, expected) => {
    expect(formatActivityNote(raw)).toBe(expected);
  });

  it('the VOID correction reads as a removal, without the internal reason code', () => {
    expect(
      formatActivityNote('pipeline no_contact -> voided (accidental-add correction: ADDED_BY_MISTAKE)'),
    ).toBe('No contact → Removed (added by mistake)');
  });

  it('keeps the recruiter note and drops the internal evidence provenance ids', () => {
    expect(
      formatActivityNote('pipeline contacted -> talent_responded: replied by email [evidence communication:9f1c]'),
    ).toBe('Contacted → Talent responded — replied by email');
    expect(formatActivityNote('pipeline contacted -> talent_responded [evidence communication:9f1c]')).toBe(
      'Contacted → Talent responded',
    );
  });

  it('leaves human notes and unknown statuses verbatim (never guesses)', () => {
    expect(formatActivityNote('Called back, left voicemail')).toBe('Called back, left voicemail');
    expect(formatActivityNote('pipeline no_contact -> mystery_state')).toBe('pipeline no_contact -> mystery_state');
  });
});
