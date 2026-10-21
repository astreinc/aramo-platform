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
import { RequisitionPrismaService, RequisitionRepository } from '@aramo/requisition';
import type { AuthContextType } from '@aramo/auth';

import { TalentResponseService } from '../communications/talent-response.service.js';
import { VoiceEvidenceReaderAdapter } from '../engagement/voice-evidence.adapter.js';
import { communicationsEvidenceVerifier } from './helpers/evidence-verifier.js';

// Recruiting-Journey §7/§8/§16/§23 + Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED
// §7 (S4, A1 AM-4) — the RECRUITER-CONFIRMED "Talent responded", end to end on real Postgres 17
// (requisition + pipeline + communications schemas in one DB), with the REAL composition-root
// evidence verifier. The invariants:
//   • only a recruiter USER confirms; the attestation (literal true) is required; and evidence is
//     required — a verified source interaction OR an attributable note;
//   • the confirmation is a durable recruiter_attested interaction, disposition
//     response_confirmed (the caller's disposition is honoured), carrying the source id, BOTH the
//     occurred and the recorded time, and the reviewer; it NEVER grades provider_verified;
//   • talent_responded rests on a recruiter_response_confirmation ONLY — a provider two-way
//     interaction never establishes it (R-7 inverted), and the multi-hop refusal rolls back all;
//   • a non-substantive / foreign / mismatched source is refused; a system principal is refused;
//   • occurred_at > now, or < the first grounded outbound contact → refused;
//   • invisible pipeline → concealed 404; same-key replay → ONE record, ONE milestone;
//   • a double confirmation gives one advance and one 409;
//   • closed/canceled: a response BEFORE the closing time is appended (advanced:false, both times
//     kept); AFTER it → REQUISITION_NOT_ADVANCEABLE; lead → refused before any write.

