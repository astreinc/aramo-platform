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
import {
  SignJWT,
  exportSPKI,
  generateKeyPair,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { establishOpenRequisition } from './support/establish-open-requisition.js';
import { ConfigurableTestResolver } from './support/test-auth-harness.js';

// GET /v1/my-desk — recruiter command-center READ composition, proven against
// real Postgres 17 + the full AppModule (real guards + visibility interceptor +
// resolver). Proof matrix (Architect ruling):
//   - tenant isolation (another tenant's rows never appear)
//   - RBAC (missing dashboard:read → 403; tenant lacking `ats` → 403)
//   - visibility resolver (unassigned-requisition work is hidden)
//   - task ownership (another recruiter's task is hidden)
//   - deterministic ordering (overdue → today → upcoming)
//   - summary/list consistency (counts derive from the returned arrays)
//   - interview day-window handling (only the local-today session appears)
//   - awaiting-client ordering (oldest first)
//   - exception filtering (only BLOCKED placement + expiring SENT offer)
//   - task→requisition enrichment incl. the ambiguity/null negative case
// Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const migrationsFor = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
};
// AppModule boot set (the reporting/dashboard proof lib set) + the seam libs the
// desk composition reads across (client-selection, placement, task).
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
  ...migrationsFor('task'),
  // Increment-2 derived-kinds composition (submittal-readiness) authorities.
  ...migrationsFor('submittal-eligibility'),
  ...migrationsFor('documents'),
  ...migrationsFor('client-talent-restriction'),
  // Not read by the desk — applied only so the CI processing reconciler's
  // onModuleInit scan (a background job) finds its table and does not raise an
  // unrelated unhandled rejection during the run.
  ...migrationsFor('conversation-intelligence'),
];

// DDL splitter that skips ';' inside -- line comments, $$ bodies, AND
// single-quoted string literals (with '' escapes) — a documents migration
// carries a ';' inside a COMMENT-string, which a comment/$$-only splitter breaks.
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
          i += 1; // an escaped '' — stay inside the string
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
const AUDIENCE = 'aramo-my-desk-integration-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const RECRUITER_OTHER = '00000000-0000-7000-8000-000000000bb2';
const ADMIN = '00000000-0000-7000-8000-000000000aa1';

const RECRUITER_SCOPES = ['dashboard:read', 'requisition:read'];

const DAY = 86_400_000;
const __resolver = new ConfigurableTestResolver();

