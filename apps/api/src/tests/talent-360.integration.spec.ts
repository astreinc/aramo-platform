import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey, type KeyObject } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { establishOpenRequisition } from './support/establish-open-requisition.js';
import { ConfigurableTestResolver } from './support/test-auth-harness.js';

// GET /v1/talent-360/:id — the person-centric recruiter workspace composition,
// proven against real Postgres 17 + the full AppModule (real guards + visibility
// interceptor + resolver). The invariant under proof: Talent 360 composes
// AUTHORIZED TRUTH from the owning domains; it never becomes the authority, never
// broadens access, and creates no state. Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const migrationsFor = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
};
const MIGRATION_FILES: string[] = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('metering'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('consent'),
  ...migrationsFor('company'),
  ...migrationsFor('contact'),
  ...migrationsFor('requisition'),
  ...migrationsFor('talent-record'),
  ...migrationsFor('activity'),
  ...migrationsFor('calendar'),
  ...migrationsFor('saved-list'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('submittal'),
  ...migrationsFor('client-selection'),
  ...migrationsFor('placement'),
  // The Talent Journey composer descends into pre-start requirements for a
  // STARTED placement (Level 3b) — its table must exist.
  ...migrationsFor('pre-start-requirement'),
  ...migrationsFor('task'),
  ...migrationsFor('submittal-eligibility'),
  ...migrationsFor('documents'),
  ...migrationsFor('client-talent-restriction'),
  // Talent 360 additionally composes across communications (last contact) and
  // talent-trust (identity outcomes via the dossier).
  ...migrationsFor('communications'),
  ...migrationsFor('talent-trust'),
  // Boot-only: the CI reconciler's onModuleInit scan needs its table present.
  ...migrationsFor('conversation-intelligence'),
];

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inString) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (!inDollar && ch === "'") {
      inString = true;
      cur += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-talent-360-integration-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const RECRUITER_2 = '00000000-0000-7000-8000-000000000bb2';
const ADMIN = '00000000-0000-7000-8000-000000000aa1';
const RTR_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';

const FULL_SCOPES = [
  'talent:read',
  'pipeline:read',
  'task:read',
  'activity:read',
  'communication:read',
  'document:read',
];
const DAY = 86_400_000;
const __resolver = new ConfigurableTestResolver();

type SignKey = CryptoKey | KeyObject;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'GET /v1/talent-360/:id — composes authorized truth, is not the authority (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let key: SignKey;

    // Fixture ids.
    let mainTalent = '';
    let emptyTalent = '';
    let supersededTalent = '';
    let survivorTalent = '';
    let tenantBTalent = '';
    let req1 = '';
    let req2 = '';
    let req3 = '';
    let reqClosed = '';
    let reqHidden = '';
    const NOW = Date.now();

    async function jwt(scopes: readonly string[], tenant = TENANT_A, sub = RECRUITER): Promise<string> {
      return new SignJWT({
        sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        authz_version: __resolver.grant(tenant, sub, [...scopes]),
        site_id: SITE_A,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function get(talentId: string, token: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/talent-360/${talentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    }

    // ---- seed helpers (direct SQL; UUID cross-refs, no FK) --------------------
    async function seedCompany(name: string): Promise<string> {
      const id = randomUUID();
      await db.query(`INSERT INTO company."Company" (id, tenant_id, site_id, name) VALUES ($1,$2,$3,$4)`, [id, TENANT_A, SITE_A, name]);
      return id;
    }
    async function seedTalent(a: { tenant?: string; first: string; last: string; email?: string | null; phone?: string | null; workAuth?: string | null; owner?: string | null; recordStatus?: string; supersededBy?: string | null }): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, site_id, first_name, last_name, email1, phone_cell, work_authorization, owner_id, source, record_status, superseded_by_record_id, key_skills, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
        [id, a.tenant ?? TENANT_A, SITE_A, a.first, a.last, a.email ?? null, a.phone ?? null, a.workAuth ?? null, a.owner ?? null, 'Referral sourcing', a.recordStatus ?? 'live', a.supersededBy ?? null, 'Scrum, SAFe'],
      );
      return id;
    }
    async function seedAssignment(req: string, user: string) {
      await db.query(
        `INSERT INTO requisition."RequisitionAssignment" (id, tenant_id, requisition_id, user_id, assigned_at, assigned_by_id) VALUES ($1,$2,$3,$4,now(),$5)`,
        [randomUUID(), TENANT_A, req, user, ADMIN],
      );
    }
    async function seedPipeline(req: string, talent: string, status: string, tenant = TENANT_A) {
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::"pipeline"."PipelineStatus",now(),now())`,
        [randomUUID(), tenant, talent, req, status],
      );
    }
    async function seedSubmittal(a: { talent: string; req: string; state: string }): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id, resume_edition_id, state, created_by, created_at, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"submittal"."SubmittalState",$9,now(),now())`,
        [id, TENANT_A, a.talent, a.req, randomUUID(), randomUUID(), null, a.state, ADMIN],
      );
      return id;
    }
    async function seedSelection(a: { submittalId: string; req: string; talent: string; state: string; createdMs: number }): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO client_selection."ClientSelectionProcess"
           (id, tenant_id, submittal_id, requisition_id, talent_id, state, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::"client_selection"."ClientSelectionState",0,$7,now())`,
        [id, TENANT_A, a.submittalId, a.req, a.talent, a.state, new Date(a.createdMs)],
      );
      return id;
    }
    async function seedInterview(a: { processId: string; req: string; talent: string; whenMs: number; state: string }) {
      await db.query(
        `INSERT INTO client_selection."InterviewSession"
           (id, tenant_id, client_selection_process_id, requisition_id, talent_record_id, interview_type, round, scheduled_at, state, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'client_interview',1,$6,$7::"client_selection"."InterviewSessionState",0,now(),now())`,
        [randomUUID(), TENANT_A, a.processId, a.req, a.talent, new Date(a.whenMs), a.state],
      );
    }
    async function seedOffer(a: { submittalId: string; req: string; talent: string; state: string }) {
      await db.query(
        `INSERT INTO offer."Offer" (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"offer"."OfferState",now())`,
        [randomUUID(), TENANT_A, a.submittalId, a.req, a.talent, a.state],
      );
    }
    async function seedPlacement(a: { submittalId: string; req: string; talent: string; state: string }) {
      await db.query(
        `INSERT INTO placement."PlacementProcess" (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offered_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"placement"."PlacementState",now(),now())`,
        [randomUUID(), TENANT_A, a.submittalId, a.req, a.talent, a.state],
      );
    }
    async function seedExecutedRtr(talent: string, req: string) {
      const docId = randomUUID();
      await db.query(
        `INSERT INTO documents."Document" (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by, created_at, executed_at)
         VALUES ($1,$2,$3,$4,'EXECUTED','SINGLE_SIGNATURE','UPLOADED',$5,now(),now())`,
        [docId, TENANT_A, RTR_TYPE_ID, 'Right to Represent', ADMIN],
      );
      for (const [rt, rel, rid] of [['TALENT', 'SUBJECT', talent], ['REQUISITION', 'REGARDING', req]] as const) {
        await db.query(
          `INSERT INTO documents."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), TENANT_A, docId, rt, rid, rel, ADMIN],
        );
      }
    }
    async function seedCommunication(talent: string, channel: string, direction: string, whenMs: number) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO communications."CommunicationInteraction"
           (id, tenant_id, channel, direction, status, integration_connection_id, from_address, to_address, created_at, updated_at)
         VALUES ($1,$2,$3::"communications"."CommunicationChannel",$4::"communications"."CommunicationDirection",'completed'::"communications"."CommunicationInteractionStatus",$5,'a@x.com','b@y.com',$6,$6)`,
        [id, TENANT_A, channel, direction, randomUUID(), new Date(whenMs)],
      );
      await db.query(
        `INSERT INTO communications."CommunicationAssociation" (id, tenant_id, interaction_id, subject_type, subject_id, relation_type, created_at)
         VALUES ($1,$2,$3,'talent_record'::"communications"."CommunicationSubjectType",$4,'subject'::"communications"."CommunicationRelationType",now())`,
        [randomUUID(), TENANT_A, id, talent],
      );
    }
    async function seedActivity(talent: string, type: string, whenMs: number) {
      await db.query(
        `INSERT INTO activity."Activity" (id, tenant_id, site_id, type, subject_type, subject_id, notes, created_by_id, created_at)
         VALUES ($1,$2,$3,$4::"activity"."ActivityType",'talent_record',$5,'note',$6,$7)`,
        [randomUUID(), TENANT_A, SITE_A, type, talent, ADMIN, new Date(whenMs)],
      );
    }
    async function seedConsentGranted(talent: string) {
      await db.query(
        `INSERT INTO consent."TalentConsentEvent" (id, talent_record_id, tenant_id, scope, action, captured_method, consent_version, occurred_at, expires_at, created_at)
         VALUES ($1,$2,$3,'contacting','granted','web_form','v1',now(),$4,now())`,
        [randomUUID(), talent, TENANT_A, new Date(NOW + 365 * DAY)],
      );
    }
    async function seedTask(talent: string, title: string) {
      await db.query(
        `INSERT INTO task."Task" (id, tenant_id, title, due_date, type, source, assignee_id, created_by_user_id, owner_type, owner_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'follow_up','manual',$5,$6,'talent_record',$7,now(),now())`,
        [randomUUID(), TENANT_A, title, new Date(NOW + DAY), RECRUITER, ADMIN, talent],
      );
    }
    async function seedTrustDossier(talent: string) {
      const subj = randomUUID();
      const subjB = randomUUID();
      await db.query(`INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at) VALUES ($1,$2,'ACTIVE',now())`, [subj, TENANT_A]);
      await db.query(`INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at) VALUES ($1,$2,'ACTIVE',now())`, [subjB, TENANT_A]);
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef" (id, subject_id, tenant_id, ref_type, ref_id, linked_at, link_source) VALUES ($1,$2,$3,'ATS_TALENT_RECORD',$4,now(),'seed')`,
        [randomUUID(), subj, TENANT_A, talent],
      );
      for (const kind of ['EMAIL', 'PHONE']) {
        await db.query(
          `INSERT INTO talent_trust."SubjectAnchor" (id, subject_id, tenant_id, anchor_kind, normalized_value, source_evidence_id, source_class, created_at) VALUES ($1,$2,$3,$4,$5,$6,'seed',now())`,
          [randomUUID(), subj, TENANT_A, kind, `${kind.toLowerCase()}:v`, randomUUID()],
        );
        await db.query(
          `INSERT INTO talent_trust."VerificationRequest" (id, tenant_id, talent_record_id, subject_id, anchor_kind, normalized_value, token_hash, status, created_by, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'CONFIRMED',$8,now(),$9)`,
          [randomUUID(), TENANT_A, talent, subj, kind, `${kind.toLowerCase()}:v`, randomUUID(), ADMIN, new Date(NOW + DAY)],
        );
      }
      await db.query(
        `INSERT INTO talent_trust."SubjectMatchAdvisory" (id, tenant_id, subject_a_id, subject_b_id, advise_band, has_contradiction, match_basis, status, created_by, created_at) VALUES ($1,$2,$3,$4,'POSSIBLE',false,'{}'::jsonb,'PENDING_REVIEW',$5,now())`,
        [randomUUID(), TENANT_A, subj, subjB, ADMIN],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATION_FILES) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          const t = s.trim();
          if (t) await db.query(t);
        }
      }
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_A],
      );

      const kp = await generateKeyPair(ALG);
      key = kp.privateKey;
      const publicPem = await exportSPKI(kp.publicKey as never);
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
        .useValue(__resolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;

      // ---- seed ----
      const company = await seedCompany('Freddie Mac');
      mainTalent = await seedTalent({ first: 'Divya', last: 'Vasudevan', email: 'divya@example.com', phone: '(703) 555-0182', workAuth: 'permanent_resident', owner: RECRUITER });
      emptyTalent = await seedTalent({ first: 'Empty', last: 'Person', email: 'empty@example.com', phone: '555', workAuth: 'us_citizen' });
      survivorTalent = await seedTalent({ first: 'Survivor', last: 'Record' });
      supersededTalent = await seedTalent({ first: 'Old', last: 'Record', recordStatus: 'superseded', supersededBy: survivorTalent });
      tenantBTalent = await seedTalent({ tenant: TENANT_B, first: 'Cross', last: 'Tenant' });

      const mkReq = async (title: string): Promise<string> =>
        (await establishOpenRequisition(app, { tenant_id: TENANT_A, entered_by_id: ADMIN, input: { title, company_id: company, site_id: SITE_A } })).id;
      req1 = await mkReq('Scrum Master — Multifamily');
      req2 = await mkReq('Agile Delivery Lead');
      req3 = await mkReq('Senior Scrum Master');
      reqClosed = await mkReq('Agile Coach (closed)');
      reqHidden = await mkReq('Salesforce Admin (unassigned)');
      for (const r of [req1, req2, req3, reqClosed]) await seedAssignment(r, RECRUITER);
      // reqHidden intentionally unassigned → visibility-hidden.

      // MAIN — 3 active opportunities across distinct stages + 1 closed + 1 hidden.
      // req1: interview today.
      await seedPipeline(req1, mainTalent, 'qualified');
      const s1 = await seedSubmittal({ talent: mainTalent, req: req1, state: 'submitted_to_ats' });
      const cs1 = await seedSelection({ submittalId: s1, req: req1, talent: mainTalent, state: 'INTERVIEW', createdMs: NOW - 5 * DAY });
      await seedInterview({ processId: cs1, req: req1, talent: mainTalent, whenMs: NOW + 3 * 3_600_000, state: 'SCHEDULED' });
      // req2: waiting for client (CLIENT_REVIEW 3 days).
      await seedPipeline(req2, mainTalent, 'qualified');
      const s2 = await seedSubmittal({ talent: mainTalent, req: req2, state: 'submitted_to_ats' });
      await seedSelection({ submittalId: s2, req: req2, talent: mainTalent, state: 'CLIENT_REVIEW', createdMs: NOW - 3 * DAY });
      // req3: offer accepted + placement started.
      await seedPipeline(req3, mainTalent, 'qualified');
      const s3 = await seedSubmittal({ talent: mainTalent, req: req3, state: 'confirmed' });
      await seedOffer({ submittalId: s3, req: req3, talent: mainTalent, state: 'ACCEPTED' });
      await seedPlacement({ submittalId: s3, req: req3, talent: mainTalent, state: 'STARTED' });
      // closed + hidden.
      await seedPipeline(reqClosed, mainTalent, 'not_in_consideration');
      await seedPipeline(reqHidden, mainTalent, 'qualified');

      await seedExecutedRtr(mainTalent, req1);
      // Last contact must be the communications top-1 (email today), NOT the
      // later activity row — seed the activity AFTER the comm to prove it.
      await seedCommunication(mainTalent, 'email', 'inbound', NOW - 3_600_000);
      await seedActivity(mainTalent, 'note', NOW - 60_000);
      await seedConsentGranted(mainTalent);
      await seedTask(mainTalent, 'Debrief call with Divya');
      await seedTrustDossier(mainTalent);

      // Superseded talent still has an episode — it must NEVER reconstruct it.
      await seedPipeline(req1, supersededTalent, 'qualified');
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });

    // ---- positive: the multi-opportunity Talent, fully authorized ------------
    describe('the multi-opportunity Talent renders authoritative truth', () => {
      it('exposes exactly the 3 visible active opportunities (hidden requisition excluded)', async () => {
        const { status, body } = await get(mainTalent, await jwt(FULL_SCOPES));
        expect(status).toBe(200);
        expect(body.opportunities.active).toHaveLength(3);
        const codes = body.opportunities.active.map((o: any) => o.requisition_code);
        expect(new Set(codes).size).toBe(3);
        expect(body.relationship_strip.active_opportunities).toBe(3);
      });

      it('derives KPI counts from the owning domains (submittals/interviews-today/offers/assignments)', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        const s = body.relationship_strip;
        expect(s.submittals).toBe(3);
        expect(s.interviews_today).toBe(1);
        expect(s.offers).toBe(1);
        expect(s.assignments).toBe(1); // STARTED placement only (HALT-4)
      });

      it('derives waiting-for-client from real client-selection created_at, not a mocked string', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        const waiting = (body.attention as any[]).find((a) => a.kind === 'waiting');
        expect(waiting).toBeDefined();
        expect(waiting.kicker).toBe('WAITING 3 DAYS');
      });

      it('derives interview-today from the real interview session substrate', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        expect((body.attention as any[]).some((a) => a.kind === 'interview')).toBe(true);
      });

      it('takes last contact from the top communication interaction, not the later Activity row', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        expect(body.relationship_strip.last_contact.channel).toBe('email');
        // The activity note is newer; last_contact must still be the comm instant.
        expect(Date.parse(body.relationship_strip.last_contact.at)).toBe(NOW - 3_600_000);
      });

      it('reports the signed RTR from the Documents/e-sign authority (EXECUTED + executed_at)', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        const rtr = (body.documents.key_documents as any[]).find((d) => d.kind.toLowerCase().includes('represent'));
        expect(rtr).toBeDefined();
        expect(rtr.signed).toBe(true);
        expect(rtr.signed_at).not.toBeNull();
      });

      it('surfaces the duplicate identity outcome from the real advisory/dossier path', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        expect(body.identity.primary_email_confirmed).toBe(true);
        expect(body.identity.mobile_confirmed).toBe(true);
        expect(body.identity.advisory).not.toBeNull();
      });

      it('keeps relationship counts single-TalentRecord scoped (active + closed = 4, no merged-human claim)', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        expect(body.relationship.history.requisitions).toBe(4);
        expect(body.relationship.history.placements).toBe(1);
      });

      it('preserves the landed recruiting_ready predicate exactly (informational, unchanged)', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        expect(body.header.recruiting_ready.ready).toBe(true); // live + contact + work-auth
        expect(body.header.recruiting_ready.rule.toLowerCase()).not.toContain('consent');
      });

      it('reports Contact permitted only from the consent authority', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        expect(body.header.contactability.recruiting_permitted).toBe(true);
      });
    });

    // ---- partial-page contract over HTTP -------------------------------------
    describe('partial-page contract over HTTP — unauthorized → null, authorized-empty → [] / 0', () => {
      it('an authorized-but-empty Talent yields [] opportunities and 0 counts (not null)', async () => {
        const { status, body } = await get(emptyTalent, await jwt(FULL_SCOPES));
        expect(status).toBe(200);
        expect(body.opportunities).toEqual({ active: [], closed: [] });
        expect(body.relationship_strip.active_opportunities).toBe(0);
        expect(body.attention).toEqual([]);
      });
    });

    // ---- §23 negative controls (each named separately) -----------------------
    describe('§23 negative controls', () => {
      it('cross-tenant Talent cannot be read (404, never leaks existence)', async () => {
        const { status } = await get(tenantBTalent, await jwt(FULL_SCOPES));
        expect(status).toBe(404);
      });

      it('a hidden (unassigned) requisition never appears in opportunities/counts/attention', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        const codes: string[] = body.opportunities.active.map((o: any) => o.requisition_code);
        // reqHidden's active episode is excluded; only 3 visible remain.
        expect(codes).toHaveLength(3);
      });

      it('missing document:read removes Documents (null) without failing the page', async () => {
        const { status, body } = await get(mainTalent, await jwt(FULL_SCOPES.filter((s) => s !== 'document:read')));
        expect(status).toBe(200);
        expect(body.documents).toBeNull();
        expect(body.authorized_sections.documents).toBe(false);
        expect(body.header.display_name).toBe('Divya Vasudevan');
      });

      it('missing communication:read removes last-contact without failing the page', async () => {
        const { status, body } = await get(mainTalent, await jwt(FULL_SCOPES.filter((s) => s !== 'communication:read')));
        expect(status).toBe(200);
        expect(body.relationship_strip.last_contact).toBeNull();
        expect(body.authorized_sections.communications).toBe(false);
      });

      it('missing task:read removes Tasks (null) without failing the page', async () => {
        const { status, body } = await get(mainTalent, await jwt(FULL_SCOPES.filter((s) => s !== 'task:read')));
        expect(status).toBe(200);
        expect(body.tasks).toBeNull();
      });

      it('missing pipeline:read removes opportunities/attention/strip counts without failing the page', async () => {
        const { status, body } = await get(mainTalent, await jwt(['talent:read']));
        expect(status).toBe(200);
        expect(body.opportunities).toBeNull();
        expect(body.attention).toBeNull();
        expect(body.relationship_strip.active_opportunities).toBeNull();
      });

      it('requisition-level commercial fields never appear in the Talent 360 payload (no broadening)', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        const json = JSON.stringify(body);
        for (const key of ['bill_rate', 'pay_rate', 'salary_amount', 'margin_amount', 'markup_percent']) {
          expect(json).not.toContain(key);
        }
      });

      it('no confirmed/confirmation interview field is fabricated (HALT-6 PROTOTYPE-ONLY)', async () => {
        const { body } = await get(mainTalent, await jwt(FULL_SCOPES));
        const opp = body.opportunities.active[0];
        expect(opp).not.toHaveProperty('confirmation');
        expect(JSON.stringify(body)).not.toContain('"confirmation"');
      });

      it('no Talent 360 persistence table/state is created (it composes, it does not store)', async () => {
        const r = await db.query(
          `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%talent%360%' OR table_name ILIKE '%talent360%'`,
        );
        expect(r.rowCount).toBe(0);
      });

      it('a superseded Talent returns the survivor pointer and never reconstructs opportunity/identity state', async () => {
        const { status, body } = await get(supersededTalent, await jwt(FULL_SCOPES));
        expect(status).toBe(200);
        expect(body.header.record_status).toBe('superseded');
        expect(body.header.superseded_by_record_id).toBe(survivorTalent);
        expect(body.opportunities).toBeNull(); // the seeded episode is never surfaced
        expect(body.identity).toBeNull();
      });
    });
  },
);
