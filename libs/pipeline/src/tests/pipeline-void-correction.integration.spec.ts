import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';

import { PipelineRepository } from '../lib/pipeline.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// Accidental-Add Correction — the governed VOID command, end-to-end against real
// Postgres 17. Proves the DOMAIN axis (the apps/api engagement + downstream guards are
// proven separately): VOID succeeds ONLY from no_contact; it releases the live-episode
// slot (a fresh episode can be created after); it writes durable no_contact→voided
// history carrying ADDED_BY_MISTAKE and writes NO PipelineDisposition; CAS rejects a
// stale version; a non-visible episode is concealed as 404; a voided episode cannot be
// re-voided; and a sibling requisition episode for the same Talent is untouched.
// Every criterion carries the non-vacuous BEFORE/AFTER (Rule F).

const MIGRATIONS = [
  '../../../../libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  '../../../../libs/requisition/prisma/migrations/20260907120000_add_requisition_postal_code/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260921160000_rn1_activity_note_extension/migration.sql',
  '../../../../libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  '../../prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  '../../prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  '../../prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  '../../prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  '../../prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  '../../prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  '../../prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  '../../prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
  '../../prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
  // Accidental-Add Correction — the two VOID migrations (enum ADD VALUE own-tx, then
  // the 3-member live-index recreate). Applied in order, exactly as migrate deploy runs.
  '../../prisma/migrations/20260925120000_pipeline_void_add_enum_value/migration.sql',
  '../../prisma/migrations/20260925120100_pipeline_void_live_index_recreate/migration.sql',
].map((p) => resolve(__dirname, p));

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) { cur += ch; if (ch === '\n') inLineComment = false; continue; }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') { inLineComment = true; cur += ch; continue; }
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(cur); cur = ''; } else { cur += ch; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Pipeline VOID accidental-add correction (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let repo: PipelineRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new PrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          if (s.trim()) await setup.$executeRawUnsafe(s.trim());
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PipelineRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setup?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedRequisition(tenant: string): Promise<string> {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, openings, openings_available) ` +
          `VALUES ('${id}', '${tenant}', 'VOID requisition', '${randomUUID()}', 3, 3)`,
      );
      return id;
    }
    const version = async (tenant: string, id: string): Promise<number> =>
      (await repo.findById({ tenant_id: tenant, id }))!.version;
    const status = async (tenant: string, id: string): Promise<string | null> =>
      (await repo.findById({ tenant_id: tenant, id }))?.status ?? null;
    const create = (tenant: string, talent: string, req: string, actor: string) =>
      repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req },
        entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: actor,
      });

    // -----------------------------------------------------------------------------------
    // PC1-1 — VOID from no_contact succeeds, releases the live slot, writes durable history.
    // -----------------------------------------------------------------------------------
    it('PC1-1: no_contact → voided; slot released (re-add creates a FRESH no_contact episode); history recorded', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const actor = randomUUID();
      const req = await seedRequisition(tenant);
      const ep = await create(tenant, talent, req, actor);
      expect(await status(tenant, ep.id)).toBe('no_contact'); // BEFORE

      // BEFORE: while the episode is LIVE, a second create on the same triple is refused.
      let live: unknown;
      try { await create(tenant, talent, req, actor); } catch (e) { live = e; }
      expect((live as AramoError).code).toBe('PIPELINE_EPISODE_ALREADY_LIVE');

      const voided = await repo.void({
        tenant_id: tenant, id: ep.id, reason: 'ADDED_BY_MISTAKE',
        expected_version: await version(tenant, ep.id), changed_by_id: actor,
        requestId: 'v1', visible_requisition_ids: null,
      });
      expect(voided.status).toBe('voided'); // AFTER — exact terminal

      // AFTER: the slot is released → a fresh episode can now be created (new id, no_contact).
      const reAdd = await create(tenant, talent, req, actor);
      expect(reAdd.id).not.toBe(ep.id);
      expect(await status(tenant, reAdd.id)).toBe('no_contact');
      expect(await status(tenant, ep.id)).toBe('voided'); // the original is immutable/terminal

      // Durable history: the no_contact → voided row carries ADDED_BY_MISTAKE; NO disposition.
      const hist = await repo.listHistory({ tenant_id: tenant, pipeline_id: ep.id, requestId: 'h', visible_requisition_ids: null });
      expect(hist.some((h) => h.status_to === 'voided' && h.status_from === 'no_contact' && h.note === 'ADDED_BY_MISTAKE')).toBe(true);
      const dispo = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::int AS n FROM pipeline."PipelineDisposition" WHERE pipeline_id = '${ep.id}'`,
      );
      expect(Number(dispo[0]!.n)).toBe(0); // VOID is never a disposition (§3)
    });

    // -----------------------------------------------------------------------------------
    // PC1-2 — VOID is refused from every non-no_contact state (strict v1 §5).
    // -----------------------------------------------------------------------------------
    it('PC1-2: VOID from contacted / qualified → PIPELINE_VOID_NOT_ALLOWED_FROM_STATE', async () => {
      const tenant = randomUUID(); const actor = randomUUID();
      // contacted
      const rc = await seedRequisition(tenant); const tc = randomUUID();
      const c = await create(tenant, tc, rc, actor);
      await repo.applyAction({ tenant_id: tenant, id: c.id, action: 'CONTACT', expected_version: await version(tenant, c.id), changed_by_id: actor, requestId: 'c', visible_requisition_ids: null });
      expect(await status(tenant, c.id)).toBe('contacted'); // BEFORE
      let e1: unknown;
      try { await repo.void({ tenant_id: tenant, id: c.id, reason: 'ADDED_BY_MISTAKE', expected_version: await version(tenant, c.id), changed_by_id: actor, requestId: 'v', visible_requisition_ids: null }); } catch (e) { e1 = e; }
      expect((e1 as AramoError).code).toBe('PIPELINE_VOID_NOT_ALLOWED_FROM_STATE');
      expect((e1 as AramoError).statusCode).toBe(422);
      expect(await status(tenant, c.id)).toBe('contacted'); // AFTER — no mutation

      // qualified
      const rq = await seedRequisition(tenant); const tq = randomUUID();
      const q = await create(tenant, tq, rq, actor);
      for (const action of ['CONTACT', 'MARK_RESPONDED', 'START_QUALIFICATION', 'QUALIFY'] as const) {
        await repo.applyAction({ tenant_id: tenant, id: q.id, action, expected_version: await version(tenant, q.id), changed_by_id: actor, requestId: action, visible_requisition_ids: null });
      }
      expect(await status(tenant, q.id)).toBe('qualified'); // BEFORE
      let e2: unknown;
      try { await repo.void({ tenant_id: tenant, id: q.id, reason: 'ADDED_BY_MISTAKE', expected_version: await version(tenant, q.id), changed_by_id: actor, requestId: 'v', visible_requisition_ids: null }); } catch (e) { e2 = e; }
      expect((e2 as AramoError).code).toBe('PIPELINE_VOID_NOT_ALLOWED_FROM_STATE');
    });

    // -----------------------------------------------------------------------------------
    // PC1-3 — CAS: a stale expected_version is refused with no partial mutation.
    // -----------------------------------------------------------------------------------
    it('PC1-3: stale expected_version → PIPELINE_TRANSITION_CONFLICT (no last-write-wins)', async () => {
      const tenant = randomUUID(); const actor = randomUUID();
      const req = await seedRequisition(tenant); const talent = randomUUID();
      const ep = await create(tenant, talent, req, actor);
      const stale = (await version(tenant, ep.id)) - 1;
      let err: unknown;
      try { await repo.void({ tenant_id: tenant, id: ep.id, reason: 'ADDED_BY_MISTAKE', expected_version: stale, changed_by_id: actor, requestId: 'v', visible_requisition_ids: null }); } catch (e) { err = e; }
      expect((err as AramoError).code).toBe('PIPELINE_TRANSITION_CONFLICT');
      expect((err as AramoError).statusCode).toBe(409);
      expect(await status(tenant, ep.id)).toBe('no_contact'); // unchanged
    });

    // -----------------------------------------------------------------------------------
    // PC1-4 — concealment: a non-visible episode is a 404 (existence never leaked).
    // -----------------------------------------------------------------------------------
    it('PC1-4: non-visible requisition → 404 NOT_FOUND', async () => {
      const tenant = randomUUID(); const actor = randomUUID();
      const req = await seedRequisition(tenant); const talent = randomUUID();
      const ep = await create(tenant, talent, req, actor);
      let err: unknown;
      try { await repo.void({ tenant_id: tenant, id: ep.id, reason: 'ADDED_BY_MISTAKE', expected_version: await version(tenant, ep.id), changed_by_id: actor, requestId: 'v', visible_requisition_ids: new Set<string>([randomUUID()]) }); } catch (e) { err = e; }
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).statusCode).toBe(404);
      expect(await status(tenant, ep.id)).toBe('no_contact'); // unchanged
    });

    // -----------------------------------------------------------------------------------
    // PC1-5 — a voided episode cannot be re-voided; a sibling requisition episode for the
    // SAME Talent is untouched (the TalentRecord/other-episodes invariant, §8).
    // -----------------------------------------------------------------------------------
    it('PC1-5: re-void rejected; a sibling requisition episode for the same Talent is untouched', async () => {
      const tenant = randomUUID(); const actor = randomUUID(); const talent = randomUUID();
      const reqA = await seedRequisition(tenant); const reqB = await seedRequisition(tenant);
      const a = await create(tenant, talent, reqA, actor);
      const b = await create(tenant, talent, reqB, actor); // same Talent, different requisition
      await repo.void({ tenant_id: tenant, id: a.id, reason: 'ADDED_BY_MISTAKE', expected_version: await version(tenant, a.id), changed_by_id: actor, requestId: 'v', visible_requisition_ids: null });
      expect(await status(tenant, a.id)).toBe('voided');
      expect(await status(tenant, b.id)).toBe('no_contact'); // sibling untouched

      // Re-void the terminal episode → rejected (voided != no_contact).
      let err: unknown;
      try { await repo.void({ tenant_id: tenant, id: a.id, reason: 'ADDED_BY_MISTAKE', expected_version: await version(tenant, a.id), changed_by_id: actor, requestId: 'v2', visible_requisition_ids: null }); } catch (e) { err = e; }
      expect((err as AramoError).code).toBe('PIPELINE_VOID_NOT_ALLOWED_FROM_STATE');
    });
  },
);
