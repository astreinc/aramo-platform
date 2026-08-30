import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementPipelineInboxRepository } from '../lib/placement-pipeline-inbox.repository.js';

// Lane 2 / L2-G (Part 3) — the idempotent-consumer inbox proofs. The UNIQUE
// placement_event_id is the idempotency authority: a re-delivered reserve() of the SAME
// event returns {reserved:false} (success no-op), never a second processable reservation.
// markProcessed flips a pending row to processed with a classified outcome; it is only
// invoked after the Pipeline command reaches success/recognized-satisfied (proven in the
// apps/api orchestrator spec — a transient failure leaves the row pending, retry-safe).
const MIGRATIONS = [
  '../../prisma/migrations/20260831120000_l2g_init_placement_pipeline_bridge/migration.sql',
].map((p) => resolve(__dirname, p));

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-G placement-pipeline-bridge inbox (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: PlacementPipelineInboxRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const s of readFileSync(m, 'utf8').split(';')) {
          const t = s.trim();
          if (t.length > 0) await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementPipelineInboxRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('reserve is idempotent on the UNIQUE event id: first = created(pending); a still-pending re-delivery = pending (retry-safe), never a duplicate row', async () => {
      const eventId = randomUUID();
      const tenant = randomUUID();
      const first = await repo.reserve({ placement_event_id: eventId, tenant_id: tenant, event_type: 'placement.process.state_changed' });
      expect(first.disposition).toBe('created');
      expect(first.row.status).toBe('pending');

      // A re-delivery of the SAME event while STILL pending → retry token (not a no-op —
      // the command hasn't succeeded yet), the SAME row, no duplicate insert.
      const again = await repo.reserve({ placement_event_id: eventId, tenant_id: tenant, event_type: 'placement.process.state_changed' });
      expect(again.disposition).toBe('pending');
      expect(again.row.id).toBe(first.row.id);

      // Exactly ONE inbox row exists for the event (no duplicate).
      const count = await prisma.placementPipelineInbox.count({ where: { placement_event_id: eventId } });
      expect(count).toBe(1);
    });

    it('markProcessed flips a reserved row to processed; a re-delivery after processing = processed (success no-op)', async () => {
      const eventId = randomUUID();
      const tenant = randomUUID();
      await repo.reserve({ placement_event_id: eventId, tenant_id: tenant, event_type: 'placement.process.state_changed' });
      await repo.markProcessed({ placement_event_id: eventId, outcome_code: 'completed' });
      const row = await repo.findByEventId(eventId);
      expect(row!.status).toBe('processed');
      expect(row!.outcome_code).toBe('completed');
      expect(row!.processed_at).not.toBeNull();

      // A re-delivery after processing → reserve reports the PROCESSED terminal (a genuine
      // duplicate-delivery no-op; never re-processed).
      const again = await repo.reserve({ placement_event_id: eventId, tenant_id: tenant, event_type: 'placement.process.state_changed' });
      expect(again.disposition).toBe('processed');
      expect(again.row.status).toBe('processed');
      expect(again.row.outcome_code).toBe('completed');
    });

    it('a classified-skip is a PROCESSED terminal (not left pending)', async () => {
      const eventId = randomUUID();
      const tenant = randomUUID();
      await repo.reserve({ placement_event_id: eventId, tenant_id: tenant, event_type: 'placement.process.state_changed' });
      // The orchestrator classified this event unactionable — still a processed terminal.
      await repo.markProcessed({ placement_event_id: eventId, outcome_code: 'no_pipeline_lineage' });
      const row = await repo.findByEventId(eventId);
      expect(row!.status).toBe('processed');
      expect(row!.outcome_code).toBe('no_pipeline_lineage');
    });
  },
);
