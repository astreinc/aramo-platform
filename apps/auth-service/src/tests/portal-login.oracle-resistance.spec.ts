import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PortalIdentityRepositoryAdapter } from '../app/auth/portal-identity-repository.adapter.js';
import { PortalLoginService } from '../app/auth/portal-login.service.js';

// Auth-Decoupling PR-2/3 §3.2 — ORACLE-RESISTANCE across the port hop (R-P23-5).
// The port must not introduce a distinguishable branch, error, or side effect
// that separates eligible / ineligible / malformed. Adds the ADAPTER-THROWS case
// the directive calls out: an EligibilityPolicy error must propagate UNIFORMLY
// (it happens before the eligibility branch, for any parseable email) — never as
// a branch that reveals eligibility.

const REQ = { ip: '1.2.3.4', baseUrl: 'https://portal.test' };

function makeService(opts: {
  resolveImpl: () => Promise<{ subject_ref: string } | null>;
  existingPortal?: { id: string } | null;
}) {
  const resolve = vi.fn().mockImplementation(opts.resolveImpl);
  const eligibility = { resolve } as never;

  const findPortalByEmail = vi.fn().mockResolvedValue(opts.existingPortal ?? null);
  const findOpenLoginToken = vi.fn().mockResolvedValue(null);
  const createLoginToken = vi.fn().mockResolvedValue(undefined);
  const rotateLoginToken = vi.fn().mockResolvedValue(undefined);
  const portals = { findPortalByEmail, findOpenLoginToken, createLoginToken, rotateLoginToken } as never;

  const send = vi.fn().mockResolvedValue({ message_id: 'm1' });
  const email = { send } as never;
  const session = { establishPortalSession: vi.fn() } as never;
  const budget = { allow: vi.fn().mockReturnValue(true) } as never;

  const service = new PortalLoginService(
    new PortalIdentityRepositoryAdapter(portals),
    eligibility,
    email,
    session,
    budget,
  );
  return { service, resolve, findPortalByEmail, send };
}

beforeEach(() => vi.clearAllMocks());

describe('requestLink — neutral symmetry (eligible / ineligible / malformed)', () => {
  it('all three parseable/ malformed outcomes return the identical void result', async () => {
    const eligible = makeService({ resolveImpl: async () => ({ subject_ref: 's1' }) });
    const ineligible = makeService({ resolveImpl: async () => null });
    const malformed = makeService({ resolveImpl: async () => null });

    expect(await eligible.service.requestLink({ email: 'a@example.com', ...REQ })).toBeUndefined();
    expect(await ineligible.service.requestLink({ email: 'b@example.com', ...REQ })).toBeUndefined();
    expect(await malformed.service.requestLink({ email: 'not-an-email', ...REQ })).toBeUndefined();
  });

  it('malformed email never even consults the eligibility port (same as pre-port)', async () => {
    const { service, resolve, send } = makeService({ resolveImpl: async () => null });
    await service.requestLink({ email: 'not-an-email', ...REQ });
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('requestLink — ADAPTER-THROWS is uniform, not a distinguishable branch', () => {
  it('a throwing eligibility rejects identically for a would-be-eligible and a would-be-ineligible email', async () => {
    const boom = () => Promise.reject(new Error('index unavailable'));
    // "would-be-eligible via PortalUser" — but resolve throws BEFORE findPortalByEmail.
    const wouldBeEligible = makeService({ resolveImpl: boom, existingPortal: { id: 'p1' } });
    const wouldBeIneligible = makeService({ resolveImpl: boom, existingPortal: null });

    await expect(wouldBeEligible.service.requestLink({ email: 'a@example.com', ...REQ })).rejects.toThrow();
    await expect(wouldBeIneligible.service.requestLink({ email: 'b@example.com', ...REQ })).rejects.toThrow();

    // The error surfaces BEFORE any eligibility-revealing side effect: no portal
    // read, no mail — for BOTH. The failure carries no eligibility signal.
    expect(wouldBeEligible.findPortalByEmail).not.toHaveBeenCalled();
    expect(wouldBeIneligible.findPortalByEmail).not.toHaveBeenCalled();
    expect(wouldBeEligible.send).not.toHaveBeenCalled();
    expect(wouldBeIneligible.send).not.toHaveBeenCalled();
  });

  it('a throwing eligibility does NOT throw for a malformed email (resolve never reached)', async () => {
    const { service } = makeService({ resolveImpl: () => Promise.reject(new Error('boom')) });
    await expect(service.requestLink({ email: 'not-an-email', ...REQ })).resolves.toBeUndefined();
  });
});

describe('consume — ADAPTER-THROWS propagates as before', () => {
  it('a throwing eligibility rejects consume (uniform, after token consume)', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('index down'));
    const portals = {
      consumeLoginToken: vi.fn().mockResolvedValue({ email_normalized: 'known@example.com' }),
      findOrCreatePortalOnLogin: vi.fn(),
    } as never;
    const service = new PortalLoginService(
      new PortalIdentityRepositoryAdapter(portals),
      { resolve } as never,
      { send: vi.fn() } as never,
      { establishPortalSession: vi.fn() } as never,
      { allow: vi.fn().mockReturnValue(true) } as never,
    );
    await expect(service.consume({ rawToken: 'raw', ip: '1.2.3.4' })).rejects.toThrow();
  });
});
