import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountLinkDirectory } from '../lib/account-link-directory.port.js';
import { AccountLinkService, LinkEmailBudget, isLinkHandle } from '../lib/account-link.service.js';
import { renderLinkCodeEmail, renderSignInMethodNoticeEmail } from '../lib/account-link-email.js';
import { encodeSignupHandoff, mapIdpHint, mapPinnedIdpHint } from '../lib/auth.controller.js';
import type { PrincipalDirectory, ResolveSessionResult } from '../lib/principal-directory.port.js';
import { SessionOrchestratorService } from '../lib/session-orchestrator.service.js';

// Apple Go-Live (LOCKED) W1 + Amendment A1 (LOCKED) — auth-side units:
//   - the Cognito provider-name mapping (R-1);
//   - the pending-link offer (L-2), the email-code start (same answer, no wait on
//     the send), the security notices (L-5);
//   - the callback orchestration: R-5 signup hand-off never issues a session, a
//     pending link never issues a session, path 1 never resolves or mints one,
//     proof (a) attaches after a normal sign-in.

const HANDLE = 'Q'.repeat(43);

type Fn = ReturnType<typeof vi.fn>;
function fakeDirectory(): { [K in keyof AccountLinkDirectory]: Fn } {
  return {
    createPendingLink: vi.fn(async (i: { idp: string }) => ({ handle: HANDLE, idp: i.idp })),
    attachPendingLink: vi.fn(async () => ({ ok: true, idp: 'apple', account_email: 'owner@example.com' })),
    attachIdentity: vi.fn(async (i: { idp: string }) => ({ ok: true, idp: i.idp, account_email: 'owner@example.com' })),
    startEmailProof: vi.fn(async () => ({ to: 'owner@example.com', code: '123456', idp: 'apple' })),
    verifyEmailProof: vi.fn(async () => ({ ok: true, idp: 'apple', account_email: 'owner@example.com' })),
    listSignInMethods: vi.fn(async () => []),
    removeSignInMethod: vi.fn(async () => ({ ok: true, idp: 'google', account_email: 'owner@example.com' })),
  };
}

describe('Apple Go-Live R-1 — provider name mapping', () => {
  it('maps button values to Cognito provider names (closed allowlist)', () => {
    expect(mapIdpHint('apple')).toBe('SignInWithApple');
    expect(mapIdpHint('APPLE')).toBe('SignInWithApple');
    expect(mapIdpHint('google')).toBe('Google');
    expect(mapIdpHint('microsoft')).toBe('microsoft');
    expect(mapIdpHint('okta')).toBeNull();
  });
  it('maps a pinned Aramo value; passes an unknown pin through verbatim', () => {
    expect(mapPinnedIdpHint('apple')).toBe('SignInWithApple');
    expect(mapPinnedIdpHint('google')).toBe('Google');
    expect(mapPinnedIdpHint('LegacyName')).toBe('LegacyName');
  });
  it('encodes the R-5 hand-off as base64url JSON', () => {
    const v = encodeSignupHandoff({ email: 'a@privaterelay.appleid.com', given_name: null, family_name: 'L' });
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(v, 'base64url').toString('utf8'))).toEqual({ email: 'a@privaterelay.appleid.com', given_name: null, family_name: 'L' });
  });
});

