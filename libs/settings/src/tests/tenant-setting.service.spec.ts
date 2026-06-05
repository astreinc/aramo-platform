import { describe, expect, it, vi } from 'vitest';

import { TenantSettingService } from '../lib/tenant-setting.service.js';
import { TenantSettingRepository } from '../lib/tenant-setting.repository.js';

// Settings S1 — TenantSettingService unit tests.
//
// The S1 service surface is `get<K>` + `getAll`. With the `KNOWN_SETTINGS`
// registry shipped EMPTY (Gate-5 Ruling 1), the directly-testable behavior
// is:
//   - getAll returns `{}` regardless of what rows the repository surfaces
//     (forward-compatibility: unknown-key DB rows are filtered out — the
//     view contains exactly the registered keys, which in S1 is none).
//   - the repository is consulted for every read (no memoization — Gate-5
//     Ruling 3; D4b's per-request memo pattern has no analog here).
//
// `get<K>` is not exercised here because `K extends KnownSettingKey` is
// `never` in S1 (the empty registry). The full default-fallback /
// row-projection cascade is covered by the integration spec via the
// repository surface; service-level get<K> lights up in S2 when a key
// exists to compile against.

function makeRepoStub(args: {
  findOne?: (tenantId: string, key: string) => Promise<{ value: unknown } | null>;
  findAllForTenant?: (tenantId: string) => Promise<ReadonlyArray<{ key: string; value: unknown }>>;
}): TenantSettingRepository {
  return {
    findOne: args.findOne ?? (async () => null),
    findAllForTenant: args.findAllForTenant ?? (async () => []),
  } as unknown as TenantSettingRepository;
}

describe('TenantSettingService.getAll — S1 empty-registry behavior', () => {
  it('returns `{}` when the registry is empty AND no rows exist', async () => {
    const repo = makeRepoStub({});
    const svc = new TenantSettingService(repo);

    const view = await svc.getAll('01900000-0000-7000-8000-000000000aaa');

    expect(view).toEqual({});
  });

  it('returns `{}` even when DB rows exist for unknown-to-S1 keys', async () => {
    // Forward-compat invariant: an older reader against a newer writer
    // must drop unknown keys, not error. In S1 every key is unknown, so
    // every row is filtered. Once S2 registers a key, that key's row
    // surfaces; other rows still drop.
    const repo = makeRepoStub({
      findAllForTenant: async () => [
        { key: 'future.unknown_key', value: 'whatever' },
        { key: 'another.future_key', value: { nested: 1 } },
      ],
    });
    const svc = new TenantSettingService(repo);

    const view = await svc.getAll('01900000-0000-7000-8000-000000000aaa');

    expect(view).toEqual({});
  });

  it('consults the repository on every call (no memoization)', async () => {
    // Gate-5 Ruling 3: read-through; config is cold-path; no D4b-style
    // per-request memo. Two getAll calls hit the repo twice.
    const findAllForTenant = vi.fn(async () => []);
    const repo = makeRepoStub({ findAllForTenant });
    const svc = new TenantSettingService(repo);

    await svc.getAll('01900000-0000-7000-8000-000000000aaa');
    await svc.getAll('01900000-0000-7000-8000-000000000aaa');

    expect(findAllForTenant).toHaveBeenCalledTimes(2);
  });

  it('passes the tenant_id through to the repository verbatim', async () => {
    // Per-tenant isolation is enforced by the WHERE tenant_id in the
    // repository; the service's job is to deliver the tenant_id from the
    // auth context unchanged. The endpoint-level isolation proof is the
    // integration spec; this is the in-process plumbing proof.
    const findAllForTenant = vi.fn(async () => []);
    const repo = makeRepoStub({ findAllForTenant });
    const svc = new TenantSettingService(repo);

    const tenantA = '01900000-0000-7000-8000-000000000aaa';
    const tenantB = '01900000-0000-7000-8000-000000000bbb';
    await svc.getAll(tenantA);
    await svc.getAll(tenantB);

    expect(findAllForTenant).toHaveBeenNthCalledWith(1, tenantA);
    expect(findAllForTenant).toHaveBeenNthCalledWith(2, tenantB);
  });
});
