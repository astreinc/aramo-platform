import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, TALENT_EVIDENCE_LATE_COLUMN_MIGRATIONS, resolveEntitlementMigrations } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { v7 as uuidv7 } from 'uuid';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';
import { CanonicalizationService } from '@aramo/canonicalization';
import { TALENT_EVENT_CREATED, TalentRecordRepository } from '@aramo/talent-record';

import { AppModule } from '../app.module.js';
import { DuplicateDetectionTalentEventHandler } from '../ats-talent-events/duplicate-detection.handler.js';
import { DuplicateDetectionService } from '../talent-identity/duplicate-detection.service.js';
import { PromotionService } from '../talent-identity/promotion.service.js';
import { SourcingService } from '../talent-identity/sourcing.service.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';

// ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3) — ATS-local identity, end-to-end on
// real Postgres 17: canonicalize → sourced_talent (idempotent per external id),
// the sourcing pool + drill-in, promotion (tenant dedupe 409 + the ATS advisory
// gate + talent.created in the create transaction), the duplicate detector
// (shared email / phone, never cross-tenant), and the advisory approve / dismiss /
// reverse lifecycle with the record re-home — none of it touching a trust,
// identity-index or platform-trust schema (none is even migrated here).

const __authzTestResolver = new ConfigurableTestResolver();
type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql',
  'libs/identity/prisma/migrations/20261015000002_ic4_tenant_kind/migration.sql',
  ...resolveEntitlementMigrations(ROOT),
].map(M)
  .concat(migrationsFor('ingestion'))
  .concat(migrationsFor('canonicalization'))
  .concat(migrationsFor('sourced-talent'))
  .concat(migrationsFor('talent-record'))
  .concat(migrationsFor('consent'))
  .concat(
    [
      // operational-holder schemas (the re-home sweeps; raw SQL over base cols).
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
      'libs/pipeline/prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
      'libs/pipeline/prisma/migrations/20260925120000_pipeline_void_add_enum_value/migration.sql',
      'libs/pipeline/prisma/migrations/20260925120100_pipeline_void_live_index_recreate/migration.sql',
      'libs/selection/prisma/migrations/20260525120000_init_selection_model/migration.sql',
      'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql',
      'libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
      'libs/submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
      'libs/evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql',
      'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
      'libs/documents/prisma/migrations/20260921180000_init_documents_model/migration.sql',
      'libs/documents/prisma/migrations/20260922130000_doc2_templates_rendering_requirements/migration.sql',
      'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
      'libs/talent-evidence/prisma/migrations/20260922120000_doc1b_talentdocument_reconciliation/migration.sql',
      'libs/talent-evidence/prisma/migrations/20260714120000_tr7_b1_education_certification/migration.sql',
      'libs/talent-evidence/prisma/migrations/20260915120000_hf1_resume_provenance/migration.sql',
      'libs/talent-evidence/prisma/migrations/20260915170000_hf2_experience_intelligence/migration.sql',
      'libs/talent-evidence/prisma/migrations/20260915180000_skill_tax_1g_canonical_reconciliation/migration.sql',
      ...TALENT_EVIDENCE_LATE_COLUMN_MIGRATIONS,
      'libs/saved-list/prisma/migrations/20260602120000_init_saved_list_model/migration.sql',
      'libs/attachment/prisma/migrations/20260602120000_init_attachment_model/migration.sql',
      'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
      'libs/activity/prisma/migrations/20260921160000_rn1_activity_note_extension/migration.sql',
      'libs/task/prisma/migrations/20260609140000_init_task_model/migration.sql',
      'libs/technical-screening/prisma/migrations/20261016120000_inc3_technical_screening_init/migration.sql',
      'libs/technical-screening/prisma/migrations/20261016130000_inc3_a1_ai_assisted_screening/migration.sql',
      'libs/examination/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
      'libs/submittal/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
      'libs/submittal/prisma/migrations/20260812120000_t2p1_relocate_submittal_to_submittal_schema/migration.sql',
      'libs/submittal/prisma/migrations/20260822130000_l8b1_submittal_pipeline_link/migration.sql',
      'libs/submittal/prisma/migrations/20260920130000_talent_intel_1d_d_submittal_resume_edition/migration.sql',
      'libs/submittal/prisma/migrations/20261002120000_sw2_submitted_to_client_provenance/migration.sql',
      'libs/evidence/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
    ].map(M),
  );

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ati-sep-1-wp2-spec';
const ALG = 'RS256';
const TENANT_A = '01900000-0000-7000-8000-00000000a2a1';
const TENANT_B = '01900000-0000-7000-8000-00000000a2b2';
const ADMIN = '00000000-0000-7000-8000-00000000a201';
const RESOLVE = 'identity:resolve';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATI-SEP-1 T10 WP2 — ATS-local sourcing, promotion + duplicate advisories (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let app: INestApplication;
    let port = 0;
    let db: Client;
    let privateKey: SignKey;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let canonicalization: CanonicalizationService;
    let sourcing: SourcingService;
    let promotion: PromotionService;
    let detection: DuplicateDetectionService;
    let handler: DuplicateDetectionTalentEventHandler;
    let records: TalentRecordRepository;

    async function signJwt(scopes: string[], tenant = TENANT_A): Promise<string> {
      return new SignJWT({
        sub: ADMIN,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        authz_version: __authzTestResolver.grant(tenant, ADMIN, scopes),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    async function post(path: string, jwt: string, body: unknown): Promise<{ status: number; body: any }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    async function get(path: string, jwt: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    // ---- seed helpers --------------------------------------------------------------

    async function mkPayload(
      tenant: string,
      over: { source?: string; profile_url?: string | null; email?: string | null; name?: string | null } = {},
    ): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO ingestion."RawPayloadReference"
           (id, tenant_id, source, source_class, storage_ref, sha256, content_type, captured_at,
            declared_name, verified_email, profile_url, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'THIRD_PARTY_UNVERIFIED', $4, $5, 'application/json',
                 CURRENT_TIMESTAMP, $6, $7, $8, CURRENT_TIMESTAMP)`,
        [
          id,
          tenant,
          over.source ?? 'indeed',
          `${tenant}/ingestion/${id}.json`,
          `sha-${id}`,
          over.name === undefined ? 'Ada Lovelace' : over.name,
          over.email === undefined ? null : over.email,
          over.profile_url === undefined ? null : over.profile_url,
        ],
      );
      return id;
    }

    // A channel-writer arrival (Indeed-apply shape) for an ingestion payload.
    async function mkArrival(
      tenant: string,
      payloadId: string,
      a: { name: string; email: string | null; phone: string | null },
    ): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO sourced_talent."SourcedTalent"
           (id, tenant_id, source_channel, external_source_id, normalized_email, normalized_phone,
            provenance, legal_basis, arrived_at)
         VALUES ($1::uuid, $2::uuid, 'INDEED', $3, $4, $5, $6::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [
          id,
          tenant,
          `apply-${id}`,
          a.email,
          a.phone === null ? null : a.phone.replace(/\D+/g, ''),
          JSON.stringify({
            ingestion_payload_id: payloadId,
            applicant: { full_name: a.name, email: a.email, phone: a.phone },
          }),
        ],
      );
      return id;
    }

    async function mkRecord(
      tenant: string,
      r: { first: string; last: string; email: string; phone: string },
    ): Promise<string> {
      const created = await records.create({
        tenant_id: tenant,
        entered_by_id: ADMIN,
        input: { first_name: r.first, last_name: r.last, email1: r.email, phone_cell: r.phone },
        requestId: 'wp2-seed',
      });
      return created.id;
    }

    async function advisoriesFor(tenant: string): Promise<Array<Record<string, any>>> {
      const r = await db.query(
        `SELECT * FROM talent_record.talent_duplicate_advisory WHERE tenant_id = $1::uuid ORDER BY created_at, id`,
        [tenant],
      );
      return r.rows;
    }

    async function recordStatus(id: string): Promise<string> {
      const r = await db.query(`SELECT record_status FROM talent_record."TalentRecord" WHERE id = $1::uuid`, [id]);
      return r.rows[0].record_status as string;
    }

    async function mkSelection(recordId: string, tenant: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO selection."TalentSelection" (id, tenant_id, talent_id, requisition_id, state, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'surfaced', CURRENT_TIMESTAMP)`,
        [id, tenant, recordId, uuidv7()],
      );
      return id;
    }

    async function selectionRecordOf(id: string): Promise<string> {
      const r = await db.query(`SELECT talent_id FROM selection."TalentSelection" WHERE id = $1::uuid`, [id]);
      return r.rows[0].talent_id as string;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      for (const id of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at)
           VALUES ($1::uuid, 'WP2 Tenant', CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
          [id],
        );
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [id],
        );
      }

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      privateKey = kp.privateKey as SignKey;
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;

      canonicalization = module.get(CanonicalizationService);
      sourcing = module.get(SourcingService);
      promotion = module.get(PromotionService);
      detection = module.get(DuplicateDetectionService);
      handler = new DuplicateDetectionTalentEventHandler(detection);
      records = module.get(TalentRecordRepository);
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // ---- canonicalize → SourcedTalent -------------------------------------------------

    it('canonicalize resolves a payload to ONE SourcedTalent, idempotently per external id; no legacy ids', async () => {
      const p1 = await mkPayload(TENANT_A, { profile_url: 'https://github.com/ada', email: 'ADA@x.com', source: 'github' });
      const r1 = await canonicalization.canonicalize({
        payload_id: p1, source_channel: 'import', authContext: { tenant_id: TENANT_A }, requestId: 'c1',
      });
      expect(r1.already_canonicalized).toBe(false);
      expect(r1.resolution_method).toBe('new_identity');
      const again = await canonicalization.canonicalize({
        payload_id: p1, source_channel: 'import', authContext: { tenant_id: TENANT_A }, requestId: 'c2',
      });
      expect(again.already_canonicalized).toBe(true);
      expect(again.sourced_talent_id).toBe(r1.sourced_talent_id);

      // A second payload for the SAME channel profile resolves to the SAME arrival.
      const p2 = await mkPayload(TENANT_A, { profile_url: 'https://github.com/ada', source: 'github' });
      const r2 = await canonicalization.canonicalize({
        payload_id: p2, source_channel: 'import', authContext: { tenant_id: TENANT_A }, requestId: 'c3',
      });
      expect(r2.sourced_talent_id).toBe(r1.sourced_talent_id);
      expect(r2.resolution_method).toBe('confirmed_anchor_match');

      const row = await db.query(
        `SELECT source_channel, external_source_id, normalized_email FROM sourced_talent."SourcedTalent" WHERE id = $1::uuid`,
        [r1.sourced_talent_id],
      );
      expect(row.rows[0]).toEqual({
        source_channel: 'GITHUB',
        external_source_id: 'https://github.com/ada',
        normalized_email: 'ada@x.com',
      });
      const pr = await db.query(
        `SELECT sourced_talent_id, resolved_subject_id, resolved_cluster_id FROM ingestion."RawPayloadReference" WHERE id = ANY($1::uuid[])`,
        [[p1, p2]],
      );
      for (const r of pr.rows) {
        expect(r.sourced_talent_id).toBe(r1.sourced_talent_id);
        expect(r.resolved_subject_id).toBeNull();
        expect(r.resolved_cluster_id).toBeNull();
      }
      // The outbox event carries the arrival id (one per first canonicalize).
      const ev = await db.query(
        `SELECT event_payload FROM canonicalization."OutboxEvent" WHERE event_payload->>'payload_id' = $1`,
        [p1],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0].event_payload.sourced_talent_id).toBe(r1.sourced_talent_id);
    });

    it('canonicalize reuses the arrival a channel writer already recorded for the payload', async () => {
      const p = await mkPayload(TENANT_A);
      const arrival = await mkArrival(TENANT_A, p, { name: 'Reuse Me', email: 'reuse@x.com', phone: null });
      const r = await canonicalization.canonicalize({
        payload_id: p, source_channel: 'import', authContext: { tenant_id: TENANT_A }, requestId: 'c4',
      });
      expect(r.sourced_talent_id).toBe(arrival);
    });

    // ---- pool + drill-in --------------------------------------------------------------------

    it('the pool lists un-linked arrivals (ATS data only); drill-in is tenant-walled', async () => {
      const p = await mkPayload(TENANT_A);
      const arrival = await mkArrival(TENANT_A, p, { name: 'Pool Person', email: 'pool@x.com', phone: '(415) 555-0101' });
      const page = await sourcing.getPool(TENANT_A, { limit: 200 });
      const item = page.items.find((i) => i.subject_id === arrival);
      expect(item).toMatchObject({
        display_name: 'Pool Person',
        email: 'pool@x.com',
        phone: '(415) 555-0101',
        source_channel: 'INDEED',
        open_advisory_count: 0,
      });
      expect(item).not.toHaveProperty('trust_bands');

      const detail = await sourcing.getSubjectDetail(TENANT_A, arrival);
      expect(detail.refs.find((r) => r.ref_type === 'SOURCED_TALENT')?.ref_id).toBe(arrival);
      expect(detail.open_identity_advisories).toEqual([]);
      await expect(sourcing.getSubjectDetail(TENANT_B, arrival)).rejects.toThrow(/not found/);

      // Over HTTP the route param is the SourcedTalent id.
      const res = await get(`/v1/sourcing/pool/${arrival}`, await signJwt(['talent:source']));
      expect(res.status).toBe(200);
      expect(res.body.subject_id).toBe(arrival);
    });

    // ---- promotion ----------------------------------------------------------------------------

    it('promotion mints the record + PROMOTED link + talent.created in-txn; replay is already_promoted; the arrival leaves the pool', async () => {
      const p = await mkPayload(TENANT_A);
      const arrival = await mkArrival(TENANT_A, p, {
        name: 'Grace Brewster Hopper', email: 'grace@x.com', phone: '415-555-0102',
      });
      const out = await promotion.promoteArrival({ tenant_id: TENANT_A, sourced_talent_id: arrival });
      expect(out.status).toBe('promoted');
      const recordId = (out as { talent_record_id: string }).talent_record_id;

      const rec = await db.query(
        `SELECT first_name, last_name, email1, tenant_status, cluster_id FROM talent_record."TalentRecord" WHERE id = $1::uuid`,
        [recordId],
      );
      expect(rec.rows[0]).toMatchObject({
        first_name: 'Grace', last_name: 'Brewster Hopper', email1: 'grace@x.com', tenant_status: 'sourced', cluster_id: null,
      });
      const ev = await db.query(
        `SELECT event_type FROM talent_record."TalentEventOutbox" WHERE tenant_id = $1::uuid AND event_payload->>'talent_record_id' = $2`,
        [TENANT_A, recordId],
      );
      expect(ev.rows.map((r) => r.event_type)).toContain(TALENT_EVENT_CREATED);
      const link = await db.query(
        `SELECT link_kind, talent_record_id FROM talent_record.talent_record_sourced_arrival WHERE sourced_talent_id = $1::uuid`,
        [arrival],
      );
      expect(link.rows[0]).toEqual({ link_kind: 'PROMOTED', talent_record_id: recordId });
      const consent = await db.query(
        `SELECT count(*)::int AS n FROM consent."TalentConsentEvent" WHERE talent_record_id = $1::uuid`,
        [recordId],
      );
      expect(consent.rows[0].n).toBeGreaterThan(0);

      const replay = await promotion.promoteArrival({ tenant_id: TENANT_A, sourced_talent_id: arrival });
      expect(replay).toEqual({ status: 'already_promoted', talent_record_id: recordId });
      const page = await sourcing.getPool(TENANT_A, { limit: 200 });
      expect(page.items.some((i) => i.subject_id === arrival)).toBe(false);
    });

    it('promotion defers without a two-part name / without both contact anchors / for another tenant', async () => {
      const p = await mkPayload(TENANT_A);
      const mono = await mkArrival(TENANT_A, p, { name: 'Cher', email: 'cher@x.com', phone: '4155550103' });
      expect((await promotion.promoteArrival({ tenant_id: TENANT_A, sourced_talent_id: mono })).status).toBe('deferred_no_name');
      const noPhone = await mkArrival(TENANT_A, p, { name: 'No Phone', email: 'nophone@x.com', phone: null });
      expect((await promotion.promoteArrival({ tenant_id: TENANT_A, sourced_talent_id: noPhone })).status).toBe(
        'deferred_incomplete_contact',
      );
      expect((await promotion.promoteArrival({ tenant_id: TENANT_B, sourced_talent_id: noPhone })).status).toBe(
        'deferred_unknown_subject',
      );
    });

    it('a tenant duplicate refuses 409 (Add Talent parity), raises a SOURCED_ARRIVAL advisory, which then gates promotion', async () => {
      const existing = await mkRecord(TENANT_A, { first: 'Dup', last: 'Existing', email: 'dup@x.com', phone: '4155550104' });
      const p = await mkPayload(TENANT_A);
      const arrival = await mkArrival(TENANT_A, p, { name: 'Dup Arrival', email: 'dup@x.com', phone: '4155559999' });

      await expect(promotion.promoteArrival({ tenant_id: TENANT_A, sourced_talent_id: arrival })).rejects.toMatchObject({
        code: 'TALENT_RECORD_DUPLICATE',
        statusCode: 409,
      });
      const adv = (await advisoriesFor(TENANT_A)).filter((a) => a.sourced_talent_id === arrival);
      expect(adv).toHaveLength(1);
      expect(adv[0]).toMatchObject({
        talent_record_a_id: existing, basis: 'SOURCED_ARRIVAL', status: 'PENDING_REVIEW', shared_kinds: ['EMAIL'],
      });
      expect((await promotion.promoteArrival({ tenant_id: TENANT_A, sourced_talent_id: arrival })).status).toBe(
        'deferred_unresolved_identity',
      );

      // HTTP: the pipeline trigger returns the same deferral (200); approve links it.
      const detail = await sourcing.getSubjectDetail(TENANT_A, arrival);
      expect(detail.open_identity_advisories[0]).toMatchObject({
        talent_record_id: existing, talent_record_name: 'Dup Existing', shared_kinds: ['EMAIL'],
      });
      const ok = await post(`/v1/talent/identity/advisories/${adv[0]!.id}/approve`, await signJwt([RESOLVE]), {});
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('APPROVED');
      expect(await promotion.promoteArrival({ tenant_id: TENANT_A, sourced_talent_id: arrival })).toEqual({
        status: 'already_promoted',
        talent_record_id: existing,
      });

      // Reverse → the link is removed (the arrival is back in the pool).
      const rev = await post(`/v1/talent/identity/advisories/${adv[0]!.id}/reverse`, await signJwt([RESOLVE]), {
        justification: 'not the same person',
      });
      expect(rev.status).toBe(200);
      expect(rev.body.status).toBe('REVERSED');
      const link = await db.query(
        `SELECT count(*)::int AS n FROM talent_record.talent_record_sourced_arrival WHERE sourced_talent_id = $1::uuid`,
        [arrival],
      );
      expect(link.rows[0].n).toBe(0);
    });

    // ---- detector ------------------------------------------------------------------------------

    it('the detector raises PENDING pair advisories for a shared email / phone — never cross-tenant; idempotent', async () => {
      const a = await mkRecord(TENANT_A, { first: 'Pat', last: 'One', email: 'pat@x.com', phone: '4155550110' });
      const b = await mkRecord(TENANT_A, { first: 'Pat', last: 'Two', email: 'PAT@x.com', phone: '(415) 555-0110' });
      const other = await mkRecord(TENANT_B, { first: 'Pat', last: 'Elsewhere', email: 'pat@x.com', phone: '4155550110' });
      const unrelated = await mkRecord(TENANT_A, { first: 'Sam', last: 'Else', email: 'sam@x.com', phone: '4155550111' });

      await handler.handle({
        event_id: uuidv7(), event_type: TALENT_EVENT_CREATED, event_version: 'v1', tenant_id: TENANT_A,
        source: 'talent-record', subject_type: 'talent_record', subject_id: b,
        occurred_at: new Date().toISOString(), correlation_id: 'x', causation_id: null,
        payload: { talent_record_id: b },
      } as never);
      // Re-delivery is harmless.
      await detection.detectForRecord(TENANT_A, b);

      const [lo, hi] = a < b ? [a, b] : [b, a];
      const pairs = (await advisoriesFor(TENANT_A)).filter(
        (x) => x.talent_record_b_id !== null && [a, b].includes(x.talent_record_a_id),
      );
      expect(pairs).toHaveLength(1);
      expect(pairs[0]).toMatchObject({
        talent_record_a_id: lo, talent_record_b_id: hi, basis: 'EMAIL', status: 'PENDING_REVIEW',
      });
      expect([...pairs[0]!.shared_kinds].sort()).toEqual(['EMAIL', 'PHONE']);
      // Never cross-tenant, never unrelated.
      expect(await advisoriesFor(TENANT_B)).toEqual([]);
      const all = await advisoriesFor(TENANT_A);
      expect(all.some((x) => [x.talent_record_a_id, x.talent_record_b_id].includes(other))).toBe(false);
      expect(all.some((x) => [x.talent_record_a_id, x.talent_record_b_id].includes(unrelated))).toBe(false);
    });

    // ---- advisory lifecycle + re-home ---------------------------------------------------------

    it('approve re-homes onto the survivor (holder re-pointed, other record superseded); reverse restores; 403/409/404 gates', async () => {
      const r1 = await mkRecord(TENANT_A, { first: 'Lee', last: 'One', email: 'lee@x.com', phone: '4155550120' });
      const r2 = await mkRecord(TENANT_A, { first: 'Lee', last: 'Two', email: 'lee@x.com', phone: '4155550121' });
      await detection.detectForRecord(TENANT_A, r2);
      const adv = (await advisoriesFor(TENANT_A)).find(
        (x) => x.talent_record_b_id !== null && [r1, r2].includes(x.talent_record_a_id),
      )!;
      const [survivor, loser] = [adv.talent_record_a_id as string, adv.talent_record_b_id as string];
      const sel = await mkSelection(loser, TENANT_A);

      // The worklist (privileged) lists it with names + kinds.
      const list = await get('/v1/talent/identity/advisories', await signJwt([RESOLVE]));
      expect(list.status).toBe(200);
      const listed = list.body.items.find((i: { id: string }) => i.id === adv.id);
      expect(listed).toMatchObject({ basis: 'EMAIL', shared_anchor_kinds: ['EMAIL'] });
      expect(listed.talent_record_a_name).toMatch(/^Lee /);

      // Without identity:resolve → 403, untouched.
      expect((await post(`/v1/talent/identity/advisories/${adv.id}/approve`, await signJwt([]), {})).status).toBe(403);
      // Another tenant cannot see it → 404.
      expect(
        (await post(`/v1/talent/identity/advisories/${adv.id}/approve`, await signJwt([RESOLVE], TENANT_B), {})).status,
      ).toBe(404);

      const ok = await post(`/v1/talent/identity/advisories/${adv.id}/approve`, await signJwt([RESOLVE]), {});
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        status: 'APPROVED', surviving_record_id: survivor, superseded_record_id: loser, decided_by: ADMIN,
      });
      expect(ok.body.merge_completed_at).not.toBeNull();
      expect(await recordStatus(loser)).toBe('superseded');
      expect(await recordStatus(survivor)).toBe('live');
      expect(await selectionRecordOf(sel)).toBe(survivor);

      // Already resolved → 409.
      const again = await post(`/v1/talent/identity/advisories/${adv.id}/approve`, await signJwt([RESOLVE]), {});
      expect(again.status).toBe(409);
      // Reverse needs a justification.
      expect(
        (await post(`/v1/talent/identity/advisories/${adv.id}/reverse`, await signJwt([RESOLVE]), {})).status,
      ).toBe(400);
      const rev = await post(`/v1/talent/identity/advisories/${adv.id}/reverse`, await signJwt([RESOLVE]), {
        justification: 'different people',
      });
      expect(rev.status).toBe(200);
      expect(rev.body.status).toBe('REVERSED');
      expect(await recordStatus(loser)).toBe('live');
      expect(await selectionRecordOf(sel)).toBe(loser);
    });

    it('dismiss → DISMISSED, no re-home; a dismissed pair is not re-raised; reverse of a non-approved advisory → 409', async () => {
      const r1 = await mkRecord(TENANT_A, { first: 'Kim', last: 'One', email: 'kim@x.com', phone: '4155550130' });
      const r2 = await mkRecord(TENANT_A, { first: 'Kim', last: 'Two', email: 'kim@x.com', phone: '4155550131' });
      await detection.detectForRecord(TENANT_A, r1);
      const adv = (await advisoriesFor(TENANT_A)).find(
        (x) => x.talent_record_b_id !== null && [r1, r2].includes(x.talent_record_a_id),
      )!;
      const res = await post(`/v1/talent/identity/advisories/${adv.id}/dismiss`, await signJwt([RESOLVE]), {
        justification: 'siblings',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('DISMISSED');
      expect(await recordStatus(r1)).toBe('live');
      expect(await recordStatus(r2)).toBe('live');
      await detection.detectForRecord(TENANT_A, r2);
      const after = (await advisoriesFor(TENANT_A)).filter(
        (x) => x.talent_record_b_id !== null && [r1, r2].includes(x.talent_record_a_id),
      );
      expect(after).toHaveLength(1);
      expect(after[0]!.status).toBe('DISMISSED');
      expect(
        (await post(`/v1/talent/identity/advisories/${adv.id}/reverse`, await signJwt([RESOLVE]), { justification: 'x' }))
          .status,
      ).toBe(409);
    });
  },
);
