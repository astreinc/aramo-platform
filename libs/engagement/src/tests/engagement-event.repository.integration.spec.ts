import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { makeMockLogger } from '@aramo/common';

import { EngagementEventRepository } from '../lib/engagement-event.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-2 §4.11 — integration spec for EngagementEventRepository.
//
// Brings up a Postgres 17 testcontainer, applies the engagement init
// migration (PR-1) + the add_engagement_event_log migration (PR-2),
// constructs EngagementEventRepository, and asserts:
//   - appendEvent round-trips against real Postgres.
//   - Intra-schema FK constraint: appending with a non-existent
//     engagement_id is rejected by Postgres.
//   - Absolute-immutability trigger: raw SQL UPDATE on any column raises
//     check_violation with the spec'd "TalentEngagementEvent is immutable"
//     message.
//   - Enum closed-list: raw SQL insert with an invalid event_type value
//     is rejected by Postgres at the enum-type layer.
//   - Tenant isolation: cross-tenant findByTenantAndId returns null.
//
// Dollar-quote-aware splitDdl handles the migration's CREATE FUNCTION
// blocks (PR-1 column-scoped trigger + PR-2 absolute-immutability trigger).

const ENGAGEMENT_INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260525120000_init_engagement_model/migration.sql',
);
const ENGAGEMENT_EVENT_LOG_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260525150000_add_engagement_event_log/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQUISITION = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

const ENGAGEMENT_A = '33333333-3333-7333-8333-333333333333';
const ENGAGEMENT_B_TENANT_B = '44444444-4444-7444-8444-444444444444';

let eventSeq = 0;
function nextEventId(): string {
  eventSeq += 1;
  return `00000000-0000-7000-8000-${eventSeq.toString(16).padStart(12, '0')}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'EngagementEventRepository — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let repo: EngagementEventRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrations = [
        readFileSync(ENGAGEMENT_INIT_MIGRATION_PATH, 'utf8'),
        readFileSync(ENGAGEMENT_EVENT_LOG_MIGRATION_PATH, 'utf8'),
      ];

      client = new PrismaService(url);
      await client.$connect();
      for (const sql of migrations) {
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await client.$executeRawUnsafe(trimmed);
        }
      }

      repo = new EngagementEventRepository(client, makeMockLogger());

      // Seed parent engagements for FK resolution.
      await seedEngagement(client, {
        id: ENGAGEMENT_A,
        tenant_id: TENANT_A,
        talent_id: TALENT,
        requisition_id: REQUISITION,
      });
      await seedEngagement(client, {
        id: ENGAGEMENT_B_TENANT_B,
        tenant_id: TENANT_B,
        talent_id: TALENT,
        requisition_id: REQUISITION,
      });
    }, 180_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    it('appendEvent round-trips against real Postgres', async () => {
      const id = nextEventId();
      const view = await repo.appendEvent({
        id,
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_A,
        event_type: 'state_transition',
        event_payload: { from: 'surfaced', to: 'evaluated' },
      });
      expect(view.id).toBe(id);
      expect(view.tenant_id).toBe(TENANT_A);
      expect(view.engagement_id).toBe(ENGAGEMENT_A);
      expect(view.event_type).toBe('state_transition');
      expect(view.event_payload).toEqual({ from: 'surfaced', to: 'evaluated' });
      expect(view.created_at).toBeInstanceOf(Date);

      // Read it back.
      const reread = await repo.findById(id);
      expect(reread?.id).toBe(id);
      expect(reread?.event_payload).toEqual({ from: 'surfaced', to: 'evaluated' });
    });

    it('intra-schema FK rejects append with non-existent engagement_id', async () => {
      const ghostEngagement = '99999999-9999-7999-8999-999999999999';
      await expect(
        repo.appendEvent({
          id: nextEventId(),
          tenant_id: TENANT_A,
          engagement_id: ghostEngagement,
          event_type: 'outreach_sent',
          event_payload: {},
        }),
      ).rejects.toThrow(/foreign key|TalentEngagementEvent_engagement_id_fkey/i);
    });

    it('absolute-immutability trigger rejects raw SQL UPDATE on any column', async () => {
      const id = nextEventId();
      await repo.appendEvent({
        id,
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_A,
        event_type: 'response_received',
        event_payload: { snippet: 'hello' },
      });
      await expect(
        client.$executeRawUnsafe(
          `UPDATE engagement."TalentEngagementEvent"
             SET event_payload = '{"snippet":"changed"}'::jsonb
             WHERE id = '${id}'::uuid`,
        ),
      ).rejects.toThrow(
        /TalentEngagementEvent is immutable per Charter v1\.2 §4\.4 Ruling D/,
      );
    });

    it('enum closed-list rejects raw SQL insert with invalid event_type', async () => {
      const id = nextEventId();
      await expect(
        client.$executeRawUnsafe(
          `INSERT INTO engagement."TalentEngagementEvent" (
             id, tenant_id, engagement_id, event_type, event_payload
           ) VALUES (
             '${id}'::uuid,
             '${TENANT_A}'::uuid,
             '${ENGAGEMENT_A}'::uuid,
             'definitely_not_an_event_type'::engagement."EngagementEventType",
             '{}'::jsonb
           )`,
        ),
      ).rejects.toThrow(/invalid input value for enum/i);
    });

    it('tenant isolation: cross-tenant findByTenantAndId returns null', async () => {
      const id = nextEventId();
      await repo.appendEvent({
        id,
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_A,
        event_type: 'conversation_started',
        event_payload: {},
      });

      const sameTenant = await repo.findByTenantAndId({ tenant_id: TENANT_A, id });
      expect(sameTenant?.id).toBe(id);

      const crossTenant = await repo.findByTenantAndId({ tenant_id: TENANT_B, id });
      expect(crossTenant).toBeNull();
    });

    it('findByEngagementId returns rows ASC by created_at', async () => {
      // Append two more events on ENGAGEMENT_A and ensure ordering.
      const idA = nextEventId();
      await repo.appendEvent({
        id: idA,
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_A,
        event_type: 'outreach_sent',
        event_payload: { seq: 'first' },
      });
      // Tiny gap so created_at differs even if the test rig is fast.
      await new Promise((r) => setTimeout(r, 5));
      const idB = nextEventId();
      await repo.appendEvent({
        id: idB,
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_A,
        event_type: 'response_received',
        event_payload: { seq: 'second' },
      });
      const rows = await repo.findByEngagementId(ENGAGEMENT_A);
      // ENGAGEMENT_A accumulates events across tests in this suite —
      // we only check that idA precedes idB.
      const idAIdx = rows.findIndex((r) => r.id === idA);
      const idBIdx = rows.findIndex((r) => r.id === idB);
      expect(idAIdx).toBeGreaterThanOrEqual(0);
      expect(idBIdx).toBeGreaterThan(idAIdx);
    });

    it('findByTenantAndEngagementId scopes to tenant', async () => {
      const tenantBView = await repo.findByTenantAndEngagementId({
        tenant_id: TENANT_B,
        engagement_id: ENGAGEMENT_A,
      });
      // ENGAGEMENT_A is in TENANT_A; tenant-B-scoped read returns [].
      expect(tenantBView).toEqual([]);
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedEngagement(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
  },
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO engagement."TalentJobEngagement" (
       id, tenant_id, talent_id, requisition_id, state
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.requisition_id}'::uuid,
       'surfaced'::engagement."EngagementState"
     )`,
  );
}

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