describe('AccountLinkService (A1)', () => {
  let dir: ReturnType<typeof fakeDirectory>;
  let send: Fn;
  let svc: AccountLinkService;
  beforeEach(() => {
    dir = fakeDirectory();
    send = vi.fn(async () => ({ message_id: 'm' }));
    svc = new AccountLinkService(dir as unknown as AccountLinkDirectory, { send } as never, new LinkEmailBudget());
  });

  it('isLinkHandle accepts only 43-char base64url', () => {
    expect(isLinkHandle(HANDLE)).toBe(true);
    expect(isLinkHandle('x')).toBe(false);
    expect(isLinkHandle(`${HANDLE}=`)).toBe(false);
    expect(isLinkHandle(42)).toBe(false);
  });

  it('offers a pending link only for the two linkable denials and a known provider', async () => {
    const id = { sub: 's', email: 'a@b.test', idp: 'apple' };
    expect(await svc.offerPendingLink('user_not_provisioned', id)).toEqual({ handle: HANDLE, idp: 'apple' });
    expect(await svc.offerPendingLink('idp_identity_conflict', { ...id, idp: 'google' })).toEqual({ handle: HANDLE, idp: 'google' });
    expect(await svc.offerPendingLink('tenant_suspended', id)).toBeNull();
    expect(await svc.offerPendingLink('user_not_provisioned', { ...id, idp: 'ambiguous' })).toBeNull();
    expect(await svc.offerPendingLink('user_not_provisioned', { ...id, idp: null })).toBeNull();
    expect(dir.createPendingLink).toHaveBeenCalledTimes(2);
  });

  it('a pending-link store failure leaves the denial unchanged (null, no throw)', async () => {
    dir.createPendingLink.mockRejectedValueOnce(new Error('db down'));
    expect(await svc.offerPendingLink('user_not_provisioned', { sub: 's', email: 'e', idp: 'apple' })).toBeNull();
  });

  it('email start: sends the code without awaiting the mail; nothing for a malformed handle or no account', async () => {
    let release!: () => void;
    send.mockImplementationOnce(() => new Promise((r) => (release = () => r({ message_id: 'm' }))));
    await svc.startEmailProof({ handle: HANDLE, email: 'owner@example.com', ip: '1.1.1.1' });
    // Returned while the mail is still pending: the same time class as "no account".
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com', subject: 'Your Aramo verification code' }));
    release();
    dir.startEmailProof.mockResolvedValueOnce(null);
    await svc.startEmailProof({ handle: HANDLE, email: 'nobody@example.com', ip: '1.1.1.2' });
    await svc.startEmailProof({ handle: 'bad', email: 'x', ip: '1.1.1.3' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(dir.startEmailProof).toHaveBeenCalledTimes(2);
  });

  it('email start: the per-IP budget stops sending after 10 calls in the window', async () => {
    for (let i = 0; i < 12; i += 1) await svc.startEmailProof({ handle: HANDLE, email: 'owner@example.com', ip: '9.9.9.9' });
    expect(dir.startEmailProof).toHaveBeenCalledTimes(10);
  });

  it('security email on add (verify / signed-in / proof a) and on remove; none on refusal', async () => {
    await svc.verifyEmailProof({ handle: HANDLE, code: '123456' });
    await svc.attachSignedIn('u', { sub: 's', email: 'e', idp: 'google' });
    await svc.attachAfterSignIn(HANDLE, 'u');
    await svc.removeSignInMethod('u', 'google');
    const subjects = send.mock.calls.map(([m]) => (m as { subject: string }).subject);
    expect(subjects).toEqual([
      'Apple sign-in added to your Aramo account',
      'Google sign-in added to your Aramo account',
      'Apple sign-in added to your Aramo account',
      'Google sign-in removed from your Aramo account',
    ]);
    send.mockClear();
    dir.attachIdentity.mockResolvedValueOnce({ ok: false, reason: 'idp_already_linked' });
    expect(await svc.attachSignedIn('u', { sub: 's', email: 'e', idp: 'google' })).toEqual({ ok: false, reason: 'idp_already_linked' });
    dir.removeSignInMethod.mockResolvedValueOnce({ ok: false, reason: 'last_sign_in_method' });
    await svc.removeSignInMethod('u', 'google');
    expect(send).not.toHaveBeenCalled();
  });

  it('a malformed handle at verify is link_expired without touching the store', async () => {
    expect(await svc.verifyEmailProof({ handle: 'x', code: '1' })).toEqual({ ok: false, reason: 'link_expired' });
    expect(dir.verifyEmailProof).not.toHaveBeenCalled();
  });

  it('the emails name the provider and carry no link', () => {
    const code = renderLinkCodeEmail({ code: '654321', idp: 'apple' });
    expect(code.text).toContain('654321');
    expect(code.text).toContain('Apple');
    expect(code.html).not.toContain('href');
    const notice = renderSignInMethodNoticeEmail({ idp: 'microsoft', change: 'added' });
    expect(notice.text).toContain('Microsoft was added as a sign-in method to your Aramo account.');
    expect(notice.text).toContain("If this wasn't you");
  });
});

describe('SessionOrchestratorService — Apple Go-Live linking branches', () => {
  const ENV = {
    AUTH_COGNITO_DOMAIN: 'auth.example.test',
    AUTH_COGNITO_CLIENT_ID: 'client',
    AUTH_COGNITO_REDIRECT_URI: 'https://sign.example.test/auth/sign/callback',
  };
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  function build(opts: { sealed?: Record<string, unknown>; resolution: ResolveSessionResult; idp?: string }) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id_token: 'id-token' }) })));
    const pkce = {
      decryptState: vi.fn().mockReturnValue({
        verifier: 'v',
        state: 'st',
        consumer: 'sign',
        issued_at: Math.floor(Date.now() / 1000),
        ...(opts.sealed ?? {}),
      }),
    };
    const cognito = {
      verify: vi.fn(async () => ({
        sub: 'apple-sub',
        email: 'x7k2@privaterelay.appleid.com',
        email_verified: true,
        token_use: 'id',
        idp: opts.idp ?? 'apple',
        given_name: 'Ada',
        family_name: null,
      })),
    };
    const principals = { resolveSession: vi.fn(async () => opts.resolution), resolveScopes: vi.fn() };
    const refreshTokens = { create: vi.fn(async () => ({ id: 'rt' })) };
    const jwtIssuer = { sign: vi.fn(async () => 'jwt') };
    const auditSink = { record: vi.fn(async () => undefined) };
    const dir = fakeDirectory();
    const send = vi.fn(async () => ({ message_id: 'm' }));
    const links = new AccountLinkService(dir as unknown as AccountLinkDirectory, { send } as never, new LinkEmailBudget());
    const orch = new SessionOrchestratorService(
      pkce as never,
      cognito as never,
      principals as unknown as PrincipalDirectory,
      refreshTokens as never,
      jwtIssuer as never,
      auditSink as never,
      links,
    );
    const run = () =>
      orch.handleCallback({ consumer: 'sign', code: 'c', state: 'st', cognitoError: undefined, cognitoErrorDescription: undefined, pkceStateCipher: 'cipher' });
    return { run, principals, refreshTokens, jwtIssuer, dir };
  }

  it('R-5: signup intent + user_not_provisioned → signup_handoff; no session, no pending link', async () => {
    const h = build({ sealed: { intent: 'signup' }, resolution: { kind: 'denied', reason: 'user_not_provisioned' } });
    expect(await h.run()).toEqual({ kind: 'signup_handoff', email: 'x7k2@privaterelay.appleid.com', given_name: 'Ada', family_name: null });
    expect(h.refreshTokens.create).not.toHaveBeenCalled();
    expect(h.jwtIssuer.sign).not.toHaveBeenCalled();
    expect(h.dir.createPendingLink).not.toHaveBeenCalled();
  });

  it('L-2: user_not_provisioned without intent → auth_error with a pending link; never a session', async () => {
    const h = build({ resolution: { kind: 'denied', reason: 'user_not_provisioned' } });
    expect(await h.run()).toEqual({ kind: 'auth_error', reason: 'user_not_provisioned', link: { handle: HANDLE, idp: 'apple' } });
    expect(h.refreshTokens.create).not.toHaveBeenCalled();
    expect(h.jwtIssuer.sign).not.toHaveBeenCalled();
  });

  it('L-2: R-3 Business relay mismatch stays a denial (the relay email matches no work account)', async () => {
    const h = build({ resolution: { kind: 'denied', reason: 'idp_not_permitted_for_tenant' } });
    expect(await h.run()).toEqual({ kind: 'auth_error', reason: 'idp_not_permitted_for_tenant' });
    expect(h.dir.createPendingLink).not.toHaveBeenCalled();
  });

  it('path 1: link_user_id sealed → attach (proof signed_in), NEVER resolveSession or mint', async () => {
    const h = build({ sealed: { link_user_id: 'user-1', link_return: '/account' }, resolution: { kind: 'denied', reason: 'unused' } });
    expect(await h.run()).toEqual({ kind: 'linked', idp: 'apple', returnTo: '/account' });
    expect(h.principals.resolveSession).not.toHaveBeenCalled();
    expect(h.jwtIssuer.sign).not.toHaveBeenCalled();
    expect(h.dir.attachIdentity).toHaveBeenCalledWith(expect.objectContaining({ principal_id: 'user-1', proof: 'signed_in', idp: 'apple' }));
    h.dir.attachIdentity.mockResolvedValueOnce({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    expect(await h.run()).toEqual({ kind: 'link_refused', reason: 'idp_not_permitted_for_tenant', returnTo: '/account' });
  });

  it('proof (a): link_handle sealed → normal session, then attach; refusal never fails the sign-in', async () => {
    const resolved: ResolveSessionResult = { kind: 'resolved', principal_id: 'user-1', context_id: 't-1', scopes: [], authz_version: 1 };
    const h = build({ sealed: { link_handle: HANDLE }, resolution: resolved, idp: 'google' });
    expect(await h.run()).toMatchObject({ kind: 'success', link: { linked: 'apple' } });
    expect(h.dir.attachPendingLink).toHaveBeenCalledWith({ handle: HANDLE, principal_id: 'user-1' });
    h.dir.attachPendingLink.mockResolvedValueOnce({ ok: false, reason: 'link_expired' });
    expect(await h.run()).toMatchObject({ kind: 'success', accessJwt: 'jwt', link: { refused: 'link_expired' } });
  });
});
