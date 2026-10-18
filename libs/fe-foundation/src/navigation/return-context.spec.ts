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
    expect(parseReturnContext(`?from=sign&return=${encodeURIComponent('/sign/app/settings/branding')}`)?.label).toBe('Back to Sign Settings');
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
