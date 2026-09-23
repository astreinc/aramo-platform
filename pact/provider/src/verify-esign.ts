import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { Verifier } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AppModule } from '@aramo/esign-service';

// DOC-3 — Pact provider verifier for apps/esign-service.
//
// Consumer:  aramo-core     (apps/api's SignatureProviderPort HTTP adapter)
// Provider:  esign-service  (apps/esign-service)
//
// A SEPARATE provider (mirrors pact/provider/src/verify.ts for auth-service):
// boots the esign-service NestJS app against a Postgres 17 testcontainer with
// the esign schema, then verifies the recorded aramo-core → esign-service pact.
// The esign migration is applied WHOLE-FILE (its append-only trigger body is
// dollar-quoted; the naive splitDdl used elsewhere is comment/`$$`-blind).
//
// Gated on ARAMO_RUN_PACT_PROVIDER=1 (same as verify.ts / verify-api.ts).

const ROOT = resolve(__dirname, '../../..');
// Apply ALL esign migrations whole-file, in order — the append-only trigger is
// $$-quoted (the shared splitDdl is comment/$$-blind), and DOC-4 added the
// ExecutedDocument migration (never hardcode a single-migration list).
function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const PACT_FILE = resolve(ROOT, 'pact/pacts/aramo-core-esign-service.json');

// Fixed ids — MUST match pact/consumers/esign-consumer/src/esign.consumer.test.ts.
const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const ENVELOPE_ID = '22222222-2222-7222-8222-222222222222';
const SIGNER_ID = '33333333-3333-7333-8333-333333333333';
const CREATED_BY = '44444444-4444-7444-8444-444444444444';
const DOC_REF = '55555555-5555-7555-8555-555555555555';
const REV_REF = '66666666-6666-7666-8666-666666666666';
const SHA256 = 'a'.repeat(64);

describe.skipIf(process.env['ARAMO_RUN_PACT_PROVIDER'] !== '1')(
  'pact provider verification — esign-service (apps/esign-service)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    // Seed a signature envelope (+ document, signer, one hash-chained event) so
    // the GET and evidence interactions resolve. Idempotent (delete-then-insert).
    async function seedEnvelope(): Promise<void> {
      await db.query(`DELETE FROM "esign"."SignatureEnvelope" WHERE id = $1`, [ENVELOPE_ID]);
      await db.query(
        `INSERT INTO "esign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
         VALUES ($1,$2,'Offer Letter','DRAFT','SINGLE_SIGNATURE',$3)`,
        [ENVELOPE_ID, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "esign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'offer.pdf',$5,1)`,
        [TENANT_ID, ENVELOPE_ID, DOC_REF, REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "esign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
         VALUES ($1,$2,$3,'jane@example.com','Jane Doe',1,'PENDING')`,
        [SIGNER_ID, TENANT_ID, ENVELOPE_ID],
      );
      await db.query(
        `INSERT INTO "esign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, previous_event_hash, event_hash)
         VALUES (gen_random_uuid(),$1,$2,'ENVELOPE_CREATED','SERVICE',NULL,'seed-event-chain-hash')`,
        [TENANT_ID, ENVELOPE_ID],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // Whole-file apply — the SignatureEvent append-only trigger is $$-quoted.
      for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        MAILER_PROVIDER: process.env['MAILER_PROVIDER'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('verifies all interactions from pact/pacts/aramo-core-esign-service.json', async () => {
      const verifier = new Verifier({
        provider: 'esign-service',
        providerBaseUrl: `http://127.0.0.1:${port}`,
        pactUrls: [PACT_FILE],
        stateHandlers: {
          'no prior envelope for the request': async () => undefined,
          'a signature envelope exists': async () => {
            await seedEnvelope();
          },
        },
      });
      await verifier.verifyProvider();
    }, 180_000);
  },
);
