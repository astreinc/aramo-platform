import { createHash, randomUUID } from 'node:crypto';
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
// DOC-4C (R1 seam A) — the sign-web → esign-service signer-session pact.
const SIGN_WEB_PACT_FILE = resolve(ROOT, 'pact/pacts/sign-web-esign-service.json');

// Fixed ids — MUST match pact/consumers/esign-consumer/src/esign.consumer.test.ts.
const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const ENVELOPE_ID = '22222222-2222-7222-8222-222222222222';
const SIGNER_ID = '33333333-3333-7333-8333-333333333333';
const CREATED_BY = '44444444-4444-7444-8444-444444444444';
const DOC_REF = '55555555-5555-7555-8555-555555555555';
const REV_REF = '66666666-6666-7666-8666-666666666666';
const SHA256 = 'a'.repeat(64);
// DOC-4C (R1 seam B) — a DISTINCT COMPLETED envelope for the executed-pull state
// (the DRAFT 'a signature envelope exists' fixture cannot be re-seeded — events
// are append-only). MUST match pact/consumers/esign-consumer/src/esign.consumer.test.ts.
const EXEC_ENVELOPE_ID = '88888888-8888-7888-8888-888888888888';
const EXEC_ENV_DOC_ID = '99999999-9999-7999-8999-999999999999';

