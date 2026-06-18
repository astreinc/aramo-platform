import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '../../prisma/generated/client/client.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TenantSettingService } from '../lib/tenant-setting.service.js';
import { TenantSettingRepository } from '../lib/tenant-setting.repository.js';

// Settings S2 — TenantSettingService unit tests.
//
// S1 covered getAll's empty-registry shape. S2 lights up:
//   - get<K>('compensation.display_default') — typed-accessor + default-
//     fallback for the first concrete known-key (proofs (c)/(d))
//   - getAll surfaces compensation.display_default with the default `both`
//   - set<K>('compensation.display_default', value) — read-then-upsert in
//     $transaction returning {key, value, previous_value}; validator
//     rejects bad values BEFORE the DB is touched (proof (e))

const TENANT = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const ACTOR = '00000000-0000-7000-8000-000000000bb1';
const REQ = 'req-test-1';

function makeRepoStub(args: {
  findOne?: (tenantId: string, key: string) => Promise<{ value: unknown } | null>;
  findAllForTenant?: (tenantId: string) => Promise<ReadonlyArray<{ key: string; value: unknown }>>;
  findOneOnTx?: (
    tx: Prisma.TransactionClient,
    tenantId: string,
    key: string,
  ) => Promise<{ value: unknown } | null>;
  upsertOnTx?: (
    tx: Prisma.TransactionClient,
    tenantId: string,
    key: string,
    value: unknown,
    lastModifiedBy: string,
  ) => Promise<{ value: unknown }>;
}): TenantSettingRepository {
  return {
    findOne: args.findOne ?? (async () => null),
    findAllForTenant: args.findAllForTenant ?? (async () => []),
    findOneOnTx: args.findOneOnTx ?? (async () => null),
    upsertOnTx: args.upsertOnTx ?? (async (_tx, _t, _k, v) => ({ value: v })),
  } as unknown as TenantSettingRepository;
}

// Minimal PrismaService stub. set<K> uses $transaction(async (tx) => …);
// the stub invokes the callback with a sentinel tx object so the
// repository stubs above receive a non-null first arg.
function makePrismaStub(): PrismaService {
  const stub: Pick<PrismaService, '$transaction'> = {
    $transaction: (async (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => callback({} as Prisma.TransactionClient)) as PrismaService['$transaction'],
  };
  return stub as unknown as PrismaService;
}

describe('TenantSettingService.get<K> — S2 typed-accessor proofs', () => {
  it('returns the code-default `both` when no row exists (default-fallback)', async () => {
    const repo = makeRepoStub({ findOne: async () => null });
    const svc = new TenantSettingService(repo, makePrismaStub());

    const value = await svc.get(TENANT, 'compensation.display_default');

    expect(value).toBe('both');
  });

  it('returns the row-value when a row exists (typed-accessor projection)', async () => {
    const repo = makeRepoStub({
      findOne: async () => ({ value: 'markup' }),
    });
    const svc = new TenantSettingService(repo, makePrismaStub());

    const value = await svc.get(TENANT, 'compensation.display_default');

    expect(value).toBe('markup');
  });
});

describe('TenantSettingService.getAll — S2 view materialization', () => {
  it('surfaces every known-key with its code-default when no row exists (S2 + S4)', async () => {
    const repo = makeRepoStub({ findAllForTenant: async () => [] });
    const svc = new TenantSettingService(repo, makePrismaStub());

    const view = await svc.getAll(TENANT);

    expect(view).toEqual({
      'compensation.display_default': 'both',
      'audit.financials_enabled': false,
    });
  });

  it('surfaces the row-value when one exists; absent keys still default', async () => {
    const repo = makeRepoStub({
      findAllForTenant: async () => [
        { key: 'compensation.display_default', value: 'spread' },
      ],
    });
    const svc = new TenantSettingService(repo, makePrismaStub());

    const view = await svc.getAll(TENANT);

    expect(view).toEqual({
      'compensation.display_default': 'spread',
      'audit.financials_enabled': false,
    });
  });

  it('filters DB rows for unknown-to-this-version keys (forward-compat invariant)', async () => {
    const repo = makeRepoStub({
      findAllForTenant: async () => [
        { key: 'compensation.display_default', value: 'markup' },
        { key: 'future.unknown_key', value: 'whatever' },
      ],
    });
    const svc = new TenantSettingService(repo, makePrismaStub());

    const view = await svc.getAll(TENANT);

    expect(view).toEqual({
      'compensation.display_default': 'markup',
      'audit.financials_enabled': false,
    });
  });
});

describe('TenantSettingService.set<K> — S2 write-path proofs', () => {
  it('upserts a valid value and returns {key, value, previous_value: null} on first-set', async () => {
    const findOneOnTx = vi.fn(async () => null);
    const upsertOnTx = vi.fn(async (_tx, _t, _k, v) => ({ value: v }));
    const repo = makeRepoStub({ findOneOnTx, upsertOnTx });
    const svc = new TenantSettingService(repo, makePrismaStub());

    const result = await svc.set(
      TENANT,
      'compensation.display_default',
      'spread',
      ACTOR,
      REQ,
    );

    expect(result).toEqual({
      key: 'compensation.display_default',
      value: 'spread',
      previous_value: null,
    });
    expect(findOneOnTx).toHaveBeenCalledTimes(1);
    expect(upsertOnTx).toHaveBeenCalledTimes(1);
    // last_modified_by threaded through to the upsert primitive (the
    // schema-side provenance — Settings S2 directive §1).
    expect(upsertOnTx).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      'compensation.display_default',
      'spread',
      ACTOR,
    );
  });

  it('captures previous_value atomically (read-then-upsert in the tx)', async () => {
    const findOneOnTx = vi.fn(async () => ({ value: 'both' }));
    const upsertOnTx = vi.fn(async (_tx, _t, _k, v) => ({ value: v }));
    const repo = makeRepoStub({ findOneOnTx, upsertOnTx });
    const svc = new TenantSettingService(repo, makePrismaStub());

    const result = await svc.set(
      TENANT,
      'compensation.display_default',
      'markup',
      ACTOR,
      REQ,
    );

    expect(result).toEqual({
      key: 'compensation.display_default',
      value: 'markup',
      previous_value: 'both',
    });
  });

  it('rejects an invalid value with VALIDATION_ERROR — the DB is not touched', async () => {
    const findOneOnTx = vi.fn(async () => null);
    const upsertOnTx = vi.fn(async (_tx, _t, _k, v) => ({ value: v }));
    const repo = makeRepoStub({ findOneOnTx, upsertOnTx });
    const svc = new TenantSettingService(repo, makePrismaStub());

    await expect(
      svc.set(
        TENANT,
        'compensation.display_default',
        'margin_percent',
        ACTOR,
        REQ,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: {
        details: {
          reason: 'invalid_value',
          key: 'compensation.display_default',
        },
      },
    });
    expect(findOneOnTx).not.toHaveBeenCalled();
    expect(upsertOnTx).not.toHaveBeenCalled();
  });
});
