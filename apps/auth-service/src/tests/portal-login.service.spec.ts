import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalLoginService } from '@aramo/auth-core';

import { PortalIdentityRepositoryAdapter } from '../app/auth/portal-identity-repository.adapter.js';

// Portal P1 — passwordless login orchestration unit coverage. The three
// eligibility cases (eligibility-hit / PortalUser-hit / miss) and the neutral
// request-link contract, plus the consume success/failure modes, with all
// collaborators stubbed.
//
// Auth-Decoupling PR-2/3 (§3.1): PortalLoginService now depends on the auth-owned
// EmailSender / EligibilityPolicy ports, so the identity-index + mailer mocks are
// substituted by an EligibilityPolicy mock (`resolve`) and an EmailSender mock
// (`send`, same shape). PROVIDER SUBSTITUTION ONLY — every assertion is unchanged
// (subject_ref IS the former cluster id, so `cluster_id: CLUSTER_ID` still holds).

const CLUSTER_ID = 'cccccccc-cccc-7ccc-8ccc-ccccccccc001';
const PORTAL_ID = 'dddddddd-dddd-7ddd-8ddd-ddddddddd001';

function makeService(over: {
  cluster?: { id: string } | null;
  existingPortal?: { id: string } | null;
  openToken?: { id: string } | null;
  consumeResult?: { email_normalized: string } | null;
  budgetAllows?: boolean;
} = {}) {
  // EligibilityPolicy.resolve mirrors the former index lookup: a cluster hit maps
  // to an opaque { subject_ref }, a miss to null (over.cluster == null covers both
  // the `undefined` default and an explicit null).
  const resolve = vi
    .fn()
    .mockResolvedValue(over.cluster == null ? null : { subject_ref: over.cluster.id });
  const eligibility = { resolve } as never;

  const findPortalByEmail = vi
    .fn()
    .mockResolvedValue(over.existingPortal ?? null);
  const findOpenLoginToken = vi.fn().mockResolvedValue(over.openToken ?? null);
  const rotateLoginToken = vi.fn().mockResolvedValue(undefined);
  const createLoginToken = vi.fn().mockResolvedValue(undefined);
  const consumeLoginToken = vi
    .fn()
    .mockResolvedValue(
      over.consumeResult === undefined
        ? { email_normalized: 'known@example.com' }
        : over.consumeResult,
    );
  const findOrCreatePortalOnLogin = vi
    .fn()
    .mockResolvedValue({ id: PORTAL_ID });
  const portals = {
    findPortalByEmail,
    findOpenLoginToken,
    rotateLoginToken,
    createLoginToken,
    consumeLoginToken,
    findOrCreatePortalOnLogin,
  } as never;

  const send = vi.fn().mockResolvedValue({ message_id: 'm1' });
  const email = { send } as never;

  const establishPortalSession = vi
    .fn()
    .mockResolvedValue({ accessJwt: 'jwt', refreshTokenPlaintext: 'refresh' });
  const session = { establishPortalSession } as never;

  const allow = vi.fn().mockReturnValue(over.budgetAllows ?? true);
  const budget = { allow } as never;

  // PR-5a §4.1 — wrap the repository mock in the REAL PortalIdentityRepositoryAdapter
  // (the service now depends on PortalIdentityStore); the 6 method assertions still
  // fire through the adapter, and the 3 token helpers use the real functions as before.
  const service = new PortalLoginService(
    new PortalIdentityRepositoryAdapter(portals),
    eligibility,
    email,
    session,
    budget,
  );
  return {
    service,
    resolve,
    findPortalByEmail,
    createLoginToken,
    rotateLoginToken,
    send,
    consumeLoginToken,
    findOrCreatePortalOnLogin,
    establishPortalSession,
    allow,
  };
}

// A neutral test base (the real public host is candidate.aramo.ai, kept out of
// .ts literals so the vocabulary rule needs no code-level exemption).
const REQ = { ip: '1.2.3.4', baseUrl: 'https://portal.test' };

