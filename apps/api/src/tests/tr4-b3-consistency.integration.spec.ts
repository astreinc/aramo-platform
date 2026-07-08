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
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TalentTrustService } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { ConsistencyService } from '../talent-identity/consistency.service.js';

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
].map(M);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-tr4-b3-spec';
const TENANT = '01900000-0000-7000-8000-0000000000a1';
const ADMIN = '00000000-0000-7000-8000-00000000a001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-4 B3 — consistency detectors + resolve API (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let privateKey: SignKey;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let consistency: ConsistencyService;

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({ sub: ADMIN, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, scopes })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }
    async function post(path: string, jwt: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }

    // Seed an EMPLOYMENT CLAIMS record via the gate (canonicalizes employer_norm +
    // ISO dates). Distinct source_ref = independent source.
    async function seedEmployment(args: {
      talentId: string;
      employer: string;
      start: string | null;
      end: string | null;
      srcId: string;
      sourceClass?: 'SELF' | 'THIRD_PARTY_UNVERIFIED';
    }): Promise<string> {
      const ev = await trust.recordEvidence({
        subjectRef: { tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: args.talentId },
        dimension: 'CLAIMS',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: {
          employer_raw: args.employer,
          role_title_raw: 'Engineer',
          ...(args.start !== null ? { start_date_raw: args.start } : {}),
          ...(args.end !== null ? { end_date_raw: args.end } : {}),
        },
        source_class: args.sourceClass ?? 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: { talent_evidence_id: args.srcId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'test',
      });
      return ev.id;
    }

    async function subjectIdFor(talentId: string): Promise<string> {
      const s = await trust.resolveSubjectRef({ tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: talentId });
      return s!.id;
    }
    async function statusOf(evidenceId: string): Promise<string> {
      const r = await db.query<{ current_status: string }>(
        `SELECT current_status FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`,
        [evidenceId],
      );
      return r.rows[0]!.current_status;
    }
    async function linkCount(): Promise<number> {
      const r = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM talent_trust."EvidenceLink"`);
      return Number(r.rows[0]!.n);
    }
    async function gapRows(subjectId: string): Promise<Array<{ id: string; current_status: string }>> {
      const r = await db.query<{ id: string; current_status: string }>(
        `SELECT id, current_status FROM talent_trust."EvidenceRecord"
         WHERE subject_id = $1::uuid AND assertion_type = 'TIMELINE_GAP'`,
        [subjectId],
      );
      return r.rows;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR4B3', now()) ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`,
        [TENANT],
      );

      const kp = await generateKeyPair('RS256');
      const publicPem = await exportSPKI(kp.publicKey as never);
      privateKey = kp.privateKey as SignKey;
      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
      trust = module.get(TalentTrustService);
      consistency = module.get(ConsistencyService);
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

    beforeEach(async () => {
      for (const t of ['EvidenceLink', 'EvidenceEvent', 'EvidenceRecord', 'TrustState', 'ResolutionSubjectRef', 'ResolutionSubject']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (a) impossible range — linkless, null-silent -----------------------

    it('(a) impossible range: contradicts the record LINKLESS; a valid range stays silent', async () => {
      const talent = uuidv7();
      const bad = await seedEmployment({ talentId: talent, employer: 'acme', start: '2020-06-01', end: '2020-01-01', srcId: 's1' });
      const good = await seedEmployment({ talentId: talent, employer: 'globex', start: '2019-01-01', end: '2019-06-01', srcId: 's2' });
      const sid = await subjectIdFor(talent);

      await trust.runConsistencyForSubject(TENANT, sid);

      expect(await statusOf(bad)).toBe('CONTRADICTED');
      expect(await statusOf(good)).toBe('VALID'); // silent
      expect(await linkCount()).toBe(0); // LINKLESS — no EvidenceLink written
    });

    // ---- (b/c) idempotence + watermark --------------------------------------

    it('(b) a re-run over unchanged evidence writes nothing new; the watermark advances', async () => {
      const talent = uuidv7();
      await seedEmployment({ talentId: talent, employer: 'acme', start: '2020-06-01', end: '2020-01-01', srcId: 's1' });
      const sid = await subjectIdFor(talent);

      await consistency.drainBatch({ batchSize: 100 });
      const eventsAfter1 = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE event_type = 'CONTRADICTED'`);
      const wm1 = await db.query<{ w: Date | null }>(`SELECT last_consistency_at AS w FROM talent_trust."ResolutionSubject" WHERE id = $1::uuid`, [sid]);
      expect(wm1.rows[0]!.w).not.toBeNull(); // watermark set

      // A second drain finds nothing (watermark gate), so no new events.
      const second = await consistency.drainBatch({ batchSize: 100 });
      expect(second.attempted).toBe(0);
      const eventsAfter2 = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE event_type = 'CONTRADICTED'`);
      expect(eventsAfter2.rows[0]!.n).toBe(eventsAfter1.rows[0]!.n); // no double-raise
    });

    // ---- (e) employer conflict → cap → resolve via endpoint → cap lifts ------

    it('(e) employer conflict contradicts pairwise, caps CLAIMS at CORROBORATED; resolve endpoint lifts it; refusals domain-coded', async () => {
      const talent = uuidv7();
      const a = await seedEmployment({ talentId: talent, employer: 'acme', start: '2020-01-01', end: '2020-12-31', srcId: 'a' });
      const b = await seedEmployment({ talentId: talent, employer: 'globex', start: '2020-03-01', end: '2021-02-28', srcId: 'b' });
      const sid = await subjectIdFor(talent);

      await trust.runConsistencyForSubject(TENANT, sid);
      // The pairwise contradict flipped the incumbent (lower evidence_id is `to`).
      const contradictedId = (await statusOf(a)) === 'CONTRADICTED' ? a : b;
      expect(await statusOf(contradictedId)).toBe('CONTRADICTED');
      expect(await linkCount()).toBe(1); // one CONTRADICTS link
      const capped = await db.query<{ band: string; n: number }>(
        `SELECT claims_band AS band, open_contradiction_count AS n FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`,
        [sid],
      );
      expect(capped.rows[0]!.n).toBe(1);
      expect(['NOT_ESTABLISHED', 'SELF_ASSERTED', 'CORROBORATED']).toContain(capped.rows[0]!.band);

      // Refusal: unknown id → 404; a VALID (non-CONTRADICTED) record → 422.
      const jwt = await signJwt(['identity:resolve']);
      const notFound = await post(`/v1/talent/identity/contradictions/${uuidv7()}/resolve`, jwt, { reason: 'x' });
      expect(notFound.status).toBe(404);
      const validId = contradictedId === a ? b : a;
      const notContra = await post(`/v1/talent/identity/contradictions/${validId}/resolve`, jwt, { reason: 'x' });
      expect(notContra.status).toBe(422);
      expect((notContra.body['error'] as Record<string, unknown>)['code']).toBe('EVIDENCE_NOT_CONTRADICTED');

      // Resolve the real contradiction via the endpoint → status VALID, cap lifts.
      const ok = await post(`/v1/talent/identity/contradictions/${contradictedId}/resolve`, jwt, { reason: 'reviewed — distinct roles' });
      expect(ok.status).toBe(200);
      expect(await statusOf(contradictedId)).toBe('VALID');
      const lifted = await db.query<{ n: number }>(`SELECT open_contradiction_count AS n FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`, [sid]);
      expect(lifted.rows[0]!.n).toBe(0); // cap lifted
    });

    // ---- (d) healed timeline gap → SUPERSEDED --------------------------------

    it('(d) interior gap → TIMELINE_GAP evidence; a filling job → next run SUPERSEDES it', async () => {
      const talent = uuidv7();
      await seedEmployment({ talentId: talent, employer: 'acme', start: '2018-01-01', end: '2018-12-31', srcId: 'j1' });
      await seedEmployment({ talentId: talent, employer: 'globex', start: '2020-06-01', end: '2021-06-01', srcId: 'j2' });
      const sid = await subjectIdFor(talent);

      const r1 = await trust.runConsistencyForSubject(TENANT, sid);
      expect(r1.gaps_opened).toBe(1);
      const gaps1 = await gapRows(sid);
      expect(gaps1).toHaveLength(1);
      expect(gaps1[0]!.current_status).toBe('VALID');
      // ai_derived:false, DERIVED method, CONTINUITY dimension on the gap row.
      const gapMeta = await db.query<{ dimension: string; method: string; ai_derived: boolean; source_class: string }>(
        `SELECT dimension, method, ai_derived, source_class FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`,
        [gaps1[0]!.id],
      );
      expect(gapMeta.rows[0]).toMatchObject({ dimension: 'CONTINUITY', method: 'DERIVED', ai_derived: false, source_class: 'THIRD_PARTY_UNVERIFIED' });

      // Fill the gap.
      await seedEmployment({ talentId: talent, employer: 'initech', start: '2019-01-01', end: '2020-05-01', srcId: 'fill' });
      const r2 = await trust.runConsistencyForSubject(TENANT, sid);
      expect(r2.gaps_healed).toBe(1);
      expect((await gapRows(sid)).find((g) => g.id === gaps1[0]!.id)?.current_status).toBe('SUPERSEDED');
    });

    // ---- (c/f) idempotence + no-double-raise on the same conflict ------------

    it('(c/f) re-running the employer-conflict detector is a no-op (one link, one event) — no double-raise', async () => {
      const talent = uuidv7();
      await seedEmployment({ talentId: talent, employer: 'acme', start: '2020-01-01', end: '2020-12-31', srcId: 'a' });
      await seedEmployment({ talentId: talent, employer: 'globex', start: '2020-03-01', end: '2021-02-28', srcId: 'b' });
      const sid = await subjectIdFor(talent);

      await trust.runConsistencyForSubject(TENANT, sid);
      const links1 = await linkCount();
      const ev1 = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE event_type = 'CONTRADICTED'`);

      await trust.runConsistencyForSubject(TENANT, sid); // re-run
      expect(await linkCount()).toBe(links1); // link unique + service no-op
      const ev2 = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE event_type = 'CONTRADICTED'`);
      expect(ev2.rows[0]!.n).toBe(ev1.rows[0]!.n); // no second CONTRADICTED event
    });
  },
);
