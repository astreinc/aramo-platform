import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  TechnicalScreeningRepository,
  type AiGenerationInput,
} from '../lib/technical-screening.repository.js';
import { TechnicalScreeningService } from '../lib/technical-screening.service.js';
import type { ScreeningEvidencePublisher, ScreeningEvidencePublishInput } from '../lib/screening-publisher.port.js';

// TIP-E2E INC-3 A1 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §B.2–§B.5, R-B) — the
// AI-assisted screening domain against real Postgres 17: AI-draft provenance
// survives edit/confirm, rejected drafts are never published, unreviewed drafts
// block confirmation, transcript citations ride as coordinates, DB triggers keep
// origin / AI original immutable, question plan regeneration keeps selections,
// suggestion actions are set once, and retention deletes AI content on confirm.

const MIGRATIONS = [
  resolve(__dirname, '../../prisma/migrations/20261016120000_inc3_technical_screening_init/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20261016130000_inc3_a1_ai_assisted_screening/migration.sql'),
];
const TENANT = '0192f222-aaaa-7000-8000-00000000000a';
const ACTOR = '0192f222-cccc-7000-8000-00000000000c';
const TRANSCRIPT = '0192f222-dddd-7000-8000-00000000000d';
const RID = 'req-a1';

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

class RecordingPublisher implements ScreeningEvidencePublisher {
  calls: ScreeningEvidencePublishInput[] = [];
  async publish(input: ScreeningEvidencePublishInput): Promise<{ written: boolean }> {
    this.calls.push(input);
    return { written: true };
  }
}

