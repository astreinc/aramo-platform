import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { NativeDeviceSessionRepository } from '../lib/native-device-session.repository.js';
import { NativeDeviceSessionService } from '../lib/native-device-session.service.js';
import { RefreshTokenRepository, RotationRaceError } from '../lib/refresh-token.repository.js';
import { RefreshTokenService } from '../lib/refresh-token.service.js';

// AUTH-SIGNIN-1 Amendment M-A1 §3.6/§3.8 — the native device session + the
// redeemed-code ledger against real Postgres 17, with the auth_storage DDL
// migration chain (the data-only sign-naming migration is a no-op on an empty
// table and is omitted). The new migration is ADDITIVE: two new tables.
const MIGRATION_PATHS = [
  '20260512100000_init_auth_storage',
  '20260719000000_add_host_auth_profile',
  '20261025120000_native_device_sessions',
].map((m) => resolve(__dirname, `../../prisma/migrations/${m}/migration.sql`));

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'auth-storage NativeDeviceSession + NativeRedeemedCode — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: NativeDeviceSessionService;
    let tokens: RefreshTokenService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATION_PATHS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      svc = new NativeDeviceSessionService(new NativeDeviceSessionRepository(prisma));
      tokens = new RefreshTokenService(new RefreshTokenRepository(prisma));
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    beforeEach(async () => {
      await prisma.nativeDeviceSession.deleteMany({});
      await prisma.nativeRedeemedCode.deleteMany({});
      await prisma.refreshToken.deleteMany({});
    });

    const later = (s: number): Date => new Date(Date.now() + s * 1000);

    async function newSession(user_id = uuidv7(), tenant_id = uuidv7(), hash = `h-${uuidv7()}`) {
      return svc.createSession({
        user_id,
        tenant_id,
        consumer_type: 'sign',
        refresh_consumer_type: 'sign_native',
        client_id: 'native-client',
        installation_id: 'inst',
        platform: 'ios',
        app_version: '1.0.0',
        token_hash: hash,
        expires_at: later(3600),
      });
    }

    it('the migration is additive: two new tables; RefreshToken columns unchanged', async () => {
      const tables = (await prisma.$queryRawUnsafe(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'auth_storage' ORDER BY table_name`,
      )) as { table_name: string }[];
      expect(tables.map((t) => t.table_name)).toEqual(['HostAuthProfile', 'NativeDeviceSession', 'NativeRedeemedCode', 'RefreshToken']);
      const cols = (await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'auth_storage' AND table_name = 'RefreshToken' ORDER BY column_name`,
      )) as { column_name: string }[];
      expect(cols.map((c) => c.column_name)).toEqual(['consumer_type', 'created_at', 'expires_at', 'id', 'replaced_by_id', 'revoked_at', 'tenant_id', 'token_hash', 'updated_at', 'user_id']);
    });

    it('redeemed-code ledger: one winner under concurrency; code replay and nonce replay are told apart; expired rows are pruned', async () => {
      const args = { code_hash: 'c1', nonce_hash: 'n1', client_id: 'native-client', expires_at: later(600) };
      const results = await Promise.all([svc.redeemCode(args), svc.redeemCode(args), svc.redeemCode(args)]);
      expect(results.filter((r) => r === 'redeemed')).toHaveLength(1);
      expect(results.filter((r) => r === 'code_already_redeemed')).toHaveLength(2);
      expect(await svc.redeemCode({ ...args, code_hash: 'c2' })).toBe('nonce_replayed');
      await prisma.nativeRedeemedCode.create({ data: { code_hash: 'old', nonce_hash: 'old-n', client_id: 'x', expires_at: new Date(Date.now() - 1000) } });
      expect(await svc.redeemCode({ code_hash: 'c3', nonce_hash: 'n3', client_id: 'native-client', expires_at: later(600) })).toBe('redeemed');
      expect(await prisma.nativeRedeemedCode.findUnique({ where: { code_hash: 'old' } })).toBeNull();
    });

    it('createSession writes the family root token (hashed, native consumer) and the session that owns it in one transaction', async () => {
      const { session, refresh_token_id } = await newSession(undefined, undefined, 'root-hash');
      const tok = await tokens.findByHash({ token_hash: 'root-hash' });
      expect(tok).toMatchObject({ id: refresh_token_id, consumer_type: 'sign_native', revoked_at: null });
      expect(session).toMatchObject({ refresh_family_root_id: refresh_token_id, current_refresh_token_id: refresh_token_id, consumer_type: 'sign', platform: 'ios' });
      expect((await svc.findActiveByCurrentToken(refresh_token_id))?.id).toBe(session.id);
    });

    it('a platform outside ios|android is refused by the CHECK constraint', async () => {
      await expect(
        svc.createSession({
          user_id: uuidv7(), tenant_id: uuidv7(), consumer_type: 'sign', refresh_consumer_type: 'sign_native', client_id: 'c',
          installation_id: 'i', platform: 'windows' as never, app_version: '1', token_hash: 'h-win', expires_at: later(60),
        }),
      ).rejects.toThrow();
    });

    it('rotateForSession moves the current pointer atomically; a concurrent second rotation of the same token loses with RotationRaceError and leaves no orphan', async () => {
      const { session, refresh_token_id } = await newSession();
      const [a, b] = await Promise.allSettled([
        svc.rotateForSession({ session_id: session.id, old_token_id: refresh_token_id, new_token_hash: 'n-a', new_expires_at: later(3600) }),
        svc.rotateForSession({ session_id: session.id, old_token_id: refresh_token_id, new_token_hash: 'n-b', new_expires_at: later(3600) }),
      ]);
      const won = [a, b].filter((r) => r.status === 'fulfilled');
      const lost = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.reason).toBeInstanceOf(RotationRaceError);
      const all = await prisma.refreshToken.findMany({});
      expect(all).toHaveLength(2);
      const after = (await svc.findById(session.id))!;
      expect(after.current_refresh_token_id).not.toBe(refresh_token_id);
      expect(after.refresh_family_root_id).toBe(refresh_token_id);
      const old = await prisma.refreshToken.findUnique({ where: { id: refresh_token_id } });
      expect(old?.replaced_by_id).toBe(after.current_refresh_token_id);
    });

    it('rotation of a revoked session is refused (RotationRaceError), even with a live token row', async () => {
      const { session, refresh_token_id } = await newSession();
      await prisma.nativeDeviceSession.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
      await expect(
        svc.rotateForSession({ session_id: session.id, old_token_id: refresh_token_id, new_token_hash: 'n', new_expires_at: later(60) }),
      ).rejects.toBeInstanceOf(RotationRaceError);
    });

    it('revokeSession revokes the session AND its live family member; idempotent false on the second call', async () => {
      const { session } = await newSession();
      const r1 = await svc.rotateForSession({ session_id: session.id, old_token_id: session.current_refresh_token_id, new_token_hash: 'gen2', new_expires_at: later(60) });
      expect(await svc.revokeSession({ id: session.id, reason: 'device_revoked' })).toBe(true);
      expect(await svc.revokeSession({ id: session.id, reason: 'device_revoked' })).toBe(false);
      const live = await prisma.refreshToken.findMany({ where: { revoked_at: null } });
      expect(live).toHaveLength(0);
      expect((await svc.findById(session.id))?.revoke_reason).toBe('device_revoked');
      expect(await svc.isActive(session.id)).toBe(false);
      expect(r1.session.id).toBe(session.id);
    });

    it('owner scoping: findOwnedActive answers null for another user or tenant; list shows only the caller\'s live sessions', async () => {
      const user = uuidv7();
      const tenant = uuidv7();
      const mine = await newSession(user, tenant);
      const mine2 = await newSession(user, tenant);
      const theirs = await newSession(uuidv7(), tenant);
      await svc.revokeSession({ id: mine2.session.id, reason: 'logout' });
      expect(await svc.findOwnedActive({ id: theirs.session.id, user_id: user, tenant_id: tenant })).toBeNull();
      expect(await svc.findOwnedActive({ id: mine.session.id, user_id: user, tenant_id: uuidv7() })).toBeNull();
      expect((await svc.findOwnedActive({ id: mine.session.id, user_id: user, tenant_id: tenant }))?.id).toBe(mine.session.id);
      const list = await svc.listActiveForUser({ user_id: user, tenant_id: tenant });
      expect(list.map((s) => s.id)).toEqual([mine.session.id]);
    });

    it('liveness includes the current token: a user-wide refresh-token revocation (browser cascade) makes the session non-live', async () => {
      const user = uuidv7();
      const tenant = uuidv7();
      const s = await newSession(user, tenant);
      expect(await svc.isActive(s.session.id)).toBe(true);
      await tokens.revokeAllForUser({ user_id: user });
      expect(await svc.isActive(s.session.id)).toBe(false);
      expect(await svc.findOwnedActive({ id: s.session.id, user_id: user, tenant_id: tenant })).toBeNull();
      expect(await svc.listActiveForUser({ user_id: user, tenant_id: tenant })).toEqual([]);
    });

    it('revokeAllForUser closes every live session of the user only', async () => {
      const user = uuidv7();
      await newSession(user);
      await newSession(user);
      const other = await newSession();
      expect((await svc.revokeAllForUser({ user_id: user, reason: 'reuse_detected' })).revoked_count).toBe(2);
      expect(await svc.isActive(other.session.id)).toBe(true);
    });
  },
);
