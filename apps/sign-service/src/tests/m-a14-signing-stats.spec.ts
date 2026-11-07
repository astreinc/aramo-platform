import 'reflect-metadata';
import { randomBytes } from 'node:crypto';

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import { INBOX_HANDLE_KEY_ENV, RecipientInboxRepository } from '@aramo/sign';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignMeSigningStatsController } from '../app/me/stats/sign-me-signing-stats.controller.js';
import { SignMeSigningStatsService } from '../app/me/stats/sign-me-signing-stats.service.js';

// Aramo Sign Mobile M-A14 R-4 — GET /v1/sign/me/signing-stats counts THIS account only:
// self-signed envelopes in the caller's tenant + received envelopes reached through the
// inbox's own matching (bindings, and discovery when on), where the caller's row is SIGNED.

const ME = '11111111-1111-7111-8111-111111111111';
const OTHER = '44444444-4444-7444-8444-444444444444';
const MY_TENANT = '22222222-2222-7222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-7333-8333-333333333333';
const auth = (sub: string, tenant_id: string): AuthContextType => ({ sub, consumer_type: 'sign', actor_kind: 'user', tenant_id, scopes: [], iat: 0, exp: 0 });
const PROOF = { email: 'dana@example.test', proven_at: new Date('2026-10-01T00:00:00.000Z') };

// One shared store holding BOTH accounts' rows; each repo read filters by its own key, as the
// real queries do (the repository half is proven on its where clauses below).
interface Row {
  envelope_id: string;
  status: string;
}
const store = {
  self: [
    { tenant_id: MY_TENANT, user_id: ME, envelope_id: 'env-self-1' },
    { tenant_id: MY_TENANT, user_id: ME, envelope_id: 'env-both' },
    { tenant_id: OTHER_TENANT, user_id: OTHER, envelope_id: 'env-other-self' },
    // The same user id in another tenant is not this session's tenant.
    { tenant_id: OTHER_TENANT, user_id: ME, envelope_id: 'env-me-elsewhere' },
  ],
  bound: {
    [ME]: [{ envelope_id: 'env-received', status: 'SIGNED' }, { envelope_id: 'env-pending', status: 'PENDING' }, { envelope_id: 'env-both', status: 'SIGNED' }],
    [OTHER]: [{ envelope_id: 'env-other-received', status: 'SIGNED' }],
  } as Record<string, Row[]>,
  discovered: {
    [ME]: [{ envelope_id: 'env-found', status: 'SIGNED' }, { envelope_id: 'env-found-declined', status: 'DECLINED' }],
    [OTHER]: [{ envelope_id: 'env-other-found', status: 'SIGNED' }],
  } as Record<string, Row[]>,
  pages: {
    'env-self-1': [3],
    'env-both': [2, 1],
    'env-received': [null], // never measured → 1
    'env-found': [5],
    'env-other-self': [40],
    'env-other-received': [40],
    'env-other-found': [40],
    'env-me-elsewhere': [40],
    'env-pending': [40],
    'env-found-declined': [40],
  } as Record<string, Array<number | null>>,
};
const entry = (r: Row) => ({ envelope_id: r.envelope_id, signer: { name: 'x', status: r.status, signed_at: null } });

function service() {
  const repo = {
    selfSignedEnvelopeIds: vi.fn(async (tenant_id: string, user_id: string) => store.self.filter((r) => r.tenant_id === tenant_id && r.user_id === user_id).map((r) => r.envelope_id)),
    listForUser: vi.fn(async (user_id: string) => (store.bound[user_id] ?? []).map(entry)),
    verifiedEmailProof: vi.fn(async () => PROOF),
    listDiscoveredForUser: vi.fn(async (user_id: string) => (store.discovered[user_id] ?? []).map(entry)),
    documentPageCounts: vi.fn(async (ids: readonly string[]) => ids.flatMap((id) => (store.pages[id] ?? []).map((pages) => ({ envelope_id: id, pages })))),
  };
  return { svc: new SignMeSigningStatsService(repo as never), repo };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[INBOX_HANDLE_KEY_ENV];
  process.env[INBOX_HANDLE_KEY_ENV] = randomBytes(32).toString('base64');
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[INBOX_HANDLE_KEY_ENV];
  else process.env[INBOX_HANDLE_KEY_ENV] = savedKey;
});

