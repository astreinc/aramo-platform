import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  ENGAGEMENT_STATE_VALUES,
  type EngagementStateValue,
} from '../lib/engagement-state.js';

// M5 PR-1 §4.9 — schema-invariant integration spec for libs/engagement.
//
// Brings up a Postgres 17 testcontainer, applies the engagement init
// migration, and asserts the column-scoped immutability trigger and
// enum closed-list invariants against real Postgres:
//
//   1. Insert: all 11 state values insertable as starting state
//      (despite default `surfaced`) via raw SQL.
//   2. Column-scoped trigger: UPDATE on any non-state column raises
//      check_violation with the 'TalentJobEngagement is immutable
//      except for the state column per Group 2 §2.3b Loops 1-5'
//      message.
//   3. Column-scoped trigger: each of the 10 legal state transitions
//      from Amendment v1.1 §3 succeeds (parameterized).
//   4. Column-scoped trigger: representative illegal state transitions
//      raise check_violation with the 'Illegal engagement state
//      transition' message.
//   5. Enum closed-list: raw SQL insert with invalid state value is
//      rejected by Postgres at the enum-type layer.
//
// Per Amendment v1.1 §3 the legal transitions are:
//   surfaced            -> evaluated
//   evaluated           -> {engaged, maybe, passed}
//   engaged             -> awaiting_response
//   awaiting_response   -> responded
//   responded           -> in_conversation
//   in_conversation     -> {not_interested, ready_for_submittal}
//   ready_for_submittal -> submitted

const ENGAGEMENT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260525120000_init_engagement_model/migration.sql',
);

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQUISITION = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

const LEGAL_TRANSITIONS: ReadonlyArray<[EngagementStateValue, EngagementStateValue]> = [
  ['surfaced', 'evaluated'],
  ['evaluated', 'engaged'],
  ['evaluated', 'maybe'],
  ['evaluated', 'passed'],
  ['engaged', 'awaiting_response'],
  ['awaiting_response', 'responded'],
  ['responded', 'in_conversation'],
  ['in_conversation', 'not_interested'],
  ['in_conversation', 'ready_for_submittal'],
  ['ready_for_submittal', 'submitted'],
];

