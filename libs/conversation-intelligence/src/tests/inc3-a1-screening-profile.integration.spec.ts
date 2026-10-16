import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  ConversationIntelligenceRunRepository,
  type CiScreeningRunProvenance,
} from '../lib/conversation-intelligence-run.repository.js';
import { ConversationIntelligenceProcessingService } from '../lib/conversation-intelligence-processing.service.js';
import { CI_PROCESSING_ERROR_CODES, CiAnalysisValidationError } from '../lib/domain/errors.js';
import { FakeCiModelProvider } from '../lib/model/fake/fake-ci-model-provider.js';
import {
  CI_SCREENING_PROMPT_SHA256,
  CI_SCREENING_PROMPT_TEMPLATE_ID,
  CI_SCREENING_PROMPT_TEMPLATE_VERSION,
  CI_SCREENING_SCHEMA_VERSION,
  resolveScreeningCitations,
  screeningContextSha256,
  validateScreeningAnalysisResult,
} from '../lib/analysis/screening-analysis.js';
import type { AiProcessingAuthorizationPort } from '../lib/ports/ai-processing-authorization.port.js';
import type { NormalizedTranscriptView } from '../lib/ports/normalized-transcript-source.port.js';
import type {
  ScreeningAnalysisContextSource,
  ScreeningAnalysisModel,
  ScreeningContextLoad,
  ScreeningFindingDraftSink,
  ScreeningModelOutcome,
} from '../lib/ports/screening-analysis.port.js';

// TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D.1/D.2/D.3) — the
// SCREENING analysis profile of the one CI engine.
//   - strict allowlist output contract, protected-trait refusal, citation
//     re-validation (unknown utterance / quote not in the SENT text);
//   - coordinates resolved against the stored text, never invented;
//   - additive migration: REQUISITION invariants unchanged, SCREENING needs a
//     session, identity converges on the partial unique key, profile immutable;
//   - processing: exactly-one session, ai_processing BEFORE any model call,
//     drafts land in the screening domain first (idempotent on the run id).

const RESULT = {
  schema_version: CI_SCREENING_SCHEMA_VERSION,
  findings: [
    {
      skill: 'Kubernetes',
      observation: 'Described running three production clusters and rolling upgrades.',
      limitations: null,
      citations: [{ utterance_id: 'utt_2', quote: 'three production clusters' }],
    },
  ],
};

function view(tenant: string, transcriptId: string, interactionId: string): NormalizedTranscriptView {
  return {
    conversation_transcript_id: transcriptId,
    tenant_id: tenant,
    interaction_id: interactionId,
    normalized_sha256: 'c'.repeat(64),
    utterances: [
      { utterance_id: 'utt_1', ordinal: 0, speaker_role: 'RECRUITER', text: 'Tell me about your Kubernetes work.' },
      { utterance_id: 'utt_2', ordinal: 1, speaker_role: 'UNKNOWN', text: 'I ran three production clusters, email me at a@b.example.' },
    ],
  };
}

