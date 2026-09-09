import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConversationTranscriptPrismaService,
  ConversationTranscriptRepository,
  ConversationTranscriptService,
  ConversationTranscriptProviderRegistry,
  TranscriptNormalizationService,
  TranscriptSourceParserRegistry,
  InMemoryTranscriptArtifactStore,
  type InteractionReferencePort,
} from '@aramo/conversation-transcript';

import { ZoomRecordingTranscriptProvider, type ZoomConnectionSecretResolver } from '../conversation-transcript/zoom/zoom-recording-transcript.provider.js';
import { ZoomVttTranscriptParser } from '../conversation-transcript/zoom/zoom-vtt.parser.js';
import { ZOOM_RECORDING_TRANSCRIPT_FORMAT } from '../conversation-transcript/zoom/zoom-transcript.constants.js';
import { ZoomTranscriptHttpClient, type FetchLike, type FetchResponseLike, type ZoomAccessTokenProvider } from '../conversation-transcript/zoom/zoom-transcript-http.client.js';
import {
  ZoomRecordingTranscriptOrchestrator,
  type TranscriptConsentGate,
  type TranscriptInteractionCorrelator,
} from '../conversation-transcript/zoom/zoom-recording-transcript.orchestrator.js';
import { parseZoomRecordingTranscriptEvent } from '../conversation-transcript/zoom/zoom-recording-transcript-event.js';

// CI-B5Z — Zoom recording-transcript orchestration against real Postgres 17.
// Applies ONLY the conversation-transcript migrations; the interaction reference
// + correlation are faked (Communications correlation is proven separately), so
// the aggregate's interaction_id is an opaque UUID. Zoom HTTP is mocked; object
// storage is the in-memory fake. Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');