const ROOT = resolve(__dirname, '../../../..');
function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('requisition'),
  ...migrationsFor('activity'),
  ...migrationsFor('metering'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('communications'),
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Recruiter-confirmed Talent response — real Postgres 17 (§23; v1.2 §7)',
  () => {
    let container: StartedPostgreSqlContainer;
    let url: string;
    let db: Client;
    let commsPrisma: CommunicationsPrismaService;
    let pipelinePrisma: PipelinePrismaService;
    let reqPrisma: RequisitionPrismaService;
    let comms: CommunicationsRepository;
    let pipelines: PipelineRepository;
    let requisitions: RequisitionRepository;
    let svc: TalentResponseService;
    let voiceEvidence: VoiceEvidenceReaderAdapter;

    const TENANT = randomUUID();
    const ACTOR = randomUUID();

    function auth(over: Partial<{ tenant: string; actor_kind: string; consumer_type: string }> = {}): AuthContextType {
      return {
        sub: ACTOR,
        tenant_id: over.tenant ?? TENANT,
        scopes: ['pipeline:change-status'],
        actor_kind: over.actor_kind ?? 'user',
        consumer_type: over.consumer_type ?? 'recruiter',
      } as unknown as AuthContextType;
    }

    async function seedRequisition(status = 'open', tenant = TENANT): Promise<string> {
      const req = randomUUID();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number)
         VALUES ($1,$2,'S4 fixture',$3,$4::requisition."RecruitingStatus",
                 (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2))`,
        [req, tenant, randomUUID(), status],
      );
      return req;
    }
    // A fresh no_contact episode on an open requisition.
    async function seedEpisode(): Promise<{ id: string; talent: string; req: string }> {
      const talent = randomUUID();
      const req = await seedRequisition('open');
      const created = await pipelines.create({
        tenant_id: TENANT,
        input: { talent_record_id: talent, requisition_id: req },
        entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: ACTOR,
      });
      return { id: created.id, talent, req };
    }
    // Move the requisition to a terminal status that took effect at `closedAt`.
    async function closeRequisition(req: string, status: 'closed' | 'canceled', closedAt: Date): Promise<void> {
      await db.query(`UPDATE requisition."Requisition" SET status=$2::requisition."RecruitingStatus" WHERE id=$1`, [req, status]);
      await db.query(
        `INSERT INTO requisition."RequisitionLifecycleEvent"
           (id, tenant_id, requisition_id, previous_status, next_status, actor_id, origin, reason_code, correlation_id, occurred_at)
         VALUES ($1,$2,$3,'open',$4::requisition."RecruitingStatus",$5,'ui','REQUISITION_STATUS_CHANGED',$6,$7)`,
        [randomUUID(), TENANT, req, status, ACTOR, randomUUID(), closedAt],
      );
    }
    // A provider-mediated interaction bound to talent + requisition (+ pipeline), with an
    // optional latest disposition.
    async function providerInteraction(
      ep: { id: string; talent: string; req: string },
      opts: { tenant?: string; talent?: string; req?: string; disposition?: string; channel?: 'voice' | 'email' } = {},
    ): Promise<string> {
      const tenant = opts.tenant ?? TENANT;
      const call = await comms.createInteraction({
        tenant_id: tenant,
        channel: opts.channel ?? 'voice',
        direction: 'outbound',
        integration_connection_id: randomUUID(),
        from_address: '+15715550100',
        to_address: '+17035550111',
        status: 'completed',
      });
      for (const a of [
        { subject_type: 'talent_record' as const, subject_id: opts.talent ?? ep.talent, relation_type: 'subject' as const },
        { subject_type: 'requisition' as const, subject_id: opts.req ?? ep.req, relation_type: 'regarding' as const },
        { subject_type: 'pipeline' as const, subject_id: ep.id, relation_type: 'regarding' as const },
      ]) {
        await comms.addAssociation({ tenant_id: tenant, interaction_id: call.id, ...a });
      }
      if (opts.disposition !== undefined) {
        await db.query(
          `INSERT INTO communications."CommunicationDisposition" (id, tenant_id, interaction_id, disposition, dispositioned_by_id)
           VALUES ($1,$2,$3,$4::communications."CommunicationDispositionOutcome",$5)`,
          [randomUUID(), tenant, call.id, opts.disposition, ACTOR],
        );
      }
      return call.id;
    }

    function confirm(
      ep: { id: string },
      over: Partial<Parameters<TalentResponseService['recordResponse']>[0]> = {},
      service: TalentResponseService = svc,
    ) {
      return service.recordResponse({
        auth: auth(),
        pipelineId: ep.id,
        channel: 'voice',
        occurredAt: new Date(),
        note: 'Talent called back and confirmed interest in the role',
        substantiveResponseAttested: true,
        idempotencyKey: randomUUID(),
        requestId: `s4-${randomUUID()}`,
        visibleRequisitionIds: null,
        ...over,
      });
    }
    async function refusal(p: Promise<unknown>): Promise<{ code?: string; status?: number; reason?: unknown }> {
      try {
        await p;
        return { code: 'NO_THROW' };
      } catch (e) {
        const x = e as { code?: string; statusCode?: number; context?: { details?: { reason?: unknown } } };
        return { code: x.code, status: x.statusCode, reason: x.context?.details?.reason };
      }
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // node-pg simple-query executes multi-statement DDL (dollar-quotes + comments) natively.
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));

      commsPrisma = new CommunicationsPrismaService(url);
      pipelinePrisma = new PipelinePrismaService(url);
      reqPrisma = new RequisitionPrismaService(url);
      await commsPrisma.$connect();
      await pipelinePrisma.$connect();
      await reqPrisma.$connect();
      comms = new CommunicationsRepository(commsPrisma);
      // The REAL composition-root verifier (no RTR guard: this spec never qualifies).
      pipelines = new PipelineRepository(pipelinePrisma, undefined, communicationsEvidenceVerifier());
      // Only findStatusById / findClosingInstant are exercised (no policy / capacity paths).
      requisitions = new RequisitionRepository(reqPrisma, {} as never, {} as never, {} as never, {} as never);
      svc = new TalentResponseService(comms, pipelines, requisitions);
      voiceEvidence = new VoiceEvidenceReaderAdapter(comms);
    }, 240_000);

    afterAll(async () => {
      await commsPrisma?.$disconnect();
      await pipelinePrisma?.$disconnect();
      await reqPrisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    async function interactionRow(id: string): Promise<Record<string, unknown>> {
      const r = await db.query(`SELECT * FROM communications."CommunicationInteraction" WHERE id=$1`, [id]);
      return r.rows[0] as Record<string, unknown>;
    }
    async function dispositionsOf(id: string): Promise<string[]> {
      const r = await db.query(
        `SELECT disposition::text AS d FROM communications."CommunicationDisposition" WHERE interaction_id=$1`,
        [id],
      );
      return r.rows.map((x) => (x as { d: string }).d);
    }
    async function pipelineStatus(id: string): Promise<{ status: string; version: number }> {
      const r = await db.query(`SELECT status, version FROM pipeline."Pipeline" WHERE id=$1`, [id]);
      return r.rows[0] as { status: string; version: number };
    }
    async function confirmationCount(pipelineId: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS c FROM communications."CommunicationInteraction" i
           JOIN communications."CommunicationAssociation" a ON a.interaction_id = i.id
          WHERE a.subject_type='pipeline' AND a.subject_id=$1 AND i.evidence_authority='recruiter_attested'`,
        [pipelineId],
      );
      return Number((r.rows[0] as { c: number }).c);
    }

    // ---- Positive (v1.2 §7.8) ---------------------------------------------------------------
    it('a note-grounded confirmation records the accountable record and advances no_contact -> talent_responded', async () => {
      const ep = await seedEpisode();
      const occurredAt = new Date(Date.now() - 5 * 60 * 1000);
      const res = await confirm(ep, { occurredAt });

      expect(res.pipeline.status).toBe('talent_responded');
      expect(res.advanced).toBe(true);
      expect((await pipelineStatus(ep.id)).status).toBe('talent_responded');

      // Accountable record: reviewer + BOTH times (occurred = recruiter-supplied; recorded = DB).
      expect(res.recorded_by_id).toBe(ACTOR);
      expect(res.occurred_at.toISOString()).toBe(occurredAt.toISOString());
      expect(res.recorded_at.getTime()).toBeGreaterThan(occurredAt.getTime());
      const row = await interactionRow(res.interaction_id);
      expect(row['evidence_authority']).toBe('recruiter_attested');
      expect(row['direction']).toBe('inbound');
      expect(row['status']).toBe('recorded');
      expect(row['integration_connection_id']).toBeNull();
      expect(row['provider_interaction_id']).toBeNull();
      expect(row['initiated_by_id']).toBe(ACTOR);
      expect((row['connected_at'] as Date).toISOString()).toBe(occurredAt.toISOString());
      expect(row['source_interaction_id']).toBeNull();
      // The caller's disposition is HONOURED (it was previously always `connected`).
      expect(await dispositionsOf(res.interaction_id)).toEqual(['response_confirmed']);

      // NEVER grades provider_verified: the voice-evidence reader grades it RECRUITER_ATTESTED.
      const facts = await voiceEvidence.readFacts(TENANT, ep.talent, ep.req);
      const voice = facts.find((f) => f.channel === 'voice')!;
      expect(voice.two_way_conversation).toBe(true);
      expect(voice.evidence_strength).toBe('RECRUITER_ATTESTED');
    });

    it('a source-grounded confirmation (no note) records the source id and advances to talent_responded', async () => {
      const ep = await seedEpisode();
      const source = await providerInteraction(ep, { disposition: 'interested' });
      const res = await confirm(ep, { note: null, sourceInteractionId: source });
      expect(res.pipeline.status).toBe('talent_responded');
      expect((await interactionRow(res.interaction_id))['source_interaction_id']).toBe(source);
    });

    it('a provider-backed two-way interaction still grades PROVIDER_VERIFIED (§19 unchanged)', async () => {
      const ep = await seedEpisode();
      await providerInteraction(ep);
      const facts = await voiceEvidence.readFacts(TENANT, ep.talent, ep.req);
      expect(facts.find((f) => f.channel === 'voice')!.evidence_strength).toBe('PROVIDER_VERIFIED');
    });

    // ---- R-7 INVERTED (v1.2 §7.1/§7.2): a provider two-way interaction never establishes
    // talent_responded — and the refusal on the second hop rolls back the first ----
    it('a provider-verified two-way interaction does NOT establish talent_responded (all hops roll back)', async () => {
      const ep = await seedEpisode();
      const call = await providerInteraction(ep);
      expect(await comms.findAssociatedPipelineId(TENANT, call)).toBe(ep.id);
      const r = await refusal(
        pipelines.reconcileForward({
          tenant_id: TENANT, id: ep.id, target: 'talent_responded',
          changed_by_id: ACTOR, requestId: 'r7', visible_requisition_ids: null,
          evidence: { kind: 'communication_interaction', id: call },
        }),
      );
      expect(r).toMatchObject({ code: 'PIPELINE_EVIDENCE_INADMISSIBLE', reason: 'kind_not_admissible' });
      expect(await pipelineStatus(ep.id)).toEqual({ status: 'no_contact', version: 0 });
    });

    it('an ordinary interaction cannot pose as a recruiter response confirmation (verifier)', async () => {
      const ep = await seedEpisode();
      const call = await providerInteraction(ep);
      const r = await refusal(
        pipelines.reconcileForward({
          tenant_id: TENANT, id: ep.id, target: 'talent_responded',
          changed_by_id: ACTOR, requestId: 'r7b', visible_requisition_ids: null,
          evidence: { kind: 'recruiter_response_confirmation', id: call },
        }),
      );
      expect(r).toMatchObject({ code: 'PIPELINE_EVIDENCE_INADMISSIBLE', reason: 'not_a_response_confirmation' });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
    });

    // ---- Negative (v1.2 §7.8) ---------------------------------------------------------------
    it('no attestation → 422 attestation_required; nothing recorded', async () => {
      const ep = await seedEpisode();
      for (const attested of [undefined, false]) {
        const r = await refusal(confirm(ep, { substantiveResponseAttested: attested }));
        expect(r).toEqual({ code: 'VALIDATION_ERROR', status: 422, reason: 'attestation_required' });
      }
      expect(await confirmationCount(ep.id)).toBe(0);
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
    });

    it('neither a source nor a note → 422 note_required_without_source; the attestation alone never suffices', async () => {
      const ep = await seedEpisode();
      for (const note of [null, '   ']) {
        const r = await refusal(confirm(ep, { note }));
        expect(r).toEqual({ code: 'VALIDATION_ERROR', status: 422, reason: 'note_required_without_source' });
      }
      expect(await confirmationCount(ep.id)).toBe(0);
    });

    for (const disposition of ['callback_requested', 'follow_up_required', 'no_answer', 'left_voicemail', 'busy', 'wrong_number', 'do_not_contact']) {
      it(`a source whose latest outcome is ${disposition} is not substantive → refused`, async () => {
        const ep = await seedEpisode();
        const source = await providerInteraction(ep, { disposition });
        const r = await refusal(confirm(ep, { sourceInteractionId: source }));
        expect(r).toEqual({ code: 'PIPELINE_EVIDENCE_INADMISSIBLE', status: 422, reason: 'source_not_substantive' });
        expect(await confirmationCount(ep.id)).toBe(0);
        expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
      });
    }

    it("another tenant's, another Talent's or another requisition's source is refused", async () => {
      const ep = await seedEpisode();
      const foreignTenant = await providerInteraction(ep, { tenant: randomUUID() });
      const otherTalent = await providerInteraction(ep, { talent: randomUUID() });
      const otherReq = await providerInteraction(ep, { req: randomUUID() });
      expect((await refusal(confirm(ep, { sourceInteractionId: foreignTenant }))).reason).toBe('source_not_found');
      expect((await refusal(confirm(ep, { sourceInteractionId: otherTalent }))).reason).toBe('source_talent_mismatch');
      expect((await refusal(confirm(ep, { sourceInteractionId: otherReq }))).reason).toBe('source_requisition_mismatch');
      expect((await refusal(confirm(ep, { sourceInteractionId: randomUUID() }))).reason).toBe('source_not_found');
      expect(await confirmationCount(ep.id)).toBe(0);
    });

    it('a system / service-account / non-recruiter principal never confirms (403)', async () => {
      const ep = await seedEpisode();
      for (const over of [{ actor_kind: 'system' }, { actor_kind: 'service_account' }, { consumer_type: 'portal' }]) {
        const r = await refusal(confirm(ep, { auth: auth(over) }));
        expect(r).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', status: 403, reason: 'recruiter_user_required' });
      }
      expect(await confirmationCount(ep.id)).toBe(0);
    });

    it('an unbound evidence verifier refuses the milestone (verifier_unbound)', async () => {
      const ep = await seedEpisode();
      const unverified = new TalentResponseService(comms, new PipelineRepository(pipelinePrisma), requisitions);
      const r = await refusal(confirm(ep, {}, unverified));
      expect(r).toMatchObject({ code: 'PIPELINE_EVIDENCE_INADMISSIBLE', reason: 'verifier_unbound' });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
    });

    it('refuses occurred_at in the future', async () => {
      const ep = await seedEpisode();
      const r = await refusal(confirm(ep, { occurredAt: new Date(Date.now() + 60 * 60 * 1000) }));
      expect(r).toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
    });

    it('refuses occurred_at preceding the first grounded outbound contact for this Talent x Requisition', async () => {
      const ep = await seedEpisode();
      await providerInteraction(ep, { channel: 'email' }); // a grounded outbound contact (created now)
      const r = await refusal(confirm(ep, { occurredAt: new Date(Date.now() - 60 * 60 * 1000) }));
      expect(r).toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
    });

    it('refuses (conceals 404) a response for a pipeline the actor cannot see', async () => {
      const ep = await seedEpisode();
      expect(await refusal(confirm(ep, { visibleRequisitionIds: new Set<string>([randomUUID()]) }))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await refusal(confirm(ep, { auth: auth({ tenant: randomUUID() }) }))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
    });

    // ---- Idempotency + concurrency ----------------------------------------------------------
    it('same idempotency key replay yields ONE confirmation and ONE effective milestone', async () => {
      const ep = await seedEpisode();
      const key = randomUUID();
      const first = await confirm(ep, { idempotencyKey: key, channel: 'sms' });
      const afterFirst = await pipelineStatus(ep.id);
      expect(first.pipeline.status).toBe('talent_responded');
      expect(first.deduped).toBe(false);
      const second = await confirm(ep, { idempotencyKey: key, channel: 'sms' });
      expect(second.deduped).toBe(true);
      expect(second.interaction_id).toBe(first.interaction_id);
      expect(second.advanced).toBe(false);
      expect(await pipelineStatus(ep.id)).toEqual(afterFirst);
      expect(await confirmationCount(ep.id)).toBe(1);
    });

    it('a double confirmation (two keys, concurrent) gives ONE advance and ONE 409', async () => {
      const ep = await seedEpisode();
      // Hold the Pipeline row so both confirmations read version 0 and queue on the CAS write.
      const holder = new Client({ connectionString: url });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM pipeline."Pipeline" WHERE id=$1 FOR UPDATE`, [ep.id]);
        const a = confirm(ep);
        const b = confirm(ep);
        await new Promise((r) => setTimeout(r, 1_000));
        await holder.query('COMMIT');
        const settled = await Promise.allSettled([a, b]);
        const ok = settled.filter((s) => s.status === 'fulfilled');
        const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect((failed[0]!.reason as { statusCode?: number }).statusCode).toBe(409);
      } finally {
        await holder.end();
      }
      const after = await pipelineStatus(ep.id);
      expect(after).toEqual({ status: 'talent_responded', version: 2 }); // exactly one 2-hop advance
    });

    // ---- Requisition status (v1.2 §7.5 / S2) -------------------------------------------------
    for (const terminal of ['closed', 'canceled'] as const) {
      it(`${terminal}: a response BEFORE the closing time is appended (advanced:false, both times kept)`, async () => {
        const ep = await seedEpisode();
        const closedAt = new Date(Date.now() - 60 * 60 * 1000);
        await closeRequisition(ep.req, terminal, closedAt);
        const occurredAt = new Date(closedAt.getTime() - 30 * 60 * 1000);
        const res = await confirm(ep, { occurredAt });
        expect(res.advanced).toBe(false);
        expect(res.pipeline.status).toBe('no_contact');
        expect(await pipelineStatus(ep.id)).toEqual({ status: 'no_contact', version: 0 });
        const row = await interactionRow(res.interaction_id);
        expect((row['connected_at'] as Date).toISOString()).toBe(occurredAt.toISOString()); // occurred
        expect((row['created_at'] as Date).getTime()).toBeGreaterThan(closedAt.getTime()); // recorded
        expect(await dispositionsOf(res.interaction_id)).toEqual(['response_confirmed']);
      });

      it(`${terminal}: a response AFTER the closing time → REQUISITION_NOT_ADVANCEABLE; nothing recorded`, async () => {
        const ep = await seedEpisode();
        const closedAt = new Date(Date.now() - 60 * 60 * 1000);
        await closeRequisition(ep.req, terminal, closedAt);
        const r = await refusal(confirm(ep, { occurredAt: new Date(closedAt.getTime() + 10 * 60 * 1000) }));
        expect(r).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', status: 409 });
        expect(await confirmationCount(ep.id)).toBe(0);
        expect((await pipelineStatus(ep.id)).status).toBe('no_contact');
      });
    }

    it('lead (D-2 provisional): RESPONSE is not permitted → refused before any write', async () => {
      const ep = await seedEpisode();
      await db.query(`UPDATE requisition."Requisition" SET status='lead' WHERE id=$1`, [ep.req]);
      const r = await refusal(confirm(ep));
      expect(r).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', status: 409 });
      expect(await confirmationCount(ep.id)).toBe(0);
    });

    it('on hold: a confirmation advances (recruiting continues on hold, R1)', async () => {
      const ep = await seedEpisode();
      await db.query(`UPDATE requisition."Requisition" SET status='on_hold' WHERE id=$1`, [ep.req]);
      const res = await confirm(ep);
      expect(res.pipeline.status).toBe('talent_responded');
    });
  },
);
