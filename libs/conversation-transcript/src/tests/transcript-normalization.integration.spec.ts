import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConversationTranscriptRepository } from '../lib/conversation-transcript.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TranscriptNotFoundError } from '../lib/domain/errors.js';
import {
  MAX_NORMALIZATION_ATTEMPTS,
  TranscriptNormalizationService,
} from '../lib/normalization/transcript-normalization.service.js';
import { NORMALIZED_TRANSCRIPT_SCHEMA_VERSION } from '../lib/normalization/normalized-transcript.js';
import { NORMALIZATION_ERROR_CODES } from '../lib/normalization/normalization-errors.js';
import { sha256Hex } from '../lib/normalization/hashing.js';
import { TranscriptSourceParserRegistry } from '../lib/normalization/transcript-source-parser.registry.js';
import {
  FixtureTranscriptParser,
  FIXTURE_TRANSCRIPT_FORMAT,
} from '../lib/normalization/fixture-transcript-parser.js';
import { InMemoryTranscriptArtifactStore } from '../lib/normalization/fake/in-memory-transcript-artifact-store.js';

// CI-B4 — normalization + artifact-lifecycle proofs against real Postgres 17.
// Skipped unless ARAMO_RUN_INTEGRATION=1. Applies ONLY the conversation_transcript
// migrations by glob (init + B4 normalization) — B4 reads/writes only its own
// schema (interaction_id is a UUID ref, no communications rows needed). Object
// storage is the in-memory fake (no AWS).

const ROOT = resolve(__dirname, '../../../..');

