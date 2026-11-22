import { describe, expect, it } from 'vitest';

import { MAX_SIGNERS } from '../api';

import { signersFullText } from './EnvelopeWizard';

// UAT SND-05 / C3 (audit row 20, Appendix A) — the 10-signer limit is said; the 11th signer is
// refused, never turned into a copy recipient.
describe('signer limit note', () => {
  it('says the limit and how to add someone who receives a copy', () => {
    expect(MAX_SIGNERS).toBe(10);
    expect(signersFullText(false)).toBe('An envelope can have at most 10 signers. Add anyone else as someone who receives a copy.');
    expect(signersFullText(true)).toMatch(/^An envelope can have at most 10 signers\. It can also have at most \d+ people who receive a copy\.$/);
  });
});