// DOC-4C (R1 seam A) — sign-web signer-session fixtures. Each op has a DISTINCT
// token + envelope + signer + session (SignatureEvent is append-only ⇒ no delete/
// re-seed; unique token_hash ⇒ no cross-op collision). MUST match
// pact/consumers/sign-web-consumer/src/signer-session.consumer.test.ts.
const hashToken = (t: string): string => createHash('sha256').update(t).digest('base64url');
// exchange (the only op that echoes ids).
const EX_ENVELOPE_ID = '7a000000-0000-7000-8000-0000000000a1';
const EX_SIGNER_ID = '7a000000-0000-7000-8000-0000000000a2';
const EX_SESSION_ID = '7a000000-0000-7000-8000-0000000000a3';
const EX_ENV_DOC_ID = '7a000000-0000-7000-8000-0000000000a6';
const TOKEN_EXCHANGE = 'sign-web-pact-token-exchange';
// disclosure.
const D_ENVELOPE_ID = '7a000000-0000-7000-8000-0000000000b1';
const D_SIGNER_ID = '7a000000-0000-7000-8000-0000000000b2';
const D_SESSION_ID = '7a000000-0000-7000-8000-0000000000b3';
const D_ENV_DOC_ID = '7a000000-0000-7000-8000-0000000000b6';
const TOKEN_DISCLOSURE = 'sign-web-pact-token-disclosure';
// fill.
const F_ENVELOPE_ID = '7a000000-0000-7000-8000-0000000000c1';
const F_SIGNER_ID = '7a000000-0000-7000-8000-0000000000c2';
const F_SESSION_ID = '7a000000-0000-7000-8000-0000000000c3';
const F_ENV_DOC_ID = '7a000000-0000-7000-8000-0000000000c6';
const FILL_FIELD_ID = '7a000000-0000-7000-8000-0000000000c4';
const TOKEN_FILL = 'sign-web-pact-token-fill';
// complete (2nd pending signer ⇒ IN_PROGRESS, no executed-bytes side effect).
const C_ENVELOPE_ID = '7a000000-0000-7000-8000-0000000000d1';
const C_SIGNER_ID = '7a000000-0000-7000-8000-0000000000d2';
const C_SESSION_ID = '7a000000-0000-7000-8000-0000000000d3';
const C_ENV_DOC_ID = '7a000000-0000-7000-8000-0000000000d6';
const C_SIGNER2_ID = '7a000000-0000-7000-8000-0000000000d5';
const TOKEN_COMPLETE = 'sign-web-pact-token-complete';

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
      // SignatureEvent → envelope is onDelete:Restrict — clear events before the
      // envelope (idempotent re-seed across interactions sharing this state).
      await db.query(`DELETE FROM "esign"."SignatureEvent" WHERE envelope_id = $1`, [ENVELOPE_ID]);
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

    // DOC-4C (R1 seam A) — seed ONE independent signer-session fixture (envelope +
    // document + signer + head event + ISSUED session). NO deletes: SignatureEvent
    // is append-only; each op uses a distinct envelope/token so nothing is re-seeded.
    // Only the sha256.base64url hash of the raw token persists (R17).
    async function seedSignerFixture(f: {
      envelopeId: string;
      envDocId: string;
      signerId: string;
      sessionId: string;
      token: string;
      disclosure?: boolean;
      field?: boolean;
      fieldId?: string;
      secondSignerId?: string;
    }): Promise<void> {
      await db.query(
        `INSERT INTO "esign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
         VALUES ($1,$2,'Offer Letter','SENT','SINGLE_SIGNATURE',$3)`,
        [f.envelopeId, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "esign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES ($1,$2,$3,$4,$5,'offer.pdf',$6,1)`,
        [f.envDocId, TENANT_ID, f.envelopeId, DOC_REF, REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "esign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
         VALUES ($1,$2,$3,'jane@example.com','Jane Doe',1,'PENDING')`,
        [f.signerId, TENANT_ID, f.envelopeId],
      );
      if (f.secondSignerId !== undefined) {
        await db.query(
          `INSERT INTO "esign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
           VALUES ($1,$2,$3,'john@example.com','John Roe',2,'PENDING')`,
          [f.secondSignerId, TENANT_ID, f.envelopeId],
        );
      }
      await db.query(
        `INSERT INTO "esign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, previous_event_hash, event_hash)
         VALUES (gen_random_uuid(),$1,$2,'ENVELOPE_CREATED','SERVICE',NULL,$3)`,
        [TENANT_ID, f.envelopeId, `sw-seed-${f.envelopeId}`],
      );
      await db.query(
        `INSERT INTO "esign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,'ISSUED', now() + interval '7 days')`,
        [f.sessionId, TENANT_ID, f.envelopeId, f.signerId, hashToken(f.token)],
      );
      if (f.disclosure === true) {
        await db.query(
          `INSERT INTO "esign"."SignerDisclosureAcceptance" (id, tenant_id, signer_id, disclosure_version, disclosure_text_hash, session_id)
           VALUES (gen_random_uuid(),$1,$2,'v1',$3,$4)`,
          [TENANT_ID, f.signerId, 'a'.repeat(64), f.sessionId],
        );
      }
      if (f.field === true && f.fieldId !== undefined) {
        await db.query(
          `INSERT INTO "esign"."SignatureField" (id, tenant_id, envelope_document_id, signer_id, field_type, page_number, x, y, required)
           VALUES ($1,$2,$3,$4,'SIGNATURE',1,10,10,true)`,
          [f.fieldId, TENANT_ID, f.envDocId, f.signerId],
        );
      }
    }

    // DOC-4C (R1 seam B) — seed a distinct COMPLETED envelope with an executed
    // document + execution certificate so the executed-artifact pull resolves. NO
    // delete (fresh id; SignatureEvent append-only).
    async function seedExecutedEnvelope(): Promise<void> {
      await db.query(
        `INSERT INTO "esign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
         VALUES ($1,$2,'Offer Letter','COMPLETED','SINGLE_SIGNATURE',$3)`,
        [EXEC_ENVELOPE_ID, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "esign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES ($1,$2,$3,$4,$5,'offer.pdf',$6,1)`,
        [EXEC_ENV_DOC_ID, TENANT_ID, EXEC_ENVELOPE_ID, DOC_REF, REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "esign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,8, decode('255044462d312e34','hex'))`,
        [TENANT_ID, EXEC_ENVELOPE_ID, EXEC_ENV_DOC_ID, SHA256, 'b'.repeat(64)],
      );
      await db.query(
        `INSERT INTO "esign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes)
         VALUES (gen_random_uuid(),$1,$2,$3,4, decode('63657274','hex'))`,
        [TENANT_ID, EXEC_ENVELOPE_ID, 'c'.repeat(64)],
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

    it('verifies the aramo-core → esign-service and sign-web → esign-service pacts', async () => {
      const verifier = new Verifier({
        provider: 'esign-service',
        providerBaseUrl: `http://127.0.0.1:${port}`,
        pactUrls: [PACT_FILE, SIGN_WEB_PACT_FILE],
        stateHandlers: {
          'no prior envelope for the request': async () => undefined,
          'a signature envelope exists': async () => {
            await seedEnvelope();
          },
          // DOC-4C seam B — the executed-artifact pull (aramo-core → esign-service).
          'an executed envelope exists': async () => {
            await seedExecutedEnvelope();
          },
          // DOC-4C seam A — the public signer-session ops (sign-web → esign-service).
          'a signer session is issued for the envelope': async () => {
            await seedSignerFixture({ envelopeId: EX_ENVELOPE_ID, envDocId: EX_ENV_DOC_ID, signerId: EX_SIGNER_ID, sessionId: EX_SESSION_ID, token: TOKEN_EXCHANGE });
          },
          'a signer session is ready to accept disclosure': async () => {
            await seedSignerFixture({ envelopeId: D_ENVELOPE_ID, envDocId: D_ENV_DOC_ID, signerId: D_SIGNER_ID, sessionId: D_SESSION_ID, token: TOKEN_DISCLOSURE });
          },
          'a signer session has accepted disclosure with a fillable field': async () => {
            await seedSignerFixture({ envelopeId: F_ENVELOPE_ID, envDocId: F_ENV_DOC_ID, signerId: F_SIGNER_ID, sessionId: F_SESSION_ID, token: TOKEN_FILL, disclosure: true, field: true, fieldId: FILL_FIELD_ID });
          },
          'a signer session is ready to complete with another pending signer': async () => {
            await seedSignerFixture({ envelopeId: C_ENVELOPE_ID, envDocId: C_ENV_DOC_ID, signerId: C_SIGNER_ID, sessionId: C_SESSION_ID, token: TOKEN_COMPLETE, disclosure: true, secondSignerId: C_SIGNER2_ID });
          },
        },
      });
      await verifier.verifyProvider();
    }, 180_000);
  },
);
