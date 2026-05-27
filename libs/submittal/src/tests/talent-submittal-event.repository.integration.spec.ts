import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { makeMockLogger } from '@aramo/common';

import { TalentSubmittalEventRepository } from '../lib/talent-submittal-event.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-8b1 §4.14 — integration spec for TalentSubmittalEventRepository.
//
// Brings up a Postgres 17 testcontainer, applies the submittal init
// migration (M4 PR-3) + the add_submittal_revoke migration (M4 PR-7) +
// the new add_submittal_event_log migration (PR-8b1), constructs
// TalentSubmittalEventRepository, and asserts:
//   - appendEvent round-trips against real Postgres.
//   - Intra-schema FK constraint: appending with a non-existent
//     submittal_id is rejected by Postgres.
//   - Absolute-immutability trigger: raw SQL UPDATE on any column raises
//     check_violation with the spec'd "TalentSubmittalEvent is immutable"
//     message.
//   - Enum closed-list: raw SQL insert with an invalid event_type value
//     is rejected by Postgres at the enum-type layer.
//   - Tenant isolation: cross-tenant findByTenantAndId returns null.
//   - findBySubmittalId returns rows ASC by created_at.
//
// Dollar-quote-aware splitDdl handles the migrations' CREATE FUNCTION
// blocks (M4 PR-3 init trigger + M4 PR-7 trigger rewrite + PR-8b1
// absolute-immutability trigger).

const SUBMITTAL_INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260523120000_init_submittal_model/migration.sql',
);
const SUBMITTAL_REVOKE_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
);
const SUBMITTAL_EVENT_LOG_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260526140602_add_submittal_event_log/migration.sql',
);
// M5 PR-8b2 — canonical 5-state rename + cutover migration. Required
// so the seed helpers + event_payload fixtures can use canonical state
// names (M4 'draft'/'submitted' → 'created'/'submitted_to_ats').
const SUBMITTAL_RENAME_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const EVIDENCE_PKG = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const PINNED_EXAM = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const RECRUITER = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

const SUBMITTAL_A = '33333333-3333-7333-8333-333333333333';
const SUBMITTAL_B_TENANT_B = '44444444-4444-7444-8444-444444444444';

