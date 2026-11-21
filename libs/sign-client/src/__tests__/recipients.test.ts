// Client Rule Consolidation C2-5 — runs under vitest and mobile Jest (globals only).
// Audit row 21 (copy recipient limit) and the recipient kinds (M-A5 §1.3).
import { COPY_DELIVERIES, MAX_COPY_RECIPIENTS, RECIPIENT_KINDS, SIGNING_RECIPIENT_KINDS } from '../index.js';

describe('recipient kinds and limits', () => {
  it.each([
    ['RECIPIENT_KINDS', [...RECIPIENT_KINDS], ['SIGNER', 'IN_PERSON_SIGNER', 'RECEIVES_COPY', 'WITNESS']],
    ['SIGNING_RECIPIENT_KINDS', [...SIGNING_RECIPIENT_KINDS], ['SIGNER', 'IN_PERSON_SIGNER', 'WITNESS']],
    ['COPY_DELIVERIES', [...COPY_DELIVERIES], ['ON_SEND', 'ON_COMPLETION', 'BOTH']],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  it('at most 10 copy recipients', () => {
    expect(MAX_COPY_RECIPIENTS).toBe(10);
  });

  it('a copy recipient never signs', () => {
    expect(SIGNING_RECIPIENT_KINDS.includes('RECEIVES_COPY')).toBe(false);
  });
});
