import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import {
  ClientSelectionProcessRepository,
  ClientSelectionPrismaService,
} from '@aramo/client-selection';

// Lane 2 / L2-F (F1) — the apps/api create-from-submittal orchestration proof. The
// owner lib spec proves the aggregate (create + CAS + immutability + the @@unique
// negative); THIS spec proves the composition seam that the lib deliberately cannot:
//   F1.1(pos): a real Submittal resolves to a created process with the DERIVED keys —
//     requisition_id = submittal.job_id, talent_id from the submittal, site_id from the
//     linked Pipeline (nullable, R4).
//   F1.1(neg): a non-existent / cross-tenant / not-visible Submittal is refused
//     CLIENT_SELECTION_SUBMITTAL_INVALID (409) — the negative acceptance.
// Real Postgres 17 testcontainer; the orchestration + repository are instantiated
// directly (no Nest app) against curated migrations, mirroring submit-talent.integration.

const { ClientSelectionCreateFromSubmittalService } = await import(
  '../client-selection/client-selection-create.service.js'
);

const MIGRATIONS = [
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql',
  'libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
  'libs/submittal/prisma/migrations/20260526140602_add_submittal_event_log/migration.sql',
  'libs/submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
  'libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql',
  'libs/submittal/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
  'libs/submittal/prisma/migrations/20260812120000_t2p1_relocate_submittal_to_submittal_schema/migration.sql',
  'libs/submittal/prisma/migrations/20260822130000_l8b1_submittal_pipeline_link/migration.sql',
  'libs/client-selection/prisma/migrations/20260829120000_l2f_init_client_selection/migration.sql',
];

