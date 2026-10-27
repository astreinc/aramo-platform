import { describe, expect, it } from 'vitest';

import { cognitoCreateUserAttributes } from '../lib/util/cognito-attributes.js';

// COG-ATTR-1 (LOCKED 2026-10-27) — the AdminCreateUser attribute set the `aramo-platform` pool
// requires: name / given_name / family_name / profile, always non-empty, derived only from the
// invite's email and display name.

const asMap = (attrs: { Name: string; Value: string }[]) => Object.fromEntries(attrs.map((a) => [a.Name, a.Value]));

describe('cognitoCreateUserAttributes (COG-ATTR-1)', () => {
  it('COG-1 a two-word display name splits into given / family; profile is the email', () => {
    expect(asMap(cognitoCreateUserAttributes({ email: 'finance_admin@aramo.ai', display_name: 'Aramo Finance' }))).toEqual({
      email: 'finance_admin@aramo.ai',
      email_verified: 'true',
      name: 'Aramo Finance',
      given_name: 'Aramo',
      family_name: 'Finance',
      profile: 'finance_admin@aramo.ai',
    });
  });

  it('COG-2 a multi-word family name keeps every remaining token', () => {
    const m = asMap(cognitoCreateUserAttributes({ email: 'x@aramo.ai', display_name: 'Ana Maria de la Cruz' }));
    expect([m['given_name'], m['family_name']]).toEqual(['Ana', 'Maria de la Cruz']);
  });

  it('COG-3 a single token fills both given and family name', () => {
    const m = asMap(cognitoCreateUserAttributes({ email: 'x@aramo.ai', display_name: 'Priya' }));
    expect([m['name'], m['given_name'], m['family_name']]).toEqual(['Priya', 'Priya', 'Priya']);
  });

  it.each([undefined, null, '', '   '])('COG-4 no display name (%j) falls back to the email local part', (display_name) => {
    const m = asMap(cognitoCreateUserAttributes({ email: 'catalog_manager@aramo.ai', display_name }));
    expect([m['name'], m['given_name'], m['family_name']]).toEqual(['catalog_manager', 'catalog_manager', 'catalog_manager']);
  });

  it('COG-5 whitespace is trimmed and collapsed; the email is normalized', () => {
    const m = asMap(cognitoCreateUserAttributes({ email: '  Dev.Raman@ARAMO.ai ', display_name: '  Dev   Raman  ' }));
    expect(m).toMatchObject({ email: 'dev.raman@aramo.ai', name: 'Dev Raman', given_name: 'Dev', family_name: 'Raman', profile: 'dev.raman@aramo.ai' });
  });

  it('COG-6 every value is non-empty and within the 2048-character limit', () => {
    const long = `A ${'b'.repeat(3000)}`;
    for (const a of cognitoCreateUserAttributes({ email: 'x@aramo.ai', display_name: long })) {
      expect(a.Value.length).toBeGreaterThan(0);
      expect(a.Value.length).toBeLessThanOrEqual(2048);
    }
  });
});