describe('screening analysis contract (unit)', () => {
  it('accepts exactly the v1 shape and refuses extra keys, missing citations and protected attributes', () => {
    expect(validateScreeningAnalysisResult(RESULT).findings).toHaveLength(1);
    const extra = { ...RESULT, findings: [{ ...RESULT.findings[0], fit: 0.9 }] };
    expect(() => validateScreeningAnalysisResult(extra)).toThrow(CiAnalysisValidationError);
    expect(() => validateScreeningAnalysisResult({ ...RESULT, verdict: 'x' })).toThrow(CiAnalysisValidationError);
    const uncited = { ...RESULT, findings: [{ ...RESULT.findings[0], citations: [] }] };
    expect(() => validateScreeningAnalysisResult(uncited)).toThrow(CiAnalysisValidationError);
    const trait = { ...RESULT, findings: [{ ...RESULT.findings[0], limitations: 'Mentioned a medical leave.' }] };
    expect(() => validateScreeningAnalysisResult(trait)).toThrow(CiAnalysisValidationError);
  });

  it('re-validates citations against the SENT text and resolves coordinates against the stored text', () => {
    const r = validateScreeningAnalysisResult(RESULT);
    const stored = new Map([['utt_2', 'I ran three production clusters, email me at a@b.example.']]);
    const sent = new Map([['utt_2', 'I ran three production clusters, email me at [EMAIL].']]);
    expect(resolveScreeningCitations(r, sent, stored)).toEqual([[{ utterance_id: 'utt_2', start_offset: 6, end_offset: 31 }]]);

    const unknown = validateScreeningAnalysisResult({ ...RESULT, findings: [{ ...RESULT.findings[0], citations: [{ utterance_id: 'utt_9', quote: 'x' }] }] });
    expect(() => resolveScreeningCitations(unknown, sent, stored)).toThrow(
      expect.objectContaining({ code: CI_PROCESSING_ERROR_CODES.CITATION_INVALID }),
    );
    const invented = validateScreeningAnalysisResult({ ...RESULT, findings: [{ ...RESULT.findings[0], citations: [{ utterance_id: 'utt_2', quote: 'five clusters' }] }] });
    expect(() => resolveScreeningCitations(invented, sent, stored)).toThrow(
      expect.objectContaining({ code: CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH }),
    );
    // A quote over a redaction token cannot locate in the stored text → the
    // whole utterance, never an invented span.
    const redacted = validateScreeningAnalysisResult({ ...RESULT, findings: [{ ...RESULT.findings[0], citations: [{ utterance_id: 'utt_2', quote: 'email me at [EMAIL]' }] }] });
    expect(resolveScreeningCitations(redacted, sent, stored)).toEqual([[{ utterance_id: 'utt_2', start_offset: 0, end_offset: stored.get('utt_2')!.length }]]);
  });
});