describe('M-A14 R-4 — signing stats are this account only', () => {
  it('counts self-signed (own tenant) + bound + discovered envelopes the caller SIGNED, deduped by envelope', async () => {
    const { svc, repo } = service();
    const out = await svc.stats(auth(ME, MY_TENANT));
    // env-self-1 (3) + env-both (2 + 1) + env-received (1, unmeasured) + env-found (5).
    expect(out).toEqual({ documents_signed: 4, pages_signed: 12 });
    // Every read is keyed by this session's subject (and tenant for self-sign) — never another.
    expect(repo.selfSignedEnvelopeIds).toHaveBeenCalledWith(MY_TENANT, ME);
    expect(repo.listForUser).toHaveBeenCalledWith(ME);
    expect(repo.verifiedEmailProof).toHaveBeenCalledWith(ME);
    expect(repo.listDiscoveredForUser).toHaveBeenCalledWith(ME, PROOF);
    const asked = repo.documentPageCounts.mock.calls[0]?.[0] ?? [];
    expect([...asked].sort()).toEqual(['env-both', 'env-found', 'env-received', 'env-self-1']);
    for (const foreign of ['env-other-self', 'env-other-received', 'env-other-found', 'env-me-elsewhere', 'env-pending', 'env-found-declined']) expect(asked).not.toContain(foreign);
  });

  it("another account sees only its own counts, never the caller's", async () => {
    const { svc } = service();
    expect(await svc.stats(auth(OTHER, OTHER_TENANT))).toEqual({ documents_signed: 3, pages_signed: 120 });
    expect(await svc.stats(auth(ME, MY_TENANT))).toEqual({ documents_signed: 4, pages_signed: 12 });
  });

  it('without inbox discovery (no handle key) the discovered rows are not counted — the inbox rule', async () => {
    delete process.env[INBOX_HANDLE_KEY_ENV];
    const { svc, repo } = service();
    expect(await svc.stats(auth(ME, MY_TENANT))).toEqual({ documents_signed: 3, pages_signed: 7 });
    expect(repo.listDiscoveredForUser).not.toHaveBeenCalled();
  });

  it('nothing signed → zeros, and no document read', async () => {
    const { svc, repo } = service();
    expect(await svc.stats(auth('55555555-5555-7555-8555-555555555555', MY_TENANT))).toEqual({ documents_signed: 0, pages_signed: 0 });
    expect(repo.documentPageCounts).not.toHaveBeenCalled();
  });
});

describe('M-A14 R-4 — RecipientInboxRepository reads are keyed by the account', () => {
  it('selfSignedEnvelopeIds filters on (tenant, bound user, SIGNED, not deleted) and dedupes', async () => {
    const findMany = vi.fn(async () => [{ envelope_id: 'e1' }, { envelope_id: 'e1' }, { envelope_id: 'e2' }]);
    const repo = new RecipientInboxRepository({ signer: { findMany } } as never, {} as never);
    expect(await repo.selfSignedEnvelopeIds(MY_TENANT, ME)).toEqual(['e1', 'e2']);
    expect(findMany).toHaveBeenCalledWith({
      where: { tenant_id: MY_TENANT, bound_user_id: ME, status: 'SIGNED', envelope: { deleted_at: null } },
      select: { envelope_id: true },
    });
  });

  it('documentPageCounts reads counts only (envelope id + page sizes), null when never measured', async () => {
    const findMany = vi.fn(async () => [
      { envelope_id: 'e1', page_sizes: { pages: [{ width: 612, height: 792 }, { width: 612, height: 792 }] } },
      { envelope_id: 'e1', page_sizes: null },
    ]);
    const repo = new RecipientInboxRepository({ envelopeDocument: { findMany } } as never, {} as never);
    expect(await repo.documentPageCounts(['e1'])).toEqual([{ envelope_id: 'e1', pages: 2 }, { envelope_id: 'e1', pages: null }]);
    expect(findMany).toHaveBeenCalledWith({ where: { envelope_id: { in: ['e1'] } }, select: { envelope_id: true, page_sizes: { select: { pages: true } } } });
    expect(await repo.documentPageCounts([])).toEqual([]);
  });
});

describe('M-A14 R-4 — GET /v1/sign/me/signing-stats route metadata', () => {
  it('session + sign consumer only (no Sign role scope), the same zone as /v1/sign/me/settings', () => {
    const h = (SignMeSigningStatsController.prototype as unknown as Record<string, object>)['signingStats'] ?? {};
    expect(Reflect.getMetadata(GUARDS_METADATA, h)).toEqual([JwtAuthGuard, EsignSenderConsumerGuard]);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, h)).toBeUndefined();
    expect(Reflect.getMetadata('path', SignMeSigningStatsController)).toBe('v1/sign/me');
    expect(Reflect.getMetadata('path', h)).toBe('signing-stats');
  });

  it('the controller passes the verified auth context (never a client-supplied id) to the service', async () => {
    const stats = { stats: vi.fn(async () => ({ documents_signed: 1, pages_signed: 2 })) };
    const a = auth(ME, MY_TENANT);
    expect(await new SignMeSigningStatsController(stats as never).signingStats(a, 'req-1')).toEqual({ documents_signed: 1, pages_signed: 2 });
    expect(stats.stats).toHaveBeenCalledWith(a);
  });
});
