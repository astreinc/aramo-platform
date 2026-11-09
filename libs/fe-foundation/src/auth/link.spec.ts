import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureAuthConsumer } from './consumer';
import { fetchSignInMethods, linkProviderUrl, linkRefusalMessage, parseLinkFragment, removeSignInMethod, startLinkEmail, verifyLinkEmail } from './link';
import { loginUrl } from './session';

// Apple Go-Live A1 — pending-link fragment, email-code proof, Sign-in methods.

const H = 'A'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  configureAuthConsumer('recruiter');
});

describe('parseLinkFragment', () => {
  it('reads link + idp from the fragment', () => {
    expect(parseLinkFragment(`#link=${H}&idp=apple`)).toEqual({ handle: H, idp: 'apple' });
    expect(parseLinkFragment(`link=${H}&idp=google`)).toEqual({ handle: H, idp: 'google' });
  });

  it('rejects missing, malformed or unknown values', () => {
    expect(parseLinkFragment('')).toBeNull();
    expect(parseLinkFragment(null)).toBeNull();
    expect(parseLinkFragment(`#link=${H}`)).toBeNull();
    expect(parseLinkFragment(`#link=${H}&idp=okta`)).toBeNull();
    expect(parseLinkFragment('#link=a%20b&idp=apple')).toBeNull();
  });
});

describe('loginUrl link / intent', () => {
  it('adds link and intent', () => {
    expect(loginUrl({ idp: 'google', link: H, returnTo: null, consumer: 'sign' })).toBe(`/auth/sign/login?idp=google&link=${H}`);
    expect(loginUrl({ idp: 'apple', intent: 'signup', returnTo: null, consumer: 'sign' })).toBe('/auth/sign/login?idp=apple&intent=signup');
  });
});

describe('email-code proof', () => {
  it('start posts the handle (and the email when given)', async () => {
    const f = vi.fn().mockResolvedValue(json({}, 202));
    vi.stubGlobal('fetch', f);
    expect(await startLinkEmail(H, 'pat@example.com')).toBe(true);
    expect(f).toHaveBeenCalledWith('/auth/link/email/start', expect.objectContaining({ method: 'POST', body: JSON.stringify({ link_handle: H, email: 'pat@example.com' }) }));
  });

  it('start reports a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await startLinkEmail(H)).toBe(false);
  });

  it('verify maps success and each refusal', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    f.mockResolvedValueOnce(json({ linked: true, idp: 'apple' }));
    expect(await verifyLinkEmail(H, '123456')).toEqual({ ok: true, idp: 'apple' });
    f.mockResolvedValueOnce(json({ error: { details: { reason: 'code_invalid', attempts_remaining: 2 } } }, 400));
    expect(await verifyLinkEmail(H, '1')).toEqual({ ok: false, reason: 'code_invalid', attemptsRemaining: 2 });
    for (const reason of ['code_expired', 'code_attempts_exceeded', 'link_expired'] as const) {
      f.mockResolvedValueOnce(json({ error: { details: { reason } } }, 400));
      expect(await verifyLinkEmail(H, '1')).toEqual({ ok: false, reason });
    }
    f.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    expect(await verifyLinkEmail(H, '1')).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('Sign-in methods', () => {
  it('lists the methods for the consumer, dropping unknown providers', async () => {
    configureAuthConsumer('sign');
    const f = vi.fn().mockResolvedValue(
      json({ items: [{ idp: 'google', email_snapshot: 'pat@gmail.com', linked_at: '2026-11-01T00:00:00Z' }, { idp: 'okta', email_snapshot: null, linked_at: 'x' }] }),
    );
    vi.stubGlobal('fetch', f);
    expect(await fetchSignInMethods()).toEqual([{ idp: 'google', email_snapshot: 'pat@gmail.com', linked_at: '2026-11-01T00:00:00Z' }]);
    expect(String(f.mock.calls[0]?.[0])).toBe('/auth/me/sign-in-methods?consumer=sign');
  });

  it('remove sends DELETE and surfaces the 409', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: { code: 'CONFLICT', message: 'x', details: { reason: 'last_sign_in_method' } } }, 409));
    vi.stubGlobal('fetch', f);
    await expect(removeSignInMethod('apple', 'sign')).rejects.toMatchObject({ status: 409, details: { reason: 'last_sign_in_method' } });
    expect(f).toHaveBeenCalledWith('/auth/me/sign-in-methods/apple?consumer=sign', expect.objectContaining({ method: 'DELETE' }));
  });

  it('linkProviderUrl and refusal copy', () => {
    expect(linkProviderUrl('apple', '/personal/settings/personal', 'sign')).toBe('/auth/sign/link?idp=apple&return=%2Fpersonal%2Fsettings%2Fpersonal');
    expect(linkRefusalMessage('identity_already_linked', 'Apple')).toBe('That Apple account is already connected to a different Aramo account.');
    expect(linkRefusalMessage(null, 'Apple')).toBe('We couldn’t connect Apple. Try again.');
  });
});
