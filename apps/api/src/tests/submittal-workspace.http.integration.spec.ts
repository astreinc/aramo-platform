import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey, type KeyObject } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { seedLivePipelineEpisode } from './sw1-live-pipeline.fixture.js';
import { ConfigurableTestResolver } from './support/test-auth-harness.js';

// SW-7 §22 — GET /v1/submittals/:id/workspace FULL-STACK HTTP regression. Boots the
// REAL AppModule (real JwtAuthGuard + RolesGuard + EntitlementGuard('ats') +
// RequireSiteMatch + the requisition-visibility boundary + the REAL engagement /
// document-readiness / client-submittal-policy service chain) against real Postgres.
// It proves the SW-4 projection + the SW-4-remediation ClientSelectionEvent query
// (subject_type='process' + subject_id=<process>) over HTTP: correct state, feedback
// and history from the right process events, with unrelated-process and cross-tenant
// events excluded. The route guards are NOT weakened. Gated on ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const migrationsFor = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
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
  ...migrationsFor('pre-start-requirement'),
  ...migrationsFor('task'),
  ...migrationsFor('submittal-eligibility'),
  ...migrationsFor('documents'),
  ...migrationsFor('client-talent-restriction'),
  ...migrationsFor('communications'),
  ...migrationsFor('talent-trust'),
  ...migrationsFor('conversation-intelligence'),
];

// node-pg executes multi-statement + dollar-quoted bodies natively; apply whole files.
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-submittal-workspace-http-spec';
const ALG = 'RS256';
type SignKey = CryptoKey | KeyObject;

