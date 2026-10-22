import { describe, expect, it } from 'vitest';

import {
  CONTACT_DETAILS_CONFIRMED,
  CONTACT_DETAILS_UNCONFIRMED,
  POSSIBLE_DUPLICATE,
  contactDetailsChip,
  contactDetailsEvidence,
} from './t360-model';

// ATS-QA-1 I-2 — Talent 360 §14 conformance: the header reports contact-details OUTCOMES
// (primary email + mobile confirmed), never a legal/government identity verification; a
// possible duplicate is a separate status.
describe('contact details (Talent 360 §14)', () => {
  const id = (primary_email_confirmed: boolean, mobile_confirmed: boolean) => ({
    primary_email_confirmed,
    mobile_confirmed,
    advisory: null,
  });

  it.each([
    [true, true, CONTACT_DETAILS_CONFIRMED, 'green', 'Primary email confirmed · mobile confirmed'],
    [true, false, CONTACT_DETAILS_UNCONFIRMED, 'amber', 'Primary email confirmed · mobile not yet confirmed'],
    [false, true, CONTACT_DETAILS_UNCONFIRMED, 'amber', 'Mobile confirmed · primary email not yet confirmed'],
    [false, false, CONTACT_DETAILS_UNCONFIRMED, 'amber', 'Not yet confirmed'],
  ] as const)('email=%s mobile=%s → %s', (email, mobile, label, tone, evidence) => {
    expect(contactDetailsChip(id(email, mobile))).toEqual({ label, tone });
    expect(contactDetailsEvidence(id(email, mobile))).toBe(evidence);
  });

  it('a duplicate advisory never changes the contact-details chip', () => {
    const adv = { advisory_id: 'a', label: 'Possible duplicate needs review' };
    expect(contactDetailsChip({ primary_email_confirmed: true, mobile_confirmed: true, advisory: adv }).label).toBe(
      CONTACT_DETAILS_CONFIRMED,
    );
  });

  it('copy never implies identity verification', () => {
    for (const s of [CONTACT_DETAILS_CONFIRMED, CONTACT_DETAILS_UNCONFIRMED, POSSIBLE_DUPLICATE]) {
      expect(s).not.toMatch(/identity|verified|verification|government|legal/i);
    }
    expect(CONTACT_DETAILS_CONFIRMED).toBe('Contact details confirmed');
    expect(CONTACT_DETAILS_UNCONFIRMED).toBe('Contact details · not yet confirmed');
    expect(POSSIBLE_DUPLICATE).toBe('Possible duplicate — review needed');
  });
});
