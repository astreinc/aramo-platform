import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { PipelinePrismaService, PipelineRepository } from '@aramo/pipeline';
import { DocumentIdempotencyService, DocumentsRepository, PrismaService as DocumentsPrismaService } from '@aramo/documents';
import { ClientSubmittalPolicyService, checksumDefinition } from '@aramo/client-submittal-policy';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import { ClientSubmittalPolicyGatewayAdapter } from '../client-submittal-policy/client-submittal-policy-gateway.adapter.js';
import { DocumentReadinessGate, RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/document-readiness.gate.js';
import { RtrQualifiedTransitionGuard } from '../rtr/rtr-qualified-transition-guard.module.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §4 (S1, A1 AM-6) — RTR policy
// integrity on REAL Postgres 17, through the REAL composition: PipelineRepository →
// RtrQualifiedTransitionGuard → DocumentReadinessGate → ClientSubmittalPolicyService →
// the raw-SQL policy gateway (advisory-locked publish) + documents.
//   §4.1/§4.2  the R5 matrix (5 rows) + D-4 + NO_KEY + FLOOR; UNRESOLVED refuses Qualified.
//   §4.3       RTR-versus-Qualified atomicity (executed RTR FOR SHARE) — both orders.
//   §4.4       policy-publish-versus-Qualified linearization — both orders; concurrent
//              publishes leave ONE open window; explicit effective_from refused (PO C-1).
//   §4.4(g)    lock coverage: the generic PolicyStore.publish refuses client-submittal packages.
//   §4.5       an unbound guard refuses `qualified`; bypass via applyAction QUALIFY refused.
//   §4.6       the applied policy (source/version/checksum/t_L) is audited in-tx.
//   §2.2 T-3   a lock-wait timeout surfaces as 409 TRANSACTION_CONFLICT_RETRYABLE, no writes.

const ROOT = resolve(__dirname, '../../../..');
const migrationsFor = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};
const MIGRATIONS = [
  ...migrationsFor('requisition'),
  ...migrationsFor('activity'),
  ...migrationsFor('metering'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('documents'),
];

const ACTOR = '01900000-0000-7000-8000-00000000a001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'S1 — RTR policy integrity (Talent Lifecycle R1–R5 v1.2 §4; real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let url: string;
    let db: Client;
    let pipelinePrisma: PipelinePrismaService;
    let docsPrisma: DocumentsPrismaService;
    let policyPrisma: PolicyStorePrismaService;
    let csp: ClientSubmittalPolicyService;
    let repo: PipelineRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATIONS) await db.query(readFileSync(m, 'utf8'));

      pipelinePrisma = new PipelinePrismaService(url);
      docsPrisma = new DocumentsPrismaService(url);
      policyPrisma = new PolicyStorePrismaService(url);
      await Promise.all([pipelinePrisma.$connect(), docsPrisma.$connect(), policyPrisma.$connect()]);

      csp = new ClientSubmittalPolicyService(new ClientSubmittalPolicyGatewayAdapter(policyPrisma as never));
      const gate = new DocumentReadinessGate(
        new DocumentsRepository(docsPrisma, new DocumentIdempotencyService(docsPrisma)),
        csp,
        {
          findCompanyId: async ({ tenant_id, id }) =>
            ((
              await db.query<{ company_id: string | null }>(
                `SELECT company_id FROM requisition."Requisition" WHERE id=$1 AND tenant_id=$2`,
                [id, tenant_id],
              )
            ).rows[0]?.company_id ?? null),
        },
      );
      repo = new PipelineRepository(pipelinePrisma, new RtrQualifiedTransitionGuard(gate));
    }, 180_000);

    afterAll(async () => {
      await pipelinePrisma?.$disconnect();
      await docsPrisma?.$disconnect();
      await policyPrisma?.$disconnect();
      await db?.end();
      await container?.stop();
    }, 60_000);

    // ---- seed + act helpers ------------------------------------------------------------
    async function seedFixture(tenant = randomUUID()): Promise<{
      tenant: string; company: string; req: string; talent: string; pipeline: string;
    }> {
      const company = randomUUID();
      const req = randomUUID();
      const talent = randomUUID();
      const pipeline = randomUUID();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number)
         VALUES ($1,$2,'S1 fixture',$3,'open'::requisition."RecruitingStatus",
                 (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2))`,
        [req, tenant, company],
      );
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'qualifying'::"pipeline"."PipelineStatus",now(),now())`,
        [pipeline, tenant, talent, req],
      );
      return { tenant, company, req, talent, pipeline };
    }

    async function seedExecutedRtr(tenant: string, req: string, talent: string): Promise<string> {
      const docId = randomUUID();
      await db.query(
        `INSERT INTO documents."Document"
           (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by, executed_at)
         VALUES ($1,$2,$3,'RTR','EXECUTED','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$4,now())`,
        [docId, tenant, RIGHT_TO_REPRESENT_TYPE_ID, randomUUID()],
      );
      for (const [rtype, rid, rel] of [['REQUISITION', req, 'REGARDING'], ['TALENT', talent, 'SUBJECT']] as const) {
        await db.query(
          `INSERT INTO documents."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), tenant, docId, rtype, rid, rel, randomUUID()],
        );
      }
      return docId;
    }

    async function publish(
      tenant: string,
      scope: 'TENANT' | 'CLIENT' | 'REQUISITION',
      scope_ref: string | null,
      disposition: 'REQUIRED' | 'NOT_REQUIRED',
      opts: { version?: string; override_policy?: 'DEFAULT' | 'FLOOR'; key?: string } = {},
    ): Promise<void> {
      await csp.publish({
        tenant_id: tenant,
        scope,
        scope_ref,
        version: opts.version ?? '1.0.0',
        definition: {
          requirements: [
            {
              key: opts.key ?? 'rtr_present',
              disposition,
              override_class: 'HARD_DENY',
              override_policy: opts.override_policy ?? 'DEFAULT',
            },
          ],
        },
        published_by: ACTOR,
      });
    }

    async function versionOf(pipeline: string): Promise<number> {
      return (await db.query<{ version: number }>(`SELECT version FROM pipeline."Pipeline" WHERE id=$1`, [pipeline]))
        .rows[0]!.version;
    }
    async function statusOf(pipeline: string): Promise<string> {
      return (await db.query<{ status: string }>(`SELECT status FROM pipeline."Pipeline" WHERE id=$1`, [pipeline]))
        .rows[0]!.status;
    }

    async function qualify(f: { tenant: string; pipeline: string }, r: PipelineRepository = repo) {
      return r.transition({
        tenant_id: f.tenant,
        id: f.pipeline,
        to_status: 'qualified',
        changed_by_id: ACTOR,
        requestId: `s1-${randomUUID()}`,
        expected_version: await versionOf(f.pipeline),
        visible_requisition_ids: null,
      });
    }

    async function errorOf(p: Promise<unknown>): Promise<{ code?: string; statusCode?: number; reason?: unknown }> {
      try {
        await p;
        return { code: 'NO_THROW' };
      } catch (e) {
        const err = e as { code?: string; statusCode?: number; context?: { details?: { reason?: unknown } } };
        return { code: err.code, statusCode: err.statusCode, reason: err.context?.details?.reason };
      }
    }

    // Poll until a lock wait is visible in pg_locks (a backend is BLOCKED), bounded.
    async function waitUntilBlocked(predicateSql: string): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const r = await db.query<{ n: string }>(predicateSql);
        if (Number(r.rows[0]!.n) > 0) return;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error('timed out waiting for a blocked backend');
    }
    const ANY_UNGRANTED = `SELECT count(*)::text AS n FROM pg_locks WHERE NOT granted`;

    async function settledWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
      const marker = Symbol('pending');
      const r = await Promise.race([p.then(() => 'done', () => 'done'), new Promise((res) => setTimeout(() => res(marker), ms))]);
      return r !== marker;
    }

    // ---- §4.1/§4.2 — the R5 matrix + D-4 + NO_KEY + FLOOR ----------------------------------
    describe('R5 matrix (R-DIR §1 R5; A1 AM-6 §7.2–§7.4)', () => {
      it('row 1 — tenant NOT_REQUIRED, client missing → NOT_REQUIRED → qualifies with no RTR', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'NOT_REQUIRED');
        await qualify(f);
        expect(await statusOf(f.pipeline)).toBe('qualified');
      });

      it('row 2 — tenant REQUIRED, client missing → REQUIRED: refused without RTR, qualifies with it', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'REQUIRED');
        expect(await errorOf(qualify(f))).toMatchObject({ code: 'PIPELINE_QUALIFY_REQUIRES_RTR', statusCode: 422 });
        expect(await statusOf(f.pipeline)).toBe('qualifying');
        await seedExecutedRtr(f.tenant, f.req, f.talent);
        await qualify(f);
        expect(await statusOf(f.pipeline)).toBe('qualified');
      });

      it('row 3 — tenant NOT_REQUIRED, client REQUIRED → REQUIRED (override permitted) → refused without RTR', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'NOT_REQUIRED');
        await publish(f.tenant, 'CLIENT', f.company, 'REQUIRED');
        expect(await errorOf(qualify(f))).toMatchObject({ code: 'PIPELINE_QUALIFY_REQUIRES_RTR' });
      });

      it('row 4 — tenant REQUIRED (override permitted), client NOT_REQUIRED → NOT_REQUIRED → qualifies', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'REQUIRED');
        await publish(f.tenant, 'CLIENT', f.company, 'NOT_REQUIRED');
        await qualify(f);
        expect(await statusOf(f.pipeline)).toBe('qualified');
      });

      it('row 5 — tenant missing, client missing → UNRESOLVED → 422 PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED', async () => {
        const f = await seedFixture();
        expect(await errorOf(qualify(f))).toEqual({
          code: 'PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED',
          statusCode: 422,
          reason: 'no_policy_layer',
        });
        expect(await statusOf(f.pipeline)).toBe('qualifying');
      });

      it('D-4 — tenant missing, explicit client NOT_REQUIRED → the client setting governs → qualifies', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'CLIENT', f.company, 'NOT_REQUIRED');
        await qualify(f);
        expect(await statusOf(f.pipeline)).toBe('qualified');
      });

      it('NO_KEY — a policy that never declares rtr_present → UNRESOLVED (never "not required")', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'REQUIRED', { key: 'work_authorization_present' });
        expect(await errorOf(qualify(f))).toMatchObject({
          code: 'PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED',
          reason: 'rtr_requirement_not_declared',
        });
      });

      it('FLOOR — a client cannot weaken a tenant FLOOR (publish refused)', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'REQUIRED', { override_policy: 'FLOOR' });
        await expect(publish(f.tenant, 'CLIENT', f.company, 'NOT_REQUIRED')).rejects.toMatchObject({
          code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
        });
        expect(await errorOf(qualify(f))).toMatchObject({ code: 'PIPELINE_QUALIFY_REQUIRES_RTR' });
      });

      it('isolation — another tenant\'s policy and executed RTR never satisfy this tenant', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'REQUIRED');
        const other = randomUUID();
        await publish(other, 'TENANT', null, 'NOT_REQUIRED');
        await seedExecutedRtr(other, f.req, f.talent); // same ids, different tenant
        expect(await errorOf(qualify(f))).toMatchObject({ code: 'PIPELINE_QUALIFY_REQUIRES_RTR' });
      });
    });

    // ---- §4.4(c) / PO ruling C-1 + §4.4(g) lock coverage -------------------------------
    describe('publication rules (PO C-1; §4.4(g))', () => {
      it('an explicit effective_from is refused (immediate effect only)', async () => {
        const tenant = randomUUID();
        await expect(
          csp.publish({
            tenant_id: tenant,
            scope: 'TENANT',
            scope_ref: null,
            version: '1.0.0',
            definition: { requirements: [{ key: 'rtr_present', disposition: 'NOT_REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }] },
            published_by: ACTOR,
            effective_from: new Date(Date.now() + 86_400_000),
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        const rows = await db.query(`SELECT 1 FROM policy_store."StoredPolicyVersion" WHERE tenant_id=$1`, [tenant]);
        expect(rows.rowCount).toBe(0);
      });

      it('effective_from is the DATABASE clock at publication', async () => {
        const tenant = randomUUID();
        const before = (await db.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
        await publish(tenant, 'TENANT', null, 'NOT_REQUIRED');
        const after = (await db.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
        const ef = (await db.query<{ effective_from: Date }>(
          `SELECT effective_from FROM policy_store."StoredPolicyVersion" WHERE tenant_id=$1`, [tenant],
        )).rows[0]!.effective_from;
        expect(ef.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
        expect(ef.getTime()).toBeLessThanOrEqual(new Date(after).getTime());
      });

      it('lock coverage — the generic PolicyStore.publish refuses a client-submittal-policy package', async () => {
        const store = new PolicyStore(policyPrisma);
        await expect(
          store.publish({
            tenant_id: randomUUID(),
            published_by: ACTOR,
            definition: {
              name: 'client-submittal-policy',
              version: '9.9.9',
              registry: { resources: ['REQUISITION_TALENT'], actions: ['ADD'] },
              default_disposition: { decision: 'ALLOW', reason_code: 'X' },
              rules: [],
            },
          }),
        ).rejects.toThrow(/client-submittal/);
      });

      it('concurrent publishes for one tenant serialize: exactly ONE open window remains', async () => {
        const tenant = randomUUID();
        await publish(tenant, 'TENANT', null, 'NOT_REQUIRED', { version: '1.0.0' });
        await Promise.all([
          publish(tenant, 'TENANT', null, 'REQUIRED', { version: '2.0.0' }),
          publish(tenant, 'TENANT', null, 'NOT_REQUIRED', { version: '3.0.0' }),
        ]);
        const open = await db.query(
          `SELECT version FROM policy_store."StoredPolicyVersion"
            WHERE tenant_id=$1 AND package_name='client-submittal-policy' AND effective_to IS NULL`,
          [tenant],
        );
        expect(open.rowCount).toBe(1);
      });
    });

    // ---- §4.5 mandatory guard + bypass --------------------------------------------------
    describe('mandatory guard + bypass (§4.5)', () => {
      it('a repository WITHOUT the guard refuses qualified (rtr_guard_unbound) — never ungated', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'NOT_REQUIRED');
        const unguarded = new PipelineRepository(pipelinePrisma);
        expect(await errorOf(qualify(f, unguarded))).toMatchObject({
          code: 'PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED',
          reason: 'rtr_guard_unbound',
        });
        expect(await statusOf(f.pipeline)).toBe('qualifying');
      });

      it('applyAction QUALIFY (the /actions + provider path) is gated identically', async () => {
        const f = await seedFixture(); // no policy → UNRESOLVED
        const err = await errorOf(
          repo.applyAction({
            tenant_id: f.tenant,
            id: f.pipeline,
            action: 'QUALIFY',
            expected_version: await versionOf(f.pipeline),
            changed_by_id: ACTOR,
            requestId: 's1-actions',
            visible_requisition_ids: null,
          }),
        );
        expect(err.code).toBe('PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED');
      });
    });

    // ---- §4.6 audit ---------------------------------------------------------------------
    it('audit — the applied RTR policy (source/version/checksum/t_L) is recorded in-tx + on the outbox', async () => {
      const f = await seedFixture();
      await publish(f.tenant, 'TENANT', null, 'NOT_REQUIRED');
      await publish(f.tenant, 'CLIENT', f.company, 'REQUIRED', { version: '2.0.0' });
      await seedExecutedRtr(f.tenant, f.req, f.talent);
      await qualify(f);
      const rec = await db.query<{ inputs: { derived: { rtr_policy: Record<string, unknown> } }; action: string }>(
        `SELECT inputs, action FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND action='QUALIFY'`,
        [f.tenant],
      );
      expect(rec.rowCount).toBe(1);
      const rp = rec.rows[0]!.inputs.derived.rtr_policy;
      expect(rp).toMatchObject({ disposition: 'REQUIRED', source: 'CLIENT_OVERRIDE', scope_ref: f.company, version: '2.0.0' });
      expect(typeof rp['checksum']).toBe('string');
      expect(typeof rp['resolved_at']).toBe('string');
      const ob = await db.query<{ event_payload: { rtr_policy?: Record<string, unknown> } }>(
        `SELECT event_payload FROM pipeline."OutboxEvent"
          WHERE tenant_id=$1 AND event_type='pipeline.state_transition' AND event_payload->>'to_status'='qualified'`,
        [f.tenant],
      );
      expect(ob.rows[0]!.event_payload.rtr_policy).toMatchObject({ source: 'CLIENT_OVERRIDE', version: '2.0.0' });
    });

    // ---- §4.3 Concurrency A — RTR invalidation versus Qualified -------------------------
    describe('Concurrency A — RTR invalidation versus Qualified (§4.3; LR-F B)', () => {
      it('(i) Qualified holds the executed RTR FOR SHARE → a void UPDATE cannot proceed until it commits', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'REQUIRED');
        const doc = await seedExecutedRtr(f.tenant, f.req, f.talent);
        // Pause the Qualified tx AFTER its RTR lock: block its later history INSERT.
        const pauser = new Client({ connectionString: url });
        const voider = new Client({ connectionString: url });
        await pauser.connect();
        await voider.connect();
        try {
          await pauser.query('BEGIN');
          await pauser.query('LOCK TABLE pipeline."PipelineStatusHistory" IN EXCLUSIVE MODE');
          const q = qualify(f);
          await waitUntilBlocked(ANY_UNGRANTED);
          // The Qualified tx now holds the Document row FOR SHARE: the void must not get it.
          await voider.query('BEGIN');
          await voider.query(`SET LOCAL lock_timeout = '1500ms'`);
          await expect(
            voider.query(`UPDATE documents."Document" SET status='VOIDED' WHERE id=$1`, [doc]),
          ).rejects.toMatchObject({ code: '55P03' });
          await voider.query('ROLLBACK');
          await pauser.query('COMMIT');
          await q;
          expect(await statusOf(f.pipeline)).toBe('qualified');
        } finally {
          await pauser.end();
          await voider.end();
        }
      });

      it('(ii) a void committed first → Qualified re-checks status under the lock and is refused 422', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'REQUIRED');
        const doc = await seedExecutedRtr(f.tenant, f.req, f.talent);
        const voider = new Client({ connectionString: url });
        await voider.connect();
        try {
          await voider.query('BEGIN');
          await voider.query(`UPDATE documents."Document" SET status='VOIDED' WHERE id=$1`, [doc]);
          const q = errorOf(qualify(f));
          await waitUntilBlocked(ANY_UNGRANTED); // Qualified waits on the row
          await voider.query('COMMIT');
          expect(await q).toMatchObject({ code: 'PIPELINE_QUALIFY_REQUIRES_RTR', statusCode: 422 });
          expect(await statusOf(f.pipeline)).toBe('qualifying');
          const hist = await db.query(`SELECT 1 FROM pipeline."PipelineStatusHistory" WHERE pipeline_id=$1`, [f.pipeline]);
          expect(hist.rowCount).toBe(0); // the whole tx rolled back
        } finally {
          await voider.end();
        }
      });
    });

    // ---- §4.4 Concurrency B — policy publish versus Qualified ---------------------------
    describe('Concurrency B — policy publish versus Qualified (§4.4; LR-F A)', () => {
      it('(i) Qualified holds the shared lock → a publish (Not required → Required) waits; Qualified applies the OLD version', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'NOT_REQUIRED', { version: '1.0.0' });
        const pauser = new Client({ connectionString: url });
        await pauser.connect();
        try {
          await pauser.query('BEGIN');
          await pauser.query('LOCK TABLE pipeline."PipelineStatusHistory" IN EXCLUSIVE MODE');
          const q = qualify(f);
          await waitUntilBlocked(ANY_UNGRANTED);
          const pub = publish(f.tenant, 'TENANT', null, 'REQUIRED', { version: '2.0.0' });
          expect(await settledWithin(pub, 1_000)).toBe(false); // blocked on the advisory lock
          await pauser.query('COMMIT');
          await q;
          await pub;
          expect(await statusOf(f.pipeline)).toBe('qualified');
          const rec = await db.query<{ inputs: { derived: { rtr_policy: { version: string; disposition: string } } } }>(
            `SELECT inputs FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND action='QUALIFY'`,
            [f.tenant],
          );
          expect(rec.rows[0]!.inputs.derived.rtr_policy).toMatchObject({ version: '1.0.0', disposition: 'NOT_REQUIRED' });
        } finally {
          await pauser.end();
        }
      });

      it('(ii) a publish holding the exclusive lock commits first → Qualified waits, then applies the NEW version (refused)', async () => {
        const f = await seedFixture();
        await publish(f.tenant, 'TENANT', null, 'NOT_REQUIRED', { version: '1.0.0' });
        const publisher = new Client({ connectionString: url });
        await publisher.connect();
        try {
          const def = { requirements: [{ key: 'rtr_present', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }] };
          await publisher.query('BEGIN');
          await publisher.query(`SELECT pg_advisory_xact_lock(hashtextextended('csp:' || $1::text, 0))`, [f.tenant]);
          const q = errorOf(qualify(f));
          await waitUntilBlocked(ANY_UNGRANTED); // Qualified waits on the shared lock
          await publisher.query(
            `UPDATE policy_store."StoredPolicyVersion" SET effective_to = clock_timestamp()
              WHERE tenant_id=$1 AND package_name='client-submittal-policy' AND effective_to IS NULL`,
            [f.tenant],
          );
          await publisher.query(
            `INSERT INTO policy_store."StoredPolicyVersion"
               (id, tenant_id, package_name, version, definition, checksum, effective_from, effective_to, published_by, published_at)
             VALUES (gen_random_uuid(), $1, 'client-submittal-policy', '2.0.0', $2::jsonb, $3, clock_timestamp(), NULL, $4, now())`,
            [f.tenant, JSON.stringify(def), checksumDefinition(def as never), ACTOR],
          );
          await publisher.query('COMMIT');
          expect(await q).toMatchObject({ code: 'PIPELINE_QUALIFY_REQUIRES_RTR' });
          expect(await statusOf(f.pipeline)).toBe('qualifying');
        } finally {
          await publisher.end();
        }
      });
    });

    // ---- §2.2 T-3 — retryable conflicts ---------------------------------------------------
    it('T-3 — a lock wait beyond the tx timeout → 409 TRANSACTION_CONFLICT_RETRYABLE, nothing written', async () => {
      const f = await seedFixture();
      await publish(f.tenant, 'TENANT', null, 'NOT_REQUIRED');
      const holder = new Client({ connectionString: url });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('csp:' || $1::text, 0))`, [f.tenant]);
        expect(await errorOf(qualify(f))).toMatchObject({ code: 'TRANSACTION_CONFLICT_RETRYABLE', statusCode: 409 });
        await holder.query('ROLLBACK');
      } finally {
        await holder.end();
      }
      expect(await statusOf(f.pipeline)).toBe('qualifying');
      const hist = await db.query(`SELECT 1 FROM pipeline."PipelineStatusHistory" WHERE pipeline_id=$1`, [f.pipeline]);
      expect(hist.rowCount).toBe(0);
    }, 60_000);
  },
);