const logger = { log: () => undefined, error: () => undefined, warn: () => undefined } as never;

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ClientSelectionCreateFromSubmittalService — create-from-submittal orchestration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let sql: Client;
    let csPrisma: ClientSelectionPrismaService;
    let repo: ClientSelectionProcessRepository;
    let svc: InstanceType<typeof ClientSelectionCreateFromSubmittalService>;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      sql = new Client({ connectionString: url });
      await sql.connect();
      // pg native multi-statement query is comment-safe (no splitDdl trap).
      for (const p of MIGRATIONS) await sql.query(readFileSync(p, 'utf8'));
      csPrisma = new ClientSelectionPrismaService(url);
      await csPrisma.$connect();
      repo = new ClientSelectionProcessRepository(csPrisma);
      svc = new ClientSelectionCreateFromSubmittalService(csPrisma, repo, logger);
    }, 180_000);

    afterAll(async () => {
      await csPrisma?.$disconnect();
      await sql?.end();
      await container?.stop();
    });

    beforeEach(async () => {
      // Clean slate per test (client_selection rows use a tenant-reset escape for the
      // append-only event log DELETE).
      await sql.query(`SELECT set_config('app.tenant_reset','authorized',false)`);
      await sql.query(`DELETE FROM "client_selection"."ClientSelectionEvent"`);
      await sql.query(`DELETE FROM "client_selection"."OutboxEvent"`);
      await sql.query(`DELETE FROM "client_selection"."ClientSelectionProcess"`);
      await sql.query(`SELECT set_config('app.tenant_reset','',false)`);
      await sql.query(`DELETE FROM "submittal"."TalentSubmittalRecord"`);
      await sql.query(`DELETE FROM "pipeline"."Pipeline"`);
    });

    async function seedPipeline(t: string, id: string, talent: string, req: string, siteId: string | null): Promise<void> {
      await sql.query(
        `INSERT INTO pipeline."Pipeline" (id,tenant_id,talent_record_id,requisition_id,site_id,status)
         VALUES ($1,$2,$3,$4,$5,'qualifying'::pipeline."PipelineStatus")`,
        [id, t, talent, req, siteId],
      );
    }
    async function seedSubmittal(t: string, id: string, talent: string, job: string, pipelineId: string | null): Promise<void> {
      await sql.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id,tenant_id,talent_id,job_id,evidence_package_id,pinned_examination_id,state,created_by,pipeline_id)
         VALUES ($1,$2,$3,$4,$5,$6,'ready_for_review'::submittal."SubmittalState",$7,$8)`,
        [id, t, talent, job, randomUUID(), randomUUID(), randomUUID(), pipelineId],
      );
    }

    // F1.1(pos) — a real Submittal linked to a Pipeline resolves to a created process
    // carrying the DERIVED keys: requisition_id = job_id, talent_id, site_id from the
    // linked Pipeline.
    it('F1.1(pos): creates a process from a Submittal, deriving requisition_id/talent_id + site_id from the linked Pipeline', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const site = randomUUID();
      const pipelineId = randomUUID();
      const submittalId = randomUUID();
      await seedPipeline(TENANT_A, pipelineId, talent, req, site);
      await seedSubmittal(TENANT_A, submittalId, talent, req, pipelineId);

      const view = await svc.createFromSubmittal({
        tenant_id: TENANT_A,
        submittal_id: submittalId,
        created_by_id: randomUUID(),
        visible_requisition_ids: null,
        requestId: 'req-pos',
      });

      expect(view.submittal_id).toBe(submittalId);
      expect(view.requisition_id).toBe(req);
      expect(view.talent_id).toBe(talent);
      expect(view.site_id).toBe(site);
      expect(view.state).toBe('CLIENT_REVIEW');
      expect(view.version).toBe(0);

      // The birth event + outbox row exist (durable substrate).
      const events = await sql.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM "client_selection"."ClientSelectionEvent" WHERE subject_id=$1`,
        [view.id],
      );
      expect(events.rows[0]!.c).toBe('1');
    }, 60_000);

    // F1.1(pos, site_id null branch) — a Submittal with NO pipeline link creates a
    // process with site_id = null (R4: site_id is nullable, derived-or-absent).
    it('F1.1(pos): a Submittal with no pipeline link creates a process with site_id = null', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const submittalId = randomUUID();
      await seedSubmittal(TENANT_A, submittalId, talent, req, null);

      const view = await svc.createFromSubmittal({
        tenant_id: TENANT_A,
        submittal_id: submittalId,
        visible_requisition_ids: null,
        requestId: 'req-pos-nolink',
      });

      expect(view.requisition_id).toBe(req);
      expect(view.talent_id).toBe(talent);
      expect(view.site_id).toBeNull();
    }, 60_000);

    // F1.1(neg) — a non-existent Submittal is refused CLIENT_SELECTION_SUBMITTAL_INVALID
    // (409); no process is written.
    it('F1.1(neg): a non-existent Submittal is refused CLIENT_SELECTION_SUBMITTAL_INVALID (409)', async () => {
      await expect(
        svc.createFromSubmittal({
          tenant_id: TENANT_A,
          submittal_id: randomUUID(),
          visible_requisition_ids: null,
          requestId: 'req-neg-missing',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_SUBMITTAL_INVALID', statusCode: 409 });

      const rows = await sql.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM "client_selection"."ClientSelectionProcess"`,
      );
      expect(rows.rows[0]!.c).toBe('0');
    }, 60_000);

    // F1.1(neg) — a Submittal that exists only under ANOTHER tenant is refused for the
    // calling tenant (cross-tenant isolation), same SUBMITTAL_INVALID (409).
    it('F1.1(neg): a cross-tenant Submittal is refused CLIENT_SELECTION_SUBMITTAL_INVALID (409)', async () => {
      const submittalId = randomUUID();
      await seedSubmittal(TENANT_B, submittalId, randomUUID(), randomUUID(), null);

      await expect(
        svc.createFromSubmittal({
          tenant_id: TENANT_A,
          submittal_id: submittalId,
          visible_requisition_ids: null,
          requestId: 'req-neg-xtenant',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_SUBMITTAL_INVALID', statusCode: 409 });
    }, 60_000);

    // F1.1(neg, visibility) — a Submittal whose requisition the actor cannot see is
    // concealed as SUBMITTAL_INVALID (never a 403/existence leak).
    it('F1.1(neg): a Submittal whose requisition is not visible is concealed as SUBMITTAL_INVALID (409)', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const submittalId = randomUUID();
      await seedSubmittal(TENANT_A, submittalId, talent, req, null);

      await expect(
        svc.createFromSubmittal({
          tenant_id: TENANT_A,
          submittal_id: submittalId,
          // Actor sees only some OTHER requisition, not `req`.
          visible_requisition_ids: new Set<string>([randomUUID()]),
          requestId: 'req-neg-invisible',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_SUBMITTAL_INVALID', statusCode: 409 });
    }, 60_000);
  },
);
