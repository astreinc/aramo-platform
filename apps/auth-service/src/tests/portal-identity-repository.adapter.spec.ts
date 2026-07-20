import { describe, expect, it, vi } from 'vitest';
import type { PortalIdentityRepository } from '@aramo/portal-identity';

import { PortalIdentityRepositoryAdapter } from '../app/auth/portal-identity-repository.adapter.js';

// Auth-Decoupling PR-5a §4.6 — the PortalIdentityStore adapter. The 6 repository
// methods pass through to PortalIdentityRepository; the 3 login-token helpers
// delegate to the real @aramo/portal-identity functions.

function make() {
  const repo = {
    findPortalByEmail: vi.fn().mockResolvedValue({ id: 'u1' }),
    findOrCreatePortalOnLogin: vi.fn().mockResolvedValue({ id: 'u1' }),
    createLoginToken: vi.fn().mockResolvedValue({ id: 't1' }),
    findOpenLoginToken: vi.fn().mockResolvedValue({ id: 't1' }),
    rotateLoginToken: vi.fn().mockResolvedValue({ id: 't2' }),
    consumeLoginToken: vi.fn().mockResolvedValue({ id: 't1', email_normalized: 'a@b.c' }),
  } as unknown as PortalIdentityRepository;
  return { repo, adapter: new PortalIdentityRepositoryAdapter(repo) };
}

describe('PortalIdentityRepositoryAdapter — repository pass-through', () => {
  it('forwards every method with the same args + result', async () => {
    const { repo, adapter } = make();
    const now = new Date('2026-07-20T00:00:00.000Z');

    expect(await adapter.findPortalByEmail('a@b.c')).toEqual({ id: 'u1' });
    expect(repo.findPortalByEmail).toHaveBeenCalledWith('a@b.c');

    await adapter.findOrCreatePortalOnLogin({ email_normalized: 'a@b.c', cluster_id: null, now });
    expect(repo.findOrCreatePortalOnLogin).toHaveBeenCalledWith({ email_normalized: 'a@b.c', cluster_id: null, now });

    await adapter.createLoginToken({ email_normalized: 'a@b.c', token_hash: 'h', expires_at: now });
    expect(repo.createLoginToken).toHaveBeenCalledWith({ email_normalized: 'a@b.c', token_hash: 'h', expires_at: now });

    await adapter.findOpenLoginToken('a@b.c', now);
    expect(repo.findOpenLoginToken).toHaveBeenCalledWith('a@b.c', now);

    await adapter.rotateLoginToken({ id: 't1', token_hash: 'h2', expires_at: now });
    expect(repo.rotateLoginToken).toHaveBeenCalledWith({ id: 't1', token_hash: 'h2', expires_at: now });

    expect(await adapter.consumeLoginToken('hash', now)).toEqual({ id: 't1', email_normalized: 'a@b.c' });
    expect(repo.consumeLoginToken).toHaveBeenCalledWith('hash', now);
  });
});

describe('PortalIdentityRepositoryAdapter — login-token helpers (real functions)', () => {
  it('generatePortalLoginToken returns { raw, hash } and hash matches hashPortalLoginToken(raw)', () => {
    const { adapter } = make();
    const { raw, hash } = adapter.generatePortalLoginToken();
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThan(0);
    expect(adapter.hashPortalLoginToken(raw)).toBe(hash);
  });

  it('portalLoginExpiresAt returns a future Date', () => {
    const { adapter } = make();
    const now = new Date('2026-07-20T00:00:00.000Z');
    const exp = adapter.portalLoginExpiresAt(now);
    expect(exp).toBeInstanceOf(Date);
    expect(exp.getTime()).toBeGreaterThan(now.getTime());
  });
});
