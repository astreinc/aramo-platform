import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  RefreshTokenRepository,
  RotationRaceError,
} from '../lib/refresh-token.repository.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';
const OLD_ID = '01900000-0000-7000-8000-0000000000bb';

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: OLD_ID,
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    consumer_type: 'recruiter',
    token_hash: 'hash-old',
    created_at: new Date('2026-05-12T00:00:00Z'),
    updated_at: new Date('2026-05-12T00:00:00Z'),
    expires_at: new Date('2026-06-11T00:00:00Z'),
    revoked_at: null,
    replaced_by_id: null,
    ...overrides,
  };
}

describe('RefreshTokenRepository.create', () => {
  // Test 6: inserts a row with app-side UUID v7 id.
  it('inserts a row with app-side UUID v7 id', async () => {
    const create = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeRow({ ...data }),
    );
    const prisma = { refreshToken: { create } } as unknown as PrismaService;
    const repo = new RefreshTokenRepository(prisma);

    const result = await repo.create({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      consumer_type: 'recruiter',
      token_hash: 'h-new',
      expires_at: new Date('2026-06-11T00:00:00Z'),
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    // UUID v7: chars 14-15 are "70" (version + variant prefix in subgroup 3).
    expect(data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.user_id).toBe(USER_ID);
  });
});

describe('RefreshTokenRepository.findByHash', () => {
  // Test 7: returns null for non-existent hash.
  it('returns null for non-existent hash', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = { refreshToken: { findUnique } } as unknown as PrismaService;
    const repo = new RefreshTokenRepository(prisma);

    const result = await repo.findByHash({ token_hash: 'no-such' });

    expect(result).toBeNull();
    expect(findUnique).toHaveBeenCalledWith({ where: { token_hash: 'no-such' } });
  });

  // Test 8: returns the row for an existing hash (DTO with ISO timestamps).
  it('returns the row for an existing hash with ISO timestamps', async () => {
    const findUnique = vi.fn().mockResolvedValue(makeRow());
    const prisma = { refreshToken: { findUnique } } as unknown as PrismaService;
    const repo = new RefreshTokenRepository(prisma);

    const result = await repo.findByHash({ token_hash: 'hash-old' });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(OLD_ID);
    expect(typeof result!.created_at).toBe('string');
    expect(result!.created_at).toBe('2026-05-12T00:00:00.000Z');
  });
});

describe('RefreshTokenRepository.rotate', () => {
  // Test 9: loads with FOR UPDATE, derives bindings, creates new, marks old.
  it('locks old via FOR UPDATE, creates new, conditionally updates old', async () => {
    const oldRow = makeRow();
    const queryRawUnsafe = vi.fn().mockResolvedValue([oldRow]);
    const create = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeRow({ ...data }),
    );
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(makeRow({ revoked_at: new Date(), replaced_by_id: 'new-id' }));

    const txClient = {
      $queryRawUnsafe: queryRawUnsafe,
      refreshToken: { create, updateMany, findUnique },
    };
    const $transaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient));
    const prisma = { $transaction } as unknown as PrismaService;
    const repo = new RefreshTokenRepository(prisma);

    const result = await repo.rotate({
      old_id: OLD_ID,
      new_token_hash: 'h-new',
      new_expires_at: new Date('2026-06-11T00:00:00Z'),
    });

    // FOR UPDATE invoked
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect((queryRawUnsafe.mock.calls[0]![0] as string)).toContain('FOR UPDATE');
    expect((queryRawUnsafe.mock.calls[0]![0] as string)).toContain('auth_storage');

    // Test 10: derived bindings on new row
    const created = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(created.user_id).toBe(USER_ID);
    expect(created.tenant_id).toBe(TENANT_ID);
    expect(created.consumer_type).toBe('recruiter');
    expect(created.token_hash).toBe('h-new');

    // Conditional updateMany guards on revoked_at + replaced_by_id null
    const where = updateMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.revoked_at).toBeNull();
    expect(where.replaced_by_id).toBeNull();

    // Returns both DTOs
    expect(result.new_token).toBeDefined();
    expect(result.old_token).toBeDefined();
  });

  // Test 11: conditional update fails (race) → RotationRaceError thrown.
  it('throws RotationRaceError when conditional update affects 0 rows', async () => {
    const oldRow = makeRow();
    const txClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([oldRow]),
      refreshToken: {
        create: vi.fn().mockResolvedValue(makeRow({ id: 'new-id', token_hash: 'h-new' })),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient)),
    } as unknown as PrismaService;
    const repo = new RefreshTokenRepository(prisma);

    await expect(
      repo.rotate({
        old_id: OLD_ID,
        new_token_hash: 'h-new',
        new_expires_at: new Date('2026-06-11T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(RotationRaceError);
  });
});

describe('RefreshTokenRepository.revoke / revokeAllForUser', () => {
  // Test 12: revoke sets revoked_at on the specified row.
  it('revoke sets revoked_at on the specified row', async () => {
    const update = vi.fn().mockResolvedValue(makeRow({ revoked_at: new Date() }));
    const prisma = { refreshToken: { update } } as unknown as PrismaService;
    const repo = new RefreshTokenRepository(prisma);

    await repo.revoke({ id: OLD_ID });

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0] as { where: { id: string }; data: { revoked_at: Date } };
    expect(arg.where.id).toBe(OLD_ID);
    expect(arg.data.revoked_at).toBeInstanceOf(Date);
  });

  // Test 13: revokeAllForUser marks all non-revoked rows revoked, returns count.
  it('revokeAllForUser updates only non-revoked rows for user and returns count', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 4 });
    const prisma = { refreshToken: { updateMany } } as unknown as PrismaService;
    const repo = new RefreshTokenRepository(prisma);

    const result = await repo.revokeAllForUser({ user_id: USER_ID });

    expect(result.revoked_count).toBe(4);
    const where = updateMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.user_id).toBe(USER_ID);
    expect(where.revoked_at).toBeNull();
  });
});
