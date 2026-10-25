import { NATIVE_FALLBACK_REDIRECT_URI, NATIVE_REDIRECT_URI } from '../../config/env';
import { SIGNING_TOKEN } from '../../testing/fakes';
import { stashGuestToken, takeGuestToken } from '../guestTokenVault';
import { requiresSession, routeLink } from '../routeLink';

const UUID = '3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f';

describe('deep-link routing (M-A2 §3.3)', () => {
  it.each([
    [
      `https://sign.aramo.ai/s/${SIGNING_TOKEN}`,
      { kind: 'guest', mode: 'sign', token: SIGNING_TOKEN },
    ],
    [
      `https://sign.aramo.ai/s/${SIGNING_TOKEN}/`,
      { kind: 'guest', mode: 'sign', token: SIGNING_TOKEN },
    ],
    [
      `https://SIGN.ARAMO.AI/d/${SIGNING_TOKEN}?utm=x`,
      { kind: 'guest', mode: 'download', token: SIGNING_TOKEN },
    ],
    [
      `https://sign.aramo.ai/auth/native/callback?code=c&state=s`,
      { kind: 'auth-callback', url: `${NATIVE_REDIRECT_URI}?code=c&state=s` },
    ],
    [
      `aramosign://auth/callback?code=c&state=s`,
      { kind: 'auth-callback', url: `${NATIVE_FALLBACK_REDIRECT_URI}?code=c&state=s` },
    ],
    [`aramosign://envelope/${UUID}`, { kind: 'envelope', envelopeId: UUID }],
    [`aramosign://sign/${UUID.toUpperCase()}`, { kind: 'inbox-sign', envelopeId: UUID }],
  ])('routes %s', (url, expected) => {
    expect(routeLink(url)).toEqual(expected);
  });

  it.each([
    'https://sign.aramo.ai/legal/terms',
    'https://sign.aramo.ai/',
    'https://sign.aramo.ai',
    'https://sign.aramo.ai/inbox?x=1',
  ])('opens other Sign-host paths in the browser: %s', (url) => {
    expect(routeLink(url).kind).toBe('browser');
  });

  it.each([
    `https://evil.example/s/${SIGNING_TOKEN}`,
    `https://sign.aramo.ai.evil.example/s/${SIGNING_TOKEN}`,
    `https://user@sign.aramo.ai/s/${SIGNING_TOKEN}`,
    `https://sign.aramo.ai:8443/s/${SIGNING_TOKEN}`,
    `http://sign.aramo.ai/s/${SIGNING_TOKEN}`,
    `javascript:alert(1)`,
    `aramosign://other/${UUID}`,
    `aramosign://envelope/not-a-uuid`,
    `aramosign://auth/callbackx?code=c`,
    `https://sign.aramo.ai/s/short`,
    `https://sign.aramo.ai/s/${SIGNING_TOKEN}/extra`,
    `https://sign.aramo.ai/s/%2e%2e%2fsender`,
    `https://sign.aramo.ai/s/`,
    `https://sign.aramo.ai/auth/native/callback/../x`,
    '',
  ])('rejects foreign hosts, schemes and malformed signing links: %s', (url) => {
    const r = routeLink(url);
    expect(r.kind === 'ignore' || r.kind === 'browser').toBe(true);
    expect(r.kind).not.toBe('guest');
    if (url.includes('/s/') || url.includes('/d/')) expect(r.kind).toBe('ignore');
  });

  it('only authenticated targets need a session', () => {
    expect(requiresSession(routeLink(`aramosign://envelope/${UUID}`))).toBe(true);
    expect(requiresSession(routeLink(`https://sign.aramo.ai/s/${SIGNING_TOKEN}`))).toBe(false);
  });
});

describe('guest token vault', () => {
  it('hands the token over once by handle; the handle is not the token', () => {
    const handle = stashGuestToken(SIGNING_TOKEN);
    expect(handle).not.toContain(SIGNING_TOKEN);
    expect(takeGuestToken(handle)).toBe(SIGNING_TOKEN);
    expect(takeGuestToken(handle)).toBeNull();
  });
});
