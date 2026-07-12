import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TalentTrustService, type SubjectRef } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { DossierService } from '../talent-identity/dossier.service.js';

// TR-9 B1 (§5) — reference-attestation capture + honest accrual + the ring tell,
// against real Postgres. (a) capture e2e + dossier ride-along; (b) the shape
// refuses a rating (registry gate); (c) D3 both ways (one voice counted once via
// single_source_only); (d) D4 both ways (attester = talent identity → contra;
// external → silent); (e) idempotence; (g) HUMAN_ATTESTED's first producer.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql',
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
].map(M);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-tr9-b1-spec';
const TENANT = '01900000-0000-7000-8000-0000000000c1';
const ACTOR = '00000000-0000-7000-8000-00000000c001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-9 B1 — reference-attestation capture (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let privateKey: SignKey;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let dossier: DossierService;

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, scopes })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(privateKey);
    }
    async function post(path: string, jwt: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }
    const refFor = (recordId: string): SubjectRef => ({ tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: recordId });
    const codeOf = (b: Record<string, unknown>): string | undefined =>
      (b['error'] as Record<string, unknown> | undefined)?.['code'] as string | undefined;

    async function mkRecord(): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name) VALUES ($1::uuid,$2::uuid,'Ada','Lovelace')`,
        [id, TENANT],
      );
      return id;
    }
    const ref = (recordId: string, attesterEmail: string | undefined, statementClass = 'WORK'): Record<string, unknown> => ({
      attester: { name: 'Charles Babbage', ...(attesterEmail ? { email: attesterEmail } : {}), company: 'Analytical Engines' },
      relationship: 'former manager',
      statement_class: statementClass,
      statement: 'Led the engine team ably.',
    });
    async function claimsBand(recordId: string): Promise<string | undefined> {
      return (await trust.getTrustState(refFor(recordId)))?.claims_band;
    }
    async function singleSourceOnly(recordId: string): Promise<boolean | undefined> {
      return (await trust.getTrustState(refFor(recordId)))?.single_source_only;
    }
    async function statusOf(evidenceId: string): Promise<string> {
      const r = await db.query<{ current_status: string }>(
        `SELECT current_status FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`, [evidenceId]);
      return r.rows[0]!.current_status;
    }
    async function evidenceRow(evidenceId: string): Promise<{ source_class: string; method: string; assertion_type: string; dimension: string }> {
      const r = await db.query(`SELECT source_class, method, assertion_type, dimension FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`, [evidenceId]);
      return r.rows[0] as never;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid,'TR9B1',now()) ON CONFLICT DO NOTHING`, [TENANT]);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'ats') ON CONFLICT DO NOTHING`, [TENANT]);

      const kp = await generateKeyPair('RS256');
      privateKey = kp.privateKey as SignKey;
      for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'MAILER_PROVIDER'] as const) savedEnv[k] = process.env[k];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey as never);
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
      trust = module.get(TalentTrustService);
      dossier = module.get(DossierService);
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    beforeEach(async () => {
      for (const t of ['EvidenceLink', 'EvidenceEvent', 'EvidenceRecord', 'TrustState', 'SubjectAnchor', 'ResolutionSubjectRef', 'ResolutionSubject']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
      await db.query(`DELETE FROM talent_record."TalentRecord" WHERE tenant_id = $1::uuid`, [TENANT]);
    });

    const RA = (id: string): string => `/v1/talent-records/${id}/reference-attestations`;

    // ---- (a) capture e2e + fixed class/method + dossier ride-along ----------
    it('(a) a recorded reference lands as ATTESTATION (THIRD_PARTY_UNVERIFIED + HUMAN_ATTESTED), rides the dossier timeline, moves CLAIMS honestly', async () => {
      const rec = await mkRecord();
      const jwt = await signJwt(['talent:edit']);
      const r = await post(RA(rec), jwt, ref(rec, 'babbage@ext.example'));
      expect(r.status).toBe(201);
      expect(r.body['recorded']).toBe(true);
      const eid = r.body['evidence_id'] as string;

      const row = await evidenceRow(eid);
      expect(row.assertion_type).toBe('ATTESTATION');
      expect(row.source_class).toBe('THIRD_PARTY_UNVERIFIED'); // the honest floor
      expect(row.method).toBe('HUMAN_ATTESTED'); // the reserved hook's first producer
      expect(row.dimension).toBe('CLAIMS'); // WORK → CLAIMS

      // Honest accrual: an unverified reference reaches only SELF_ASSERTED.
      expect(await claimsBand(rec)).toBe('SELF_ASSERTED');

      // Dossier ride-along (zero renderer change): the CREATED event is in the timeline.
      const page = await dossier.getDossierEvidence(TENANT, rec, { limit: 50 });
      const item = page.items.find((i) => i.evidence !== undefined && i.event.event_type === 'CREATED');
      expect(item).toBeDefined();
    });

    // ---- (b) the shape refuses a rating structurally + the registry gate ------
    it('(b) a rating field is refused at the wire (400); a malformed payload refuses via the registry gate (422)', async () => {
      const rec = await mkRecord();
      const jwt = await signJwt(['talent:edit']);
      // A rating field → forbidNonWhitelisted strips it → 400 (the wire has no such field).
      const withRating = await post(RA(rec), jwt, { ...ref(rec, undefined), rating: 5 });
      expect(withRating.status).toBe(400);
      // The registry gate (CLAIM_SHAPE_INVALID) — reached directly with a payload
      // the DTO would not admit but the shape must still refuse defensively.
      await expect(
        trust.recordReferenceAttestationIfAbsent({
          subjectRef: refFor(rec),
          dimension: 'CLAIMS',
          assertion_payload: { attester: {} }, // missing required name/relationship/statement
        }),
      ).rejects.toMatchObject({ code: 'CLAIM_SHAPE_INVALID' });
    });

    // ---- (c) D3 both ways: one voice counted once --------------------------
    it('(c) five references from ONE attester = one independence group (single_source_only stays true); a distinct attester = a second group', async () => {
      const rec = await mkRecord();
      const jwt = await signJwt(['talent:edit']);
      // Five DISTINCT references (different statements) from the SAME attester email.
      for (let i = 0; i < 5; i++) {
        const r = await post(RA(rec), jwt, {
          ...ref(rec, 'babbage@ext.example'),
          statement: `Observation number ${i}.`,
        });
        expect(r.status).toBe(201);
      }
      expect(await claimsBand(rec)).toBe('SELF_ASSERTED'); // unverified — never elevates
      expect(await singleSourceOnly(rec)).toBe(true); // ONE voice, not five

      // A reference from a genuinely DISTINCT attester → a second independence group.
      const r2 = await post(RA(rec), jwt, {
        attester: { name: 'Grace Hopper', email: 'grace@other.example' },
        relationship: 'colleague', statement_class: 'WORK', statement: 'Also excellent.',
      });
      expect(r2.status).toBe(201);
      expect(await singleSourceOnly(rec)).toBe(false); // two independent voices
    });

    // ---- (d) D4 both ways: the ring's cheapest tell ------------------------
    it('(d) an attester email that IS the talent identity → contradicted (ATTESTER_IDENTITY_OVERLAP); an external email → silent', async () => {
      const rec = await mkRecord();
      const jwt = await signJwt(['talent:edit']);
      // The talent's OWN verified-ish email anchor (a real subject anchor value).
      await trust.recordAnchor({
        tenant_id: TENANT, talent_record_id: rec, anchor_kind: 'EMAIL',
        normalized_value: 'ada@self.example', raw_source: 'Ada@Self.example', created_by: 'test',
      });
      // A "referee" who is the talent's own identity — the fabricated network's cheapest move.
      const bad = await post(RA(rec), jwt, ref(rec, 'ada@self.example'));
      // A genuine external referee — no anchor match.
      const good = await post(RA(rec), jwt, { ...ref(rec, 'external@ref.example'), statement: 'External voice.' });
      // A referee with no email — silent (no anchor to match).
      const silent = await post(RA(rec), jwt, ref(rec, undefined));
      const badId = bad.body['evidence_id'] as string;
      const goodId = good.body['evidence_id'] as string;
      const silentId = silent.body['evidence_id'] as string;

      const subjectId = (await trust.resolveSubjectRef(refFor(rec)))!.id;
      await trust.runConsistencyForSubject(TENANT, subjectId);

      expect(await statusOf(badId)).toBe('CONTRADICTED'); // the tell fires
      expect(await statusOf(goodId)).toBe('VALID'); // external referee untouched
      expect(await statusOf(silentId)).toBe('VALID'); // absent email → silent
    });

    // ---- (e) idempotence ----------------------------------------------------
    it('(e) the same reference recorded twice is one row', async () => {
      const rec = await mkRecord();
      const jwt = await signJwt(['talent:edit']);
      const first = await post(RA(rec), jwt, ref(rec, 'babbage@ext.example'));
      const second = await post(RA(rec), jwt, ref(rec, 'babbage@ext.example'));
      expect(first.body['recorded']).toBe(true);
      expect(second.body['recorded']).toBe(false);
      expect(second.body['evidence_id']).toBe(first.body['evidence_id']);
      const n = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM talent_trust."EvidenceRecord" WHERE assertion_type = 'ATTESTATION'`);
      expect(Number(n.rows[0]!.n)).toBe(1);
    });

    // ---- (g)/gate: the scope + record guards -------------------------------
    it('(gate) refuses without talent:edit (403) and 404s a missing record', async () => {
      const rec = await mkRecord();
      const noScope = await signJwt(['talent:read']);
      expect((await post(RA(rec), noScope, ref(rec, undefined))).status).toBe(403);
      const jwt = await signJwt(['talent:edit']);
      expect((await post(RA(uuidv7()), jwt, ref(uuidv7(), undefined))).status).toBe(404);
    });
  },
);
