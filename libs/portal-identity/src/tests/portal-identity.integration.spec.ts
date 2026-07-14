import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PortalIdentityRepository } from '../lib/portal-identity.repository.js';
import { generatePortalLoginToken, portalLoginExpiresAt } from '../lib/portal-login-token.js';

// Portal P1 integration — brings up Postgres 17, applies the init migration, and
// proves the token lifecycle (mint / rotate-in-place / atomic single-use consume,
// the TR-3 replay guard) + the lazy PortalUser mint against real SQL.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260714120000_init_portal_identity/migration.sql',
);

function splitDdl(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PortalIdentityRepository — passwordless portal substrate (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: PortalIdentityRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of splitDdl(readFileSync(MIGRATION_PATH, 'utf8'))) {
        await setupClient.$executeRawUnsafe(stmt);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PortalIdentityRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('mints a token, finds it open, and rotates it in place (resend) — the old hash dies', async () => {
      const email = 'rotate@example.com';
      const now = new Date();
      const first = generatePortalLoginToken();
      await repo.createLoginToken({ email_normalized: email, token_hash: first.hash, expires_at: portalLoginExpiresAt(now) });

      const open = await repo.findOpenLoginToken(email, now);
      expect(open).not.toBeNull();

      const second = generatePortalLoginToken();
      await repo.rotateLoginToken({ id: open!.id, token_hash: second.hash, expires_at: portalLoginExpiresAt(now) });

      // The old hash no longer consumes; the rotated one does.
      expect(await repo.consumeLoginToken(first.hash, new Date())).toBeNull();
      const consumed = await repo.consumeLoginToken(second.hash, new Date());
      expect(consumed).not.toBeNull();
      expect(consumed!.email_normalized).toBe(email);
    });

    it('SINGLE-WINNER: two concurrent consumes of the same token → exactly one succeeds', async () => {
      const email = 'race@example.com';
      const now = new Date();
      const { hash } = generatePortalLoginToken();
      await repo.createLoginToken({ email_normalized: email, token_hash: hash, expires_at: portalLoginExpiresAt(now) });

      const [a, b] = await Promise.all([
        repo.consumeLoginToken(hash, new Date()),
        repo.consumeLoginToken(hash, new Date()),
      ]);
      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
    });

    it('a replayed (already-consumed) token returns null — indistinguishable from unknown', async () => {
      const now = new Date();
      const { hash } = generatePortalLoginToken();
      await repo.createLoginToken({ email_normalized: 'replay@example.com', token_hash: hash, expires_at: portalLoginExpiresAt(now) });
      expect(await repo.consumeLoginToken(hash, new Date())).not.toBeNull();
      // Second consume — already consumed → null.
      expect(await repo.consumeLoginToken(hash, new Date())).toBeNull();
    });

    it('an expired token cannot be consumed (app-side TTL enforced in the guard)', async () => {
      const { hash } = generatePortalLoginToken();
      const past = new Date('2020-01-01T00:00:00.000Z');
      await repo.createLoginToken({ email_normalized: 'expired@example.com', token_hash: hash, expires_at: past });
      expect(await repo.consumeLoginToken(hash, new Date())).toBeNull();
    });

    it('lazy mint: findOrCreatePortalOnLogin mints once with the cluster, then stamps last_login on re-login', async () => {
      const email = 'lazy@example.com';
      const clusterId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa001';
      const t1 = new Date('2026-07-14T00:00:00.000Z');
      const created = await repo.findOrCreatePortalOnLogin({ email_normalized: email, cluster_id: clusterId, now: t1 });
      expect(created.cluster_id).toBe(clusterId);
      expect(created.last_login_at?.toISOString()).toBe(t1.toISOString());

      // Second login: same user (unique email), last_login stamped fresh; cluster unchanged.
      const t2 = new Date('2026-07-14T01:00:00.000Z');
      const again = await repo.findOrCreatePortalOnLogin({ email_normalized: email, cluster_id: null, now: t2 });
      expect(again.id).toBe(created.id);
      expect(again.cluster_id).toBe(clusterId);
      expect(again.last_login_at?.toISOString()).toBe(t2.toISOString());
    });

    it('a portal with no cluster mints with cluster_id null (valid empty state)', async () => {
      const created = await repo.findOrCreatePortalOnLogin({
        email_normalized: 'nocluster@example.com',
        cluster_id: null,
        now: new Date(),
      });
      expect(created.cluster_id).toBeNull();
    });
  },
);