type SignKey = CryptoKey | KeyObject;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'GET /v1/my-desk — recruiter command-center composition (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    let recruiterJwt = '';
    let recruiterOtherTenantJwt = '';
    let unscopedJwt = '';

    // Fixture ids captured during seed.
    let reqA1 = '';
    let reqA2 = '';
    let reqU = '';
    const tal: Record<string, string> = {};

    async function signJwt(
      key: SignKey,
      args: { sub: string; tenant_id: string; site_id?: string; scopes: string[] },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        authz_version: __resolver.grant(args.tenant_id, args.sub, args.scopes),
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function getMyDesk(jwt: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/my-desk`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    }

    // ---- direct-SQL seed helpers (UUID cross-refs, no FK) --------------------
    async function seedAssignment(tenant: string, req: string, user: string) {
      await db.query(
        `INSERT INTO requisition."RequisitionAssignment"
           (id, tenant_id, requisition_id, user_id, assigned_at, assigned_by_id)
         VALUES ($1,$2,$3,$4,now(),$5)`,
        [randomUUID(), tenant, req, user, ADMIN],
      );
    }
    async function seedTask(a: {
      tenant: string;
      assignee: string;
      owner_type: string;
      owner_id: string;
      title: string;
      type: string;
      dueMs: number | null;
      requisitionId?: string; // CRM-6 — optional explicit requisition context
    }) {
      await db.query(
        `INSERT INTO task."Task"
           (id, tenant_id, title, due_date, type, source, assignee_id, created_by_user_id, owner_type, owner_id, requisition_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9,$10,now(),now())`,
        [
          randomUUID(),
          a.tenant,
          a.title,
          a.dueMs === null ? null : new Date(a.dueMs),
          a.type,
          a.assignee,
          ADMIN,
          a.owner_type,
          a.owner_id,
          a.requisitionId ?? null,
        ],
      );
    }
    async function seedPipeline(tenant: string, req: string, talent: string, status: string) {
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::"pipeline"."PipelineStatus",now(),now())`,
        [randomUUID(), tenant, talent, req, status],
      );
    }
    async function seedInterview(a: {
      tenant: string;
      req: string;
      talent: string;
      whenMs: number;
      state: string;
    }) {
      await db.query(
        `INSERT INTO client_selection."InterviewSession"
           (id, tenant_id, client_selection_process_id, requisition_id, talent_record_id, interview_type, round, scheduled_at, state, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'client_interview',1,$6,$7::"client_selection"."InterviewSessionState",0,now(),now())`,
        [randomUUID(), a.tenant, randomUUID(), a.req, a.talent, new Date(a.whenMs), a.state],
      );
    }
    async function seedSelection(a: {
      tenant: string;
      req: string;
      talent: string;
      state: string;
      createdMs: number;
    }) {
      await db.query(
        `INSERT INTO client_selection."ClientSelectionProcess"
           (id, tenant_id, submittal_id, requisition_id, talent_id, state, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::"client_selection"."ClientSelectionState",0,$7,now())`,
        [randomUUID(), a.tenant, randomUUID(), a.req, a.talent, a.state, new Date(a.createdMs)],
      );
    }
    async function seedSubmittal(a: {
      tenant: string;
      talent: string;
      req: string;
      resume_edition_id: string | null;
      state: string;
    }) {
      await db.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id, resume_edition_id, state, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"submittal"."SubmittalState",$9,now())`,
        [
          randomUUID(),
          a.tenant,
          a.talent,
          a.req,
          randomUUID(),
          randomUUID(),
          a.resume_edition_id,
          a.state,
          ADMIN,
        ],
      );
    }
    async function seedPlacement(a: {
      tenant: string;
      req: string;
      talent: string;
      state: string;
      startDate: string | null;
    }) {
      await db.query(
        `INSERT INTO placement."PlacementProcess"
           (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offered_at, proposed_start_date, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"placement"."PlacementState",now(),$7::date,now())`,
        [randomUUID(), a.tenant, randomUUID(), a.req, a.talent, a.state, a.startDate],
      );
    }
    async function seedOffer(a: {
      tenant: string;
      req: string;
      talent: string;
      state: string;
      expiresMs: number | null;
    }) {
      await db.query(
        `INSERT INTO offer."Offer"
           (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offer_expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"offer"."OfferState",$7,now())`,
        [
          randomUUID(),
          a.tenant,
          randomUUID(),
          a.req,
          a.talent,
          a.state,
          a.expiresMs === null ? null : new Date(a.expiresMs),
        ],
      );
    }

    async function seedCompany(tenant: string, name: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO company."Company" (id, tenant_id, site_id, name) VALUES ($1,$2,$3,$4)`,
        [id, tenant, SITE_A, name],
      );
      return id;
    }
    async function seedTalent(tenant: string, first: string, last: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, site_id, first_name, last_name, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [id, tenant, SITE_A, first, last],
      );
      return id;
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
      // Grant the `ats` capability to TENANT_A only (TENANT_B stays unentitled
      // → its recruiter is the RBAC capability-reject fixture).
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_A],
      );

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      recruiterJwt = await signJwt(kp.privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_A,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterOtherTenantJwt = await signJwt(kp.privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_B,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      unscopedJwt = await signJwt(kp.privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_A,
        site_id: SITE_A,
        scopes: [],
      });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__resolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;

      // --- seed reference data directly (SQL): a company + named talent ---
      const companyId = await seedCompany(TENANT_A, 'Freddie Mac');
      const names: Array<[string, string, string]> = [
        ['kevin', 'Kevin', 'Brooks'],
        ['marcus', 'Marcus', 'Lee'],
        ['rahul', 'Rahul', 'Nair'],
        ['kiran', 'Kiran', 'Rao'],
        ['emily', 'Emily', 'Carter'],
        ['samuel', 'Samuel', 'Ortiz'],
        ['liam', 'Liam', 'OConnor'],
        ['hannah', 'Hannah', 'Kim'],
      ];
      for (const [key, first, last] of names) {
        tal[key] = await seedTalent(TENANT_A, first, last);
      }
      // Requisitions via the sanctioned SYSTEM establishment path (OPEN status).
      const mkReq = async (title: string): Promise<string> => {
        const v = await establishOpenRequisition(app, {
          tenant_id: TENANT_A,
          entered_by_id: ADMIN,
          input: { title, company_id: companyId, site_id: SITE_A },
        });
        return v.id;
      };
      reqA1 = await mkReq('Business Analyst – Multi-Family');
      reqA2 = await mkReq('Java Developer');
      reqU = await mkReq('Salesforce Administrator (unassigned)');

      // Assign reqA1 + reqA2 to RECRUITER; reqU stays unassigned (visibility).
      await seedAssignment(TENANT_A, reqA1, RECRUITER);
      await seedAssignment(TENANT_A, reqA2, RECRUITER);

      // Deterministic app-timezone "today" anchor (same pattern as talent-360 #876). My Desk's
      // civil-day surfaces — interviews_today and task 'today' urgency — compare calendar DATES in
      // the app timezone (ARAMO_APP_TIME_ZONE, default America/New_York): an item is "today" iff its
      // instant's date in that zone equals now's date in that zone. A raw `Date.now()` base let the
      // relative seeds below (interview whenMs: now, task dueMs: now) straddle app-tz midnight when the
      // suite runs late-evening app-tz, flaking those counts. Noon UTC on today's app-tz date is
      // 07:00–08:00 app-tz — ALWAYS the same app-tz calendar day as now, at any wall-clock hour.
      // Test determinism only; production logic is unchanged.
      const APP_TIME_ZONE = process.env['ARAMO_APP_TIME_ZONE'] ?? 'America/New_York';
      const now = Date.parse(
        `${new Intl.DateTimeFormat('en-CA', {
          timeZone: APP_TIME_ZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date())}T12:00:00Z`,
      );
      // --- Priority queue: tasks ---
      await seedTask({ tenant: TENANT_A, assignee: RECRUITER, owner_type: 'requisition', owner_id: reqA1, title: 'Send RTR reminder', type: 'follow_up', dueMs: now - 3 * DAY }); // overdue
      await seedTask({ tenant: TENANT_A, assignee: RECRUITER, owner_type: 'talent_record', owner_id: tal['kevin'], title: 'Log qualifying call', type: 'call', dueMs: now }); // today + enriched (Kevin on 1 pipeline)
      await seedTask({ tenant: TENANT_A, assignee: RECRUITER, owner_type: 'talent_record', owner_id: tal['marcus'], title: 'Log call', type: 'call', dueMs: now }); // today + AMBIGUOUS (Marcus on 2 pipelines)
      // CRM-6 §10 rule 5 — EXPLICIT requisition context wins over the ambiguous
      // single-pipeline derivation (Marcus is on 2 pipelines → derivation=null).
      await seedTask({ tenant: TENANT_A, assignee: RECRUITER, owner_type: 'talent_record', owner_id: tal['marcus'], title: 'Follow up re Freddie Mac', type: 'follow_up', dueMs: now, requisitionId: reqA1 });
      await seedTask({ tenant: TENANT_A, assignee: RECRUITER, owner_type: 'requisition', owner_id: reqU, title: 'HIDDEN unassigned req task', type: 'admin', dueMs: now }); // visibility-hidden
      await seedTask({ tenant: TENANT_A, assignee: RECRUITER_OTHER, owner_type: 'requisition', owner_id: reqA1, title: 'HIDDEN other-recruiter task', type: 'admin', dueMs: now }); // ownership-hidden
      await seedTask({ tenant: TENANT_B, assignee: RECRUITER, owner_type: 'requisition', owner_id: reqA1, title: 'HIDDEN tenant-B task', type: 'admin', dueMs: now }); // tenant-hidden

      // --- Pipelines: Kevin single active (enrich), Marcus two active (ambiguous), + counts on reqA1 ---
      await seedPipeline(TENANT_A, reqA1, tal['kevin'], 'qualifying');
      await seedPipeline(TENANT_A, reqA1, tal['marcus'], 'qualifying');
      await seedPipeline(TENANT_A, reqA2, tal['marcus'], 'contacted');
      await seedPipeline(TENANT_A, reqA1, tal['kiran'], 'qualified');
      await seedPipeline(TENANT_A, reqA1, tal['emily'], 'qualified');
      await seedPipeline(TENANT_A, reqA1, tal['samuel'], 'voided'); // terminal — excluded from count

      // --- Submittal-ready (derived kind): Hannah is qualified on reqA2 with a
      // selected resume, no RTR requirement, no restriction, no policy → every
      // applicable gate satisfied → 'ready_to_submit'. On reqA2 so the reqA1
      // count assertions are undisturbed.
      await seedPipeline(TENANT_A, reqA2, tal['hannah'], 'qualified');
      await seedSubmittal({
        tenant: TENANT_A,
        talent: tal['hannah'],
        req: reqA2,
        resume_edition_id: randomUUID(),
        state: 'ready_for_review',
      });

      // --- Interviews: today (visible), tomorrow (window-excluded), unassigned (hidden) ---
      await seedInterview({ tenant: TENANT_A, req: reqA1, talent: tal['rahul'], whenMs: now, state: 'SCHEDULED' });
      await seedInterview({ tenant: TENANT_A, req: reqA1, talent: tal['marcus'], whenMs: now + 2 * DAY, state: 'SCHEDULED' });
      await seedInterview({ tenant: TENANT_A, req: reqU, talent: tal['kevin'], whenMs: now, state: 'SCHEDULED' });

      // --- Awaiting client: old (8d) + new (3d) on reqA1; unassigned (hidden); SELECTED (excluded) ---
      await seedSelection({ tenant: TENANT_A, req: reqA1, talent: tal['kiran'], state: 'CLIENT_REVIEW', createdMs: now - 8 * DAY });
      await seedSelection({ tenant: TENANT_A, req: reqA1, talent: tal['emily'], state: 'CLIENT_REVIEW', createdMs: now - 3 * DAY });
      await seedSelection({ tenant: TENANT_A, req: reqU, talent: tal['rahul'], state: 'CLIENT_REVIEW', createdMs: now - 5 * DAY });
      await seedSelection({ tenant: TENANT_A, req: reqA1, talent: tal['samuel'], state: 'SELECTED', createdMs: now - 9 * DAY });

      // --- Exceptions: BLOCKED placement + expiring SENT offer; excluded variants ---
      await seedPlacement({ tenant: TENANT_A, req: reqA1, talent: tal['samuel'], state: 'BLOCKED', startDate: new Date(now + 7 * DAY).toISOString().slice(0, 10) });
      await seedPlacement({ tenant: TENANT_A, req: reqA1, talent: tal['kiran'], state: 'STARTED', startDate: null });
      await seedOffer({ tenant: TENANT_A, req: reqA1, talent: tal['liam'], state: 'SENT', expiresMs: now + 3 * DAY }); // expiring
      await seedOffer({ tenant: TENANT_A, req: reqA1, talent: tal['emily'], state: 'ACCEPTED', expiresMs: now + 3 * DAY }); // excluded (state)
      await seedOffer({ tenant: TENANT_A, req: reqA1, talent: tal['kevin'], state: 'SENT', expiresMs: now + 60 * DAY }); // excluded (window)
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('RBAC: a token without dashboard:read is rejected (403)', async () => {
      expect((await getMyDesk(unscopedJwt)).status).toBe(403);
    });

    it('RBAC: a tenant lacking the `ats` capability is rejected (403)', async () => {
      expect((await getMyDesk(recruiterOtherTenantJwt)).status).toBe(403);
    });

    it('returns 200 with the desk projection for an entitled, scoped recruiter', async () => {
      const { status, body } = await getMyDesk(recruiterJwt);
      expect(status).toBe(200);
      expect(body).toHaveProperty('priority_items');
      expect(body).toHaveProperty('interviews_today');
      expect(body).toHaveProperty('awaiting_client');
      expect(body).toHaveProperty('exceptions');
      expect(body).toHaveProperty('requisitions');
    });

    it('tenant isolation + ownership + visibility: only my visible, assigned work appears', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      const titles = body.priority_items.map((i: any) => i.label + '|' + i.reason);
      expect(titles.join(' ')).not.toContain('HIDDEN');
      // reqU work never surfaces anywhere.
      const allReqIds = [
        ...body.priority_items.map((i: any) => i.requisition_id),
        ...body.interviews_today.map((i: any) => i.requisition_id),
        ...body.awaiting_client.map((i: any) => i.requisition_id),
        ...body.exceptions.map((i: any) => i.requisition_id),
      ];
      expect(allReqIds).not.toContain(reqU);
      // Only reqA1 + reqA2 appear in the requisition table.
      expect(new Set(body.requisitions.map((r: any) => r.id))).toEqual(new Set([reqA1, reqA2]));
    });

    it('deterministic ordering: overdue before today', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      const urg = body.priority_items.map((i: any) => i.urgency);
      const firstToday = urg.indexOf('today');
      const lastOverdue = urg.lastIndexOf('overdue');
      expect(lastOverdue).toBeGreaterThanOrEqual(0);
      expect(firstToday).toBeGreaterThan(lastOverdue);
    });

    it('task→requisition enrichment: single active pipeline enriches; ambiguous stays null', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      const kevin = body.priority_items.find((i: any) => i.talent_name === 'Kevin Brooks');
      // disambiguate the two Marcus tasks by reason (both label 'Marcus Lee').
      const marcusCall = body.priority_items.find(
        (i: any) => i.talent_name === 'Marcus Lee' && i.reason === 'Log call',
      );
      expect(kevin.requisition_id).toBe(reqA1);
      expect(kevin.requisition_label).toMatch(/^REQ-\d+$/);
      expect(marcusCall.requisition_id).toBeNull();
      expect(marcusCall.requisition_label).toBeNull();
    });

    it('CRM-6 §10: an EXPLICIT task.requisition_id wins over the ambiguous single-pipeline derivation', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      // Marcus is on TWO active pipelines (derivation → null), but this follow-up
      // carries an explicit requisition context → it must resolve to reqA1.
      const explicit = body.priority_items.find(
        (i: any) => i.talent_name === 'Marcus Lee' && i.reason === 'Follow up re Freddie Mac',
      );
      expect(explicit).toBeDefined();
      expect(explicit.requisition_id).toBe(reqA1);
      expect(explicit.requisition_label).toMatch(/^REQ-\d+$/);
    });

    it('interview day-window: only the local-today scheduled session appears', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      expect(body.interviews_today).toHaveLength(1);
      expect(body.interviews_today[0].talent_name).toBe('Rahul Nair');
      expect(body.interviews_today[0].confirmation).toBe('unknown');
    });

    it('awaiting client: oldest first', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      expect(body.awaiting_client.map((w: any) => w.talent_name)).toEqual(['Kiran Rao', 'Emily Carter']);
      expect(body.awaiting_client[0].waiting_days).toBeGreaterThanOrEqual(body.awaiting_client[1].waiting_days);
    });

    it('exception filtering: only BLOCKED placement + expiring SENT offer', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      const kinds = body.exceptions.map((x: any) => x.kind).sort();
      expect(kinds).toEqual(['offer_expiring', 'pre_start_blocked']);
      const blocked = body.exceptions.find((x: any) => x.kind === 'pre_start_blocked');
      expect(blocked.title).toContain('Samuel Ortiz');
      expect(blocked.severity).toBe('high');
    });

    it('requisition counts: all five counts via indexed groupBy (terminal-excluded), no LIST_LIMIT', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      const a1 = body.requisitions.find((r: any) => r.id === reqA1);
      // reqA1 active pipelines: kevin(qualifying), marcus(qualifying), kiran(qualified), emily(qualified); samuel(voided) excluded.
      expect(a1.pipeline_count).toBe(4);
      expect(a1.qualified_count).toBe(2);
      // Increment-2 downstream counts (real, from owning-domain groupBy):
      // with_client = CLIENT_REVIEW ∪ INTERVIEW: csOld(kiran)+csNew(emily) CLIENT_REVIEW; samuel SELECTED excluded → 2.
      expect(a1.with_client_count).toBe(2);
      // offer = SENT ∪ NEGOTIATION ∪ ACCEPTED: ofExpiring(liam,SENT)+ofAccepted(emily,ACCEPTED)+ofFar(kevin,SENT) → 3.
      expect(a1.offer_count).toBe(3);
      // started = STARTED only: plStarted(kiran); plBlocked(samuel,BLOCKED) excluded → 1.
      expect(a1.started_count).toBe(1);
    });

    it('derived kind: a qualified talent with every gate satisfied surfaces a submittal-ready item (real composition, reused authorities)', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      const ready = body.priority_items.find(
        (i: any) => i.kind === 'submittal' && i.talent_name === 'Hannah Kim',
      );
      expect(ready).toBeDefined();
      expect(ready.requisition_id).toBe(reqA2);
      expect(ready.reason).toMatch(/ready to submit/i);
      expect(ready.primary_action).toEqual({
        kind: 'submit_to_client',
        label: 'Submit to client',
        href: `/talent/${tal['hannah']}/submittal/${reqA2}`,
      });
    });

    it('summary/list consistency: card counts derive from the same arrays', async () => {
      const { body } = await getMyDesk(recruiterJwt);
      const overdue = body.priority_items.filter((i: any) => i.urgency === 'overdue').length;
      const today = body.priority_items.filter((i: any) => i.urgency === 'today').length;
      expect(overdue).toBeGreaterThanOrEqual(1);
      expect(today).toBeGreaterThanOrEqual(2);
      // The header/cards are FE-derived from these exact arrays — no separate
      // count field exists on the payload to drift from them.
      expect(body).not.toHaveProperty('summary');
    });
  },
);
