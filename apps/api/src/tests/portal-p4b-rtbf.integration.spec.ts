import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PortalIdentityRepository } from '@aramo/portal-identity';

import { AppModule } from '../app.module.js';
import { PortalRtbfService } from '../talent-identity/portal-rtbf.service.js';

// Portal P4 P4b (§PR-2, D-2/D-3) — the talent RTBF, end-to-end against a real
// Postgres 17. Boots AppModule, applies every lib migration (glob — auto-includes
// portal_identity incl. NoticeDelivery + platform_trust + identity_index), seeds a
// full platform identity, and drives PortalRtbfService.eraseSelf. Proves the
// full circle: purge → residue delete (NoticeDelivery EXPLICIT, Gate-5) → the
// tenant-rail record UNTOUCHED (D-2) → a re-login mints a FRESH identity; plus the
// grave-confirm mismatch refusal and idempotency.

const ROOT = resolve(__dirname, '../../../..');

function allMigrations(): string[] {
  const libs = resolve(ROOT, 'libs');
  const out: Array<{ ts: string; path: string }> = [];
  for (const lib of readdirSync(libs)) {
    const migDir = resolve(libs, lib, 'prisma', 'migrations');
    let entries: string[];
    try {
      entries = readdirSync(migDir);
    } catch {
      continue;
    }
    for (const d of entries) {
      const file = resolve(migDir, d, 'migration.sql');
      try {
        readFileSync(file);
      } catch {
        continue;
      }
      out.push({ ts: d, path: file });
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out.map((o) => o.path);
}

const EMAIL = 'erase-me@example.com';
const TENANT = '01900000-0000-7000-8000-0000000000c1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Portal P4b — talent RTBF full circle (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    let rtbf: PortalRtbfService;
    let portals: PortalIdentityRepository;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of allMigrations()) await db.query(readFileSync(p, 'utf8'));

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await module.init();
      rtbf = module.get(PortalRtbfService);
      portals = module.get(PortalIdentityRepository);
    }, 120_000);

    afterAll(async () => {
      await module?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    beforeEach(async () => {
      await db.query(`TRUNCATE TABLE identity_index."PersonCluster" CASCADE`);
      await db.query(`TRUNCATE TABLE identity_index."ClusterFingerprint" CASCADE`);
      await db.query(`TRUNCATE TABLE talent_trust."ResolutionSubject" CASCADE`);
      await db.query(`TRUNCATE TABLE portal_identity."NoticeDelivery" CASCADE`);
      await db.query(`TRUNCATE TABLE portal_identity."PortalUser" CASCADE`);
      await db.query(`TRUNCATE TABLE portal_identity."PortalLoginToken" CASCADE`);
    });

    async function seedIdentity(): Promise<{ sub: string; clusterId: string }> {
      const clusterId = uuidv7();
      const sub = uuidv7();
      await db.query(
        `INSERT INTO identity_index."PersonCluster" (id, created_at, updated_at)
         VALUES ($1::uuid, now(), now())`,
        [clusterId],
      );
      await db.query(
        `INSERT INTO identity_index."ClusterFingerprint" (id, cluster_id, fingerprint, kind, created_at)
         VALUES ($1::uuid, $2::uuid, $3, 'email', now())`,
        [uuidv7(), clusterId, `fp-${EMAIL}`],
      );
      await db.query(
        `INSERT INTO portal_identity."PortalUser" (id, email_normalized, cluster_id, created_at, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, now(), now())`,
        [sub, EMAIL, clusterId],
      );
      await db.query(
        `INSERT INTO portal_identity."NoticeDelivery" (id, portal_user_id, notice_version, channel, delivered_at, created_at)
         VALUES ($1::uuid, $2::uuid, 'portal-notice-v1', 'email', now(), now())`,
        [uuidv7(), sub],
      );
      await db.query(
        `INSERT INTO portal_identity."PortalLoginToken" (id, email_normalized, token_hash, expires_at, created_at)
         VALUES ($1::uuid, $2, $3, now() + interval '15 minutes', now())`,
        [uuidv7(), EMAIL, `hash-${sub}`],
      );
      // Tenant-rail record for the same person (D-2 untouched proof).
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
         VALUES ($1::uuid, $2::uuid, 'ACTIVE', now())`,
        [uuidv7(), TENANT],
      );
      return { sub, clusterId };
    }

    const one = async (sql: string, params: unknown[]): Promise<number> => {
      const r = await db.query<{ n: string }>(sql, params);
      return Number(r.rows[0]!.n);
    };
    const portalUsers = (sub: string) =>
      one(`SELECT count(*)::int AS n FROM portal_identity."PortalUser" WHERE id = $1::uuid`, [sub]);
    const notices = (sub: string) =>
      one(`SELECT count(*)::int AS n FROM portal_identity."NoticeDelivery" WHERE portal_user_id = $1::uuid`, [sub]);
    const tokens = () =>
      one(`SELECT count(*)::int AS n FROM portal_identity."PortalLoginToken" WHERE email_normalized = $1`, [EMAIL]);
    const clusters = (id: string) =>
      one(`SELECT count(*)::int AS n FROM identity_index."PersonCluster" WHERE id = $1::uuid`, [id]);
    const fingerprints = (id: string) =>
      one(`SELECT count(*)::int AS n FROM identity_index."ClusterFingerprint" WHERE cluster_id = $1::uuid`, [id]);
    const tenantSubjects = () =>
      one(`SELECT count(*)::int AS n FROM talent_trust."ResolutionSubject" WHERE tenant_id = $1::uuid`, [TENANT]);

    it('erases the platform identity, leaves the tenant-rail record untouched, and a re-login mints a FRESH identity', async () => {
      const { sub, clusterId } = await seedIdentity();
      // Pre-state.
      expect(await portalUsers(sub)).toBe(1);
      expect(await notices(sub)).toBe(1);
      expect(await tokens()).toBe(1);
      expect(await clusters(clusterId)).toBe(1);
      expect(await fingerprints(clusterId)).toBe(1);
      expect(await tenantSubjects()).toBe(1);

      await rtbf.eraseSelf({ portalUserId: sub, confirmation: EMAIL, requestId: 'req-1' });

      // Platform-rail: gone. NoticeDelivery EXPLICITLY erased (Gate-5).
      expect(await portalUsers(sub)).toBe(0);
      expect(await notices(sub)).toBe(0);
      expect(await tokens()).toBe(0);
      expect(await clusters(clusterId)).toBe(0);
      expect(await fingerprints(clusterId)).toBe(0);
      // D-2: the tenant-rail record is UNTOUCHED (a separate controller).
      expect(await tenantSubjects()).toBe(1);

      // Re-registration: the same email mints a BRAND-NEW identity (fresh id).
      const fresh = await portals.findOrCreatePortalOnLogin({
        email_normalized: EMAIL,
        cluster_id: uuidv7(),
        now: new Date(),
      });
      expect(fresh.id).not.toBe(sub);
    });

    it('refuses on a confirmation mismatch and deletes nothing (D-3 grave confirm)', async () => {
      const { sub } = await seedIdentity();
      await expect(
        rtbf.eraseSelf({ portalUserId: sub, confirmation: 'wrong@example.com', requestId: 'req-2' }),
      ).rejects.toThrow();
      expect(await portalUsers(sub)).toBe(1);
      expect(await notices(sub)).toBe(1);
    });

    it('is idempotent — a second erase over an already-gone identity is a no-op success', async () => {
      const { sub } = await seedIdentity();
      await rtbf.eraseSelf({ portalUserId: sub, confirmation: EMAIL, requestId: 'req-3' });
      await rtbf.eraseSelf({ portalUserId: sub, confirmation: EMAIL, requestId: 'req-4' });
      expect(await portalUsers(sub)).toBe(0);
    });
  },
);
