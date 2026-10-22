import { afterEach, describe, expect, it } from 'vitest';

import {
  clearReturnContext,
  orgHref,
  parseReturnContext,
  readRememberedReturnContext,
  rememberReturnContext,
  validReturnPath,
} from './return-context';

// Cross-app return context (Settings & navigation baseline §C) — hardened like
// `return_to`: known apps only, relative paths inside the app's base only.
afterEach(() => window.sessionStorage.clear());

describe('return context', () => {
  it('accepts a relative path inside the app base and builds the Back label', () => {
    expect(validReturnPath('ats', '/ats/admin/settings/branches')).toBe(true);
    expect(validReturnPath('ats', '/ats/admin/settings/roles?x=1')).toBe(true);
    expect(parseReturnContext(`?from=ats&return=${encodeURIComponent('/ats/admin/settings/roles')}`)).toEqual({
      app: 'ats',
      href: '/ats/admin/settings/roles',
      label: 'Back to ATS Settings',
    });
    // ORG-UX-1 §7.2 — a relative Sign path is never accepted (Sign is on its own host).
    expect(parseReturnContext(`?from=sign&return=${encodeURIComponent('/sign/settings/branding')}`)).toBeNull();
  });

  // ORG-UX-1 (LOCKED §7.2, Lead Correction C) — trusted Sign origin AND Settings path only.
  describe('Sign (cross-host) return', () => {
    const SIGN = 'https://sign.aramo.ai';
    it('accepts an absolute Sign Settings URL on the trusted origin', () => {
      const href = `${SIGN}/sign/settings/branding`;
      expect(parseReturnContext(`?from=sign&return=${encodeURIComponent(href)}`, { signOrigin: SIGN })).toEqual({
        app: 'sign',
        href,
        label: 'Back to Sign Settings',
      });
      expect(validReturnPath('sign', `${SIGN}/sign/settings/members?tab=1`, { signOrigin: SIGN })).toBe(true);
    });
    it('refuses without a trusted origin, on another origin, outside Settings, with credentials, encodings or fragments', () => {
      for (const bad of [
        'https://evil.example/sign/settings/branding',
        'https://sign.aramo.ai.evil.example/sign/settings/x',
        'http://sign.aramo.ai/sign/settings/x',
        `${SIGN}/sign/envelopes`,
        `${SIGN}/sign/settings`,
        `${SIGN}/sign/settings/../envelopes`,
        `${SIGN}/sign/settings/%2e%2e/envelopes`,
        `${SIGN}/sign/settings/%2fevil`,
        `${SIGN}/sign/settings//evil.example`,
        'https://user:pw@sign.aramo.ai/sign/settings/x',
        `${SIGN}/sign/settings/x#frag`,
        `${SIGN}/sign/settings/a b`,
        `${SIGN}/sign/settings/${'a'.repeat(600)}`,
        'javascript:alert(1)',
        '/sign/settings/x',
      ]) {
        expect(validReturnPath('sign', bad, { signOrigin: SIGN }), bad).toBe(false);
      }
      expect(validReturnPath('sign', `${SIGN}/sign/settings/x`)).toBe(false);
      expect(validReturnPath('sign', `${SIGN}/sign/settings/x`, { signOrigin: null })).toBe(false);
    });
  });

  it('refuses external, protocol-relative, cross-app, scheme-like, whitespace and over-long destinations', () => {
    for (const bad of [
      'https://evil.example/ats/',
      '//evil.example/ats/',
      '/ats//evil.example',
      '/org/users',
      '/sign/x',
      '/ats/x:y',
      '/ats/a b',
      '/ats/\\evil',
      `/ats/${'a'.repeat(600)}`,
      '',
    ]) {
      expect(validReturnPath('ats', bad)).toBe(false);
    }
    expect(parseReturnContext('?from=crm&return=/ats/x')).toBeNull();
    expect(parseReturnContext('?from=ats')).toBeNull();
  });

  it('orgHref carries a valid context and drops an invalid one', () => {
    expect(orgHref('sites', { app: 'ats', path: '/ats/admin/settings/branches' })).toBe(
      `/org/sites?from=ats&return=${encodeURIComponent('/ats/admin/settings/branches')}`,
    );
    expect(orgHref('sites', { app: 'ats', path: 'https://evil.example' })).toBe('/org/sites');
    expect(orgHref('users')).toBe('/org/users');
  });

  it('the remembered context is re-validated on read (tampered storage is ignored) and clears', () => {
    rememberReturnContext({ app: 'ats', href: '/ats/admin/tools', label: 'Back to ATS Settings' });
    expect(readRememberedReturnContext()?.href).toBe('/ats/admin/tools');
    window.sessionStorage.setItem('aramo.org.return', JSON.stringify({ app: 'ats', href: 'https://evil.example' }));
    expect(readRememberedReturnContext()).toBeNull();
    rememberReturnContext({ app: 'ats', href: '/ats/x', label: '' });
    clearReturnContext();
    expect(readRememberedReturnContext()).toBeNull();
  });
});
