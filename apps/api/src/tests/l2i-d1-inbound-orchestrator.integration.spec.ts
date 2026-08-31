import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PipelineRepository, PipelinePrismaService } from '@aramo/pipeline';
import {
  PipelineProviderDispositionMappingRepository,
  ExternalPipelineEpisodeIdentityRepository,
  PipelineExternalReconciliationRepository,
  PipelineExternalTransitionProvenanceRepository,
  IntegrationConnectionRepository,
  IntegrationPrismaService,
} from '@aramo/integration';

import { PipelineProviderObservationOrchestrator } from '../pipeline-integration/pipeline-provider-observation.orchestrator.js';

// L2-I (D1) — AC-2 (unmappable/illegal → pending, NEVER mutate) + AC-4 (mapping_version in
// provenance + provider_sequence ⊥ Aramo CAS) for the inbound reconciler-analog, end-to-end
// against real Postgres 17 (pipeline + integration schemas). The orchestrator is the ONLY
// status-writing path from a provider observation, and it is composed in apps/api.
const ROOT = resolve(__dirname, '../../../..');
const PIPELINE_MIGRATIONS = [
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  'libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  'libs/pipeline/prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  'libs/pipeline/prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  'libs/pipeline/prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  'libs/pipeline/prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  'libs/pipeline/prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  'libs/pipeline/prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  'libs/pipeline/prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  'libs/pipeline/prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
].map((p) => resolve(ROOT, p));
function integrationMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/integration/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
function splitDdl(sql: string): string[] {
  const out: string[] = []; let cur = ''; let inDollar = false; let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) { cur += ch; if (ch === '\n') inLineComment = false; continue; }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') { inLineComment = true; cur += ch; continue; }
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(cur); cur = ''; } else { cur += ch; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-I D1 inbound reconciler-analog (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let pipelinePrisma: PipelinePrismaService;
    let integrationPrisma: IntegrationPrismaService;
    let pipeline: PipelineRepository;
    let connections: IntegrationConnectionRepository;
    let mappings: PipelineProviderDispositionMappingRepository;
    let identities: ExternalPipelineEpisodeIdentityRepository;
    let reconciliations: PipelineExternalReconciliationRepository;
    let orchestrator: PipelineProviderObservationOrchestrator;
    const TENANT = randomUUID();
    const ACTOR = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of PIPELINE_MIGRATIONS) for (const s of splitDdl(readFileSync(m, 'utf8'))) { if (s.trim()) await db.query(s.trim()); }
      for (const m of integrationMigrations()) await db.query(readFileSync(m, 'utf8'));
      pipelinePrisma = new PipelinePrismaService(url); await pipelinePrisma.$connect();
      integrationPrisma = new IntegrationPrismaService(url); await integrationPrisma.$connect();
      pipeline = new PipelineRepository(pipelinePrisma);
      connections = new IntegrationConnectionRepository(integrationPrisma);
      mappings = new PipelineProviderDispositionMappingRepository(integrationPrisma);
      identities = new ExternalPipelineEpisodeIdentityRepository(integrationPrisma);
      reconciliations = new PipelineExternalReconciliationRepository(integrationPrisma);
      const provenance = new PipelineExternalTransitionProvenanceRepository(integrationPrisma);
      orchestrator = new PipelineProviderObservationOrchestrator(pipeline, mappings, identities, reconciliations, provenance);
    }, 180_000);

    afterAll(async () => {
      await pipelinePrisma?.$disconnect(); await integrationPrisma?.$disconnect();
      await db?.end(); await container?.stop();
    });

    async function seedRequisition(): Promise<string> {
      const id = randomUUID();
      await db.query(`INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id) VALUES ($1,$2,'r',$3)`, [id, TENANT, randomUUID()]);
      return id;
    }
    async function seedEpisode(): Promise<{ pipeline_id: string; requisition_id: string }> {
      const req = await seedRequisition();
      const created = await pipeline.create({
        tenant_id: TENANT,
        input: { talent_record_id: randomUUID(), requisition_id: req },
        entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: ACTOR,
      });
      return { pipeline_id: created.id, requisition_id: req };
    }
    async function seedConnBoundEpisode(externalEpisodeId: string): Promise<{ conn: string; pipeline_id: string }> {
      const conn = (await connections.create({ tenant_id: TENANT, provider_key: 'acme_ats' })).id;
      const { pipeline_id } = await seedEpisode();
      await identities.recordIdentity({ tenant_id: TENANT, connection_id: conn, external_episode_id: externalEpisodeId, pipeline_id, external_event_id: `bind-${externalEpisodeId}` });
      return { conn, pipeline_id };
    }
    const statusOf = async (id: string): Promise<string> => (await pipeline.findById({ tenant_id: TENANT, id }))!.status;

    it('AC-2 (unmappable): an unmapped provider token → pending PROVIDER_TOKEN_UNMAPPABLE + episode status UNCHANGED', async () => {
      const { conn, pipeline_id } = await seedConnBoundEpisode('EXT-A');
      expect(await statusOf(pipeline_id)).toBe('no_contact'); // BEFORE
      const outcome = await orchestrator.ingest({ tenant_id: TENANT, connection_id: conn, external_episode_id: 'EXT-A', external_event_id: 'e-unmap', provider_token: 'never_authored', requestId: 'r' });
      expect(outcome).toBe('pending_unmappable');
      expect(await statusOf(pipeline_id)).toBe('no_contact'); // AFTER — EXACT, non-vacuous
      const row = await reconciliations.findByExternalEvent(TENANT, conn, 'e-unmap');
      expect(row!.failure_reason).toBe('PROVIDER_TOKEN_UNMAPPABLE');
      expect(row!.status).toBe('pending');
    });

    it('AC-2 (illegal-from-state): a mapped-but-illegal action → pending ILLEGAL_FROM_STATE + episode UNCHANGED', async () => {
      const { conn, pipeline_id } = await seedConnBoundEpisode('EXT-B');
      // QUALIFY is illegal from no_contact (requires the qualifying funnel first).
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'hired', mapped_target: 'QUALIFY', target_kind: 'action' });
      expect(await statusOf(pipeline_id)).toBe('no_contact');
      const outcome = await orchestrator.ingest({ tenant_id: TENANT, connection_id: conn, external_episode_id: 'EXT-B', external_event_id: 'e-illegal', provider_token: 'hired', requestId: 'r' });
      expect(outcome).toBe('pending_illegal');
      expect(await statusOf(pipeline_id)).toBe('no_contact'); // never mutated
      const row = await reconciliations.findByExternalEvent(TENANT, conn, 'e-illegal');
      expect(row!.failure_reason).toBe('ILLEGAL_FROM_STATE');
      expect(row!.current_pipeline_status).toBe('no_contact');
    });

    it('AC-2 (no lineage): an observation for an unknown external episode → pending NO_EPISODE_LINEAGE', async () => {
      const conn = (await connections.create({ tenant_id: TENANT, provider_key: 'acme_ats' })).id;
      const outcome = await orchestrator.ingest({ tenant_id: TENANT, connection_id: conn, external_episode_id: 'NEVER_BOUND', external_event_id: 'e-nolineage', provider_token: 'x', requestId: 'r' });
      expect(outcome).toBe('pending_no_lineage');
      expect((await reconciliations.findByExternalEvent(TENANT, conn, 'e-nolineage'))!.failure_reason).toBe('NO_EPISODE_LINEAGE');
    });

    it('positive + AC-4: a mapped-and-legal action executes via the governed command; provenance carries mapping_version + Aramo CAS token, NOT the provider sequence', async () => {
      const { conn, pipeline_id } = await seedConnBoundEpisode('EXT-C');
      // CONTACT is legal from no_contact.
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'reached', mapped_target: 'CONTACT', target_kind: 'action' });
      expect(await statusOf(pipeline_id)).toBe('no_contact');
      // A deliberately BOGUS huge provider sequence — must NEVER be the CAS token.
      const BOGUS_SEQ = 999999;
      const outcome = await orchestrator.ingest({ tenant_id: TENANT, connection_id: conn, external_episode_id: 'EXT-C', external_event_id: 'e-exec', provider_token: 'reached', provider_sequence: BOGUS_SEQ, requestId: 'r' });
      expect(outcome).toBe('executed');
      expect(await statusOf(pipeline_id)).toBe('contacted'); // governed command advanced it
      const prov = await db.query<{ mapping_version: number; aramo_expected_version: number; provider_sequence: string | null; mapped_target: string }>(
        `SELECT mapping_version, aramo_expected_version, provider_sequence, mapped_target FROM integration."PipelineExternalTransitionProvenance" WHERE external_event_id='e-exec'`,
      );
      const p = prov.rows[0]!;
      expect(p.mapping_version).toBe(1); // resolved from the ACTIVE set
      expect(p.mapped_target).toBe('CONTACT');
      expect(Number(p.aramo_expected_version)).toBe(0); // the episode version at execution (created=0)
      expect(Number(p.provider_sequence)).toBe(BOGUS_SEQ); // recorded for audit ONLY
      // AC-4 core: the CAS token used (0) is the Aramo version, NOT the provider sequence (999999).
      expect(Number(p.aramo_expected_version)).not.toBe(BOGUS_SEQ);
    });

    it('a mapped reason-kind target dispositions via the governed DISPOSITION command', async () => {
      const { conn, pipeline_id } = await seedConnBoundEpisode('EXT-D');
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: conn, provider_token: 'client_rejected', mapped_target: 'not_a_fit', target_kind: 'reason' });
      const outcome = await orchestrator.ingest({ tenant_id: TENANT, connection_id: conn, external_episode_id: 'EXT-D', external_event_id: 'e-dispo', provider_token: 'client_rejected', requestId: 'r' });
      expect(outcome).toBe('executed');
      expect(await statusOf(pipeline_id)).toBe('not_in_consideration'); // DISPOSITION terminal
    });
  },
);