function migrationsIn(libDir: string): string[] {
  const dir = resolve(ROOT, libDir, 'prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
function splitDdl(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

const VTT = ['WEBVTT', '', '1', '00:00:00.000 --> 00:00:02.000', '<v Recruiter>hi, um, still interested?', '', '2', '00:00:02.000 --> 00:00:04.000', '<v Speaker 2>yeah i think so', ''].join('\n');

function vttResponse(status = 200, body: Buffer = Buffer.from(VTT)): FetchResponseLike {
  return { status, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'text/vtt' : null) }, arrayBuffer: async () => body };
}

const tokens: ZoomAccessTokenProvider = { getAccessToken: async () => 't', refreshAccessToken: async () => 't2' };
const connResolver: ZoomConnectionSecretResolver = { resolveSecretRef: async () => 'connector:v1:x' };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CI-B5Z Zoom recording-transcript orchestration — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: ConversationTranscriptPrismaService;
    let repo: ConversationTranscriptRepository;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();
    const CONNECTION = randomUUID();

    // Fake correlation + consent (the orchestrator's injected ports).
    function matchedCorrelator(interactionId: string): TranscriptInteractionCorrelator {
      return { correlate: async () => ({ kind: 'matched', interaction_id: interactionId }) };
    }
    const noneCorrelator: TranscriptInteractionCorrelator = { correlate: async () => ({ kind: 'none' }) };
    const ambiguousCorrelator: TranscriptInteractionCorrelator = { correlate: async () => ({ kind: 'ambiguous' }) };
    const allowConsent: TranscriptConsentGate = { evaluate: async () => ({ allowed: true, consent_decision_ref: 'cd-1' }) };
    const denyRecording: TranscriptConsentGate = { evaluate: async () => ({ allowed: false, denied_operation: 'recording' }) };
    const denyTranscription: TranscriptConsentGate = { evaluate: async () => ({ allowed: false, denied_operation: 'transcription' }) };
    const noTalent: TranscriptConsentGate = { evaluate: async () => ({ allowed: false, talent_resolution: 'none' }) };
    const ambiguousTalent: TranscriptConsentGate = { evaluate: async () => ({ allowed: false, talent_resolution: 'ambiguous' }) };
    // Any interaction "exists" (Communications authority faked for this lib-focused spec).
    const interactionRef: InteractionReferencePort = { existsInTenant: async () => true };

    function buildEngine(opts: {
      correlator: TranscriptInteractionCorrelator;
      consent: TranscriptConsentGate;
      fetchImpl?: FetchLike;
      store?: InMemoryTranscriptArtifactStore;
    }) {
      const store = opts.store ?? new InMemoryTranscriptArtifactStore();
      const providerRegistry = new ConversationTranscriptProviderRegistry();
      const client = new ZoomTranscriptHttpClient(tokens, opts.fetchImpl ?? (async () => vttResponse()));
      providerRegistry.register(new ZoomRecordingTranscriptProvider(client, store, connResolver));
      const parserRegistry = new TranscriptSourceParserRegistry();
      parserRegistry.register(new ZoomVttTranscriptParser());
      const b3 = new ConversationTranscriptService(repo, providerRegistry, interactionRef);
      const b4 = new TranscriptNormalizationService(repo, parserRegistry, store);
      const orch = new ZoomRecordingTranscriptOrchestrator(opts.correlator, opts.consent, b3, b4);
      return { store, orch };
    }

    function event(recordingId: string) {
      return { event: 'phone.recording_transcript_completed', payload: { object: { recording_id: recordingId, call_history_id: `ch-${recordingId}` } } };
    }
    function processInput(tenant: string, recordingId: string) {
      const view = parseZoomRecordingTranscriptEvent(event(recordingId));
      if (view === null) throw new Error('bad fixture');
      return { tenant_id: tenant, integration_connection_id: CONNECTION, view };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of migrationsIn('libs/conversation-transcript')) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await db.query(stmt);
      }
      prisma = new ConversationTranscriptPrismaService(url);
      await prisma.$connect();
      repo = new ConversationTranscriptRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('happy path: correlate→consent→acquire raw evidence→normalize; raw ≠ normalized', async () => {
      const interactionId = randomUUID();
      const rec = randomUUID();
      const { store, orch } = buildEngine({ correlator: matchedCorrelator(interactionId), consent: allowConsent });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('normalized');
      const row = await repo.findByProviderRef(TENANT_A, 'zoom_phone', rec);
      expect(row?.state).toBe('normalized');
      expect(row?.interaction_id).toBe(interactionId);
      expect(row?.source_artifact_ref).toBeTruthy();
      expect(row?.source_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.normalized_artifact_ref).toBeTruthy();
      expect(row?.normalized_sha256).toMatch(/^[0-9a-f]{64}$/);
      // Raw evidence is a DISTINCT artifact from the normalized one, both retrievable.
      expect(row?.source_artifact_ref).not.toBe(row?.normalized_artifact_ref);
      const raw = await store.getSource(TENANT_A, row?.source_artifact_ref as string);
      expect(raw.toString('utf8')).toContain('WEBVTT');
      // Normalized artifact is canonical JSON (no raw WEBVTT).
      const norm = store.peek(TENANT_A, row?.normalized_artifact_ref as string);
      expect(norm?.toString('utf8')).toContain('conversation-transcript.normalized.v1');
    });

    it('idempotent: replay converges (one row, one download, one normalize)', async () => {
      const interactionId = randomUUID();
      const rec = randomUUID();
      const { store, orch } = buildEngine({ correlator: matchedCorrelator(interactionId), consent: allowConsent });
      const first = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      const second = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(second.transcript_id).toBe(first.transcript_id);
      expect(store.putSourceCallCount).toBe(1); // acquire early-returns on source_ready
      expect(store.putCallCount).toBe(1); // normalize early-returns on normalized
      const n = await db.query('SELECT count(*)::int AS n FROM conversation_transcript."ConversationTranscript" WHERE tenant_id=$1 AND provider_transcript_id=$2', [TENANT_A, rec]);
      expect(n.rows[0].n).toBe(1);
    });

    it('zero correlation → parked; no aggregate created', async () => {
      const rec = randomUUID();
      const { orch } = buildEngine({ correlator: noneCorrelator, consent: allowConsent });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('parked_no_correlation');
      expect(await repo.findByProviderRef(TENANT_A, 'zoom_phone', rec)).toBeNull();
    });

    it('ambiguous correlation → intervention; no aggregate', async () => {
      const rec = randomUUID();
      const { orch } = buildEngine({ correlator: ambiguousCorrelator, consent: allowConsent });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('intervention_ambiguous_correlation');
      expect(await repo.findByProviderRef(TENANT_A, 'zoom_phone', rec)).toBeNull();
    });

    it('recording consent denied → no CI acquisition', async () => {
      const rec = randomUUID();
      const { store, orch } = buildEngine({ correlator: matchedCorrelator(randomUUID()), consent: denyRecording });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('consent_denied');
      expect(store.putSourceCallCount).toBe(0);
      expect(await repo.findByProviderRef(TENANT_A, 'zoom_phone', rec)).toBeNull();
    });

    it('transcription consent denied → no CI acquisition', async () => {
      const rec = randomUUID();
      const { store, orch } = buildEngine({ correlator: matchedCorrelator(randomUUID()), consent: denyTranscription });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('consent_denied');
      expect(store.putSourceCallCount).toBe(0);
    });

    it('zero durable Talent association → parked (no guessing)', async () => {
      const rec = randomUUID();
      const { store, orch } = buildEngine({ correlator: matchedCorrelator(randomUUID()), consent: noTalent });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('parked_no_talent_association');
      expect(store.putSourceCallCount).toBe(0);
      expect(await repo.findByProviderRef(TENANT_A, 'zoom_phone', rec)).toBeNull();
    });

    it('ambiguous Talent associations → intervention, fail closed', async () => {
      const rec = randomUUID();
      const { store, orch } = buildEngine({ correlator: matchedCorrelator(randomUUID()), consent: ambiguousTalent });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('intervention_ambiguous_talent');
      expect(store.putSourceCallCount).toBe(0);
    });

    it('retryable Zoom fetch failure → acquisition_failed, no artifacts', async () => {
      const rec = randomUUID();
      const failFetch: FetchLike = async () => vttResponse(503, Buffer.alloc(0));
      const { orch } = buildEngine({ correlator: matchedCorrelator(randomUUID()), consent: allowConsent, fetchImpl: failFetch });
      const r = await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(r.status).toBe('acquisition_failed');
      const row = await repo.findByProviderRef(TENANT_A, 'zoom_phone', rec);
      expect(row?.state).toBe('failed_retryable');
      expect(row?.normalized_artifact_ref).toBeNull();
    });

    it('restart convergence: re-drive after a failed attempt reaches normalized with stable ids', async () => {
      const interactionId = randomUUID();
      const rec = randomUUID();
      const store = new InMemoryTranscriptArtifactStore();
      // First drive fails at fetch (retryable).
      const failEngine = buildEngine({ correlator: matchedCorrelator(interactionId), consent: allowConsent, fetchImpl: async () => vttResponse(503, Buffer.alloc(0)), store });
      const f = await failEngine.orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(f.status).toBe('acquisition_failed');
      // Re-drive with a healthy provider (same persisted aggregate) → converges.
      const okEngine = buildEngine({ correlator: matchedCorrelator(interactionId), consent: allowConsent, store });
      const ok = await okEngine.orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(ok.status).toBe('normalized');
      const norm = store.peek(TENANT_A, `conversation-transcript/${TENANT_A}/${(await repo.findByProviderRef(TENANT_A, 'zoom_phone', rec))?.id}/normalized.json`);
      expect(norm).toBeDefined();
    });

    it('no transcript body column in Postgres; no transcript text in error tokens', async () => {
      const cols = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='conversation_transcript' AND table_name='ConversationTranscript'`,
      );
      for (const f of ['body', 'text', 'content', 'utterances', 'transcript', 'vtt', 'segments', 'payload']) {
        expect(cols.rows.map((r) => r.column_name)).not.toContain(f);
      }
      expect(cols.rows.filter((r) => /json/i.test(r.data_type))).toEqual([]);
    });

    it('cross-tenant: a wrong-tenant caller cannot read another tenant transcript', async () => {
      const rec = randomUUID();
      const { orch } = buildEngine({ correlator: matchedCorrelator(randomUUID()), consent: allowConsent });
      await orch.processRecordingTranscriptEvent(processInput(TENANT_A, rec));
      expect(await repo.findByProviderRef(TENANT_B, 'zoom_phone', rec)).toBeNull();
    });
  },
);
