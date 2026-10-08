import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunicationsPrismaService,
  CommunicationsRepository,
} from '@aramo/communications';
import { PipelinePrismaService, PipelineRepository } from '@aramo/pipeline';
import type { AuthContextType } from '@aramo/auth';

import { TalentResponseService } from '../communications/talent-response.service.js';
import { VoiceEvidenceReaderAdapter } from '../engagement/voice-evidence.adapter.js';

// Recruiting-Journey §7/§8/§16/§23 — recruiter-attested Talent-response capture proven
// end to end on real Postgres 17 (communications + pipeline schemas in one DB). The
// invariants (PO-locked):
//   • recruiter-attested response → a durable interaction with recruiter_attested
//     authority that NEVER grades provider_verified, advancing ONLY through the
//     canonical response-evidence handling (reconcileForward);
//   • occurred_at > now → refused;
//   • occurred_at < first grounded outbound contact (this Talent × Requisition) → refused;
//   • a pipeline outside the actor's tenant/visibility → concealed 404 (association guard);
//   • same idempotency key replay → ONE evidence record + ONE effective milestone;
//   • provider-backed evidence still grades provider_verified (§19 unchanged).

const ROOT = resolve(__dirname, '../../../..');

const PIPELINE_MIGRATIONS = [
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  'libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  'libs/activity/prisma/migrations/20260921160000_rn1_activity_note_extension/migration.sql',
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  'libs/pipeline/prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  'libs/pipeline/prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  'libs/pipeline/prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  'libs/pipeline/prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  'libs/pipeline/prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  'libs/pipeline/prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  'libs/pipeline/prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  'libs/pipeline/prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
  'libs/pipeline/prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
  'libs/pipeline/prisma/migrations/20260925120000_pipeline_void_add_enum_value/migration.sql',
  'libs/pipeline/prisma/migrations/20260925120100_pipeline_void_live_index_recreate/migration.sql',
];

function communicationsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/communications/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Recruiter-attested Talent-response capture — real Postgres 17 (§23)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let commsPrisma: CommunicationsPrismaService;
    let pipelinePrisma: PipelinePrismaService;
    let comms: CommunicationsRepository;
    let pipelines: PipelineRepository;
    let svc: TalentResponseService;
    let voiceEvidence: VoiceEvidenceReaderAdapter;

    const TENANT = randomUUID();
    const ACTOR = randomUUID();

    function auth(tenant = TENANT): AuthContextType {
      return { sub: ACTOR, tenant_id: tenant, scopes: ['pipeline:change-status'] } as unknown as AuthContextType;
    }

    // Seed a fresh no_contact episode and return its identity.
    async function seedEpisode(): Promise<{ id: string; talent: string; req: string }> {
      const talent = randomUUID();
      const req = randomUUID();
      const created = await pipelines.create({
        tenant_id: TENANT,
        input: { talent_record_id: talent, requisition_id: req },
        entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: ACTOR,
      });
      return { id: created.id, talent, req };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // node-pg simple-query executes multi-statement DDL (dollar-quotes + comments) natively.
      for (const p of PIPELINE_MIGRATIONS) await db.query(readFileSync(resolve(ROOT, p), 'utf8'));
      for (const p of communicationsMigrations()) await db.query(readFileSync(p, 'utf8'));

      commsPrisma = new CommunicationsPrismaService(url);
      pipelinePrisma = new PipelinePrismaService(url);
      await commsPrisma.$connect();
      await pipelinePrisma.$connect();
      comms = new CommunicationsRepository(commsPrisma);
      pipelines = new PipelineRepository(pipelinePrisma);
      svc = new TalentResponseService(comms, pipelines);
      voiceEvidence = new VoiceEvidenceReaderAdapter(comms);
    }, 180_000);

    afterAll(async () => {
      await commsPrisma?.$disconnect();
      await pipelinePrisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    async function interactionRow(id: string): Promise<Record<string, unknown>> {
      const r = await db.query(`SELECT * FROM communications."CommunicationInteraction" WHERE id=$1`, [id]);
      return r.rows[0] as Record<string, unknown>;
    }
    async function pipelineStatus(id: string): Promise<{ status: string; version: number }> {
      const r = await db.query(`SELECT status, version FROM pipeline."Pipeline" WHERE id=$1`, [id]);
      return r.rows[0] as { status: string; version: number };
    }

    // ---- R-1 — recruiter-attested response: honest evidence + advances via canonical path ----
    it('records recruiter_attested evidence (no provider provenance) and advances no_contact -> talent_responded', async () => {
      const ep = await seedEpisode();
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact'); // BEFORE

      const res = await svc.recordResponse({
        auth: auth(),
        pipelineId: ep.id,
        channel: 'voice',
        occurredAt: new Date(),
        note: 'Talent called back',
        idempotencyKey: randomUUID(),
        requestId: 'r1',
        visibleRequisitionIds: null,
      });

      // Pipeline walked the ordered milestones to talent_responded (EXACT after).
      expect(res.pipeline.status).toBe('talent_responded');
      expect((await pipelineStatus(ep.id)).status).toBe('talent_responded');

      // Honest evidence: recruiter_attested authority, inbound, recorded, NO provider.
      const row = await interactionRow(res.interaction_id);
      expect(row['evidence_authority']).toBe('recruiter_attested');
      expect(row['direction']).toBe('inbound');
      expect(row['status']).toBe('recorded');
      expect(row['integration_connection_id']).toBeNull();
      expect(row['provider_interaction_id']).toBeNull();

      // NEVER grades provider_verified (pt10): the voice-evidence reader grades this
      // attested two-way as RECRUITER_ATTESTED, not PROVIDER_VERIFIED.
      const facts = await voiceEvidence.readFacts(TENANT, ep.talent, ep.req);
      const voice = facts.find((f) => f.channel === 'voice')!;
      expect(voice.two_way_conversation).toBe(true);
      expect(voice.evidence_strength).toBe('RECRUITER_ATTESTED');
    });

    // ---- R-2 — provider-backed two-way still grades provider_verified (§19 unchanged) ----
    it('a provider-backed two-way interaction still grades PROVIDER_VERIFIED', async () => {
      const ep = await seedEpisode();
      // A provider-mediated completed voice call (real connection, default authority).
      const interaction = await comms.createInteraction({
        tenant_id: TENANT,
        channel: 'voice',
        direction: 'outbound',
        integration_connection_id: randomUUID(),
        from_address: '+15715550100',
        to_address: '+17035550111',
        status: 'completed',
      });
      await comms.addAssociation({
        tenant_id: TENANT, interaction_id: interaction.id,
        subject_type: 'talent_record', subject_id: ep.talent, relation_type: 'subject',
      });
      await comms.addAssociation({
        tenant_id: TENANT, interaction_id: interaction.id,
        subject_type: 'requisition', subject_id: ep.req, relation_type: 'regarding',
      });
      const facts = await voiceEvidence.readFacts(TENANT, ep.talent, ep.req);
      const voice = facts.find((f) => f.channel === 'voice')!;
      expect(voice.evidence_strength).toBe('PROVIDER_VERIFIED');
    });

    // ---- R-3 — occurred_at in the future is refused ----
    it('refuses occurred_at in the future', async () => {
      const ep = await seedEpisode();
      await expect(
        svc.recordResponse({
          auth: auth(), pipelineId: ep.id, channel: 'email',
          occurredAt: new Date(Date.now() + 60 * 60 * 1000),
          idempotencyKey: randomUUID(), requestId: 'r3', visibleRequisitionIds: null,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact'); // unchanged
    });

    // ---- R-4 — occurred_at before the first grounded outbound contact is refused ----
    it('refuses occurred_at preceding the first grounded outbound contact for this Talent x Requisition', async () => {
      const ep = await seedEpisode();
      // A grounded outbound contact exists (created_at = now).
      const contact = await comms.createInteraction({
        tenant_id: TENANT, channel: 'email', direction: 'outbound',
        integration_connection_id: randomUUID(), from_address: 'r@x', to_address: 't@x', status: 'completed',
      });
      await comms.addAssociation({ tenant_id: TENANT, interaction_id: contact.id, subject_type: 'talent_record', subject_id: ep.talent, relation_type: 'subject' });
      await comms.addAssociation({ tenant_id: TENANT, interaction_id: contact.id, subject_type: 'requisition', subject_id: ep.req, relation_type: 'regarding' });

      await expect(
        svc.recordResponse({
          auth: auth(), pipelineId: ep.id, channel: 'email',
          occurredAt: new Date(Date.now() - 60 * 60 * 1000), // an hour BEFORE the contact
          idempotencyKey: randomUUID(), requestId: 'r4', visibleRequisitionIds: null,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact'); // unchanged
    });

    // ---- R-5 — a pipeline outside the actor's tenant/visibility conceals as 404 ----
    it('refuses (conceals 404) a response for a pipeline the actor cannot see', async () => {
      const ep = await seedEpisode();
      // Visible set that EXCLUDES this pipeline's requisition.
      await expect(
        svc.recordResponse({
          auth: auth(), pipelineId: ep.id, channel: 'voice', occurredAt: new Date(),
          idempotencyKey: randomUUID(), requestId: 'r5', visibleRequisitionIds: new Set<string>([randomUUID()]),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      // And a different tenant cannot see it either.
      await expect(
        svc.recordResponse({
          auth: auth(randomUUID()), pipelineId: ep.id, channel: 'voice', occurredAt: new Date(),
          idempotencyKey: randomUUID(), requestId: 'r5b', visibleRequisitionIds: null,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact'); // unchanged
    });

    // ---- R-7 — Order E convergence: a provider-verified two-way interaction advances
    // talent_responded through the SAME canonical seam the Zoom webhook uses
    // (findAssociatedPipelineId → reconcileForward), grounded on the provider
    // interaction, grading PROVIDER_VERIFIED — no special/parallel Pipeline path ----
    it('a provider-verified two-way interaction converges to talent_responded via the canonical seam', async () => {
      const ep = await seedEpisode();
      // A provider-mediated completed voice call bound to talent + requisition + pipeline
      // (exactly what the voice path records; the Zoom webhook correlates to this row).
      const call = await comms.createInteraction({
        tenant_id: TENANT, channel: 'voice', direction: 'outbound',
        integration_connection_id: randomUUID(), from_address: '+15715550100', to_address: '+17035550111',
        status: 'completed',
      });
      for (const a of [
        { subject_type: 'talent_record' as const, subject_id: ep.talent, relation_type: 'subject' as const },
        { subject_type: 'requisition' as const, subject_id: ep.req, relation_type: 'regarding' as const },
        { subject_type: 'pipeline' as const, subject_id: ep.id, relation_type: 'regarding' as const },
      ]) {
        await comms.addAssociation({ tenant_id: TENANT, interaction_id: call.id, ...a });
      }

      // The webhook seam: resolve the bound pipeline from the interaction, then advance
      // through the canonical evidence command with provider provenance.
      const resolvedPipelineId = await comms.findAssociatedPipelineId(TENANT, call.id);
      expect(resolvedPipelineId).toBe(ep.id);
      const advanced = await pipelines.reconcileForward({
        tenant_id: TENANT, id: resolvedPipelineId!, target: 'talent_responded',
        changed_by_id: ACTOR, requestId: 'r7', visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: call.id },
      });
      expect(advanced.status).toBe('talent_responded');
      expect((await pipelineStatus(ep.id)).status).toBe('talent_responded');

      // The grounding interaction is PROVIDER_VERIFIED (never recruiter-attested).
      const facts = await voiceEvidence.readFacts(TENANT, ep.talent, ep.req);
      expect(facts.find((f) => f.channel === 'voice')!.evidence_strength).toBe('PROVIDER_VERIFIED');
    });

    // ---- R-6 — idempotent replay: one evidence record + one effective advancement ----
    it('same idempotency key replay yields ONE evidence record and ONE effective milestone', async () => {
      const ep = await seedEpisode();
      const key = randomUUID();
      const first = await svc.recordResponse({
        auth: auth(), pipelineId: ep.id, channel: 'sms', occurredAt: new Date(),
        idempotencyKey: key, requestId: 'r6a', visibleRequisitionIds: null,
      });
      const afterFirst = await pipelineStatus(ep.id);
      expect(first.pipeline.status).toBe('talent_responded');
      expect(first.deduped).toBe(false);

      const second = await svc.recordResponse({
        auth: auth(), pipelineId: ep.id, channel: 'sms', occurredAt: new Date(),
        idempotencyKey: key, requestId: 'r6b', visibleRequisitionIds: null,
      });
      expect(second.deduped).toBe(true); // same evidence row
      expect(second.interaction_id).toBe(first.interaction_id);
      // ONE effective milestone: the version did not advance again on replay.
      const afterSecond = await pipelineStatus(ep.id);
      expect(afterSecond.status).toBe('talent_responded');
      expect(afterSecond.version).toBe(afterFirst.version);
      // Exactly one interaction for this idempotency key.
      const n = await db.query(
        `SELECT count(*)::int AS c FROM communications."CommunicationInteraction" WHERE idempotency_key=$1`,
        [key],
      );
      expect(Number((n.rows[0] as { c: number }).c)).toBe(1);
    });
  },
);
