import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';
import { projectExternalSourceEventToEntryProvenance, type ExternalSourceEvent } from '../lib/external-source-event.js';

// Lane 2 / L2-I (D2) — the external source-event resolves to an episode ONLY through the
// GOVERNED create/entry path (PipelineRepository.create with the projected entry_provenance),
// storing the immutable L2-D provenance (provider origin + connection-scoped source ids). There
// is no direct-row-write path. Proven end-to-end against real Postgres 17.
const MIGRATIONS = [
  '../../../../libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  '../../../../libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  '../../prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  '../../prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  '../../prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  '../../prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  '../../prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  '../../prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  '../../prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  '../../prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
].map((p) => resolve(__dirname, p));

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
  'L2-I D2 external source-event → governed entry (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let repo: PipelineRepository;
    const TENANT = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new PrismaService(url); await setup.$connect();
      for (const m of MIGRATIONS) for (const s of splitDdl(readFileSync(m, 'utf8'))) { if (s.trim()) await setup.$executeRawUnsafe(s.trim()); }
      prisma = new PrismaService(url); await prisma.$connect();
      repo = new PipelineRepository(prisma);
    }, 180_000);

    afterAll(async () => { await setup?.$disconnect(); await prisma?.$disconnect(); await container?.stop(); });

    it('a provider source-event attaches an entry through the governed create path, storing the immutable provider provenance', async () => {
      const talent = randomUUID(); const req = randomUUID();
      const event: ExternalSourceEvent = {
        origin_type: 'VMS', source_system: 'acme_vms', source_connection_id: randomUUID(),
        external_object_type: 'vms_worker_record', external_object_id: 'VMS-777', external_event_id: 'evt-vms-1',
        observed_at: new Date('2026-08-31T00:00:00.000Z'), talent_record_id: talent, requisition_id: req,
      };
      // The ONLY bridge: project → governed create (never a raw INSERT into pipeline.Pipeline).
      const created = await repo.create({
        tenant_id: TENANT,
        input: { talent_record_id: talent, requisition_id: req },
        entry_provenance: projectExternalSourceEventToEntryProvenance(event),
        created_by_id: randomUUID(),
      });
      expect(created.status).toBe('no_contact'); // the governed create rests at the birth state

      const prov = await prisma.$queryRawUnsafe<Array<{ origin_type: string; source_system: string; source_connection_id: string; external_object_id: string; initiated_by_kind: string }>>(
        `SELECT origin_type, source_system, source_connection_id, external_object_id, initiated_by_kind
           FROM pipeline."PipelineEntryProvenance" WHERE pipeline_id = $1::uuid`,
        created.id,
      );
      expect(prov).toHaveLength(1);
      expect(prov[0]).toMatchObject({
        origin_type: 'VMS',
        source_system: 'acme_vms',
        source_connection_id: event.source_connection_id,
        external_object_id: 'VMS-777',
        initiated_by_kind: 'system',
      });
    });
  },
);
