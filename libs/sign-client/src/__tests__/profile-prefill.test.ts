// Runs under vitest and mobile Jest (globals only).
import {
  PROFILE_OFFER_COPY,
  isPrefillTarget,
  profileOfferFor,
  profileOffers,
  profilePrefill,
  senderHeldPrefills,
  type PrefillFieldLike,
} from '../index.js';

// Field-test batch 1 §2 SIG-2, as amended by A1 — the one profile rule for the server, the web
// signing page and the Aramo Sign app.
describe('profilePrefill — the values by field type (SIG-2)', () => {
  it('maps the profile and the recipient email', () => {
    expect(profilePrefill({ display_name: 'Priya Devi Raman', company: 'Northwind', title: 'Recruiter' }, 'priya@example.com')).toEqual({
      FIRST_NAME: 'Priya',
      LAST_NAME: 'Devi Raman',
      EMAIL: 'priya@example.com',
      COMPANY: 'Northwind',
      TITLE: 'Recruiter',
    });
  });

  it('a single word is the first name only: the last name stays empty (never a copy)', () => {
    expect(profilePrefill({ display_name: '  Priya  ' }, null)).toEqual({ FIRST_NAME: 'Priya' });
  });

  it('omits empty values; never fills the signer-name field', () => {
    expect(profilePrefill({ display_name: ' ', company: '  ', title: null }, '  ')).toEqual({});
    expect(profilePrefill(null, 'a@b.test')).toEqual({ EMAIL: 'a@b.test' });
    expect(Object.keys(profilePrefill({ display_name: 'Jo Signer', company: 'X', title: 'Y' }, 'a@b.test'))).not.toContain('SIGNER_NAME');
  });
});

describe('offers and sender-held values (A1-2, A1-3)', () => {
  type F = PrefillFieldLike & { id: string };
  const f = (id: string, field_type: string, extra: Partial<F> = {}): F => ({ id, field_type, ...extra });
  const prefill = profilePrefill({ display_name: 'Priya Raman', company: 'IBM', title: 'Recruiter' }, 'priya@example.com');

  it('guards: read-only, sender-filled, server-filled and non-profile fields are never targets', () => {
    expect(isPrefillTarget(f('c', 'COMPANY'))).toBe(true);
    expect(isPrefillTarget(f('c', 'COMPANY', { read_only: true }))).toBe(false);
    expect(isPrefillTarget(f('c', 'COMPANY', { sender_filled: true }))).toBe(false);
    expect(isPrefillTarget(f('c', 'COMPANY', { server_filled: true }))).toBe(false);
    expect(isPrefillTarget(f('n', 'SIGNER_NAME', { name_mode: 'SIGNER_PROFILE' }))).toBe(false);
    expect(isPrefillTarget(f('n', 'SIGNER_NAME', { name_mode: 'SIGNER_ENTERED' }))).toBe(false);
    expect(isPrefillTarget(f('t', 'TEXT'))).toBe(false);
  });

  it('offers only the empty, editable profile fields; EMAIL is never an offer', () => {
    const fields = [f('c', 'COMPANY'), f('t', 'TITLE'), f('e', 'EMAIL'), f('fn', 'FIRST_NAME', { read_only: true }), f('ln', 'LAST_NAME')];
    const offers = profileOffers(fields, prefill, (x) => x.id === 'ln');
    expect(offers.map((o) => [o.field.id, o.value])).toEqual([
      ['c', 'IBM'],
      ['t', 'Recruiter'],
    ]);
    expect(profileOfferFor(f('c', 'COMPANY'), prefill, false)).toBe('IBM');
    expect(profileOfferFor(f('c', 'COMPANY'), prefill, true)).toBeNull();
    expect(profileOfferFor(f('e', 'EMAIL'), prefill, false)).toBeNull();
  });

  it('no prefill (an emailed link, a hosted session, a guest): no offers and nothing pre-filled', () => {
    const fields = [f('c', 'COMPANY'), f('e', 'EMAIL')];
    expect(profileOffers(fields, null, () => false)).toEqual([]);
    expect(senderHeldPrefills(fields, null, () => false)).toEqual([]);
  });

  it('pre-fills the recipient email on an empty, editable EMAIL field only', () => {
    const fields = [f('e1', 'EMAIL'), f('e2', 'EMAIL', { sender_filled: true }), f('e3', 'EMAIL'), f('c', 'COMPANY')];
    expect(senderHeldPrefills(fields, prefill, (x) => x.id === 'e3').map((m) => [m.field.id, m.value])).toEqual([['e1', 'priya@example.com']]);
  });

  it('one wording for the banner, the hint and the notice', () => {
    expect(PROFILE_OFFER_COPY.banner).toBe('Fill from my profile');
    expect(PROFILE_OFFER_COPY.hint('IBM')).toBe('Use from my profile: IBM');
    expect(PROFILE_OFFER_COPY.filled(2)).toBe('Filled 2 fields from your profile. Check them before you finish.');
  });
});
