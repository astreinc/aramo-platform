import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { PrismaService } from '@aramo/submittal-eligibility';
import type { ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';

import { SubmittalWorkspaceService, type SubmittalWorkspaceContext } from '../submittal-workspace/submittal-workspace.service.js';
import type { EngagementGateService } from '../engagement/engagement-gate.service.js';
import type { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';

import { applyPipelineSchema, seedLivePipelineEpisode } from './sw1-live-pipeline.fixture.js';


// SW-4 — real-Postgres integration for the Submittal Workspace composition. It
// exercises the service's cross-schema raw reads + tenant scoping + visibility
// concealment + FIELD-LEVEL commercial authorization + the SW-3 readiness wiring
// against a real DB. The three external domain verdicts (engagement / RTR / client
// policy) are STUBBED — they are unit-covered here and own lib-local integration
// tests — so this harness stays to the schemas the workspace SQL actually reads.

const ROOT = resolve(__dirname, '../../../..');
// Full migration folders (applied in order) for the schemas the workspace SELECTs.
const SCHEMA_DIRS = [
  'libs/company/prisma/migrations',
  'libs/talent-record/prisma/migrations',
  'libs/requisition/prisma/migrations',
  'libs/submittal/prisma/migrations',
  'libs/submittal-eligibility/prisma/migrations',
  'libs/client-talent-restriction/prisma/migrations',
  'libs/client-selection/prisma/migrations',
];

function migrationFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCHEMA_DIRS) {
    const abs = resolve(ROOT, dir);
    const subs = readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const s of subs) out.push(resolve(abs, s, 'migration.sql'));
  }
  return out;
}

