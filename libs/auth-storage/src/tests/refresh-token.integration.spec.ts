import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  RefreshTokenRepository,
  RotationRaceError,
} from '../lib/refresh-token.repository.js';
import { RefreshTokenService } from '../lib/refresh-token.service.js';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260512100000_init_auth_storage/migration.sql',
);

function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments.split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'auth-storage RefreshToken — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: RefreshTokenRepository;
    let service: RefreshTokenService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const sql = readFileSync(MIGRATION_PATH, 'utf8');
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const stmt of splitDdl(sql)) {
        const t = stmt.trim();
        if (t.length === 0) continue;
        await setup.$executeRawUnsafe(t);
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new RefreshTokenRepository(prisma);
      service = new RefreshTokenService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.refreshToken.deleteMany({});
    });

    function newUserCtx(): { user_id: string; tenant_id: string } {
      return { user_id: uuidv7(), tenant_id: uuidv7() };
    }

    it('create + findByHash round-trip', async () => {
      const ctx = newUserCtx();
      const created = await service.create({
        ...ctx,
        consumer_type: 'recruiter',
        token_hash: 'h-1',
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      });
      const found = await service.findByHash({ token_hash: 'h-1' });
      expect(found?.id).toBe(created.id);
      expect(found?.user_id).toBe(ctx.user_id);
    });

    it('rotate: marks old revoked + linked, creates new with same bindings', async () => {
      const ctx = newUserCtx();
      const created = await service.create({
        ...ctx,
        consumer_type: 'recruiter',
        token_hash: 'h-1',
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      });
      const result = await service.rotate({
        old_id: created.id,
        new_token_hash: 'h-2',
        new_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      });
      expect(result.new_token.user_id).toBe(ctx.user_id);
      expect(result.new_token.tenant_id).toBe(ctx.tenant_id);
      expect(result.new_token.consumer_type).toBe('recruiter');
      expect(result.old_token.revoked_at).not.toBeNull();
      expect(result.old_token.replaced_by_id).toBe(result.new_token.id);
    });

    // Test 42 (rotation race): two concurrent rotations on the same token.
    // FOR UPDATE serializes them; the loser's conditional update sees
    // count=0 and throws RotationRaceError. End state: exactly one new row,
    // exactly one revocation linkage, no orphans.
    it('two concurrent rotations on the same token: one succeeds, one races out', async () => {
      const ctx = newUserCtx();
      const created = await service.create({
        ...ctx,
        consumer_type: 'recruiter',
        token_hash: 'h-base',
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      });

      const r1 = service.rotate({
        old_id: created.id,
        new_token_hash: 'h-A',
        new_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      });
      const r2 = service.rotate({
        old_id: created.id,
        new_token_hash: 'h-B',
        new_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      });

      const results = await Promise.allSettled([r1, r2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        RotationRaceError,
      );

      const allRows = await prisma.refreshToken.findMany();
      const revokedCount = allRows.filter((r) => r.revoked_at !== null).length;
      expect(revokedCount).toBe(1);
    });

    it('revokeAllForUser cascades over all non-revoked rows', async () => {
      const ctx = newUserCtx();
      await service.create({
        ...ctx,
        consumer_type: 'recruiter',
        token_hash: 'a',
        expires_at: new Date(Date.now() + 1_000_000),
      });
      await service.create({
        ...ctx,
        consumer_type: 'recruiter',
        token_hash: 'b',
        expires_at: new Date(Date.now() + 1_000_000),
      });
      await service.create({
        ...ctx,
        consumer_type: 'portal',
        token_hash: 'c',
        expires_at: new Date(Date.now() + 1_000_000),
      });

      const result = await service.revokeAllForUser({ user_id: ctx.user_id });
      expect(result.revoked_count).toBe(3);

      const remaining = await prisma.refreshToken.findMany({
        where: { user_id: ctx.user_id, revoked_at: null },
      });
      expect(remaining).toHaveLength(0);
    });

    it('schema check: required indexes exist on auth_storage.RefreshToken', async () => {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'auth_storage' AND tablename = 'RefreshToken' ORDER BY indexname`,
      )) as Array<{ indexname: string }>;
      const names = rows.map((r) => r.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'RefreshToken_pkey',
          'RefreshToken_token_hash_key',
          'RefreshToken_user_id_tenant_id_consumer_type_idx',
          'RefreshToken_replaced_by_id_idx',
          'RefreshToken_expires_at_idx',
        ]),
      );
    });
  },
);
