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

import { AppModule } from '../app.module.js';
import { IdentityLifecycleSweepService } from '../talent-identity/identity-lifecycle-sweep.service.js';

// TR-2b B2a (Directive §PR-1.4) — the identity-index lifecycle sweep, end-to-end
// against a real Postgres 17. Boots AppModule, applies every lib migration
// (auto-including platform_trust), seeds cross-schema cluster chains, and drives
// IdentityLifecycleSweepService.drainBatch. Proves: orphan-past-grace purged
// (fingerprints gone, arrival stamps + PortalUser.cluster_id nulled, DormantLink
// gone); live-referenced cluster untouched; within-grace orphan untouched;
// two-tenant cluster reported but NOT minted with the flag off; flag-on mints
// exactly one PENDING_NOTICE row.

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

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000a2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2b B2a — identity-index lifecycle sweep (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    let sweep: IdentityLifecycleSweepService;
    const savedEnv: Partial<Record<string, string | undefined>> = {};

    // ---- seed helpers (raw SQL — full control over created_at for grace) ----

    async function seedCluster(id: string, createdDaysAgo: number): Promise<void> {
      await db.query(
        `INSERT INTO identity_index."PersonCluster" (id, created_at, updated_at)
         VALUES ($1::uuid, now() - ($2 || ' days')::interval, now())`,
        [id, String(createdDaysAgo)],
      );
      await db.query(
        `INSERT INTO identity_index."ClusterFingerprint" (id, cluster_id, fingerprint, kind, created_at)
         VALUES ($1::uuid, $2::uuid, $3, 'email', now())`,
        [uuidv7(), id, `fp-${id}`],
      );
    }

    // A live holder for a cluster in a tenant: an ACTIVE ResolutionSubject holding
    // a PERSON_CLUSTER ref (the liveness chain's first hop) + an ATS_TALENT_RECORD
    // ref (what makes the chain LIVE).
    async function seedLiveHolder(clusterId: string, tenantId: string): Promise<void> {
      const subjectId = uuidv7();
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
         VALUES ($1::uuid, $2::uuid, 'ACTIVE', now())`,
        [subjectId, tenantId],
      );
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PERSON_CLUSTER', $4::uuid, 'seed', now())`,
        [uuidv7(), subjectId, tenantId, clusterId],
      );
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATS_TALENT_RECORD', $4::uuid, 'seed', now())`,
        [uuidv7(), subjectId, tenantId, uuidv7()],
      );
    }

    async function seedArrivalStamp(clusterId: string, tenantId: string): Promise<void> {
      await db.query(
        `INSERT INTO ingestion."RawPayloadReference"
           (id, tenant_id, source, source_class, storage_ref, sha256, content_type,
            captured_at, resolved_cluster_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'talent_direct', 'SELF', 'stub', $3, 'text/plain',
            now(), $4::uuid, now(), now())`,
        [uuidv7(), tenantId, `sha-${clusterId}`, clusterId],
      );
    }

    async function seedPortalUser(clusterId: string): Promise<void> {
      await db.query(
        `INSERT INTO portal_identity."PortalUser" (id, email_normalized, cluster_id, created_at, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, now(), now())`,
        [uuidv7(), `portal-${clusterId}@example.com`, clusterId],
      );
    }

    async function seedDormantLink(clusterId: string): Promise<void> {
      await db.query(
        `INSERT INTO platform_trust."DormantLink" (id, cluster_id, detected_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, now(), now(), now())`,
        [uuidv7(), clusterId],
      );
    }

    async function count(sql: string, params: unknown[]): Promise<number> {
      const r = await db.query<{ n: string }>(sql, params);
      return Number(r.rows[0]!.n);
    }
    const clusterExists = (id: string) =>
      count(`SELECT count(*)::int AS n FROM identity_index."PersonCluster" WHERE id = $1::uuid`, [id]);
    const fingerprintCount = (id: string) =>
      count(`SELECT count(*)::int AS n FROM identity_index."ClusterFingerprint" WHERE cluster_id = $1::uuid`, [id]);
    const arrivalStampCount = (id: string) =>
      count(`SELECT count(*)::int AS n FROM ingestion."RawPayloadReference" WHERE resolved_cluster_id = $1::uuid`, [id]);
    const portalLinkCount = (id: string) =>
      count(`SELECT count(*)::int AS n FROM portal_identity."PortalUser" WHERE cluster_id = $1::uuid`, [id]);
    const dormantCount = (id: string) =>
      count(`SELECT count(*)::int AS n FROM platform_trust."DormantLink" WHERE cluster_id = $1::uuid`, [id]);

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of allMigrations()) await db.query(readFileSync(p, 'utf8'));
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR2bB2a', now()) ON CONFLICT DO NOTHING`,
          [t],
        );
      }

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await module.init();
      sweep = module.get(IdentityLifecycleSweepService);
    }, 300_000);

    afterAll(async () => {
      await module?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      await db.query(`TRUNCATE TABLE identity_index."PersonCluster" CASCADE`);
      await db.query(`TRUNCATE TABLE talent_trust."ResolutionSubject" CASCADE`);
      await db.query(`TRUNCATE TABLE ingestion."RawPayloadReference" CASCADE`);
      await db.query(`TRUNCATE TABLE portal_identity."PortalUser" CASCADE`);
      await db.query(`TRUNCATE TABLE platform_trust."DormantLink" CASCADE`);
    });

    it('purges an orphan past grace — fingerprints, arrival stamps, portal link, dormant links all gone', async () => {
      const cluster = uuidv7();
      await seedCluster(cluster, 60); // older than ORPHAN_GRACE_DAYS=30
      // no talent_trust PERSON_CLUSTER ref → 0 live tenants → orphan
      await seedArrivalStamp(cluster, TENANT_A);
      await seedPortalUser(cluster);
      await seedDormantLink(cluster);

      const r = await sweep.drainBatch({ now: new Date() });
      expect(r.orphans_purged).toBe(1);
      expect(r.dormant_detected).toBe(0);

      expect(await clusterExists(cluster)).toBe(0);
      expect(await fingerprintCount(cluster)).toBe(0);
      expect(await arrivalStampCount(cluster)).toBe(0); // resolved_cluster_id nulled
      expect(await portalLinkCount(cluster)).toBe(0); // PortalUser.cluster_id nulled
      expect(await dormantCount(cluster)).toBe(0);
    });

    it('leaves a live-referenced cluster untouched', async () => {
      const cluster = uuidv7();
      await seedCluster(cluster, 60);
      await seedLiveHolder(cluster, TENANT_A); // 1 live tenant → normal

      const r = await sweep.drainBatch({ now: new Date() });
      expect(r.orphans_purged).toBe(0);
      expect(r.dormant_detected).toBe(0);
      expect(await clusterExists(cluster)).toBe(1);
    });

    it('leaves a within-grace orphan untouched (grace protects the young)', async () => {
      const cluster = uuidv7();
      await seedCluster(cluster, 5); // younger than ORPHAN_GRACE_DAYS=30
      // no live refs → orphan, but within grace

      const r = await sweep.drainBatch({ now: new Date() });
      expect(r.orphans_purged).toBe(0);
      expect(await clusterExists(cluster)).toBe(1);
    });

    it('reports a two-tenant (dormant) cluster but mints NOTHING with the flag off', async () => {
      const cluster = uuidv7();
      await seedCluster(cluster, 60);
      await seedLiveHolder(cluster, TENANT_A);
      await seedLiveHolder(cluster, TENANT_B); // 2 live tenants → dormant

      const r = await sweep.drainBatch({ now: new Date() }); // flag off (default)
      expect(r.dormant_detected).toBe(1);
      expect(r.dormant_minted).toBe(0);
      expect(r.orphans_purged).toBe(0);
      expect(await clusterExists(cluster)).toBe(1); // dormant ≠ purged
      expect(await dormantCount(cluster)).toBe(0); // report-only — no row
    });

    it('mints exactly one PENDING_NOTICE DormantLink for a dormant cluster with the flag ON (test only)', async () => {
      const cluster = uuidv7();
      await seedCluster(cluster, 60);
      await seedLiveHolder(cluster, TENANT_A);
      await seedLiveHolder(cluster, TENANT_B);

      const r = await sweep.drainBatch({ now: new Date(), mintingEnabled: true });
      expect(r.dormant_detected).toBe(1);
      expect(r.dormant_minted).toBe(1);
      expect(await dormantCount(cluster)).toBe(1);

      const row = await db.query<{ status: string }>(
        `SELECT status FROM platform_trust."DormantLink" WHERE cluster_id = $1::uuid`,
        [cluster],
      );
      expect(row.rows[0]!.status).toBe('PENDING_NOTICE');

      // Idempotent: a second flag-on pass does not double-mint (partial-unique).
      const r2 = await sweep.drainBatch({ now: new Date(), mintingEnabled: true });
      expect(r2.dormant_detected).toBe(1);
      expect(await dormantCount(cluster)).toBe(1);
    });
  },
);