const stubEngagement = {
  resolveApplicability: async () => 'dormant' as const,
  readReadiness: async () => ({
    governed: false, policy_present: false, satisfied: true,
    enforcement_mode: null, override_available: false, results: [], missing: [], unavailable: false, capabilities: {},
  }),
} as unknown as EngagementGateService;
const stubDoc = { assess: async () => ({ satisfied: true, deny: null }) } as unknown as DocumentReadinessGate;
const stubCsp = { resolveEffective: async () => null, decide: () => ({ decision: 'ALLOW', reason_code: '', required_capabilities: [] }) } as unknown as ClientSubmittalPolicyService;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SubmittalWorkspaceService — composition over real Postgres',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: Client;
    let prisma: PrismaService;
    let service: SubmittalWorkspaceService;

    const TENANT = randomUUID();
    const OTHER_TENANT = randomUUID();
    const TALENT = randomUUID();
    const JOB = randomUUID();
    const COMPANY = randomUUID();
    const SUB = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      setup = new Client({ connectionString: url });
      await setup.connect();
      // node-pg handles multi-statement + dollar-quoted bodies natively.
      for (const f of migrationFiles()) await setup.query(readFileSync(f, 'utf8'));
      await applyPipelineSchema((s) => setup.query(s), ROOT);
      // The working-résumé-selection table lives in the pipeline schema, in a separate
      // migration from the live-episode set the SW-1 fixture applies.
      await setup.query(
        readFileSync(resolve(ROOT, 'libs/pipeline/prisma/migrations/20260920120000_talent_intel_1d_d_requisition_resume/migration.sql'), 'utf8'),
      );

      // Seed a fully-ready submittal + its context (raw; the INSERT bypasses the
      // BEFORE-UPDATE immutability trigger). Requisition open + bill rate; talent;
      // company; a LIVE pipeline episode; a working résumé selection.
      await setup.query(
        `INSERT INTO company."Company" (id,tenant_id,name) VALUES ($1,$2,'Freddie Mac')`,
        [COMPANY, TENANT],
      );
      await setup.query(
        `INSERT INTO talent_record."TalentRecord" (id,tenant_id,first_name,last_name,title,city,state,work_authorization,email1,phone_cell)
         VALUES ($1,$2,'Divya','Vasudevan','Scrum Master','Austin','TX','US_CITIZEN','divya@example.com','+15550000000')`,
        [TALENT, TENANT],
      );
      await setup.query(
        `INSERT INTO requisition."Requisition" (id,tenant_id,title,requisition_number,company_id,status,bill_rate_amount,bill_rate_currency,bill_rate_period)
         VALUES ($1,$2,'Scrum Master',1001,$3,'open'::requisition."RecruitingStatus",92.00,'USD','HOURLY'::requisition."RatePeriod")`,
        [JOB, TENANT, COMPANY],
      );
      const pipeId = await seedLivePipelineEpisode((s, p) => setup.query(s, p), {
        tenant_id: TENANT, talent_record_id: TALENT, requisition_id: JOB,
      });
      await setup.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id,tenant_id,talent_id,job_id,evidence_package_id,pinned_examination_id,state,created_by,pipeline_id,
            submitted_bill_rate,submitted_rate_currency,submitted_rate_period)
         VALUES ($1,$2,$3,$4,$5,$6,'ready_for_review'::submittal."SubmittalState",$7,$8,90.00,'USD','HOURLY')`,
        [SUB, TENANT, TALENT, JOB, randomUUID(), randomUUID(), randomUUID(), pipeId],
      );
      await setup.query(
        `INSERT INTO pipeline."TalentRequisitionResume" (id,tenant_id,talent_record_id,requisition_id,resume_edition_id,selected_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), TENANT, TALENT, JOB, randomUUID(), randomUUID()],
      );

      prisma = new PrismaService(url);
      await prisma.$connect();
      service = new SubmittalWorkspaceService(prisma, stubEngagement, stubDoc, stubCsp);
    }, 240_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await setup?.end();
      await container?.stop();
    });

    const ctx = (o: Partial<SubmittalWorkspaceContext> = {}): SubmittalWorkspaceContext => ({
      tenant_id: TENANT,
      visible_requisition_ids: null,
      scopes: new Set(['talent:read', 'compensation:view:bill']),
      submit_authority: true,
      request_id: 'it-1',
      ...o,
    });

    it('composes the full view; ready seed → readiness READY + commercial present (live + frozen)', async () => {
      const r = await service.compose(ctx(), SUB);
      expect(r.identity).toMatchObject({ submittal_id: SUB, talent: { name: 'Divya Vasudevan' }, requisition: { title: 'Scrum Master' }, company: { name: 'Freddie Mac' } });
      expect(r.pipeline).toMatchObject({ current_stage: 'qualifying', is_live: true });
      expect(r.readiness.status).toBe('READY');
      expect(r.documents.resume_selected).toBe(true);
      expect(r.commercial).toMatchObject({
        live_bill_rate_amount: '92.00', live_bill_rate_currency: 'USD',
        submitted_bill_rate: '90.00', submitted_rate_currency: 'USD', submitted_rate_period: 'HOURLY',
      });
      expect(r.actions.can_submit_to_client).toBe(true);
      expect(r.actions.submit_authority).toBe(true);
    });

    it('AUTHZ (D-6): READY but no submit authority → can_submit_to_client false (view-only)', async () => {
      const r = await service.compose(ctx({ submit_authority: false }), SUB);
      expect(r.readiness.status).toBe('READY');
      expect(r.actions.can_submit_to_client).toBe(false);
      expect(r.actions.submit_authority).toBe(false);
    });

    it('FIELD AUTHZ: no compensation scope → commercial null (frozen snapshot not leaked)', async () => {
      const r = await service.compose(ctx({ scopes: new Set(['talent:read']) }), SUB);
      expect(r.commercial).toBeNull();
    });

    it('TENANT: a different tenant cannot read the submittal → NOT_FOUND', async () => {
      await expect(service.compose(ctx({ tenant_id: OTHER_TENANT }), SUB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('VISIBILITY: requisition outside the visible set → concealed as NOT_FOUND', async () => {
      await expect(service.compose(ctx({ visible_requisition_ids: new Set([randomUUID()]) }), SUB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // but the real requisition in the set admits.
      const r = await service.compose(ctx({ visible_requisition_ids: new Set([JOB]) }), SUB);
      expect(r.identity.submittal_id).toBe(SUB);
    });
  },
);
