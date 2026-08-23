import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Offer Lifecycle — D2 (the generated lifecycle trigger, real Postgres 17).
// Skipped unless ARAMO_RUN_INTEGRATION=1. Applies ONLY the generated offer
// migration (the offer schema is self-contained) and proves, over real PG, the
// registry-generated guards a unit test cannot: the one-live INSERT guard, the
// per-edge UPDATE matrix, terminal freeze, immutable-column pinning, and the
// append-only event/outbox triggers.

const ROOT = resolve(__dirname, '../../../..');
const OFFER_MIGRATION = resolve(
  ROOT,
  'libs/placement/prisma/migrations/20260824120000_init_offer_model/migration.sql',
);

let ctr = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++ctr).toString(16).padStart(12, '0')}`;
const TENANT = '01900000-0000-7000-8000-0000000000f1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Offer lifecycle trigger (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;

    async function insertOffer(submittal: string, state = 'DRAFT'): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO "offer"."Offer" (id, tenant_id, submittal_id, requisition_id, talent_record_id, state)
         VALUES ($1,$2,$3,$4,$5,$6::"offer"."OfferState")`,
        [id, TENANT, submittal, uuid(), uuid(), state],
      );
      return id;
    }
    async function setState(id: string, state: string): Promise<void> {
      await db.query(`UPDATE "offer"."Offer" SET state=$2::"offer"."OfferState" WHERE id=$1`, [id, state]);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      await db.query(readFileSync(OFFER_MIGRATION, 'utf8'));
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    });

    it('creates a DRAFT offer', async () => {
      const id = await insertOffer(uuid());
      const row = (await db.query(`SELECT state FROM "offer"."Offer" WHERE id=$1`, [id])).rows[0];
      expect(row.state).toBe('DRAFT');
    });

    it('one-live guard: a second NON-terminal offer for the same (tenant, submittal) is rejected', async () => {
      const sub = uuid();
      await insertOffer(sub);
      await expect(insertOffer(sub)).rejects.toThrow(/at most one live offer/);
    });

    it('one-live guard RELEASES once the first offer is terminal (a new offer may follow)', async () => {
      const sub = uuid();
      const first = await insertOffer(sub); // DRAFT
      await setState(first, 'RESCINDED'); // terminal (DRAFT -> RESCINDED is legal)
      await expect(insertOffer(sub)).resolves.toBeTypeOf('string');
    });

    it('legal edge DRAFT -> SENT -> NEGOTIATION -> ACCEPTED is allowed', async () => {
      const id = await insertOffer(uuid());
      await setState(id, 'SENT');
      await setState(id, 'NEGOTIATION');
      await setState(id, 'ACCEPTED');
      expect((await db.query(`SELECT state FROM "offer"."Offer" WHERE id=$1`, [id])).rows[0].state).toBe('ACCEPTED');
    });

    it('illegal edge DRAFT -> ACCEPTED is rejected', async () => {
      const id = await insertOffer(uuid());
      await expect(setState(id, 'ACCEPTED')).rejects.toThrow(/illegal transition|check/i);
    });

    it('terminal freeze: no edge out of ACCEPTED', async () => {
      const id = await insertOffer(uuid());
      await setState(id, 'SENT');
      await setState(id, 'ACCEPTED');
      await expect(setState(id, 'DECLINED')).rejects.toThrow(/illegal transition|check/i);
    });

    it('immutable-column pin: changing submittal_id during a transition is rejected', async () => {
      const id = await insertOffer(uuid());
      await expect(
        db.query(`UPDATE "offer"."Offer" SET state='SENT'::"offer"."OfferState", submittal_id=$2 WHERE id=$1`, [id, uuid()]),
      ).rejects.toThrow(/illegal transition|check/i);
    });

    it('OfferEvent is append-only (UPDATE + DELETE rejected)', async () => {
      const id = await insertOffer(uuid());
      const evId = uuid();
      await db.query(
        `INSERT INTO "offer"."OfferEvent" (id, tenant_id, offer_id, event_type, event_payload)
         VALUES ($1,$2,$3,'state_transition','{}'::jsonb)`,
        [evId, TENANT, id],
      );
      await expect(db.query(`UPDATE "offer"."OfferEvent" SET event_payload='{"x":1}'::jsonb WHERE id=$1`, [evId])).rejects.toThrow(/append-only/);
      await expect(db.query(`DELETE FROM "offer"."OfferEvent" WHERE id=$1`, [evId])).rejects.toThrow(/append-only/);
    });

    it('OutboxEvent is append-only except published_at', async () => {
      const oid = uuid();
      await db.query(
        `INSERT INTO "offer"."OutboxEvent" (id, tenant_id, event_type, event_payload) VALUES ($1,$2,'offer.created','{}'::jsonb)`,
        [oid, TENANT],
      );
      // published_at stamp is allowed
      await expect(db.query(`UPDATE "offer"."OutboxEvent" SET published_at=now() WHERE id=$1`, [oid])).resolves.toBeTruthy();
      // any other column change is rejected
      await expect(db.query(`UPDATE "offer"."OutboxEvent" SET event_type='x' WHERE id=$1`, [oid])).rejects.toThrow(/append-only/);
      await expect(db.query(`DELETE FROM "offer"."OutboxEvent" WHERE id=$1`, [oid])).rejects.toThrow(/append-only/);
    });
  },
);
