import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import {
  PipelineProviderDispositionMappingRepository,
  IntegrationConnectionRepository,
  IntegrationPrismaService,
} from '@aramo/integration';

import { PipelineProviderMappingAdminService } from '../pipeline-integration/pipeline-provider-mapping-admin.service.js';

// L2-I (D1) — AC-3: provider vocabulary maps to canonical WITHOUT bending the ontology.
// The mapping-admin service validates a target against the canonical set DERIVED from
// @aramo/pipeline (recruiter actions + non-system reasons) at AUTHOR time; a non-canonical /
// system-only / DOWNSTREAM_OUTCOME target is rejected (422) with ZERO rows written. Also
// exercises the AC-2 UNMAPPABLE primitive (no active set/row → null).
const ROOT = resolve(__dirname, '../../../..');
function integrationMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/integration/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-I D1 provider mapping admin — author-time canonical-target validation (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: IntegrationPrismaService;
    let connections: IntegrationConnectionRepository;
    let mappings: PipelineProviderDispositionMappingRepository;
    let admin: PipelineProviderMappingAdminService;
    const TENANT = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of integrationMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new IntegrationPrismaService(url);
      await prisma.$connect();
      connections = new IntegrationConnectionRepository(prisma);
      mappings = new PipelineProviderDispositionMappingRepository(prisma);
      admin = new PipelineProviderMappingAdminService(mappings, connections);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    const seedConn = async (): Promise<string> =>
      (await connections.create({ tenant_id: TENANT, provider_key: 'acme_ats' })).id;
    const rowCount = async (conn: string): Promise<number> =>
      Number((await db.query(`SELECT count(*)::int c FROM integration."PipelineProviderDispositionMapping" WHERE connection_id=$1`, [conn])).rows[0].c);
    const authorErr = async (conn: string, token: string, target: string): Promise<AramoError> => {
      try { await admin.authorMapping({ tenant_id: TENANT, connection_id: conn, provider_token: token, mapped_target: target, requestId: 'r' }); }
      catch (e) { return e as AramoError; }
      throw new Error('expected authorMapping to throw');
    };

    it('AC-3: a canonical recruiter ACTION target is accepted and stored as kind=action', async () => {
      const conn = await seedConn();
      await admin.authorMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'hired', mapped_target: 'QUALIFY', requestId: 'r' });
      const r = await mappings.findByConnectionState(TENANT, conn, 'hired');
      expect(r!.mapped_target).toBe('QUALIFY');
      expect(r!.target_kind).toBe('action');
    });

    it('AC-3: a canonical NON-system disposition REASON target is accepted and stored as kind=reason', async () => {
      const conn = await seedConn();
      await admin.authorMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'rejected', mapped_target: 'not_a_fit', requestId: 'r' });
      const r = await mappings.findByConnectionState(TENANT, conn, 'rejected');
      expect(r!.mapped_target).toBe('not_a_fit');
      expect(r!.target_kind).toBe('reason');
    });

    it('AC-3 negative control: system-only COMPLETE is rejected 422 with ZERO rows written', async () => {
      const conn = await seedConn();
      const err = await authorErr(conn, 'placed', 'COMPLETE');
      expect(err).toBeInstanceOf(AramoError);
      expect(err.code).toBe('PIPELINE_PROVIDER_MAPPING_TARGET_INVALID');
      expect(err.statusCode).toBe(422);
      expect(await rowCount(conn)).toBe(0); // author-time rejection wrote nothing
    });

    it('AC-3 negative control: a DOWNSTREAM_OUTCOME reason (placement_started) is rejected 422', async () => {
      const conn = await seedConn();
      const err = await authorErr(conn, 'started', 'placement_started');
      expect(err.code).toBe('PIPELINE_PROVIDER_MAPPING_TARGET_INVALID');
      expect(await rowCount(conn)).toBe(0);
    });

    it('AC-3 negative control: an opaque/unknown token is rejected 422', async () => {
      const conn = await seedConn();
      const err = await authorErr(conn, 'weird', 'PROVIDER_QUALITY_9');
      expect(err.code).toBe('PIPELINE_PROVIDER_MAPPING_TARGET_INVALID');
      expect(await rowCount(conn)).toBe(0);
    });

    it('AC-2 primitive: an unmapped provider token resolves to null (the pending trigger), a mapped one resolves', async () => {
      const conn = await seedConn();
      await admin.authorMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'contacted_by_provider', mapped_target: 'CONTACT', requestId: 'r' });
      expect(await mappings.findByConnectionState(TENANT, conn, 'never_authored')).toBeNull();
      expect((await mappings.findByConnectionState(TENANT, conn, 'contacted_by_provider'))!.mapped_target).toBe('CONTACT');
    });
  },
);