const GEN: AiGenerationInput = {
  kind: 'FINDINGS_DRAFT',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  provider_request_id: 'req_1',
  prompt_version: 'screening-findings.v1',
  input_sha256: 'a'.repeat(64),
  used_talent_profile: false,
  used_requisition: false,
  used_transcript: true,
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TIP-E2E INC-3 A1 — AI-assisted screening domain (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TechnicalScreeningRepository;
    let publisher: RecordingPublisher;
    let service: TechnicalScreeningService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(m, 'utf8'))) {
          if (stmt.trim().length > 0) await setup.$executeRawUnsafe(stmt.trim());
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TechnicalScreeningRepository(prisma);
      publisher = new RecordingPublisher();
      service = new TechnicalScreeningService(repo, publisher);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function draftWithAi() {
      const s = await service.createSession({
        tenant_id: TENANT, site_id: null, talent_record_id: uuidv7(), interaction_id: null,
        requisition_id: uuidv7(), actor_id: ACTOR,
      });
      const drafted = await repo.saveAiDraftedFindings({
        tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, generation: GEN,
        findings: [
          {
            skill_raw: 'Kubernetes', basis: 'SELF_REPORTED', observation_raw: 'Said they ran clusters in production.',
            limitations_raw: null, evidence_source: 'MEETING_TRANSCRIPT',
            citations: [{ conversation_transcript_id: TRANSCRIPT, utterance_id: 'u-7', start_offset: 0, end_offset: 40, normalized_sha256: 'b'.repeat(64) }],
          },
          {
            skill_raw: 'Go', basis: 'SELF_REPORTED', observation_raw: 'Mentioned Go services.',
            limitations_raw: null, evidence_source: 'MEETING_TRANSCRIPT',
            citations: [{ conversation_transcript_id: TRANSCRIPT, utterance_id: 'u-9', start_offset: 3, end_offset: 21, normalized_sha256: 'b'.repeat(64) }],
          },
        ],
      });
      return { session: s, ids: drafted.finding_ids, version: drafted.version };
    }

    it('records the optional requisition on the session (question tailoring only)', async () => {
      const { session } = await draftWithAi();
      expect(session.requisition_id).not.toBeNull();
      const events = await service.listEvents(TENANT, session.id);
      expect(events[0]?.payload).toEqual({ has_requisition: true });
    });

    it('unreviewed AI drafts block confirmation; rejected drafts are never published; AI provenance survives edit + confirm', async () => {
      const { session, ids, version } = await draftWithAi();
      await expect(
        service.confirm({ tenant_id: TENANT, session_id: session.id, version, confirmed_finding_ids: ids, observations_confirmed: true, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      // Edit the first (→ EDITED), reject the second (→ REJECTED).
      const edited = await service.editFinding({
        tenant_id: TENANT, session_id: session.id, finding_id: ids[0]!, version, actor_id: ACTOR, requestId: RID,
        finding: { skill_raw: 'Kubernetes', basis: 'SELF_REPORTED', observation_raw: 'Described running clusters; no detail on upgrades.' },
      });
      expect(edited.finding.origin).toBe('AI_DRAFTED');
      expect(edited.finding.review_status).toBe('EDITED');
      expect(edited.finding.reviewed_by_actor_id).toBe(ACTOR);
      expect(edited.finding.ai_original).toMatchObject({ observation_raw: 'Said they ran clusters in production.' });
      const rejected = await service.reviewAiFinding({
        tenant_id: TENANT, session_id: session.id, finding_id: ids[1]!, version: edited.version, outcome: 'REJECTED', actor_id: ACTOR, requestId: RID,
      });
      expect(rejected.finding.review_status).toBe('REJECTED');

      // The confirmed set is the non-rejected findings only.
      await expect(
        service.confirm({ tenant_id: TENANT, session_id: session.id, version: rejected.version, confirmed_finding_ids: ids, observations_confirmed: true, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_VERSION_CONFLICT' });
      const c = await service.confirm({
        tenant_id: TENANT, session_id: session.id, version: rejected.version, confirmed_finding_ids: [ids[0]!], observations_confirmed: true, actor_id: ACTOR, requestId: RID,
      });
      expect(c.publications).toHaveLength(1);
      const payload = c.publications[0]!.canonical_payload as Record<string, unknown>;
      expect(payload['basis']).toBe('SELF_REPORTED'); // a self-statement is never promoted
      expect(payload['provenance']).toEqual({
        origin: 'AI_DRAFTED',
        evidence_source: 'MEETING_TRANSCRIPT',
        review_outcome: 'EDITED',
        citation_refs: [{ conversation_transcript_id: TRANSCRIPT, utterance_id: 'u-7', start: 0, end: 40 }],
      });
      expect(JSON.stringify(payload)).not.toContain(ACTOR);
    });

    it('an AI draft cannot be removed — only reviewed', async () => {
      const { session, ids, version } = await draftWithAi();
      await expect(
        service.removeFinding({ tenant_id: TENANT, session_id: session.id, finding_id: ids[0]!, version, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_STATE_INVALID' });
    });

    it('a recruiter-authored finding publishes with RECRUITER_AUTHORED provenance', async () => {
      const s = await service.createSession({ tenant_id: TENANT, site_id: null, talent_record_id: uuidv7(), interaction_id: null, actor_id: ACTOR });
      const a = await service.addFinding({
        tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, requestId: RID,
        finding: { skill_raw: 'SQL', basis: 'RECRUITER_OBSERVED', observation_raw: 'Explained index choice.' },
      });
      const c = await service.confirm({ tenant_id: TENANT, session_id: s.id, version: a.version, confirmed_finding_ids: [a.finding.id], observations_confirmed: true, actor_id: ACTOR, requestId: RID });
      expect((c.publications[0]!.canonical_payload as Record<string, unknown>)['provenance']).toEqual({
        origin: 'RECRUITER_AUTHORED',
        evidence_source: 'RECRUITER_OBSERVATION',
      });
    });

    it('DB triggers keep origin, AI original and evidence source immutable even in DRAFT; requisition immutable after confirm', async () => {
      const { session, ids } = await draftWithAi();
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningFinding" SET origin = 'RECRUITER_AUTHORED', review_status = NULL, ai_original = NULL WHERE id = '${ids[0]}'`),
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningFinding" SET ai_original = '{}'::jsonb WHERE id = '${ids[0]}'`),
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningFindingCitation" SET end_offset = 99 WHERE finding_id = '${ids[0]}'`),
      ).rejects.toThrow(/append-only/);
      // Confirm a separate session, then try to change its requisition.
      const s = await service.createSession({ tenant_id: TENANT, site_id: null, talent_record_id: uuidv7(), interaction_id: null, requisition_id: uuidv7(), actor_id: ACTOR });
      const a = await service.addFinding({ tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, requestId: RID, finding: { skill_raw: 'Go', basis: 'RECRUITER_OBSERVED', observation_raw: 'x' } });
      await service.confirm({ tenant_id: TENANT, session_id: s.id, version: a.version, confirmed_finding_ids: [a.finding.id], observations_confirmed: true, actor_id: ACTOR, requestId: RID });
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningSession" SET requisition_id = NULL WHERE id = '${s.id}'`),
      ).rejects.toThrow(/immutable once CONFIRMED/);
      expect(session.id).toBeDefined();
    });

    it('question plan: regeneration retires PROPOSED AI questions but keeps SELECTED and recruiter-authored ones', async () => {
      const s = await service.createSession({ tenant_id: TENANT, site_id: null, talent_record_id: uuidv7(), interaction_id: null, actor_id: ACTOR });
      const plan1 = await repo.saveQuestionPlan({
        tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, generation: { ...GEN, kind: 'QUESTION_PLAN' },
        questions: [
          { text: 'How do you size node pools?', skill_ref: 'Kubernetes', intent: 'PROBE' },
          { text: 'Walk through a rollback.', skill_ref: 'Kubernetes', intent: 'PROBE' },
        ],
      });
      const [q1, q2] = plan1.questions;
      await service.updateQuestion({ tenant_id: TENANT, session_id: s.id, question_id: q1!.id, actor_id: ACTOR, status: 'SELECTED', text: 'How do you size and scale node pools?', requestId: RID });
      const own = await service.addQuestion({ tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, text: 'What did you own end to end?', requestId: RID });
      const plan2 = await repo.saveQuestionPlan({
        tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, generation: { ...GEN, kind: 'QUESTION_PLAN' },
        questions: [{ text: 'Explain a CrashLoopBackOff diagnosis.', skill_ref: 'Kubernetes', intent: 'PROBE' }],
      });
      const byId = new Map(plan2.questions.map((q) => [q.id, q]));
      expect(byId.get(q1!.id)).toMatchObject({ status: 'SELECTED', edited: true });
      expect(byId.get(q2!.id)?.status).toBe('REMOVED');
      expect(byId.get(own.id)).toMatchObject({ origin: 'RECRUITER_AUTHORED', status: 'SELECTED' });
      expect(plan2.questions.filter((q) => q.status === 'PROPOSED')).toHaveLength(1);
      const gens = await repo.listGenerations(TENANT, s.id);
      expect(gens.map((g) => g.kind)).toEqual(['QUESTION_PLAN', 'QUESTION_PLAN']);
    });

    it('notes are append-only; a suggestion action is recorded once', async () => {
      const s = await service.createSession({ tenant_id: TENANT, site_id: null, talent_record_id: uuidv7(), interaction_id: null, actor_id: ACTOR });
      const note = await service.addNote({ tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, body: 'Strong on networking; vague on storage.', requestId: RID });
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningNote" SET body = 'x' WHERE id = '${note.id}'`),
      ).rejects.toThrow(/append-only/);
      const [sug] = await repo.saveSuggestions({
        tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, generation: { ...GEN, kind: 'FOLLOW_UP' },
        trigger_kind: 'NOTE', trigger_ref: { note_id: note.id }, suggestions: ['Which storage class did you use and why?'],
      });
      await service.actionSuggestion({ tenant_id: TENANT, session_id: s.id, suggestion_id: sug!.id, actor_id: ACTOR, action: 'USED', requestId: RID });
      await expect(
        service.actionSuggestion({ tenant_id: TENANT, session_id: s.id, suggestion_id: sug!.id, actor_id: ACTOR, action: 'DISMISSED', requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_VERSION_CONFLICT' });
      const events = (await service.listEvents(TENANT, s.id)).map((e) => e.event_type);
      expect(events).toEqual(['SESSION_CREATED', 'NOTE_ADDED', 'SUGGESTION_GENERATED', 'SUGGESTION_ACTIONED']);
      expect(JSON.stringify((await service.listEvents(TENANT, s.id)).map((e) => e.payload))).not.toMatch(/storage/);
    });

    it('meeting and transcript links: DRAFT only, transcript link idempotent', async () => {
      const s = await service.createSession({ tenant_id: TENANT, site_id: null, talent_record_id: uuidv7(), interaction_id: null, actor_id: ACTOR });
      const interaction = uuidv7();
      const linked = await service.linkMeeting({ tenant_id: TENANT, session_id: s.id, interaction_id: interaction, actor_id: ACTOR, requestId: RID });
      expect(linked.interaction_id).toBe(interaction);
      expect((await repo.findSessionsByInteraction(TENANT, interaction)).map((x) => x.id)).toEqual([s.id]);
      const t = uuidv7();
      expect(await service.linkTranscript({ tenant_id: TENANT, session_id: s.id, conversation_transcript_id: t, source: 'TEAMS_GRAPH', actor_id: ACTOR, requestId: RID })).toEqual({ linked: true });
      expect(await service.linkTranscript({ tenant_id: TENANT, session_id: s.id, conversation_transcript_id: t, source: 'TEAMS_GRAPH', actor_id: ACTOR, requestId: RID })).toEqual({ linked: false });
    });

    it('R-B retention: AI content (questions, notes, suggestions) is deleted once the session is confirmed or voided; provenance metadata survives', async () => {
      const s = await service.createSession({ tenant_id: TENANT, site_id: null, talent_record_id: uuidv7(), interaction_id: null, actor_id: ACTOR });
      await repo.saveQuestionPlan({ tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, generation: { ...GEN, kind: 'QUESTION_PLAN' }, questions: [{ text: 'Q?', skill_ref: null, intent: 'PROBE' }] });
      const note = await service.addNote({ tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, body: 'note', requestId: RID });
      await repo.saveSuggestions({ tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, generation: { ...GEN, kind: 'FOLLOW_UP' }, trigger_kind: 'NOTE', trigger_ref: { note_id: note.id }, suggestions: ['S?'] });
      expect(await repo.deleteSessionAiContent(TENANT, s.id)).toEqual({ deleted: 0 }); // still DRAFT → nothing
      const current = await service.findSession(TENANT, s.id);
      await service.voidSession({ tenant_id: TENANT, session_id: s.id, version: current!.version, reason: null, actor_id: ACTOR, requestId: RID });
      expect(await repo.deleteSessionAiContent(TENANT, s.id)).toEqual({ deleted: 3 });
      expect(await repo.listQuestions(TENANT, s.id)).toEqual([]);
      expect(await repo.listNotes(TENANT, s.id)).toEqual([]);
      expect(await repo.listSuggestions(TENANT, s.id)).toEqual([]);
      expect((await repo.listGenerations(TENANT, s.id)).length).toBe(2); // provenance metadata survives
    });
  },
);
