import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import { PipelineRepository, PipelinePrismaService } from '@aramo/pipeline';
import { SubmittalRepository, PrismaService as SubmittalPrismaService } from '@aramo/submittal';
import { OfferRepository, PlacementRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';
import { CommunicationsRepository, CommunicationsPrismaService } from '@aramo/communications';

import { PipelineVoidService } from '../pipeline-void/pipeline-void.service.js';

// Accidental-Add Correction — the VOID orchestrator, end-to-end against real Postgres 17. The
// authority the directive + PO are strict about: the BACKEND (not the visible stage) decides
// whether VOID exists. no_contact is necessary but NOT sufficient — a no_contact episode with
// a real engagement interaction OR a downstream record must be REJECTED at the direct API.
// Composed with the REAL pipeline + comms + submittal + offer + placement repositories.

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
  ...migrationsFor('submittal'),
  ...migrationsFor('placement'),
  ...migrationsFor('communications'),
];

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = ''; let inDollar = false; let inLineComment = false; let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) { cur += ch; if (ch === '\n') inLineComment = false; continue; }
    if (inString) { cur += ch; if (ch === "'") { if (sql[i + 1] === "'") { cur += "'"; i += 1; } else { inString = false; } } continue; }
    if (!inDollar && ch === "'") { inString = true; cur += ch; continue; }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') { inLineComment = true; cur += ch; continue; }
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(cur); cur = ''; } else { cur += ch; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const NOOP_LOGGER = { log: () => undefined, warn: () => undefined, error: () => undefined } as never;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Pipeline VOID orchestrator — authoritative guards (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let service: PipelineVoidService;
    let pipelineRepo: PipelineRepository;
    const prismas: Array<{ $disconnect: () => Promise<void> }> = [];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          const t = s.trim();
          if (t.length > 0) await db.query(t);
        }
      }
      const pipelinePrisma = new PipelinePrismaService(url);
      const submittalPrisma = new SubmittalPrismaService(url);
      const placementPrisma = new PlacementPrismaService(url);
      const commsPrisma = new CommunicationsPrismaService(url);
      for (const p of [pipelinePrisma, submittalPrisma, placementPrisma, commsPrisma]) {
        await (p as unknown as { $connect: () => Promise<void> }).$connect();
        prismas.push(p as never);
      }
      pipelineRepo = new PipelineRepository(pipelinePrisma);
      service = new PipelineVoidService(
        pipelineRepo,
        new CommunicationsRepository(commsPrisma as never),
        new SubmittalRepository(submittalPrisma, {} as never, {} as never, NOOP_LOGGER, {} as never),
        new OfferRepository(placementPrisma, {} as never),
        new PlacementRepository(placementPrisma),
        NOOP_LOGGER,
      );
    }, 240_000);

    afterAll(async () => {
      for (const p of prismas) await p.$disconnect().catch(() => undefined);
      await db?.end();
      await container?.stop();
    });

    async function seedNoContact(tenant: string, req: string, talent: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'no_contact'::"pipeline"."PipelineStatus",now(),now())`,
        [id, tenant, talent, req],
      );
      return id;
    }
    async function seedSubmittal(tenant: string, talent: string, req: string): Promise<void> {
      await db.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id, state, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'submitted_to_ats'::"submittal"."SubmittalState",$7,now())`,
        [randomUUID(), tenant, talent, req, randomUUID(), randomUUID(), randomUUID()],
      );
    }
    // Seed a communications interaction associated to (talent subject ∩ requisition regarding).
    async function seedInteraction(tenant: string, talent: string, req: string, channel: string): Promise<void> {
      const interactionId = randomUUID();
      await db.query(
        `INSERT INTO communications."CommunicationInteraction"
           (id, tenant_id, channel, direction, status, integration_connection_id, from_address, to_address, created_at, updated_at)
         VALUES ($1,$2,$3::"communications"."CommunicationChannel",'outbound'::"communications"."CommunicationDirection",
                 'completed'::"communications"."CommunicationInteractionStatus",$4,'from@x.test','to@x.test',now(),now())`,
        [interactionId, tenant, channel, randomUUID()],
      );
      for (const [stype, sid, rel] of [['talent_record', talent, 'subject'], ['requisition', req, 'regarding']] as const) {
        await db.query(
          `INSERT INTO communications."CommunicationAssociation" (id, tenant_id, interaction_id, subject_type, subject_id, relation_type, created_at)
           VALUES ($1,$2,$3,$4::"communications"."CommunicationSubjectType",$5,$6::"communications"."CommunicationRelationType",now())`,
          [randomUUID(), tenant, interactionId, stype, sid, rel],
        );
      }
    }
    const version = async (tenant: string, id: string): Promise<number> => (await pipelineRepo.findById({ tenant_id: tenant, id }))!.version;
    const status = async (tenant: string, id: string): Promise<string | null> => (await pipelineRepo.findById({ tenant_id: tenant, id }))?.status ?? null;
    const voidIt = (tenant: string, id: string) =>
      service.voidEpisode({ tenant_id: tenant, pipeline_id: id, reason: 'ADDED_BY_MISTAKE', expected_version: 0, changed_by_id: randomUUID(), visible_requisition_ids: null, requestId: 'v' });

    // -----------------------------------------------------------------------------------
    // PC2-1 — clean no_contact (no engagement, no downstream) → VOID succeeds.
    // -----------------------------------------------------------------------------------
    it('PC2-1: clean no_contact → VOID succeeds (status voided)', async () => {
      const tenant = randomUUID(); const req = randomUUID(); const talent = randomUUID();
      const ep = await seedNoContact(tenant, req, talent);
      const result = await service.voidEpisode({ tenant_id: tenant, pipeline_id: ep, reason: 'ADDED_BY_MISTAKE', expected_version: await version(tenant, ep), changed_by_id: randomUUID(), visible_requisition_ids: null, requestId: 'v' });
      expect(result.status).toBe('voided');
    });

    // -----------------------------------------------------------------------------------
    // PC2-2 — no_contact + EMAIL engagement → REJECTED (the mandatory negative case).
    // -----------------------------------------------------------------------------------
    it('PC2-2: no_contact + email interaction → PIPELINE_VOID_HAS_ENGAGEMENT (direct API rejected)', async () => {
      const tenant = randomUUID(); const req = randomUUID(); const talent = randomUUID();
      const ep = await seedNoContact(tenant, req, talent);
      await seedInteraction(tenant, talent, req, 'email');
      let err: unknown;
      try { await voidIt(tenant, ep); } catch (e) { err = e; }
      expect((err as AramoError).code).toBe('PIPELINE_VOID_HAS_ENGAGEMENT');
      expect((err as AramoError).statusCode).toBe(409);
      expect(await status(tenant, ep)).toBe('no_contact'); // NOT mutated
    });

    // -----------------------------------------------------------------------------------
    // PC2-3 — no_contact + VOICE engagement → REJECTED.
    // -----------------------------------------------------------------------------------
    it('PC2-3: no_contact + voice interaction → PIPELINE_VOID_HAS_ENGAGEMENT', async () => {
      const tenant = randomUUID(); const req = randomUUID(); const talent = randomUUID();
      const ep = await seedNoContact(tenant, req, talent);
      await seedInteraction(tenant, talent, req, 'voice');
      let err: unknown;
      try { await voidIt(tenant, ep); } catch (e) { err = e; }
      expect((err as AramoError).code).toBe('PIPELINE_VOID_HAS_ENGAGEMENT');
      expect(await status(tenant, ep)).toBe('no_contact');
    });

    // -----------------------------------------------------------------------------------
    // PC2-4 — no_contact + a SUBMITTAL → REJECTED (the second mandatory negative case).
    // -----------------------------------------------------------------------------------
    it('PC2-4: no_contact + submittal → PIPELINE_VOID_HAS_DOWNSTREAM_ACTIVITY (direct API rejected)', async () => {
      const tenant = randomUUID(); const req = randomUUID(); const talent = randomUUID();
      const ep = await seedNoContact(tenant, req, talent);
      await seedSubmittal(tenant, talent, req);
      let err: unknown;
      try { await voidIt(tenant, ep); } catch (e) { err = e; }
      expect((err as AramoError).code).toBe('PIPELINE_VOID_HAS_DOWNSTREAM_ACTIVITY');
      expect((err as AramoError).statusCode).toBe(409);
      expect(await status(tenant, ep)).toBe('no_contact');
    });

    // -----------------------------------------------------------------------------------
    // PC2-5 — engagement/downstream for a DIFFERENT talent does not block this one (scoping).
    // -----------------------------------------------------------------------------------
    it('PC2-5: an interaction for a different Talent does not block VOID (per-talent scoping)', async () => {
      const tenant = randomUUID(); const req = randomUUID(); const talent = randomUUID(); const other = randomUUID();
      const ep = await seedNoContact(tenant, req, talent);
      await seedInteraction(tenant, other, req, 'email'); // a DIFFERENT talent on the same req
      const result = await voidIt(tenant, ep);
      expect(result.status).toBe('voided');
    });
  },
);