const TENANT_A = '01900000-0000-7000-8000-00000000a001';
const TENANT_B = '01900000-0000-7000-8000-00000000b002';
const SITE_A = '33333333-3333-7333-8333-33333333a001';
const RECRUITER = '00000000-0000-7000-8000-00000000bb01';
const TALENT = '01900000-0000-7000-8000-00000000d001';
const COMPANY = '01900000-0000-7000-8000-00000000c001';
const SUB = '01900000-0000-7000-8000-000000005001';
const CSP = '01900000-0000-7000-8000-000000005c01';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'GET /v1/submittals/:id/workspace — full-stack HTTP (real guards + real services + real Postgres)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let key: SignKey;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let JOB = '';

    async function jwt(scopes: readonly string[], tenant = TENANT_A, sub = RECRUITER): Promise<string> {
      return new SignJWT({
        sub, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: tenant,
        authz_version: __resolver.grant(tenant, sub, [...scopes]), site_id: SITE_A,
      })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE)
        .setExpirationTime('1h').sign(key);
    }
    async function get(id: string, token: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/submittals/${id}/workspace`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    }

    const __resolver = new ConfigurableTestResolver();

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATION_FILES) await db.query(readFileSync(m, 'utf8'));

      // 'ats' entitlement for BOTH tenants so EntitlementGuard admits them — the
      // cross-tenant test then exercises the workspace's own tenant CONCEALMENT (404),
      // not the coarser entitlement refusal (403).
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
      }

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
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER).useValue(__resolver).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      port = (await app.listen(0) as unknown as { address(): AddressInfo }).address().port;

      // ---- seed a submitted-to-client submittal + its context ----
      await db.query(`INSERT INTO company."Company" (id,tenant_id,site_id,name) VALUES ($1,$2,$3,'Freddie Mac')`, [COMPANY, TENANT_A, SITE_A]);
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id,tenant_id,first_name,last_name,title,city,state,work_authorization,email1,phone_cell)
         VALUES ($1,$2,'Divya','Vasudevan','Scrum Master','McLean','VA','permanent_resident','divya@example.com','+15550000000')`,
        [TALENT, TENANT_A],
      );
      JOB = randomUUID();
      await db.query(
        `INSERT INTO requisition."Requisition" (id,tenant_id,title,requisition_number,company_id,status,bill_rate_amount,bill_rate_currency,bill_rate_period)
         VALUES ($1,$2,'Scrum Master',5001,$3,'open'::requisition."RecruitingStatus",92.00,'USD','HOURLY'::requisition."RatePeriod")`,
        [JOB, TENANT_A, COMPANY],
      );
      // assignment → requisition visibility for RECRUITER.
      await db.query(
        `INSERT INTO requisition."RequisitionAssignment" (id,tenant_id,requisition_id,user_id,assigned_at,assigned_by_id) VALUES ($1,$2,$3,$4,now(),$5)`,
        [randomUUID(), TENANT_A, JOB, RECRUITER, RECRUITER],
      );
      const pipeId = await seedLivePipelineEpisode((s, p) => db.query(s, p), { tenant_id: TENANT_A, talent_record_id: TALENT, requisition_id: JOB });
      await db.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id,tenant_id,talent_id,job_id,evidence_package_id,pinned_examination_id,state,created_by,pipeline_id,
            submitted_bill_rate,submitted_rate_currency,submitted_rate_period,submitted_at,delivery_channel,external_reference,submitted_by_actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,'submitted_to_client'::submittal."SubmittalState",$7,$8,90.00,'USD','HOURLY',now(),'manual_vms','FG-5001',$7)`,
        [SUB, TENANT_A, TALENT, JOB, randomUUID(), randomUUID(), RECRUITER, pipeId],
      );
      // client-selection process (INTERVIEW) + process events (+ decoys that MUST be excluded).
      await db.query(
        `INSERT INTO client_selection."ClientSelectionProcess" (id,tenant_id,submittal_id,requisition_id,talent_id,state,version)
         VALUES ($1,$2,$3,$4,$5,'INTERVIEW'::client_selection."ClientSelectionState",2)`,
        [CSP, TENANT_A, SUB, JOB, TALENT],
      );
      const ev = (subjectType: string, subjectId: string, tenant: string, type: string, payload: unknown, agoHours: number) =>
        db.query(
          `INSERT INTO client_selection."ClientSelectionEvent" (id,tenant_id,subject_type,subject_id,event_type,event_payload,created_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb, now() - ($7 || ' hours')::interval)`,
          [randomUUID(), tenant, subjectType, subjectId, type, JSON.stringify(payload), String(agoHours)],
        );
      await ev('process', CSP, TENANT_A, 'client_selection.process.created', { to_state: 'CLIENT_REVIEW' }, 3);
      await ev('process', CSP, TENANT_A, 'client_selection.process.state_transition', { to_state: 'INTERVIEW', note: 'Client wants a first interview' }, 1);
      await ev('session', CSP, TENANT_A, 'client_selection.session.created', { to_state: 'SCHEDULED', note: 'DECOY-session' }, 2);
      await ev('process', randomUUID(), TENANT_A, 'client_selection.process.state_transition', { to_state: 'DECLINED', note: 'DECOY-other-process' }, 2);
      await ev('process', CSP, TENANT_B, 'client_selection.process.state_transition', { to_state: 'WITHDRAWN', note: 'DECOY-other-tenant' }, 2);
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('200 + correct ClientSelection state; feedback/history from the right process events; decoys excluded', async () => {
      const { status, body } = await get(SUB, await jwt(['talent:read', 'compensation:view:bill']));
      expect(status).toBe(200);
      expect(body.identity).toMatchObject({ submittal_id: SUB, talent: { name: 'Divya Vasudevan' }, company: { name: 'Freddie Mac' } });
      expect(body.submittal.state).toBe('submitted_to_client');
      expect(body.client_selection.present).toBe(true);
      expect(body.client_selection.state).toBe('INTERVIEW');
      // feedback = exactly the two PROCESS events (newest first), from this process + tenant only.
      expect(body.client_selection.feedback.map((f: any) => f.to_state)).toEqual(['INTERVIEW', 'CLIENT_REVIEW']);
      const notes = body.client_selection.feedback.map((f: any) => f.note);
      expect(notes).not.toContain('DECOY-session');
      expect(notes).not.toContain('DECOY-other-process');
      expect(notes).not.toContain('DECOY-other-tenant');
      expect(body.client_selection).toMatchObject({ process_id: CSP, version: 2 });
    });

    it('FIELD AUTHZ: commercial present with compensation scope; absent (null) without it', async () => {
      const withScope = await get(SUB, await jwt(['talent:read', 'compensation:view:bill']));
      expect(withScope.body.commercial).toMatchObject({ submitted_bill_rate: '90.00', submitted_rate_currency: 'USD' });
      const noScope = await get(SUB, await jwt(['talent:read']));
      expect(noScope.body.commercial).toBeNull();
    });

    it('TENANT: another tenant cannot read the submittal → 404 (never leaks existence)', async () => {
      const { status } = await get(SUB, await jwt(['talent:read'], TENANT_B));
      expect(status).toBe(404);
    });

    it('UNAUTHENTICATED: no token → 401 (guards live)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/submittals/${SUB}/workspace`);
      expect(res.status).toBe(401);
    });
  },
);