describe('PortalLoginService.requestLink — eligibility (ruling 1) + neutrality (ruling 2)', () => {
  it('ELIGIBLE via fingerprint-hit: mints a token and sends the magic-link mail', async () => {
    const { service, createLoginToken, send } = makeService({ cluster: { id: CLUSTER_ID } });
    await service.requestLink({ email: 'known@example.com', ...REQ });
    expect(createLoginToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe('known@example.com');
  });

  it('ELIGIBLE via existing-PortalUser (fingerprint miss, user exists): mints + sends', async () => {
    const { service, createLoginToken, send } = makeService({
      cluster: null,
      existingPortal: { id: PORTAL_ID },
    });
    await service.requestLink({ email: 'returning@example.com', ...REQ });
    expect(createLoginToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('INELIGIBLE (fingerprint miss + no PortalUser): NO token, NO mail — same void return', async () => {
    const { service, createLoginToken, rotateLoginToken, send } = makeService({
      cluster: null,
      existingPortal: null,
    });
    const result = await service.requestLink({ email: 'unknown@example.com', ...REQ });
    expect(result).toBeUndefined();
    expect(createLoginToken).not.toHaveBeenCalled();
    expect(rotateLoginToken).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('MALFORMED-but-parseable email: same silent no-mail path as unknown', async () => {
    const { service, createLoginToken, send } = makeService();
    await service.requestLink({ email: 'not-an-email', ...REQ });
    expect(createLoginToken).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('all three request-link outcomes return the identical (void) result — neutrality by construction', async () => {
    const eligible = makeService({ cluster: { id: CLUSTER_ID } });
    const returning = makeService({ cluster: null, existingPortal: { id: PORTAL_ID } });
    const miss = makeService({ cluster: null, existingPortal: null });
    expect(await eligible.service.requestLink({ email: 'a@example.com', ...REQ })).toBeUndefined();
    expect(await returning.service.requestLink({ email: 'b@example.com', ...REQ })).toBeUndefined();
    expect(await miss.service.requestLink({ email: 'c@example.com', ...REQ })).toBeUndefined();
  });

  it('RESEND rotates in place when an open token exists (no second row)', async () => {
    const { service, createLoginToken, rotateLoginToken } = makeService({
      cluster: { id: CLUSTER_ID },
      openToken: { id: 'tok-1' },
    });
    await service.requestLink({ email: 'known@example.com', ...REQ });
    expect(rotateLoginToken).toHaveBeenCalledTimes(1);
    expect(createLoginToken).not.toHaveBeenCalled();
  });

  it('over-budget: uniform limiter fires first — no eligibility check, no mail', async () => {
    const { service, resolve, send } = makeService({
      cluster: { id: CLUSTER_ID },
      budgetAllows: false,
    });
    await service.requestLink({ email: 'known@example.com', ...REQ });
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('PortalLoginService.consume — lazy mint (ruling 3) + one neutral failure', () => {
  it('SUCCESS: valid token → find/mint PortalUser (cluster from lookup) → session', async () => {
    const { service, findOrCreatePortalOnLogin, establishPortalSession } = makeService({
      cluster: { id: CLUSTER_ID },
      consumeResult: { email_normalized: 'known@example.com' },
    });
    const result = await service.consume({ rawToken: 'raw-token', ip: '1.2.3.4' });
    expect(result).toEqual({ kind: 'success', accessJwt: 'jwt', refreshTokenPlaintext: 'refresh' });
    // Lazy mint carries the cluster from the (re-derived) eligibility lookup.
    expect(findOrCreatePortalOnLogin).toHaveBeenCalledWith(
      expect.objectContaining({ email_normalized: 'known@example.com', cluster_id: CLUSTER_ID }),
    );
    expect(establishPortalSession).toHaveBeenCalledWith({ portal_user_id: PORTAL_ID });
  });

  it('SUCCESS with no cluster: mints with cluster_id null (valid empty state)', async () => {
    const { service, findOrCreatePortalOnLogin } = makeService({
      cluster: null,
      consumeResult: { email_normalized: 'nocluster@example.com' },
    });
    await service.consume({ rawToken: 'raw-token', ip: '1.2.3.4' });
    expect(findOrCreatePortalOnLogin).toHaveBeenCalledWith(
      expect.objectContaining({ cluster_id: null }),
    );
  });

  it('FAILURE: invalid/expired/replayed token (consume returns null) → one neutral failure', async () => {
    const { service, findOrCreatePortalOnLogin } = makeService({ consumeResult: null });
    const result = await service.consume({ rawToken: 'bad', ip: '1.2.3.4' });
    expect(result).toEqual({ kind: 'failure' });
    expect(findOrCreatePortalOnLogin).not.toHaveBeenCalled();
  });

  it('FAILURE: over-budget → neutral failure, no consume attempt', async () => {
    const { service, consumeLoginToken } = makeService({ budgetAllows: false });
    const result = await service.consume({ rawToken: 'raw-token', ip: '1.2.3.4' });
    expect(result).toEqual({ kind: 'failure' });
    expect(consumeLoginToken).not.toHaveBeenCalled();
  });

  it('FAILURE: empty/absent token → neutral failure', async () => {
    const { service, consumeLoginToken } = makeService();
    expect(await service.consume({ rawToken: '', ip: '1.2.3.4' })).toEqual({ kind: 'failure' });
    expect(await service.consume({ rawToken: undefined, ip: '1.2.3.4' })).toEqual({ kind: 'failure' });
    expect(consumeLoginToken).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