// Ten representative illegal transitions — spans terminal-out (4),
// skip-forward (3), backwards (2), and a Loop-2-only branch (1).
const ILLEGAL_TRANSITIONS: ReadonlyArray<[EngagementStateValue, EngagementStateValue]> = [
  ['maybe', 'engaged'],                          // terminal -> any
  ['passed', 'engaged'],                         // terminal -> any
  ['not_interested', 'engaged'],                 // terminal -> any
  ['submitted', 'surfaced'],                     // terminal -> any
  ['surfaced', 'engaged'],                       // skip evaluated
  ['evaluated', 'awaiting_response'],            // skip engaged
  ['engaged', 'ready_for_submittal'],            // skip multiple
  ['evaluated', 'surfaced'],                     // backwards
  ['responded', 'awaiting_response'],            // backwards
  ['surfaced', 'maybe'],                         // Loop 2 branch only from evaluated
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentJobEngagement — schema invariants (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let rowSeq = 0;

    function nextId(): string {
      // Pad an ascending counter into the UUID hex tail so each test
      // gets a fresh row.
      rowSeq += 1;
      const seq = rowSeq.toString(16).padStart(12, '0');
      return `99999999-9999-7999-8999-${seq}`;
    }

    async function seed(state: EngagementStateValue, id?: string): Promise<string> {
      const rowId = id ?? nextId();
      await client.$executeRawUnsafe(
        `INSERT INTO engagement."TalentJobEngagement" (
           id, tenant_id, talent_id, requisition_id, state
         ) VALUES (
           '${rowId}'::uuid,
           '${TENANT}'::uuid,
           '${TALENT}'::uuid,
           '${REQUISITION}'::uuid,
           '${state}'::engagement."EngagementState"
         )`,
      );
      return rowId;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrationSql = readFileSync(ENGAGEMENT_MIGRATION_PATH, 'utf8');

      client = new PrismaService(url);
      await client.$connect();
      for (const stmt of splitDdl(migrationSql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await client.$executeRawUnsafe(trimmed);
      }
    }, 180_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    it('accepts INSERT with each of the 11 enum values as starting state', async () => {
      for (const state of ENGAGEMENT_STATE_VALUES) {
        await expect(seed(state)).resolves.toMatch(
          /^99999999-9999-7999-8999-[0-9a-f]{12}$/,
        );
      }
    });

    it('column-scoped trigger rejects UPDATE on non-state columns (requisition_id)', async () => {
      const id = await seed('surfaced');
      const otherReq = 'cccccccc-cccc-7ccc-8ccc-ccccccccc000';
      await expect(
        client.$executeRawUnsafe(
          `UPDATE engagement."TalentJobEngagement"
             SET requisition_id = '${otherReq}'::uuid
             WHERE id = '${id}'::uuid`,
        ),
      ).rejects.toThrow(
        /TalentJobEngagement is immutable except for the state column per Group 2 §2\.3b Loops 1-5/,
      );
    });

    it('column-scoped trigger rejects UPDATE on talent_id', async () => {
      const id = await seed('surfaced');
      const otherTalent = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa000';
      await expect(
        client.$executeRawUnsafe(
          `UPDATE engagement."TalentJobEngagement"
             SET talent_id = '${otherTalent}'::uuid
             WHERE id = '${id}'::uuid`,
        ),
      ).rejects.toThrow(/immutable except for the state column/);
    });

    it('column-scoped trigger rejects UPDATE on examination_id', async () => {
      const id = await seed('surfaced');
      const otherExam = 'dddddddd-dddd-7ddd-8ddd-ddddddddd000';
      await expect(
        client.$executeRawUnsafe(
          `UPDATE engagement."TalentJobEngagement"
             SET examination_id = '${otherExam}'::uuid
             WHERE id = '${id}'::uuid`,
        ),
      ).rejects.toThrow(/immutable except for the state column/);
    });

    it.each(LEGAL_TRANSITIONS)(
      'column-scoped trigger permits legal state transition %s -> %s',
      async (from, to) => {
        const id = await seed(from);
        await client.$executeRawUnsafe(
          `UPDATE engagement."TalentJobEngagement"
             SET state = '${to}'::engagement."EngagementState"
             WHERE id = '${id}'::uuid`,
        );
        const rows = await client.$queryRawUnsafe<{ state: string }[]>(
          `SELECT state FROM engagement."TalentJobEngagement" WHERE id = '${id}'::uuid`,
        );
        expect(rows[0]?.state).toBe(to);
      },
    );

    it.each(ILLEGAL_TRANSITIONS)(
      'column-scoped trigger rejects illegal state transition %s -> %s',
      async (from, to) => {
        const id = await seed(from);
        await expect(
          client.$executeRawUnsafe(
            `UPDATE engagement."TalentJobEngagement"
               SET state = '${to}'::engagement."EngagementState"
               WHERE id = '${id}'::uuid`,
          ),
        ).rejects.toThrow(/Illegal engagement state transition/);
      },
    );

    it('enum closed-list — raw SQL insert with invalid state value is rejected', async () => {
      const id = '99999999-9999-7999-8999-baadbaadbaad';
      await expect(
        client.$executeRawUnsafe(
          `INSERT INTO engagement."TalentJobEngagement" (
             id, tenant_id, talent_id, requisition_id, state
           ) VALUES (
             '${id}'::uuid,
             '${TENANT}'::uuid,
             '${TALENT}'::uuid,
             '${REQUISITION}'::uuid,
             'definitely_not_a_state'::engagement."EngagementState"
           )`,
        ),
      ).rejects.toThrow(/invalid input value for enum/i);
    });
  },
);

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
