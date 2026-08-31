import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { IntegrationConnectionRepository } from '../lib/connection/integration-connection.repository.js';
import {
  PipelineProviderDispositionMappingRepository,
  ExternalPipelineEpisodeIdentityRepository,
} from '../lib/lifecycle/pipeline-disposition-mapping.repository.js';

// L2-I (D1) — the Pipeline provider-disposition mapping contract, against real Postgres 17.
// Proves the SET-versioned resolution (ACTIVE set → row), the disposition/target CHECK, the
// one-active-set partial unique, the UNMAPPABLE null (the AC-2 primitive), and the
// connection-scoped external-episode identity + per-event idempotency. This is a pure
// data-access seam — no @aramo/pipeline import anywhere (SB-7; proven structurally in the
// apps/api orchestration spec).
const ROOT = resolve(__dirname, '../../../..');
function integrationMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/integration/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-I D1 pipeline provider-disposition mapping (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let connections: IntegrationConnectionRepository;
    let mappings: PipelineProviderDispositionMappingRepository;
    let identities: ExternalPipelineEpisodeIdentityRepository;
    const TENANT = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of integrationMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      connections = new IntegrationConnectionRepository(prisma);
      mappings = new PipelineProviderDispositionMappingRepository(prisma);
      identities = new ExternalPipelineEpisodeIdentityRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    const seedConn = async (): Promise<string> =>
      (await connections.create({ tenant_id: TENANT, provider_key: 'acme_ats' })).id;

    it('upsert → resolve: an authored EXECUTE_ACTION row resolves from the ACTIVE v1 set with its target + mapping_version', async () => {
      const conn = await seedConn();
      await mappings.upsertMapping({
        tenant_id: TENANT, connection_id: conn,
        provider_token: 'hired', mapped_target: 'QUALIFY', target_kind: 'action',
      });
      const r = await mappings.findByConnectionState(TENANT, conn, 'hired');
      expect(r).not.toBeNull();
      expect(r!.disposition).toBe('EXECUTE_ACTION');
      expect(r!.mapped_target).toBe('QUALIFY');
      expect(r!.target_kind).toBe('action');
      expect(r!.mapping_version).toBe(1); // the ACTIVE set's version, carried for provenance
      expect(r!.authority_mode).toBe('external_authority');
    });

    it('a reason-kind target resolves (non-system disposition reason)', async () => {
      const conn = await seedConn();
      await mappings.upsertMapping({
        tenant_id: TENANT, connection_id: conn,
        provider_token: 'rejected_by_client', mapped_target: 'not_a_fit', target_kind: 'reason',
      });
      const r = await mappings.findByConnectionState(TENANT, conn, 'rejected_by_client');
      expect(r!.mapped_target).toBe('not_a_fit');
      expect(r!.target_kind).toBe('reason');
    });

    it('IGNORE disposition nulls target + kind (DB CHECK honored)', async () => {
      const conn = await seedConn();
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'noise', disposition: 'IGNORE' });
      const r = await mappings.findByConnectionState(TENANT, conn, 'noise');
      expect(r!.disposition).toBe('IGNORE');
      expect(r!.mapped_target).toBeNull();
      expect(r!.target_kind).toBeNull();
    });

    it('UNMAPPABLE: no active set OR no row for the token → null (the AC-2 pending primitive)', async () => {
      const conn = await seedConn();
      // No mapping authored yet → no active set → null.
      expect(await mappings.findByConnectionState(TENANT, conn, 'anything')).toBeNull();
      // Active set exists but the token is absent → still null.
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'known', mapped_target: 'CONTACT', target_kind: 'action' });
      expect(await mappings.findByConnectionState(TENANT, conn, 'unknown_token')).toBeNull();
    });

    it('the disposition/target CHECK rejects an EXECUTE_ACTION row with a null target (structural)', async () => {
      const conn = await seedConn();
      // Seed an active set first.
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'seed', mapped_target: 'QUALIFY', target_kind: 'action' });
      const set = await db.query<{ id: string }>(
        `SELECT id FROM integration."PipelineProviderDispositionMappingSet" WHERE connection_id=$1 AND status='active'`, [conn],
      );
      await expect(
        db.query(
          `INSERT INTO integration."PipelineProviderDispositionMapping"
             (id, tenant_id, connection_id, mapping_set_id, provider_token, disposition, mapped_target, target_kind)
           VALUES (gen_random_uuid(),$1,$2,$3,'bad','EXECUTE_ACTION',NULL,NULL)`,
          [TENANT, conn, set.rows[0]!.id],
        ),
      ).rejects.toThrow(/check|constraint/i);
    });

    it('one-active-set partial unique: a second active set for a connection is rejected', async () => {
      const conn = await seedConn();
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'x', mapped_target: 'CONTACT', target_kind: 'action' });
      await expect(
        db.query(
          `INSERT INTO integration."PipelineProviderDispositionMappingSet" (id, tenant_id, connection_id, version, status, created_by)
           VALUES (gen_random_uuid(),$1,$2,2,'active','00000000-0000-0000-0000-000000000000')`,
          [TENANT, conn],
        ),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it('external episode identity: recordIdentity is idempotent on the establishing event; resolveByExternalEpisode binds the pipeline id', async () => {
      const conn = await seedConn();
      const pipelineId = randomUUID();
      const eventId = 'evt-1';
      await identities.recordIdentity({ tenant_id: TENANT, connection_id: conn, external_episode_id: 'EXT-9', pipeline_id: pipelineId, external_event_id: eventId });
      // Redelivery of the SAME event → no duplicate.
      await identities.recordIdentity({ tenant_id: TENANT, connection_id: conn, external_episode_id: 'EXT-9', pipeline_id: pipelineId, external_event_id: eventId });
      const count = await db.query<{ c: string }>(
        `SELECT count(*)::int c FROM integration."ExternalPipelineEpisodeIdentity" WHERE connection_id=$1 AND external_episode_id='EXT-9'`, [conn],
      );
      expect(Number(count.rows[0]!.c)).toBe(1);
      const resolved = await identities.resolveByExternalEpisode(TENANT, conn, 'EXT-9');
      expect(resolved!.pipeline_id).toBe(pipelineId);
    });
  },
);
