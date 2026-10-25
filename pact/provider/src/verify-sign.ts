import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { Verifier } from '@pact-foundation/pact';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AppModule } from '@aramo/sign-service';
import { DOCUMENT_STORAGE_PORT, type DocumentStoragePort, type PutOwnedSourceInput } from '@aramo/sign';

// DOC-3 — Pact provider verifier for apps/sign-service.
//
// Consumer:  aramo-core     (apps/api's SignatureProviderPort HTTP adapter)
// Provider:  sign-service  (apps/sign-service)
//
// A SEPARATE provider (mirrors pact/provider/src/verify.ts for auth-service):
// boots the sign-service NestJS app against a Postgres 17 testcontainer with
// the esign schema, then verifies the recorded aramo-core → sign-service pact.
// The esign migration is applied WHOLE-FILE (its append-only trigger body is
// dollar-quoted; the naive splitDdl used elsewhere is comment/`$$`-blind).
//
// Gated on ARAMO_RUN_PACT_PROVIDER=1 (same as verify.ts / verify-api.ts).

const ROOT = resolve(__dirname, '../../..');
// Apply ALL esign migrations whole-file, in order — the append-only trigger is
// $$-quoted (the shared splitDdl is comment/$$-blind), and DOC-4 added the
// ExecutedDocument migration (never hardcode a single-migration list).
function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
// PX-1 (PX-V1 §12) — the authenticated sender surface needs the identity +
// entitlement schemas: JwtAuthGuard resolves effective scopes server-side through
// the identity resolver (AuthorizationVersion → membership → roles → scopes, with
// the `sign` consumer filter reading the tenant entitlement), EntitlementGuard
// reads entitlement."TenantEntitlement", and the sender context reads Tenant/User.
// ALL migrations of each schema, whole-file, in order (the Prisma clients SELECT
// every column; several identity migrations carry DO/$$ blocks and guard SELECTs).
function migrationsOf(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const PACT_FILE = resolve(ROOT, 'pact/pacts/aramo-core-sign-service.json');
// DOC-4C (R1 seam A) — the sign-web → sign-service signer-session pact.
const SIGN_WEB_PACT_FILE = resolve(ROOT, 'pact/pacts/sign-web-sign-service.json');
// PX-1 (PX-V1 §12) — the esign-web → sign-service sender-console pact.
const ESIGN_WEB_PACT_FILE = resolve(ROOT, 'pact/pacts/sign-workspace-sign-service.json');

// Fixed ids — MUST match pact/consumers/sign-consumer/src/esign.consumer.test.ts.
const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const ENVELOPE_ID = '22222222-2222-7222-8222-222222222222';
const SIGNER_ID = '33333333-3333-7333-8333-333333333333';
const CREATED_BY = '44444444-4444-7444-8444-444444444444';
const DOC_REF = '55555555-5555-7555-8555-555555555555';
const REV_REF = '66666666-6666-7666-8666-666666666666';
const SHA256 = 'a'.repeat(64);
// COMM-RECRUITER-W1 (W1-C) — DEDICATED ids for the reverse-lookup/reminder
// fixtures so they never collide with DOC_REF/REV_REF/ENVELOPE_ID used by the
// other states (shared refs would make the reverse lookup ambiguous → 409).
const RTR_ENVELOPE_ID = '77777777-7777-7777-8777-777777777777';
const RTR_DOC_REF = '88888888-8888-7888-8888-888888888888';
const RTR_REV_REF = '99999999-9999-7999-8999-999999999999';
const RTR_SIGNER_ID = '77777777-7777-7777-8777-7777777777aa';
// DOC-4C (R1 seam B) — a DISTINCT COMPLETED envelope for the executed-pull state
// (the DRAFT 'a signature envelope exists' fixture cannot be re-seeded — events
// are append-only). MUST match pact/consumers/sign-consumer/src/esign.consumer.test.ts.
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
// Aramo Sign launch — disclosure-text (A-7) and the signer's signed-copy link.
const T_ENVELOPE_ID = '7a000000-0000-7000-8000-0000000000e1';
const T_SIGNER_ID = '7a000000-0000-7000-8000-0000000000e2';
const T_SESSION_ID = '7a000000-0000-7000-8000-0000000000e3';
const T_ENV_DOC_ID = '7a000000-0000-7000-8000-0000000000e6';
const TOKEN_DISCLOSURE_TEXT = 'sign-web-pact-token-disclosure-text';
const X_ENVELOPE_ID = '7a000000-0000-7000-8000-0000000000f1';
const X_SIGNER_ID = '7a000000-0000-7000-8000-0000000000f2';
const X_ENV_DOC_ID = '7a000000-0000-7000-8000-0000000000f6';
const X_GRANT_ID = '7a000000-0000-7000-8000-0000000000f7';
const TOKEN_EXECUTED = 'sign-web-pact-token-executed';

// PX-1 — esign-web sender-console fixtures. MUST match
// pact/consumers/sign-workspace-consumer/src/sender-console.consumer.test.ts. The
// sender tenant is DISTINCT from TENANT_ID (the internal-surface fixtures) so the
// sender list reads only sender fixtures. Every mutating op names its OWN envelope
// via the provider-state `envelope_id` param (SignatureEvent is append-only).
const SENDER_TENANT_ID = 'e5000000-0000-7000-8000-000000000001';
const SENDER_USER_ID = 'e5000000-0000-7000-8000-000000000002';
const SENDER_MEMBERSHIP_ID = 'e5000000-0000-7000-8000-000000000003';
const SENDER_ROLE_ID = 'e5000000-0000-7000-8000-000000000004';
const SENDER_SCOPES: readonly (readonly [string, string])[] = [
  ['e5000000-0000-7000-8000-000000000011', 'sign:envelope:read'],
  ['e5000000-0000-7000-8000-000000000012', 'sign:envelope:create'],
  ['e5000000-0000-7000-8000-000000000013', 'sign:envelope:send'],
];
// The consumer's placeholder session cookie; the requestFilter swaps in a real token.
const SENDER_COOKIE_NAME = 'aramo_access_token_sign';

// CCP-A6 (Conversion Rule C-1, C-4) — the billing owner of a BUSINESS tenant holding an open
// governed (MANUAL) Sign subscription. MUST match the placeholder in
// pact/consumers/sign-workspace-consumer/src/sender-console.consumer.test.ts.
const BILLING_OWNER_PLACEHOLDER = 'sign-workspace-pact-billing-owner';
const GOV_TENANT_ID = 'e6a60000-0000-7000-8000-000000000001';
const GOV_USER_ID = 'e6a60000-0000-7000-8000-000000000002';
const GOV_MEMBERSHIP_ID = 'e6a60000-0000-7000-8000-000000000003';
const GOV_ROLE_ID = 'e6a60000-0000-7000-8000-000000000004';
const GOV_SCOPE_ID = 'e6a60000-0000-7000-8000-000000000011';
const GOV_INTENT_ID = 'e6a60000-0000-7000-8000-000000000021';
const AUTH_ISSUER = 'Aramo Core Auth'; // the issuer JwtAuthGuard pins
const AUTH_AUDIENCE = 'aramo-pact-provider-esign-audience';
// Per-fixture child ids derive from the envelope id's last two hex chars:
// …X1 envelope, …X2 document, …X3 signer, …X4 field (consumer uses …d2/…d3).
const childId = (envelopeId: string, n: number): string => `${envelopeId.slice(0, -1)}${String(n)}`;

describe.skipIf(process.env['ARAMO_RUN_PACT_PROVIDER'] !== '1')(
  'pact provider verification — sign-service (apps/sign-service)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let app: NestExpressApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let senderJwt = '';
    let billingOwnerJwt = '';
    let letterPdf: Uint8Array = new Uint8Array();

    // PX-1 — in-memory OWNED source storage (DOCUMENT_STORAGE_PORT) so uploads and
    // the server-side field-geometry validation (which re-reads the source PDF)
    // run without S3. Same key/sha256 contract as EsignObjectStorageDocumentAdapter.
    const ownedSources = new Map<string, Uint8Array>();
    const inMemoryStorage: DocumentStoragePort = {
      async putOwnedSource(input: PutOwnedSourceInput) {
        const source_object_key = `esign/source/${input.tenant_id}/${input.envelope_id}/${randomUUID()}`;
        ownedSources.set(source_object_key, new Uint8Array(input.bytes));
        return {
          source_object_key,
          byte_size: input.bytes.byteLength,
          source_sha256: createHash('sha256').update(input.bytes).digest('hex'),
        };
      },
      async getOwnedSource(source_object_key: string) {
        const bytes = ownedSources.get(source_object_key);
        if (bytes === undefined) throw new Error(`owned source ${source_object_key} not found`);
        return bytes;
      },
    };

    // PX-1 — the sender principal, seeded through the REAL authorization substrate
    // (no resolver override): a BUSINESS ACTIVE tenant entitled core + esign, a user
    // owned by it with one active membership, and the `sign_sender` role granting
    // sign:envelope:read/create/send; AuthorizationVersion pinned at 1 (the token's
    // authz_version). Idempotent — every sender state calls it.
    async function seedSender(): Promise<void> {
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at)
         VALUES ($1,'Pact Sign Co','pact-sign','BUSINESS','ACTIVE',true, now())
         ON CONFLICT (id) DO NOTHING`,
        [SENDER_TENANT_ID],
      );
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at)
         VALUES ($1,'sam.sender@example.com','Sam Sender',$2, now())
         ON CONFLICT (id) DO NOTHING`,
        [SENDER_USER_ID, SENDER_TENANT_ID],
      );
      await db.query(
        `INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (id) DO NOTHING`,
        [SENDER_MEMBERSHIP_ID, SENDER_USER_ID, SENDER_TENANT_ID],
      );
      await db.query(
        `INSERT INTO identity."Role" (id, key, description, updated_at)
         VALUES ($1,'sign_sender','Aramo Sign sender', now())
         ON CONFLICT (key) DO NOTHING`,
        [SENDER_ROLE_ID],
      );
      for (const [scopeId, key] of SENDER_SCOPES) {
        await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [scopeId, key]);
        await db.query(
          `INSERT INTO identity."RoleScope" (id, role_id, scope_id)
           SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s
           WHERE r.key = 'sign_sender' AND s.key = $1
           ON CONFLICT (role_id, scope_id) DO NOTHING`,
          [key],
        );
      }
      await db.query(
        `INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id)
         SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = 'sign_sender'
         ON CONFLICT (membership_id, role_id) DO NOTHING`,
        [SENDER_MEMBERSHIP_ID],
      );
      await db.query(
        `INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at)
         VALUES (gen_random_uuid(),$1,$2,1, now())
         ON CONFLICT (tenant_id, principal_id) DO NOTHING`,
        [SENDER_TENANT_ID, SENDER_USER_ID],
      );
      for (const capability of ['core', 'sign']) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1, $2::entitlement."Capability")
           ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [SENDER_TENANT_ID, capability],
        );
      }
      // The governed DEVELOPMENT subscription on the seeded Aramo Sign included plan
      // (100 envelopes / month), so a console send passes the allowance gate.
      // CCP-A4 (MP-A2 N-9, N-11) — explicit product context (no DB default exists) and the
      // arbiter of the one-open-BASE-per-(tenant, product) index. CCP-A5 (N-18) — pinned to the
      // plan's current (PUBLISHED) version, named explicitly (no DB default).
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
         SELECT gen_random_uuid(), $1::uuid, p.id,
                (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'),
                p.product_key, 'BASE', now(), 'DEVELOPMENT', 'pact-verify-sign'
           FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1' AND p.product_key = 'sign'
         ON CONFLICT (tenant_id, product_key) WHERE ended_at IS NULL AND composition_role = 'BASE' DO NOTHING`,
        [SENDER_TENANT_ID],
      );
    }

    // CCP-A6 — the governed-subscription billing owner (real RBAC: a role granting
    // sign:billing:manage; the tenant entitled core + sign) and an open MANUAL Sign subscription.
    async function seedGovernedBillingOwner(): Promise<void> {
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at)
         VALUES ($1,'Pact Governed Co','pact-governed','BUSINESS','ACTIVE',true, now()) ON CONFLICT (id) DO NOTHING`,
        [GOV_TENANT_ID],
      );
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at)
         VALUES ($1,'bo.owner@example.com','Bo Owner',$2, now()) ON CONFLICT (id) DO NOTHING`,
        [GOV_USER_ID, GOV_TENANT_ID],
      );
      await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now()) ON CONFLICT (id) DO NOTHING`, [
        GOV_MEMBERSHIP_ID,
        GOV_USER_ID,
        GOV_TENANT_ID,
      ]);
      await db.query(`INSERT INTO identity."Role" (id, key, description, updated_at) VALUES ($1,'pact_sign_billing_owner','Pact Sign billing owner', now()) ON CONFLICT (key) DO NOTHING`, [GOV_ROLE_ID]);
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,'sign:billing:manage') ON CONFLICT (key) DO NOTHING`, [GOV_SCOPE_ID]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id)
         SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s
          WHERE r.key = 'pact_sign_billing_owner' AND s.key = 'sign:billing:manage'
         ON CONFLICT (role_id, scope_id) DO NOTHING`,
      );
      await db.query(
        `INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id)
         SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = 'pact_sign_billing_owner'
         ON CONFLICT (membership_id, role_id) DO NOTHING`,
        [GOV_MEMBERSHIP_ID],
      );
      await db.query(
        `INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at)
         VALUES (gen_random_uuid(),$1,$2,1, now()) ON CONFLICT (tenant_id, principal_id) DO NOTHING`,
        [GOV_TENANT_ID, GOV_USER_ID],
      );
      for (const capability of ['core', 'sign']) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability") ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [GOV_TENANT_ID, capability],
        );
      }
      // The governed (MANUAL, Aramo-managed) subscription; explicit product, composition and pin.
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
         SELECT gen_random_uuid(), $1::uuid, p.id,
                (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'),
                p.product_key, 'BASE', now(), 'MANUAL', 'pact-verify-sign'
           FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1' AND p.product_key = 'sign'
         ON CONFLICT (tenant_id, product_key) WHERE ended_at IS NULL AND composition_role = 'BASE' DO NOTHING`,
        [GOV_TENANT_ID],
      );
    }
    // Billing must be configured for checkout to reach the governed-subscription decision (no
    // provider call is made: the refusal precedes every side effect). Scoped to the one state.
    // STRIPE_API_BASE points at a closed local port: should any provider call ever be reached, it
    // fails (503) instead of leaving the harness.
    const BILLING_ENV = {
      STRIPE_SECRET_KEY: 'sk_test_pact_verify_sign',
      STRIPE_WEBHOOK_SECRET: 'whsec_pact_verify_sign',
      STRIPE_API_BASE: 'http://127.0.0.1:9',
      STRIPE_PLAN_PRICES: 'aramo-sign-standard-business-v1=price_pact_business',
    } as const;
    const billingEnvSaved: Partial<Record<string, string | undefined>> = {};

    // PX-1 — one sender-authored (OWNED-source) envelope fixture. NO deletes:
    // SignatureEvent is append-only; each interaction names its own envelope id.
    // The OWNED document's source bytes are a real one-page 612x792 PDF placed in
    // the in-memory store under the row's source_object_key, so field geometry is
    // validated against a real page.
    async function seedSenderEnvelope(f: {
      envelopeId: string;
      status: 'DRAFT' | 'SENT';
      document?: boolean;
      recipient?: boolean;
      signatureField?: boolean;
    }): Promise<void> {
      await seedSender();
      const sent = f.status === 'SENT';
      await db.query(
        `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, sent_at)
         VALUES ($1,$2,'Offer letter',$3,'SINGLE_SIGNATURE',$4, ${sent ? 'now()' : 'NULL'})
         ON CONFLICT (id) DO NOTHING`,
        [f.envelopeId, SENDER_TENANT_ID, f.status, SENDER_USER_ID],
      );
      const docId = childId(f.envelopeId, 2);
      const signerId = childId(f.envelopeId, 3);
      if (f.document === true) {
        const key = `esign/source/${SENDER_TENANT_ID}/${f.envelopeId}/pact-seed`;
        ownedSources.set(key, letterPdf);
        await db.query(
          `INSERT INTO "sign"."EnvelopeDocument"
             (id, tenant_id, envelope_id, source_mode, source_object_key, content_type, byte_size, title, source_sha256, ordinal)
           VALUES ($1,$2,$3,'OWNED',$4,'application/pdf',$5,'Offer letter',$6,1)
           ON CONFLICT (id) DO NOTHING`,
          [docId, SENDER_TENANT_ID, f.envelopeId, key, letterPdf.byteLength, createHash('sha256').update(letterPdf).digest('hex')],
        );
      }
      if (f.recipient === true) {
        await db.query(
          `INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
           VALUES ($1,$2,$3,'jane@example.com','Jane Doe',1,'PENDING')
           ON CONFLICT (id) DO NOTHING`,
          [signerId, SENDER_TENANT_ID, f.envelopeId],
        );
      }
      if (f.signatureField === true) {
        await db.query(
          `INSERT INTO "sign"."SignatureField" (id, tenant_id, envelope_document_id, signer_id, field_type, page_number, x, y, width, height, required)
           VALUES ($1,$2,$3,$4,'SIGNATURE',0,72,100,180,40,true)
           ON CONFLICT (id) DO NOTHING`,
          [childId(f.envelopeId, 4), SENDER_TENANT_ID, docId, signerId],
        );
      }
      await db.query(
        `INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, actor_ref, previous_event_hash, event_hash)
         VALUES ($1,$2,$3,$4,'SERVICE',$5,NULL,$6)
         ON CONFLICT (id) DO NOTHING`,
        [childId(f.envelopeId, 9), SENDER_TENANT_ID, f.envelopeId, sent ? 'ENVELOPE_SENT' : 'ENVELOPE_CREATED', SENDER_USER_ID, `ew-seed-${f.envelopeId}`],
      );
    }
    const envelopeParam = (params: unknown): string => {
      const id = (params as { envelope_id?: unknown } | undefined)?.envelope_id;
      if (typeof id !== 'string') throw new Error('provider state requires an envelope_id param');
      return id;
    };

    // Seed a signature envelope (+ document, signer, one hash-chained event) so
    // the GET and evidence interactions resolve. Idempotent (delete-then-insert).
    async function seedEnvelope(): Promise<void> {
      // SignatureEvent → envelope is onDelete:Restrict — clear events before the
      // envelope (idempotent re-seed across interactions sharing this state).
      await db.query(`DELETE FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [ENVELOPE_ID]);
      await db.query(`DELETE FROM "sign"."SignatureEnvelope" WHERE id = $1`, [ENVELOPE_ID]);
      await db.query(
        `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
         VALUES ($1,$2,'Offer Letter','DRAFT','SINGLE_SIGNATURE',$3)`,
        [ENVELOPE_ID, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'offer.pdf',$5,1)`,
        [TENANT_ID, ENVELOPE_ID, DOC_REF, REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
         VALUES ($1,$2,$3,'jane@example.com','Jane Doe',1,'PENDING')`,
        [SIGNER_ID, TENANT_ID, ENVELOPE_ID],
      );
      await db.query(
        `INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, previous_event_hash, event_hash)
         VALUES (gen_random_uuid(),$1,$2,'ENVELOPE_CREATED','SERVICE',NULL,'seed-event-chain-hash')`,
        [TENANT_ID, ENVELOPE_ID],
      );
    }

    // COMM-RECRUITER-W1 (W1-C) — a dedicated SENT envelope (RTR_ENVELOPE_ID) with a
    // PENDING (incomplete) signer over its OWN unique (RTR_DOC_REF, RTR_REV_REF),
    // for both the reverse-lookup and the reminder states. Unique refs guarantee
    // the reverse lookup resolves EXACTLY ONE non-terminal envelope (no ambiguity).
    async function seedRtrEnvelope(): Promise<void> {
      await db.query(`DELETE FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [RTR_ENVELOPE_ID]);
      await db.query(`DELETE FROM "sign"."SigningSession" WHERE envelope_id = $1`, [RTR_ENVELOPE_ID]);
      await db.query(`DELETE FROM "sign"."SignatureEnvelope" WHERE id = $1`, [RTR_ENVELOPE_ID]);
      await db.query(
        `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
         VALUES ($1,$2,'Right to Represent','SENT','SINGLE_SIGNATURE',$3)`,
        [RTR_ENVELOPE_ID, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'rtr.pdf',$5,1)`,
        [TENANT_ID, RTR_ENVELOPE_ID, RTR_DOC_REF, RTR_REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
         VALUES ($1,$2,$3,'jane@example.com','Jane Doe',1,'PENDING')`,
        [RTR_SIGNER_ID, TENANT_ID, RTR_ENVELOPE_ID],
      );
      await db.query(
        `INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, previous_event_hash, event_hash)
         VALUES (gen_random_uuid(),$1,$2,'ENVELOPE_SENT','SERVICE',NULL,'seed-rtr-event-chain-hash')`,
        [TENANT_ID, RTR_ENVELOPE_ID],
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
        `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
         VALUES ($1,$2,'Offer Letter','SENT','SINGLE_SIGNATURE',$3)`,
        [f.envelopeId, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES ($1,$2,$3,$4,$5,'offer.pdf',$6,1)`,
        [f.envDocId, TENANT_ID, f.envelopeId, DOC_REF, REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
         VALUES ($1,$2,$3,'jane@example.com','Jane Doe',1,'PENDING')`,
        [f.signerId, TENANT_ID, f.envelopeId],
      );
      if (f.secondSignerId !== undefined) {
        await db.query(
          `INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
           VALUES ($1,$2,$3,'john@example.com','John Roe',2,'PENDING')`,
          [f.secondSignerId, TENANT_ID, f.envelopeId],
        );
      }
      await db.query(
        `INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, previous_event_hash, event_hash)
         VALUES (gen_random_uuid(),$1,$2,'ENVELOPE_CREATED','SERVICE',NULL,$3)`,
        [TENANT_ID, f.envelopeId, `sw-seed-${f.envelopeId}`],
      );
      await db.query(
        `INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,'ISSUED', now() + interval '7 days')`,
        [f.sessionId, TENANT_ID, f.envelopeId, f.signerId, hashToken(f.token)],
      );
      if (f.disclosure === true) {
        await db.query(
          `INSERT INTO "sign"."SignerDisclosureAcceptance" (id, tenant_id, signer_id, disclosure_version, disclosure_text_hash, session_id)
           VALUES (gen_random_uuid(),$1,$2,'v1',$3,$4)`,
          [TENANT_ID, f.signerId, 'a'.repeat(64), f.sessionId],
        );
      }
      if (f.field === true && f.fieldId !== undefined) {
        await db.query(
          `INSERT INTO "sign"."SignatureField" (id, tenant_id, envelope_document_id, signer_id, field_type, page_number, x, y, required)
           VALUES ($1,$2,$3,$4,'SIGNATURE',1,10,10,true)`,
          [f.fieldId, TENANT_ID, f.envDocId, f.signerId],
        );
      }
    }

    // Aramo Sign launch — a distinct COMPLETED envelope with an executed document,
    // a certificate and a signer signed-copy access grant (only the token hash is
    // stored). Fresh ids; nothing is re-seeded.
    async function seedSignedCopyGrant(): Promise<void> {
      await db.query(
        `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, completed_at)
         VALUES ($1,$2,'Offer Letter','COMPLETED','SINGLE_SIGNATURE',$3, now())`,
        [X_ENVELOPE_ID, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES ($1,$2,$3,$4,$5,'offer.pdf',$6,1)`,
        [X_ENV_DOC_ID, TENANT_ID, X_ENVELOPE_ID, DOC_REF, REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,8, decode('255044462d312e34','hex'))`,
        [TENANT_ID, X_ENVELOPE_ID, X_ENV_DOC_ID, SHA256, 'b'.repeat(64)],
      );
      await db.query(
        `INSERT INTO "sign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes)
         VALUES (gen_random_uuid(),$1,$2,$3,4, decode('63657274','hex'))`,
        [TENANT_ID, X_ENVELOPE_ID, 'c'.repeat(64)],
      );
      await db.query(
        `INSERT INTO "sign"."ExecutedAccessGrant" (id, tenant_id, envelope_id, signer_id, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + interval '30 days')`,
        [X_GRANT_ID, TENANT_ID, X_ENVELOPE_ID, X_SIGNER_ID, hashToken(TOKEN_EXECUTED)],
      );
    }

    // DOC-4C (R1 seam B) — seed a distinct COMPLETED envelope with an executed
    // document + execution certificate so the executed-artifact pull resolves. NO
    // delete (fresh id; SignatureEvent append-only).
    async function seedExecutedEnvelope(): Promise<void> {
      await db.query(
        `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
         VALUES ($1,$2,'Offer Letter','COMPLETED','SINGLE_SIGNATURE',$3)`,
        [EXEC_ENVELOPE_ID, TENANT_ID, CREATED_BY],
      );
      await db.query(
        `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES ($1,$2,$3,$4,$5,'offer.pdf',$6,1)`,
        [EXEC_ENV_DOC_ID, TENANT_ID, EXEC_ENVELOPE_ID, DOC_REF, REV_REF, SHA256],
      );
      await db.query(
        `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,8, decode('255044462d312e34','hex'))`,
        [TENANT_ID, EXEC_ENVELOPE_ID, EXEC_ENV_DOC_ID, SHA256, 'b'.repeat(64)],
      );
      await db.query(
        `INSERT INTO "sign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes)
         VALUES (gen_random_uuid(),$1,$2,$3,4, decode('63657274','hex'))`,
        [TENANT_ID, EXEC_ENVELOPE_ID, 'c'.repeat(64)],
      );
    }

    // Addendum S6 — the ATS (aramo-core) as a client of the Sign API. Fixtures MUST
    // match pact/consumers/sign-consumer/src/sign-api-transport.consumer.test.ts.
    // Idempotent: every API-transport state calls it. The live grants are seeded
    // as digests exactly as the token endpoint stores them.
    const ATS_TENANT_ID = 'a7500000-0000-7000-8000-000000000001';
    const ATS_RECRUITER_ID = 'a7500000-0000-7000-8000-000000000002';
    const ATS_USER_GRANT = 'sgt_pact_ats_user_grant_0123456789abcdefghij';
    const ATS_EVENT_GRANT = 'sgt_pact_ats_event_grant_0123456789abcdefghi';
    const ATS_CLIENT_ID = 'sgc_pact_ats';
    const ATS_CLIENT_SECRET = 'sgs_pact_ats_secret_0123456789abcdefghijklmnop';
    const ATS_EVENT_ID = 'a7500000-0000-7000-8000-0000000000e1';
    const ATS_EXEC_ENVELOPE_ID = 'a7500000-0000-7000-8000-0000000000f1';
    const ATS_INSTALLATION_ID = 'a7500000-0000-7000-8000-000000000003';
    const ATS_CREDENTIAL_ID = 'a7500000-0000-7000-8000-000000000004';
    const ATS_SUBSCRIPTION_ID = 'a7500000-0000-7000-8000-000000000005';
    const sha = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('base64url');
    async function seedAtsApi(): Promise<void> {
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,'Pact ATS Co','pact-ats','BUSINESS','ACTIVE',true, now()) ON CONFLICT (id) DO NOTHING`,
        [ATS_TENANT_ID],
      );
      for (const capability of ['core', 'ats', 'sign']) {
        await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability") ON CONFLICT (tenant_id, capability) DO NOTHING`, [ATS_TENANT_ID, capability]);
      }
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
         SELECT gen_random_uuid(), $1::uuid, p.id,
                (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'),
                p.product_key, 'BASE', now(), 'DEVELOPMENT', 'pact-verify-sign'
           FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1' AND p.product_key = 'sign'
         ON CONFLICT (tenant_id, product_key) WHERE ended_at IS NULL AND composition_role = 'BASE' DO NOTHING`,
        [ATS_TENANT_ID],
      );
      await db.query(
        `INSERT INTO "sign"."SignInstallation" (id, tenant_id, application_id, granted_permissions, modes, first_party_auto)
         SELECT $1, $2, a.id, a.requested_permissions, ARRAY['USER'], true FROM "sign"."SignApplication" a WHERE a.key = 'aramo-ats'
         ON CONFLICT (tenant_id, application_id) DO NOTHING`,
        [ATS_INSTALLATION_ID, ATS_TENANT_ID],
      );
      await db.query(
        `INSERT INTO "sign"."SignCredential" (id, application_id, installation_id, client_id, secret_hash)
         SELECT $1, a.id, NULL, $2, $3 FROM "sign"."SignApplication" a WHERE a.key = 'aramo-ats' ON CONFLICT (client_id) DO NOTHING`,
        [ATS_CREDENTIAL_ID, ATS_CLIENT_ID, sha(ATS_CLIENT_SECRET)],
      );
    }
    async function seedAtsUserGrant(): Promise<void> {
      await seedAtsApi();
      await db.query(
        `INSERT INTO "sign"."SignAccessToken" (id, token_hash, credential_id, installation_id, tenant_id, mode, subject_id, scopes, audience, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'USER', $5, ARRAY['sign:envelope:read','sign:envelope:read:all','sign:envelope:create','sign:envelope:send','sign:envelope:manage:all'], 'aramo-sign-api', now() + interval '1 day')
         ON CONFLICT (token_hash) DO NOTHING`,
        [sha(ATS_USER_GRANT), ATS_CREDENTIAL_ID, ATS_INSTALLATION_ID, ATS_TENANT_ID, ATS_RECRUITER_ID],
      );
    }
    async function seedAtsCompletion(): Promise<void> {
      await seedAtsApi();
      const doc = 'a7500000-0000-7000-8000-0000000000f2';
      await db.query(
        `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, completed_at, source_application, installation_id)
         VALUES ($1,$2,'Right to Represent','COMPLETED','SINGLE_SIGNATURE',$3, now(),'aramo-ats',$4) ON CONFLICT (id) DO NOTHING`,
        [ATS_EXEC_ENVELOPE_ID, ATS_TENANT_ID, ATS_RECRUITER_ID, ATS_INSTALLATION_ID],
      );
      await db.query(
        `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal)
         VALUES ($1,$2,$3,'a7500000-0000-7000-8000-0000000000d1','a7500000-0000-7000-8000-0000000000d2','RTR',$4,1) ON CONFLICT (id) DO NOTHING`,
        [doc, ATS_TENANT_ID, ATS_EXEC_ENVELOPE_ID, SHA256],
      );
      await db.query(
        `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes)
         SELECT gen_random_uuid(),$1,$2,$3,$4,$5,8, decode('255044462d312e34','hex') WHERE NOT EXISTS (SELECT 1 FROM "sign"."ExecutedDocument" WHERE envelope_id = $2)`,
        [ATS_TENANT_ID, ATS_EXEC_ENVELOPE_ID, doc, SHA256, 'b'.repeat(64)],
      );
      await db.query(
        `INSERT INTO "sign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes)
         SELECT gen_random_uuid(),$1,$2,$3,4, decode('63657274','hex') WHERE NOT EXISTS (SELECT 1 FROM "sign"."ExecutionCertificate" WHERE envelope_id = $2)`,
        [ATS_TENANT_ID, ATS_EXEC_ENVELOPE_ID, 'c'.repeat(64)],
      );
      await db.query(
        `INSERT INTO "sign"."SignWebhookSubscription" (id, application_id, installation_id, tenant_id, target_url, secret_ciphertext, internal)
         SELECT $1, a.id, NULL, NULL, 'http://api:3000/v1/integrations/sign/events', 'v1.pact.pact.pact', true FROM "sign"."SignApplication" a WHERE a.key = 'aramo-ats'
         ON CONFLICT (id) DO NOTHING`,
        [ATS_SUBSCRIPTION_ID],
      );
      await db.query(
        `INSERT INTO "sign"."SignWebhookDelivery" (id, subscription_id, event_id, tenant_id, envelope_id, event_type, payload, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sign.envelope.executed.v1', '{}'::jsonb, 'DELIVERED') ON CONFLICT (subscription_id, event_id) DO NOTHING`,
        [ATS_SUBSCRIPTION_ID, ATS_EVENT_ID, ATS_TENANT_ID, ATS_EXEC_ENVELOPE_ID],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // Whole-file apply — the SignatureEvent append-only trigger is $$-quoted.
      for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
      // PX-1 — identity + entitlement for the authenticated sender surface.
      for (const m of [...migrationsOf('identity'), ...migrationsOf('entitlement')]) {
        await db.query(readFileSync(m, 'utf8'));
      }
      // Multi-Provider E-Sign §B — every Aramo Sign send is charged against the plan
      // allowance (AramoSignAllowanceGate), so the verifier carries the usage stream +
      // subscription schema; the sender tenant gets a DEVELOPMENT subscription below.
      for (const m of [...migrationsOf('metering'), ...migrationsOf('subscription')]) {
        await db.query(readFileSync(m, 'utf8'));
      }

      // PX-1 — a deterministic one-page US-Letter source PDF for the OWNED fixtures.
      const pdf = await PDFDocument.create({ updateMetadata: false });
      pdf.addPage([612, 792]);
      letterPdf = await pdf.save({ useObjectStreams: false });

      // PX-1 — a per-run RS256 keypair; JwtAuthGuard verifies against AUTH_PUBLIC_KEY.
      const kp = await generateKeyPair('RS256');
      const publicPem = await exportSPKI(kp.publicKey);

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        MAILER_PROVIDER: process.env['MAILER_PROVIDER'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        REDIS_URL: process.env['REDIS_URL'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';
      process.env['AUTH_AUDIENCE'] = AUTH_AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      // In-memory authorization scope cache (no Redis in the harness).
      delete process.env['REDIS_URL'];

      // The compact `sign` access token auth-service would mint for the sender:
      // NO scopes claim — effective scopes resolve server-side from the seeded RBAC.
      const now = Math.floor(Date.now() / 1000);
      senderJwt = await new SignJWT({
        sub: SENDER_USER_ID,
        actor_kind: 'user',
        consumer_type: 'sign',
        tenant_id: SENDER_TENANT_ID,
        authz_version: 1,
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(AUTH_ISSUER)
        .setAudience(AUTH_AUDIENCE)
        .setSubject(SENDER_USER_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + 15 * 60)
        .sign(kp.privateKey);
      billingOwnerJwt = await new SignJWT({ sub: GOV_USER_ID, actor_kind: 'user', consumer_type: 'sign', tenant_id: GOV_TENANT_ID, authz_version: 1 })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(AUTH_ISSUER)
        .setAudience(AUTH_AUDIENCE)
        .setSubject(GOV_USER_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + 15 * 60)
        .sign(kp.privateKey);

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DOCUMENT_STORAGE_PORT)
        .useValue(inMemoryStorage)
        .compile();
      app = module.createNestApplication<NestExpressApplication>();
      // Mirror apps/sign-service/src/main.ts: JSON body ceiling for base64 PDF
      // uploads, cookieParser (the sender console's session cookie), ValidationPipe.
      app.useBodyParser('json', { limit: '36mb' });
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
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

    it('verifies the aramo-core, sign-web and esign-web → sign-service pacts', async () => {
      const verifier = new Verifier({
        provider: 'sign-service',
        providerBaseUrl: `http://127.0.0.1:${port}`,
        pactUrls: [PACT_FILE, SIGN_WEB_PACT_FILE, ESIGN_WEB_PACT_FILE],
        // PX-1 — the esign-web consumer sends a PLACEHOLDER consumer-isolated
        // session cookie (`aramo_access_token_sign`); swap in the real RS256 token.
        // A request without that cookie (the 401 interaction, and every other
        // consumer's request) is forwarded untouched.
        requestFilter: (req, _res, next) => {
          const cookie = req.headers['cookie'];
          if (typeof cookie === 'string' && cookie.includes(`${SENDER_COOKIE_NAME}=${BILLING_OWNER_PLACEHOLDER}`)) {
            req.headers['cookie'] = `${SENDER_COOKIE_NAME}=${billingOwnerJwt}`;
          } else if (typeof cookie === 'string' && cookie.includes(`${SENDER_COOKIE_NAME}=`)) {
            req.headers['cookie'] = `${SENDER_COOKIE_NAME}=${senderJwt}`;
          }
          next();
        },
        stateHandlers: {
          // Addendum S6 — the ATS over the authenticated Sign API.
          'an ATS user grant is live': async () => {
            await seedAtsUserGrant();
          },
          'a completion event was delivered to the ATS': async () => {
            await seedAtsCompletion();
          },
          'an ATS event grant is live': async () => {
            await seedAtsCompletion();
            await db.query(
              `INSERT INTO "sign"."SignAccessToken" (id, token_hash, credential_id, installation_id, tenant_id, mode, subject_id, scopes, audience, expires_at, grant_kind, envelope_id, event_id)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, 'APPLICATION', $3, ARRAY['sign:envelope:read'], 'aramo-sign-api', now() + interval '1 day', 'EVENT_ARTIFACT', $5, $6)
               ON CONFLICT (token_hash) DO NOTHING`,
              [sha(ATS_EVENT_GRANT), ATS_CREDENTIAL_ID, ATS_INSTALLATION_ID, ATS_TENANT_ID, ATS_EXEC_ENVELOPE_ID, ATS_EVENT_ID],
            );
          },
          'no prior envelope for the request': async () => undefined,
          'a signature envelope exists': async () => {
            await seedEnvelope();
          },
          // DOC-4C seam B — the executed-artifact pull (aramo-core → sign-service).
          'an executed envelope exists': async () => {
            await seedExecutedEnvelope();
          },
          // DOC-4C seam A — the public signer-session ops (sign-web → sign-service).
          'a signer session is issued for the envelope': async () => {
            await seedSignerFixture({ envelopeId: EX_ENVELOPE_ID, envDocId: EX_ENV_DOC_ID, signerId: EX_SIGNER_ID, sessionId: EX_SESSION_ID, token: TOKEN_EXCHANGE });
          },
          'a signer session is open on a signable envelope': async () => {
            await seedSignerFixture({ envelopeId: T_ENVELOPE_ID, envDocId: T_ENV_DOC_ID, signerId: T_SIGNER_ID, sessionId: T_SESSION_ID, token: TOKEN_DISCLOSURE_TEXT });
          },
          'a signer has a signed-copy access link for a completed envelope': async () => {
            await seedSignedCopyGrant();
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
          // COMM-RECRUITER-W1 (W1-C) — reverse lookup + same-envelope reminder.
          'a non-terminal signature envelope exists for the document revision': async () => {
            await seedRtrEnvelope();
          },
          'a sent signature envelope with an incomplete signer exists': async () => {
            await seedRtrEnvelope();
          },
          // PX-1 — the authenticated sender console (esign-web → sign-service).
          'an esign sender session exists': async () => {
            await seedSender();
            return undefined;
          },
          'a sender-authored envelope exists': async (params?: unknown) => {
            await seedSenderEnvelope({ envelopeId: envelopeParam(params), status: 'DRAFT', document: true, recipient: true, signatureField: true });
            return undefined;
          },
          'a sender draft envelope exists': async (params?: unknown) => {
            await seedSenderEnvelope({ envelopeId: envelopeParam(params), status: 'DRAFT' });
            return undefined;
          },
          'a sender draft envelope with a document and a recipient exists': async (params?: unknown) => {
            await seedSenderEnvelope({ envelopeId: envelopeParam(params), status: 'DRAFT', document: true, recipient: true });
            return undefined;
          },
          'a sender draft envelope is ready to send': async (params?: unknown) => {
            await seedSenderEnvelope({ envelopeId: envelopeParam(params), status: 'DRAFT', document: true, recipient: true, signatureField: true });
            return undefined;
          },
          // CCP-A6 — Conversion Rule C-1 / C-4: checkout refused while a governed subscription is open.
          'a business tenant holds a governed Aramo-managed Sign subscription': {
            setup: async () => {
              await seedGovernedBillingOwner();
              for (const [k, v] of Object.entries(BILLING_ENV)) {
                billingEnvSaved[k] = process.env[k];
                process.env[k] = v;
              }
              return undefined;
            },
            teardown: async () => {
              for (const k of Object.keys(BILLING_ENV)) {
                const v = billingEnvSaved[k];
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
              }
              return undefined;
            },
          },
          // CCP-A6-R — Conversion Rule C-8: the tenant-facing pending state of a held activation.
          'a business tenant with a governed subscription has a held self-service activation': async () => {
            await seedGovernedBillingOwner();
            await db.query(
              `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref)
               SELECT $1::uuid, $2::uuid, $3, p.id, 'STRIPE', 'cs_pact_held' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-standard-business-v1'
               ON CONFLICT (id) DO NOTHING`,
              [GOV_INTENT_ID, GOV_TENANT_ID, GOV_USER_ID],
            );
            await db.query(
              `INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, intent_id, reason)
               VALUES (gen_random_uuid(), $1::uuid, 'STRIPE', 'sub_pact_held', $2::uuid, 'governed_subscription_open')
               ON CONFLICT ("provider", "subscription_ref", "reason") WHERE "resolved_at" IS NULL DO NOTHING`,
              [GOV_TENANT_ID, GOV_INTENT_ID],
            );
            return undefined;
          },
          'a sent sender envelope exists': async (params?: unknown) => {
            await seedSenderEnvelope({ envelopeId: envelopeParam(params), status: 'SENT', document: true, recipient: true, signatureField: true });
            return undefined;
          },
        },
      });
      await verifier.verifyProvider();
    }, 180_000);
  },
);