function migrationsIn(libDir: string): string[] {
  const dir = resolve(ROOT, libDir, 'prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

// Comment-aware splitter — drops whole `--` comment lines before splitting on `;`.
function splitDdl(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface FixtureSeg {
  provider_segment_id?: string;
  provider_speaker_id?: string;
  speaker_label?: string;
  speaker_role_hint?: string;
  start_ms?: number;
  end_ms?: number;
  text: string;
}

function fixtureBytes(segments: FixtureSeg[], language?: string): Buffer {
  return Buffer.from(
    JSON.stringify({ ...(language ? { language } : {}), segments }),
    'utf8',
  );
}

const ALLOWED_TOP_KEYS = new Set([
  'schema_version',
  'transcript_id',
  'tenant_id',
  'interaction_id',
  'provider_key',
  'provider_transcript_id',
  'source_sha256',
  'language',
  'generated_at',
  'utterances',
]);
const ALLOWED_UTT_KEYS = new Set([
  'utterance_id',
  'ordinal',
  'speaker_role',
  'provider_speaker_id',
  'speaker_label',
  'start_ms',
  'end_ms',
  'text',
]);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CI-B4 transcript normalization — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: ConversationTranscriptRepository;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();

    function freshEngine() {
      const store = new InMemoryTranscriptArtifactStore();
      const parsers = new TranscriptSourceParserRegistry();
      parsers.register(new FixtureTranscriptParser());
      const svc = new TranscriptNormalizationService(repo, parsers, store);
      return { store, svc };
    }

    async function seedSourceReady(
      store: InMemoryTranscriptArtifactStore,
      tenant: string,
      opts: { bytes: Buffer; sourceSha256?: string; language?: string; providerGeneratedAt?: Date },
    ): Promise<{ id: string; sourceRef: string }> {
      const row = await repo.openIfAbsent({
        tenant_id: tenant,
        interaction_id: randomUUID(),
        provider_key: 'fake_transcript',
        provider_transcript_id: `pt-${randomUUID()}`,
        state: 'source_ready',
        language: opts.language ?? null,
        provider_generated_at: opts.providerGeneratedAt ?? null,
      });
      const sourceRef = `conversation-transcript/${tenant}/${row.id}/source`;
      await repo.patchInTenant(tenant, row.id, {
        source_artifact_ref: sourceRef,
        source_sha256: opts.sourceSha256 ?? sha256Hex(opts.bytes),
        acquired_at: new Date(),
      });
      store.seedSource(tenant, sourceRef, opts.bytes);
      return { id: row.id, sourceRef };
    }

    function readNormalized(store: InMemoryTranscriptArtifactStore, tenant: string, ref: string) {
      const bytes = store.peek(tenant, ref);
      if (bytes === undefined) throw new Error('normalized artifact missing');
      return { bytes, json: JSON.parse(bytes.toString('utf8')) };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of migrationsIn('libs/conversation-transcript')) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await db.query(stmt);
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ConversationTranscriptRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    // ---- TEST 1 — deterministic normalization -----------------------------
    it('TEST 1 — same source normalized twice yields identical bytes/hash/ids', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([
        { provider_speaker_id: '1', start_ms: 0, end_ms: 900, text: 'hello there' },
        { provider_speaker_id: '2', start_ms: 900, end_ms: 1800, text: 'hi' },
      ]);
      const { id, sourceRef } = await seedSourceReady(store, TENANT_A, { bytes });
      const first = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      expect(first.state).toBe('normalized');
      const firstArtifact = readNormalized(store, TENANT_A, first.normalized_artifact_ref as string);
      // Idempotent re-run — converges to identical bytes/hash/ids.
      const second = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      expect(second.normalized_sha256).toBe(first.normalized_sha256);
      const secondArtifact = readNormalized(store, TENANT_A, second.normalized_artifact_ref as string);
      expect(secondArtifact.bytes.equals(firstArtifact.bytes)).toBe(true);
      expect(secondArtifact.json.utterances.map((u: { utterance_id: string }) => u.utterance_id)).toEqual(
        firstArtifact.json.utterances.map((u: { utterance_id: string }) => u.utterance_id),
      );
      // source_sha256 unused ref kept for parity.
      expect(sourceRef).toContain(id);
    });

    // ---- TEST 2 — stable utterance ids ------------------------------------
    it('TEST 2 — utterance ids are a deterministic function of stable inputs', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'stable turn one' }, { text: 'stable turn two' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      // Ids are content-hash form (utt_<64 hex>), not random uuids.
      for (const u of json.utterances) {
        expect(u.utterance_id).toMatch(/^utt_[0-9a-f]{64}$/);
      }
      // Distinct utterances have distinct ids.
      expect(new Set(json.utterances.map((u: { utterance_id: string }) => u.utterance_id)).size).toBe(2);
    });

    // ---- TEST 3 — speaker preservation ------------------------------------
    it('TEST 3 — provider speaker id/label + reliable role hint are preserved', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([
        { provider_speaker_id: '7', speaker_label: 'Recruiter Line', speaker_role_hint: 'RECRUITER', text: 'welcome' },
      ]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      expect(json.utterances[0].provider_speaker_id).toBe('7');
      expect(json.utterances[0].speaker_label).toBe('Recruiter Line');
      expect(json.utterances[0].speaker_role).toBe('RECRUITER');
    });

    // ---- TEST 4 — unknown speaker (no fabrication) ------------------------
    it('TEST 4 — an unresolved speaker becomes UNKNOWN (never inferred)', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ provider_speaker_id: '1', speaker_label: 'Speaker 1', text: 'anonymous line' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      expect(json.utterances[0].speaker_role).toBe('UNKNOWN');
      expect(json.utterances[0].provider_speaker_id).toBe('1'); // preserved, not promoted to a role
    });

    // ---- TEST 5 — timestamp preservation ----------------------------------
    it('TEST 5 — timestamps are preserved exactly when present', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ start_ms: 1500, end_ms: 4200, text: 'timed' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      expect(json.utterances[0].start_ms).toBe(1500);
      expect(json.utterances[0].end_ms).toBe(4200);
    });

    // ---- TEST 6 — missing timestamps (no fabrication) --------------------
    it('TEST 6 — absent timestamps stay absent (no fabricated zeros)', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'no timing' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      expect('start_ms' in json.utterances[0]).toBe(false);
      expect('end_ms' in json.utterances[0]).toBe(false);
    });

    // ---- TEST 7 — source hash mismatch fails closed ----------------------
    it('TEST 7 — source hash mismatch fails closed, no normalized artifact', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'authentic' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes, sourceSha256: 'b'.repeat(64) });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      expect(row.state).toBe('normalization_failed_terminal');
      expect(row.last_error_code).toBe(NORMALIZATION_ERROR_CODES.SOURCE_HASH_MISMATCH);
      expect(row.normalized_artifact_ref).toBeNull();
      expect(row.normalized_sha256).toBeNull();
    });

    // ---- TEST 8 — normalized hash truth ----------------------------------
    it('TEST 8 — normalized_sha256 equals the hash of the exact stored bytes', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'hash me' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { bytes: stored } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      expect(row.normalized_sha256).toBe(sha256Hex(stored));
      expect(row.normalization_schema_version).toBe(NORMALIZED_TRANSCRIPT_SCHEMA_VERSION);
    });

    // ---- TEST 9 — no body/utterance text column in Postgres --------------
    it('TEST 9 — the schema persists NO transcript/utterance body column', async () => {
      const res = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'conversation_transcript' AND table_name = 'ConversationTranscript'`,
      );
      const cols = res.rows.map((r) => r.column_name);
      for (const forbidden of ['body', 'text', 'content', 'utterance', 'utterances', 'transcript_body', 'segments', 'raw_payload', 'payload']) {
        expect(cols).not.toContain(forbidden);
      }
      expect(res.rows.filter((r) => /json/i.test(r.data_type))).toEqual([]);
    });

    // ---- TEST 10 — idempotent success (no duplicate artifact/write) -------
    it('TEST 10 — normalizing an already-normalized transcript converges', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'once' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const a = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const b = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      expect(b.id).toBe(a.id);
      expect(b.normalized_sha256).toBe(a.normalized_sha256);
      expect(store.putCallCount).toBe(1); // second call did not re-write
      const count = await db.query(
        'SELECT count(*)::int AS n FROM conversation_transcript."ConversationTranscript" WHERE id = $1',
        [id],
      );
      expect(count.rows[0].n).toBe(1);
    });

    // ---- TEST 11 — retryable storage failure + bounded park --------------
    it('TEST 11 — retryable write yields failed_retryable, then parks at intervention', async () => {
      const { store, svc } = freshEngine();
      store.writeMode = 'retryable';
      const bytes = fixtureBytes([{ text: 'will fail to write' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const first = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      expect(first.state).toBe('normalization_failed_retryable');
      expect(first.normalization_attempt_count).toBe(1);
      expect(first.last_error_code).toBe(NORMALIZATION_ERROR_CODES.NORMALIZED_ARTIFACT_WRITE_FAILED);
      expect(first.normalized_artifact_ref).toBeNull();
      let last = first;
      for (let i = 1; i < MAX_NORMALIZATION_ATTEMPTS; i += 1) {
        last = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      }
      expect(last.normalization_attempt_count).toBe(MAX_NORMALIZATION_ATTEMPTS);
      expect(last.state).toBe('normalization_intervention_required');
    });

    // ---- TEST 12 — terminal parse failure (no content leak) --------------
    it('TEST 12 — malformed source fails terminal with a safe taxonomy code', async () => {
      const { store, svc } = freshEngine();
      const bytes = Buffer.from('this is not json — secret talent phone 555', 'utf8');
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      expect(row.state).toBe('normalization_failed_terminal');
      expect(row.last_error_code).toBe(NORMALIZATION_ERROR_CODES.SOURCE_PARSE_FAILED);
      // No transcript/source content leaked into the persisted error token.
      expect(row.last_error_code).not.toMatch(/secret|phone|555|not json/);
      expect(row.normalized_artifact_ref).toBeNull();
    });

    // ---- TEST 13 — source deletion after normalization -------------------
    it('TEST 13 — deleting the source leaves the normalized artifact valid', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'keep normalized' }]);
      const { id, sourceRef } = await seedSourceReady(store, TENANT_A, { bytes });
      const norm = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const deleted = await svc.deleteSourceArtifact(TENANT_A, id);
      expect(deleted.source_artifact_ref).toBeNull();
      expect(deleted.source_sha256).toBeNull();
      expect(deleted.deleted_at).not.toBeNull();
      // Normalized artifact + provenance remain independently valid.
      expect(deleted.state).toBe('normalized');
      expect(deleted.normalized_artifact_ref).toBe(norm.normalized_artifact_ref);
      expect(deleted.normalized_sha256).toBe(norm.normalized_sha256);
      expect(store.peek(TENANT_A, sourceRef)).toBeUndefined(); // source object gone
      expect(store.peek(TENANT_A, norm.normalized_artifact_ref as string)).toBeDefined();
    });

    // ---- TEST 14 — normalized deletion (independent of source) ------------
    it('TEST 14 — deleting the normalized artifact leaves source metadata intact', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'delete normalized only' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const norm = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const normalizedRef = norm.normalized_artifact_ref as string;
      const deleted = await svc.deleteNormalizedArtifact(TENANT_A, id);
      expect(deleted.normalized_deleted_at).not.toBeNull();
      expect(deleted.normalized_artifact_ref).toBeNull();
      expect(deleted.normalized_sha256).toBeNull();
      // Source metadata untouched; source deletion marker NOT set.
      expect(deleted.source_artifact_ref).not.toBeNull();
      expect(deleted.source_sha256).not.toBeNull();
      expect(deleted.deleted_at).toBeNull();
      expect(store.peek(TENANT_A, normalizedRef)).toBeUndefined();
    });

    // ---- TEST 15 — tenant isolation --------------------------------------
    it('TEST 15 — a wrong-tenant caller cannot normalize/read another tenant transcript', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ text: 'tenant a only' }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      await expect(
        svc.normalize({ tenant_id: TENANT_B, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT }),
      ).rejects.toBeInstanceOf(TranscriptNotFoundError);
      expect(await repo.findByIdInTenant(TENANT_B, id)).toBeNull();
    });

    // ---- TEST 16 — no provider-specific leakage in the artifact ----------
    it('TEST 16 — the canonical artifact contains only allowed provider-neutral keys', async () => {
      const { store, svc } = freshEngine();
      const bytes = fixtureBytes([{ provider_speaker_id: '1', start_ms: 0, end_ms: 10, text: 'clean' }], 'en-US');
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { bytes: stored, json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      for (const k of Object.keys(json)) expect(ALLOWED_TOP_KEYS.has(k), `top key ${k}`).toBe(true);
      for (const u of json.utterances) {
        for (const k of Object.keys(u)) expect(ALLOWED_UTT_KEYS.has(k), `utt key ${k}`).toBe(true);
      }
      expect(stored.toString('utf8')).not.toMatch(/zoom|teams|msgraph|graph|rtms|webhook/i);
    });

    // ---- TEST 17 — no semantic transformation ----------------------------
    it('TEST 17 — evidentiary wording is preserved (only structural cleanup)', async () => {
      const { store, svc } = freshEngine();
      const original = 'um, I, uh, think i has maybe like eight years  of java';
      const bytes = fixtureBytes([{ text: `  ${original}  ` }]);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const { json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      // Outer whitespace trimmed; hedging/repetition/grammar + internal spacing preserved.
      expect(json.utterances[0].text).toBe(original);
    });

    // ---- TEST 18 — large transcript boundary -----------------------------
    it('TEST 18 — a large transcript normalizes without leaking body into DB/errors', async () => {
      const { store, svc } = freshEngine();
      const segs: FixtureSeg[] = Array.from({ length: 5000 }, (_, i) => ({
        provider_speaker_id: String(i % 2),
        start_ms: i * 1000,
        end_ms: i * 1000 + 500,
        text: `utterance number ${i}`,
      }));
      const bytes = fixtureBytes(segs);
      const { id } = await seedSourceReady(store, TENANT_A, { bytes });
      const row = await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      expect(row.state).toBe('normalized');
      expect(row.last_error_code).toBeNull();
      const { json } = readNormalized(store, TENANT_A, row.normalized_artifact_ref as string);
      expect(json.utterances.length).toBe(5000);
      // The DB row carries only refs/hashes — never the body.
      const dbRow = await db.query(
        'SELECT normalized_artifact_ref, normalized_sha256 FROM conversation_transcript."ConversationTranscript" WHERE id = $1',
        [id],
      );
      expect(dbRow.rows[0].normalized_sha256).toBe(row.normalized_sha256);
    });

    // ---- SECURITY — no secret column; real-PG transition persisted -------
    it('SECURITY — no secret/credential/token column; normalized state persists in PG', async () => {
      const res = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'conversation_transcript' AND table_name = 'ConversationTranscript'`,
      );
      for (const c of res.rows.map((r) => r.column_name.toLowerCase())) {
        expect(c).not.toMatch(/secret|credential|password|token|access_key/);
      }
      const { store, svc } = freshEngine();
      const { id } = await seedSourceReady(store, TENANT_A, { bytes: fixtureBytes([{ text: 'persist' }]) });
      await svc.normalize({ tenant_id: TENANT_A, transcript_id: id, source_format: FIXTURE_TRANSCRIPT_FORMAT });
      const persisted = await db.query(
        'SELECT state, normalization_schema_version FROM conversation_transcript."ConversationTranscript" WHERE id = $1',
        [id],
      );
      expect(persisted.rows[0].state).toBe('normalized');
      expect(persisted.rows[0].normalization_schema_version).toBe(NORMALIZED_TRANSCRIPT_SCHEMA_VERSION);
    });
  },
);