let eventSeq = 0;
function nextEventId(): string {
  eventSeq += 1;
  return `00000000-0000-7000-8000-${eventSeq.toString(16).padStart(12, '0')}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentSubmittalEventRepository — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let repo: TalentSubmittalEventRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrations = [
        readFileSync(SUBMITTAL_INIT_MIGRATION_PATH, 'utf8'),
        readFileSync(SUBMITTAL_REVOKE_MIGRATION_PATH, 'utf8'),
        readFileSync(SUBMITTAL_EVENT_LOG_MIGRATION_PATH, 'utf8'),
        // M5 PR-8b2 — canonical 5-state rename + cutover. Required so
        // seedSubmittalRecord + event_payload fixtures align with the
        // post-rename enum values.
        readFileSync(SUBMITTAL_RENAME_MIGRATION_PATH, 'utf8'),
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

      repo = new TalentSubmittalEventRepository(client, makeMockLogger());

      // Seed parent submittal records for FK resolution.
      await seedSubmittalRecord(client, {
        id: SUBMITTAL_A,
        tenant_id: TENANT_A,
      });
      await seedSubmittalRecord(client, {
        id: SUBMITTAL_B_TENANT_B,
        tenant_id: TENANT_B,
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
        submittal_id: SUBMITTAL_A,
        event_type: 'state_transition',
        event_payload: { from_state: 'created', to_state: 'handoff_draft' },
      });
      expect(view.id).toBe(id);
      expect(view.tenant_id).toBe(TENANT_A);
      expect(view.submittal_id).toBe(SUBMITTAL_A);
      expect(view.event_type).toBe('state_transition');
      expect(view.event_payload).toEqual({ from_state: 'created', to_state: 'handoff_draft' });
      expect(view.created_at).toBeInstanceOf(Date);

      // Read it back.
      const reread = await repo.findById(id);
      expect(reread?.id).toBe(id);
      expect(reread?.event_payload).toEqual({ from_state: 'created', to_state: 'handoff_draft' });
    });

    it('intra-schema FK rejects append with non-existent submittal_id', async () => {
      const ghostSubmittal = '99999999-9999-7999-8999-999999999999';
      await expect(
        repo.appendEvent({
          id: nextEventId(),
          tenant_id: TENANT_A,
          submittal_id: ghostSubmittal,
          event_type: 'state_transition',
          event_payload: {},
        }),
      ).rejects.toThrow(/foreign key|TalentSubmittalEvent_submittal_id_fkey/i);
    });

    it('absolute-immutability trigger rejects raw SQL UPDATE on any column', async () => {
      const id = nextEventId();
      await repo.appendEvent({
        id,
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_A,
        event_type: 'state_transition',
        event_payload: { snippet: 'original' },
      });
      await expect(
        client.$executeRawUnsafe(
          `UPDATE engagement."TalentSubmittalEvent"
             SET event_payload = '{"snippet":"changed"}'::jsonb
             WHERE id = '${id}'::uuid`,
        ),
      ).rejects.toThrow(
        /TalentSubmittalEvent is immutable per Charter v1\.2 §4\.4 Ruling D/,
      );
    });

    it('enum closed-list rejects raw SQL insert with invalid event_type', async () => {
      const id = nextEventId();
      await expect(
        client.$executeRawUnsafe(
          `INSERT INTO engagement."TalentSubmittalEvent" (
             id, tenant_id, submittal_id, event_type, event_payload
           ) VALUES (
             '${id}'::uuid,
             '${TENANT_A}'::uuid,
             '${SUBMITTAL_A}'::uuid,
             'definitely_not_an_event_type'::engagement."SubmittalEventType",
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
        submittal_id: SUBMITTAL_A,
        event_type: 'state_transition',
        event_payload: {},
      });

      const sameTenant = await repo.findByTenantAndId({ tenant_id: TENANT_A, id });
      expect(sameTenant?.id).toBe(id);

      const crossTenant = await repo.findByTenantAndId({ tenant_id: TENANT_B, id });
      expect(crossTenant).toBeNull();
    });

    it('findBySubmittalId returns rows ASC by created_at', async () => {
      // Append two more events on SUBMITTAL_A and ensure ordering.
      const idA = nextEventId();
      await repo.appendEvent({
        id: idA,
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_A,
        event_type: 'state_transition',
        event_payload: { seq: 'first' },
      });
      // Tiny gap so created_at differs even if the test rig is fast.
      await new Promise((r) => setTimeout(r, 5));
      const idB = nextEventId();
      await repo.appendEvent({
        id: idB,
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_A,
        event_type: 'state_transition',
        event_payload: { seq: 'second' },
      });
      const rows = await repo.findBySubmittalId(SUBMITTAL_A);
      // SUBMITTAL_A accumulates events across tests in this suite —
      // we only check that idA precedes idB.
      const idAIdx = rows.findIndex((r) => r.id === idA);
      const idBIdx = rows.findIndex((r) => r.id === idB);
      expect(idAIdx).toBeGreaterThanOrEqual(0);
      expect(idBIdx).toBeGreaterThan(idAIdx);
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedSubmittalRecord(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
  },
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO engagement."TalentSubmittalRecord" (
       id, tenant_id, talent_id, job_id, evidence_package_id,
       pinned_examination_id, state, created_by
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${TALENT}'::uuid,
       '${JOB}'::uuid,
       '${EVIDENCE_PKG}'::uuid,
       '${PINNED_EXAM}'::uuid,
       'created'::engagement."SubmittalState",
       '${RECRUITER}'::uuid
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
