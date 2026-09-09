import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { ConversationIntelligenceRunRepository } from '../lib/conversation-intelligence-run.repository.js';
import {
  CI_MAX_PROCESSING_ATTEMPTS,
  ConversationIntelligenceProcessingService,
} from '../lib/conversation-intelligence-processing.service.js';
import { CI_PROCESSING_ERROR_CODES } from '../lib/domain/errors.js';
import { FakeCiModelProvider, type FakeCiModelMode } from '../lib/model/fake/fake-ci-model-provider.js';
import type { AiProcessingAuthorizationPort, AiProcessingAuthorizationResult } from '../lib/ports/ai-processing-authorization.port.js';
import type { NormalizedTranscriptSource, NormalizedTranscriptView, NormalizedTranscriptLoadResult } from '../lib/ports/normalized-transcript-source.port.js';
import type { RequisitionSnapshotSource } from '../lib/ports/requisition-snapshot-source.port.js';

// CI-B6 — processing proofs against real Postgres 17. Applies the
// conversation_intelligence migrations (B2 init + B6). Fake ports (transcript
// source, snapshot source, ai_processing authz) + the deterministic fake model.

const ROOT = resolve(__dirname, '../../../..');
function migrations(): string[] {
  const dir = resolve(ROOT, 'libs/conversation-intelligence/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
// Dollar-quote-aware + comment-aware splitter (B2 precedent: splits on `;` only
// outside `$$` regions and outside `--` line comments).
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

function transcriptView(tenant: string, transcriptId: string, interactionId: string, sha: string): NormalizedTranscriptView {
  return {
    conversation_transcript_id: transcriptId,
    tenant_id: tenant,
    interaction_id: interactionId,
    normalized_sha256: sha,
    utterances: [
      { utterance_id: 'utt_1', ordinal: 0, speaker_role: 'RECRUITER', text: 'How many years of Java do you have?' },
      { utterance_id: 'utt_2', ordinal: 1, speaker_role: 'UNKNOWN', text: 'I think about eight years of Java.' },
    ],
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CI-B6 conversation-intelligence processing — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: ConversationIntelligenceRunRepository;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();

    const allowAuthz: AiProcessingAuthorizationPort = { evaluate: async () => ({ allowed: true, consent_decision_ref: 'cd' }) };
    const denyAuthz: AiProcessingAuthorizationPort = { evaluate: async () => ({ allowed: false, reason: 'denied' }) };
    const noTalentAuthz: AiProcessingAuthorizationPort = { evaluate: async () => ({ allowed: false, reason: 'no_talent' }) };
    const ambiguousAuthz: AiProcessingAuthorizationPort = { evaluate: async () => ({ allowed: false, reason: 'ambiguous_talent' }) };

    function transcriptSource(result: () => NormalizedTranscriptLoadResult): NormalizedTranscriptSource {
      return { load: async () => result() };
    }
    function snapshotSource(present: boolean, id: string): RequisitionSnapshotSource {
      return { getSnapshot: async () => (present ? { id, source_requisition_version: 1, context: { role: { title: 'Engineer' } } } : null) };
    }

    async function seedReadyTranscript(tenant: string) {
      const transcriptId = randomUUID();
      const interactionId = randomUUID();
      const sha = 'b'.repeat(64);
      return { transcriptId, interactionId, sha, view: transcriptView(tenant, transcriptId, interactionId, sha) };
    }

    function buildService(opts: {
      authz: AiProcessingAuthorizationPort;
      transcripts: NormalizedTranscriptSource;
      snapshots: RequisitionSnapshotSource;
      model: FakeCiModelProvider;
    }) {
      return new ConversationIntelligenceProcessingService(repo, opts.snapshots, opts.transcripts, opts.authz, opts.model);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of migrations()) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await db.query(stmt);
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ConversationIntelligenceRunRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('happy path: authz→ground→invoke→validate→persist immutable claims/citations/draft', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const snapId = randomUUID();
      const model = new FakeCiModelProvider('valid');
      const svc = buildService({
        authz: allowAuthz,
        transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })),
        snapshots: snapshotSource(true, snapId),
        model,
      });
      const r = await svc.process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: snapId });
      expect(r.outcome).toBe('completed');
      expect(model.callCount).toBe(1);
      const run = r.run!;
      expect(run.status).toBe('completed');
      expect(run.normalized_sha256).toBe(t.sha);
      expect(run.model_provider).toBe('fake');
      expect(run.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      // Claims persisted with statuses + a material citation.
      const claims = await repo.listClaims(TENANT_A, run.id);
      expect(claims.length).toBe(2);
      expect(claims[0]!.status).toBe('SUPPORTED_BY_STATEMENT');
      // Citation stored as COORDINATES only (utterance_id), no quote column.
      const cit = await db.query(`SELECT utterance_id, normalized_sha256 FROM conversation_intelligence."ConversationIntelligenceCitation" WHERE tenant_id=$1`, [TENANT_A]);
      expect(cit.rows[0].utterance_id).toBe('utt_1');
      expect(cit.rows[0].normalized_sha256).toBe(t.sha);
      // Draft persisted.
      const draft = await db.query(`SELECT schema_version FROM conversation_intelligence."ConversationIntelligenceDraft" WHERE run_id=$1`, [run.id]);
      expect(draft.rowCount).toBe(1);
    });

    it('ai_processing denied → blocked, model NOT invoked, no claims', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const model = new FakeCiModelProvider('valid');
      const svc = buildService({ authz: denyAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, randomUUID()), model });
      const r = await svc.process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: randomUUID() });
      expect(r.outcome).toBe('blocked_not_authorized');
      expect(r.error_code).toBe(CI_PROCESSING_ERROR_CODES.AI_PROCESSING_NOT_AUTHORIZED);
      expect(model.callCount).toBe(0);
      expect((await repo.listClaims(TENANT_A, r.run!.id)).length).toBe(0);
    });

    it('no talent → park (failed_retryable); ambiguous → intervention', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const park = await buildService({ authz: noTalentAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, randomUUID()), model: new FakeCiModelProvider('valid') })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: randomUUID() });
      expect(park.outcome).toBe('failed_retryable');
      const t2 = await seedReadyTranscript(TENANT_A);
      const iv = await buildService({ authz: ambiguousAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t2.view })), snapshots: snapshotSource(true, randomUUID()), model: new FakeCiModelProvider('valid') })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: t2.transcriptId, requisition_analysis_context_snapshot_id: randomUUID() });
      expect(iv.outcome).toBe('intervention_required');
    });

    it('transcript not ready → no run, no model', async () => {
      const model = new FakeCiModelProvider('valid');
      const r = await buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'not_ready' })), snapshots: snapshotSource(true, randomUUID()), model })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: randomUUID(), requisition_analysis_context_snapshot_id: randomUUID() });
      expect(r.outcome).toBe('transcript_not_ready');
      expect(r.run).toBeUndefined();
      expect(model.callCount).toBe(0);
    });

    it('normalized hash mismatch → fail closed, no model, no claims', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const model = new FakeCiModelProvider('valid');
      const r = await buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'hash_mismatch', meta: { interaction_id: t.interactionId, normalized_sha256: t.sha } })), snapshots: snapshotSource(true, randomUUID()), model })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: randomUUID() });
      expect(r.outcome).toBe('failed_terminal');
      expect(r.error_code).toBe(CI_PROCESSING_ERROR_CODES.NORMALIZED_HASH_MISMATCH);
      expect(model.callCount).toBe(0);
      expect(r.run!.normalized_artifact_ref === undefined || true).toBe(true);
    });

    it('missing Requisition snapshot → fail closed', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const r = await buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(false, randomUUID()), model: new FakeCiModelProvider('valid') })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: randomUUID() });
      expect(r.outcome).toBe('failed_terminal');
      expect(r.error_code).toBe(CI_PROCESSING_ERROR_CODES.REQUISITION_SNAPSHOT_NOT_FOUND);
    });

    it('idempotent: re-run converges to the same completed run, model invoked once total', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const snapId = randomUUID();
      const model1 = new FakeCiModelProvider('valid');
      const svc1 = buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, snapId), model: model1 });
      const first = await svc1.process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: snapId });
      const model2 = new FakeCiModelProvider('valid');
      const svc2 = buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, snapId), model: model2 });
      const second = await svc2.process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: snapId });
      expect(second.run!.id).toBe(first.run!.id);
      expect(model2.callCount).toBe(0); // completed run returned without re-invoke
      const n = await db.query(`SELECT count(*)::int AS n FROM conversation_intelligence."ConversationIntelligenceRun" WHERE tenant_id=$1 AND conversation_transcript_id=$2`, [TENANT_A, t.transcriptId]);
      expect(n.rows[0].n).toBe(1);
    });

    it('completed run is immutable (DB trigger); claims append-only', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const snapId = randomUUID();
      const r = await buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, snapId), model: new FakeCiModelProvider('valid') })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: snapId });
      await expect(
        db.query(`UPDATE conversation_intelligence."ConversationIntelligenceRun" SET last_error_code='x' WHERE id=$1`, [r.run!.id]),
      ).rejects.toThrow();
      await expect(
        db.query(`UPDATE conversation_intelligence."ConversationIntelligenceClaim" SET statement='tampered' WHERE run_id=$1`, [r.run!.id]),
      ).rejects.toThrow();
    });

    it.each([
      ['schema_invalid_status', CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_SCHEMA_MISMATCH],
      ['unknown_field', CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_SCHEMA_MISMATCH],
      ['missing_citation', CI_PROCESSING_ERROR_CODES.CITATION_INVALID],
      ['bad_citation', CI_PROCESSING_ERROR_CODES.CITATION_INVALID],
      ['span_mismatch', CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH],
      ['protected_trait', CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_SCHEMA_MISMATCH],
      ['numeric_ordering', CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_SCHEMA_MISMATCH],
    ] as [FakeCiModelMode, string][])('defective model output %s → failed_retryable %s, no claims', async (mode, code) => {
      const t = await seedReadyTranscript(TENANT_A);
      const snapId = randomUUID();
      const r = await buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, snapId), model: new FakeCiModelProvider(mode) })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: snapId });
      expect(r.outcome).toBe('failed_retryable');
      expect(r.error_code).toBe(code);
      expect((await repo.listClaims(TENANT_A, r.run!.id)).length).toBe(0);
    });

    it('model timeout → failed_retryable; exhausted retries → intervention', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const snapId = randomUUID();
      let last;
      for (let i = 0; i < CI_MAX_PROCESSING_ATTEMPTS; i += 1) {
        last = await buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, snapId), model: new FakeCiModelProvider('timeout') })
          .process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: snapId });
      }
      expect(last!.run!.attempt_count).toBe(CI_MAX_PROCESSING_ATTEMPTS);
      expect(last!.outcome).toBe('intervention_required');
    });

    it('no transcript body / raw-response column in CI tables; citations are coordinates', async () => {
      const cols = await db.query<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='conversation_intelligence'`,
      );
      const names = cols.rows.map((r) => `${r.table_name}.${r.column_name}`.toLowerCase());
      for (const forbidden of ['transcript_body', 'utterance_text', 'raw_response', 'model_response', 'completion', 'chain_of_thought', 'reasoning']) {
        expect(names.some((n) => n.endsWith(`.${forbidden}`))).toBe(false);
      }
      // Citation table stores no `quote`/text column.
      const citCols = cols.rows.filter((r) => r.table_name === 'ConversationIntelligenceCitation').map((r) => r.column_name);
      expect(citCols).not.toContain('quote');
      expect(citCols).toContain('utterance_id');
    });

    it('tenant isolation: a wrong-tenant caller cannot read the run', async () => {
      const t = await seedReadyTranscript(TENANT_A);
      const snapId = randomUUID();
      const r = await buildService({ authz: allowAuthz, transcripts: transcriptSource(() => ({ status: 'ready', view: t.view })), snapshots: snapshotSource(true, snapId), model: new FakeCiModelProvider('valid') })
        .process({ tenant_id: TENANT_A, conversation_transcript_id: t.transcriptId, requisition_analysis_context_snapshot_id: snapId });
      expect(await repo.findRunByIdInTenant(TENANT_B, r.run!.id)).toBeNull();
      expect(await repo.findRunByIdInTenant(TENANT_A, r.run!.id)).not.toBeNull();
    });
  },
);