const ROOT = resolve(__dirname, '../../../..');
function migrations(): string[] {
  const dir = resolve(ROOT, 'libs/conversation-intelligence/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
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
      const t = cur.trim();
      if (t.length > 0) out.push(t);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'INC-3 A1-5 CI screening analysis profile — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: ConversationIntelligenceRunRepository;
    const TENANT = randomUUID();

    const allow: AiProcessingAuthorizationPort = { evaluate: async () => ({ allowed: true }) };
    const deny: AiProcessingAuthorizationPort = { evaluate: async () => ({ allowed: false, reason: 'denied' }) };

    class FakeScreeningModel implements ScreeningAnalysisModel {
      calls: unknown[] = [];
      constructor(private readonly outcome: ScreeningModelOutcome) {}
      async modelIdentity() {
        return { provider: 'openai', model: 'gpt-4o' };
      }
      redactUtterances(v: NormalizedTranscriptView) {
        return v.utterances.map((u) => ({ utterance_id: u.utterance_id, speaker_role: u.speaker_role, text: u.text.replace(/\S+@\S+/g, '[EMAIL]') }));
      }
      async generate(input: unknown): Promise<ScreeningModelOutcome> {
        this.calls.push(input);
        return this.outcome;
      }
    }
    const OK: ScreeningModelOutcome = { kind: 'ok', raw_result: RESULT, model_used: 'gpt-4o-2024-08-06', input_sha256: 'd'.repeat(64), model_request_id: 'req_1' };

    function ctxSource(load: ScreeningContextLoad): ScreeningAnalysisContextSource {
      return { load: async () => load };
    }
    function sink(result: Awaited<ReturnType<ScreeningFindingDraftSink['saveDrafts']>> = 'saved') {
      const saved: Parameters<ScreeningFindingDraftSink['saveDrafts']>[0][] = [];
      const s: ScreeningFindingDraftSink = {
        saveDrafts: async (input) => {
          saved.push(input);
          return result;
        },
      };
      return { s, saved };
    }

    async function queued(interactionId: string, snapshot: string | null = null) {
      const sessionId = randomUUID();
      const transcriptId = randomUUID();
      const prov: CiScreeningRunProvenance = {
        tenant_id: TENANT,
        conversation_transcript_id: transcriptId,
        screening_session_id: sessionId,
        screening_context_sha256: hashOf(sessionId, interactionId, snapshot),
        requisition_analysis_context_snapshot_id: snapshot,
        interaction_id: interactionId,
        normalized_sha256: 'c'.repeat(64),
        model_provider: 'openai',
        model_name: 'gpt-4o',
        prompt_template_id: CI_SCREENING_PROMPT_TEMPLATE_ID,
        prompt_template_version: CI_SCREENING_PROMPT_TEMPLATE_VERSION,
        prompt_sha256: CI_SCREENING_PROMPT_SHA256,
        output_schema_version: CI_SCREENING_SCHEMA_VERSION,
      };
      const run = await repo.createOrGetQueuedScreening(prov);
      return { run, prov, sessionId, transcriptId };
    }

    function service(opts: {
      authz?: AiProcessingAuthorizationPort;
      transcriptId: string;
      interactionId: string;
      context: ScreeningContextLoad;
      sinkPort: ScreeningFindingDraftSink;
      model: FakeScreeningModel;
      snapshotPresent?: boolean;
    }) {
      return new ConversationIntelligenceProcessingService(
        repo,
        { getSnapshot: async (_t, id) => (opts.snapshotPresent === false ? null : { id, source_requisition_version: 1, context: { role: { title: 'Engineer' } } }) },
        { load: async () => ({ status: 'ready', view: view(TENANT, opts.transcriptId, opts.interactionId) }) },
        opts.authz ?? allow,
        new FakeCiModelProvider('happy'),
        ctxSource(opts.context),
        opts.sinkPort,
        opts.model,
      );
    }
    const TALENT = randomUUID();
    const ready = (sessionId: string, interactionId: string, plan: string[] = ['Q1']): ScreeningContextLoad => ({
      status: 'ready',
      context: { session_id: sessionId, talent_record_id: TALENT, interaction_id: interactionId, question_plan: plan, recruiter_notes: [], talent_profile: { skills: ['Go'] } },
    });
    function hashOf(sessionId: string, interactionId: string, snapshot: string | null, plan: string[] = ['Q1']): string {
      const r = ready(sessionId, interactionId, plan);
      if (r.status !== 'ready') throw new Error('unreachable');
      return screeningContextSha256(r.context, snapshot);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of migrations()) for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await db.query(stmt);
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ConversationIntelligenceRunRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('migration: REQUISITION runs keep the snapshot requirement; SCREENING runs require a session', async () => {
      const base = `INSERT INTO conversation_intelligence."ConversationIntelligenceRun"
        (id, tenant_id, interaction_id, conversation_transcript_id, requisition_analysis_context_snapshot_id, analysis_profile, screening_session_id,
         screening_context_sha256, normalized_sha256, model_provider, model_name, prompt_template_id, prompt_template_version, prompt_sha256, output_schema_version)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, $8, 'x', 'p', 'm', 't', 'v', 's', 'o')`;
      const ids = () => [randomUUID(), TENANT, randomUUID(), randomUUID()];
      const h = 'e'.repeat(64);
      await expect(db.query(base, [...ids(), null, 'REQUISITION', null, null])).rejects.toThrow(/CIRun_analysis_profile_check/);
      await expect(db.query(base, [...ids(), randomUUID(), 'REQUISITION', randomUUID(), null])).rejects.toThrow(/CIRun_analysis_profile_check/);
      await expect(db.query(base, [...ids(), randomUUID(), 'REQUISITION', null, h])).rejects.toThrow(/CIRun_analysis_profile_check/);
      await expect(db.query(base, [...ids(), null, 'SCREENING', null, h])).rejects.toThrow(/CIRun_analysis_profile_check/);
      await expect(db.query(base, [...ids(), null, 'SCREENING', randomUUID(), null])).rejects.toThrow(/CIRun_analysis_profile_check/);
      await expect(db.query(base, [...ids(), null, 'OTHER', randomUUID(), h])).rejects.toThrow(/CIRun_analysis_profile_check/);
      await db.query(base, [...ids(), randomUUID(), 'REQUISITION', null, null]);
      await db.query(base, [...ids(), null, 'SCREENING', randomUUID(), h]);
    });

    it('identity converges on (transcript, session, model, prompt, schema); profile + session immutable', async () => {
      const a = await queued(randomUUID());
      const again = await repo.createOrGetQueuedScreening(a.prov);
      expect(again.id).toBe(a.run.id);
      const n = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM conversation_intelligence."ConversationIntelligenceRun" WHERE screening_session_id = $1::uuid`,
        [a.sessionId],
      );
      expect(n.rows[0]!.n).toBe(1);
      await expect(
        db.query(`UPDATE conversation_intelligence."ConversationIntelligenceRun" SET screening_session_id = $2::uuid WHERE id = $1::uuid`, [a.run.id, randomUUID()]),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.query(`UPDATE conversation_intelligence."ConversationIntelligenceRun" SET analysis_profile = 'REQUISITION' WHERE id = $1::uuid`, [a.run.id]),
      ).rejects.toThrow(/immutable/);
    });

    it('happy path: exactly-one session → model → drafts in the screening domain FIRST → immutable claims + coordinate citations', async () => {
      const interactionId = randomUUID();
      const { run, sessionId, transcriptId } = await queued(interactionId);
      const model = new FakeScreeningModel(OK);
      const { s, saved } = sink('saved');
      const out = await service({ transcriptId, interactionId, context: ready(sessionId, interactionId), sinkPort: s, model }).processScreening({ tenant_id: TENANT, run_id: run.id });
      expect(out.outcome).toBe('completed');
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        session_id: sessionId,
        run_id: run.id,
        provenance: { provider: 'openai', model: 'gpt-4o-2024-08-06', provider_request_id: 'req_1', used_talent_profile: true, used_requisition: false },
      });
      expect(saved[0]!.findings[0]!.citations).toEqual([
        { conversation_transcript_id: transcriptId, normalized_sha256: 'c'.repeat(64), utterance_id: 'utt_2', start_offset: 6, end_offset: 31 },
      ]);
      // The model received the REDACTED transcript only.
      expect(JSON.stringify(model.calls[0])).not.toContain('a@b.example');
      const claims = await repo.listClaims(TENANT, run.id);
      expect(claims).toEqual([expect.objectContaining({ claim_type: 'screening_finding_draft', status: 'SUPPORTED_BY_STATEMENT' })]);
      const cit = await db.query<Record<string, unknown>>(
        `SELECT utterance_id, start_offset, end_offset FROM conversation_intelligence."ConversationIntelligenceCitation" c
           JOIN conversation_intelligence."ConversationIntelligenceClaim" k ON k.id = c.claim_id WHERE k.run_id = $1::uuid`,
        [run.id],
      );
      expect(cit.rows).toEqual([{ utterance_id: 'utt_2', start_offset: 6, end_offset: 31 }]);
      // Replay of a completed run: no model call, no second draft.
      const replay = await service({ transcriptId, interactionId, context: ready(sessionId, interactionId), sinkPort: s, model }).processScreening({ tenant_id: TENANT, run_id: run.id });
      expect(replay.outcome).toBe('completed');
      expect(model.calls).toHaveLength(1);
      expect(saved).toHaveLength(1);
    });

    it('ai_processing denied → blocked_not_authorized with NO model call and NO drafts (fail closed)', async () => {
      const interactionId = randomUUID();
      const { run, sessionId, transcriptId } = await queued(interactionId);
      const model = new FakeScreeningModel(OK);
      const { s, saved } = sink();
      const out = await service({ authz: deny, transcriptId, interactionId, context: ready(sessionId, interactionId), sinkPort: s, model }).processScreening({ tenant_id: TENANT, run_id: run.id });
      expect([out.outcome, out.error_code]).toEqual(['blocked_not_authorized', CI_PROCESSING_ERROR_CODES.AI_PROCESSING_NOT_AUTHORIZED]);
      expect(model.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });

    it('session not DRAFT → failed_terminal; session linked to another meeting → intervention_required (no model call)', async () => {
      const i1 = randomUUID();
      const a = await queued(i1);
      const m1 = new FakeScreeningModel(OK);
      const r1 = await service({ transcriptId: a.transcriptId, interactionId: i1, context: { status: 'not_draft' }, sinkPort: sink().s, model: m1 }).processScreening({ tenant_id: TENANT, run_id: a.run.id });
      expect([r1.outcome, r1.error_code]).toEqual(['failed_terminal', CI_PROCESSING_ERROR_CODES.SCREENING_SESSION_NOT_DRAFT]);

      const i2 = randomUUID();
      const b = await queued(i2);
      const m2 = new FakeScreeningModel(OK);
      const r2 = await service({ transcriptId: b.transcriptId, interactionId: i2, context: ready(b.sessionId, randomUUID()), sinkPort: sink().s, model: m2 }).processScreening({ tenant_id: TENANT, run_id: b.run.id });
      expect([r2.outcome, r2.error_code]).toEqual(['intervention_required', CI_PROCESSING_ERROR_CODES.SCREENING_SESSION_MISMATCH]);
      expect(m1.calls.length + m2.calls.length).toBe(0);
    });

    it('a recorded snapshot that is missing fails closed; an invalid model citation retries (never persists)', async () => {
      const i1 = randomUUID();
      const a = await queued(i1, randomUUID());
      const m1 = new FakeScreeningModel(OK);
      const r1 = await service({ transcriptId: a.transcriptId, interactionId: i1, context: ready(a.sessionId, i1), sinkPort: sink().s, model: m1, snapshotPresent: false }).processScreening({ tenant_id: TENANT, run_id: a.run.id });
      expect([r1.outcome, r1.error_code]).toEqual(['failed_terminal', CI_PROCESSING_ERROR_CODES.REQUISITION_SNAPSHOT_NOT_FOUND]);
      expect(m1.calls).toHaveLength(0);

      const i2 = randomUUID();
      const b = await queued(i2);
      const bad: ScreeningModelOutcome = { ...OK, raw_result: { ...RESULT, findings: [{ ...RESULT.findings[0], citations: [{ utterance_id: 'utt_2', quote: 'ten clusters' }] }] } } as ScreeningModelOutcome;
      const { s, saved } = sink();
      const r2 = await service({ transcriptId: b.transcriptId, interactionId: i2, context: ready(b.sessionId, i2), sinkPort: s, model: new FakeScreeningModel(bad) }).processScreening({ tenant_id: TENANT, run_id: b.run.id });
      expect([r2.outcome, r2.error_code]).toEqual(['failed_retryable', CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH]);
      expect(saved).toHaveLength(0);
      expect(await repo.listClaims(TENANT, b.run.id)).toEqual([]);
    });

    it('replay binding: a context changed after scheduling is refused with NO model call; the changed context is a NEW run', async () => {
      const interactionId = randomUUID();
      const { run, prov, sessionId, transcriptId } = await queued(interactionId);
      const model = new FakeScreeningModel(OK);
      const { s, saved } = sink();
      // The recruiter selected another question after the transcript was linked.
      const changed = ready(sessionId, interactionId, ['Q1', 'Q2']);
      const out = await service({ transcriptId, interactionId, context: changed, sinkPort: s, model }).processScreening({ tenant_id: TENANT, run_id: run.id });
      expect([out.outcome, out.error_code]).toEqual(['failed_terminal', CI_PROCESSING_ERROR_CODES.SCREENING_CONTEXT_CHANGED]);
      expect(model.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
      const rescheduled = await repo.createOrGetQueuedScreening({ ...prov, screening_context_sha256: hashOf(sessionId, interactionId, null, ['Q1', 'Q2']) });
      expect(rescheduled.id).not.toBe(run.id);
      expect(rescheduled.status).toBe('queued');
      await expect(
        db.query(`UPDATE conversation_intelligence."ConversationIntelligenceRun" SET screening_context_sha256 = 'x' WHERE id = $1::uuid`, [rescheduled.id]),
      ).rejects.toThrow(/immutable/);
    });

    it('a REQUISITION-profile run is never processed as a screening run', async () => {
      const { s, saved } = sink();
      const model = new FakeScreeningModel(OK);
      const rid = randomUUID();
      await db.query(
        `INSERT INTO conversation_intelligence."ConversationIntelligenceRun"
          (id, tenant_id, interaction_id, conversation_transcript_id, requisition_analysis_context_snapshot_id, normalized_sha256, model_provider, model_name, prompt_template_id, prompt_template_version, prompt_sha256, output_schema_version)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'x', 'p', 'm', 't', 'v', 's', 'o')`,
        [rid, TENANT, randomUUID(), randomUUID(), randomUUID()],
      );
      const out = await service({ transcriptId: randomUUID(), interactionId: randomUUID(), context: { status: 'not_found' }, sinkPort: s, model }).processScreening({ tenant_id: TENANT, run_id: rid });
      expect(out.outcome).toBe('transcript_not_found');
      expect(model.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });
  },
);
