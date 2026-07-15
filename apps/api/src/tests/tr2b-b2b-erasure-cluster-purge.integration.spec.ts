import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  TalentErasureService,
  type PgExec,
  type S3Deleter,
} from '../talent-identity/talent-erasure.service.js';

// TR-2b B2b (Directive §PR-2.1/§PR-2.4) — the erasure last-reference cluster purge,
// end-to-end against a real Postgres 17. Proves: erasing the LAST-referencing human
// orphans + purges the identity cluster (all five effects; dry-run previews it
// first); erasing one-of-two tenants' human leaves the cluster ALIVE (the other
// tenant still holds it). NO grace on the erasure path.

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

const TENANT_A = '01900000-0000-7000-8000-0000000000d1';
const TENANT_B = '01900000-0000-7000-8000-0000000000d2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2b B2b — erasure last-reference cluster purge (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let pg: PgExec;
    const erasure = new TalentErasureService();
    const s3Stub: S3Deleter = async () => {
      /* no-op */
    };

    async function seedRecord(tenant: string, recordId: string): Promise<void> {
      await db.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, tenant_status, source_channel, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Erase', 'Me', 'active', 'self_signup', now(), now())`,
        [recordId, tenant],
      );
    }

    // A live holder of `clusterId` in `tenant`: an ACTIVE subject holding
    // ATS_TALENT_RECORD(recordId) + PERSON_CLUSTER(clusterId).
    async function seedHolder(
      tenant: string,
      recordId: string,
      clusterId: string,
    ): Promise<string> {
      const subjectId = uuidv7();
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
         VALUES ($1::uuid, $2::uuid, 'ACTIVE', now())`,
        [subjectId, tenant],
      );
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'ATS_TALENT_RECORD',$4::uuid,'seed',now())`,
        [uuidv7(), subjectId, tenant, recordId],
      );
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'PERSON_CLUSTER',$4::uuid,'seed',now())`,
        [uuidv7(), subjectId, tenant, clusterId],
      );
      return subjectId;
    }

    async function seedClusterAndLinks(clusterId: string, tenant: string): Promise<void> {
      await db.query(
        `INSERT INTO identity_index."PersonCluster" (id, created_at, updated_at)
         VALUES ($1::uuid, now(), now())`,
        [clusterId],
      );
      await db.query(
        `INSERT INTO identity_index."ClusterFingerprint" (id, cluster_id, fingerprint, kind, created_at)
         VALUES ($1::uuid, $2::uuid, $3, 'email', now())`,
        [uuidv7(), clusterId, `fp-${clusterId}`],
      );
      await db.query(
        `INSERT INTO ingestion."RawPayloadReference"
           (id, tenant_id, source, source_class, storage_ref, sha256, content_type,
            captured_at, resolved_cluster_id, created_at, updated_at)
         VALUES ($1::uuid,$2::uuid,'talent_direct','SELF','stub',$3,'text/plain',now(),$4::uuid,now(),now())`,
        [uuidv7(), tenant, `sha-${clusterId}`, clusterId],
      );
      await db.query(
        `INSERT INTO portal_identity."PortalUser" (id, email_normalized, cluster_id, created_at, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, now(), now())`,
        [uuidv7(), `p-${clusterId}@example.com`, clusterId],
      );
      await db.query(
        `INSERT INTO platform_trust."DormantLink" (id, cluster_id, detected_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, now(), now(), now())`,
        [uuidv7(), clusterId],
      );
    }

    const count = async (sql: string, params: unknown[]): Promise<number> => {
      const r = await db.query<{ n: string }>(sql, params);
      return Number(r.rows[0]!.n);
    };
    const clusterExists = (id: string) =>
      count(`SELECT count(*)::int AS n FROM identity_index."PersonCluster" WHERE id=$1::uuid`, [id]);
    const arrivalStamps = (id: string) =>
      count(`SELECT count(*)::int AS n FROM ingestion."RawPayloadReference" WHERE resolved_cluster_id=$1::uuid`, [id]);
    const portalLinks = (id: string) =>
      count(`SELECT count(*)::int AS n FROM portal_identity."PortalUser" WHERE cluster_id=$1::uuid`, [id]);
    const dormant = (id: string) =>
      count(`SELECT count(*)::int AS n FROM platform_trust."DormantLink" WHERE cluster_id=$1::uuid`, [id]);

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      for (const p of allMigrations()) await db.query(readFileSync(p, 'utf8'));
      pg = {
        async query<T>(sql: string, params?: unknown[]) {
          const r = await db.query(sql, params as unknown[] | undefined);
          return { rows: r.rows as T[], rowCount: r.rowCount };
        },
      };
    }, 300_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    }, 60_000);

    beforeEach(async () => {
      for (const t of [
        'talent_record."TalentRecord"',
        'talent_trust."ResolutionSubject"',
        'identity_index."PersonCluster"',
        'ingestion."RawPayloadReference"',
        'portal_identity."PortalUser"',
        'platform_trust."DormantLink"',
        'audit."ConsentAuditEvent"',
      ]) {
        await db.query(`TRUNCATE TABLE ${t} CASCADE`);
      }
    });

    it('erasing the LAST-referencing human orphans + purges the cluster (dry-run previews first)', async () => {
      const cluster = uuidv7();
      const recA = uuidv7();
      await seedRecord(TENANT_A, recA);
      await seedHolder(TENANT_A, recA, cluster);
      await seedClusterAndLinks(cluster, TENANT_A);

      // Dry-run: previews the would-purge cluster, writes nothing.
      const dry = await erasure.dryRun(pg, TENANT_A, recA);
      expect(dry.cluster_purge.captured_cluster_ids).toContain(cluster);
      expect(dry.cluster_purge.orphaned_cluster_ids).toContain(cluster);
      expect(dry.cluster_purge.purged).toHaveLength(0);
      expect(await clusterExists(cluster)).toBe(1); // dry-run purged nothing

      // Execute: the cluster is orphaned and purged (all five effects).
      const exec = await erasure.execute(pg, TENANT_A, recA, s3Stub);
      expect(exec.cluster_purge.orphaned_cluster_ids).toContain(cluster);
      expect(exec.cluster_purge.purged).toHaveLength(1);
      expect(exec.cluster_purge.purged[0]!.clusters_deleted).toBe(1);

      expect(await clusterExists(cluster)).toBe(0);
      expect(await arrivalStamps(cluster)).toBe(0);
      expect(await portalLinks(cluster)).toBe(0);
      expect(await dormant(cluster)).toBe(0);
    });

    it('erasing one-of-two tenants leaves the cluster ALIVE (the other tenant still holds it)', async () => {
      const cluster = uuidv7();
      const recA = uuidv7();
      const recB = uuidv7();
      await seedRecord(TENANT_A, recA);
      await seedRecord(TENANT_B, recB);
      await seedHolder(TENANT_A, recA, cluster);
      await seedHolder(TENANT_B, recB, cluster); // the SAME cluster, another tenant
      await seedClusterAndLinks(cluster, TENANT_A);

      const exec = await erasure.execute(pg, TENANT_A, recA, s3Stub);
      // Captured, but NOT orphaned — tenant B's live holder survives the check.
      expect(exec.cluster_purge.captured_cluster_ids).toContain(cluster);
      expect(exec.cluster_purge.orphaned_cluster_ids).not.toContain(cluster);
      expect(exec.cluster_purge.purged).toHaveLength(0);

      expect(await clusterExists(cluster)).toBe(1); // survived
      expect(await portalLinks(cluster)).toBe(1); // linkage intact
    });
  },
);
