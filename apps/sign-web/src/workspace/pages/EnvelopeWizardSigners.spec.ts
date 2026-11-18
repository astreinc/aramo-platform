import { describe, expect, it } from 'vitest';

import { MAX_SIGNERS } from '../api';
import { signersFullText } from './EnvelopeWizard';

// UAT SND-05 — the 10-signer limit is said, not applied silently.
describe('signer limit note', () => {
  it('says the limit and what happens to the next person', () => {
    expect(MAX_SIGNERS).toBe(10);
    expect(signersFullText(false)).toBe('An envelope can have up to 10 signers. Anyone else you add receives a copy.');
    expect(signersFullText(true)).toMatch(/^An envelope can have up to 10 signers and \d+ people who receive a copy\.$/);
  });
});
