import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConversationTranscriptRepository } from '../lib/conversation-transcript.repository.js';
import {
  ConversationTranscriptService,
  MAX_ACQUISITION_ATTEMPTS,
} from '../lib/conversation-transcript.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  TranscriptAcquisitionNotAuthorizedError,
  TranscriptInteractionNotFoundError,
} from '../lib/domain/errors.js';
import { ConversationTranscriptProviderRegistry } from '../lib/provider/conversation-transcript-provider.registry.js';
import {
  FakeConversationTranscriptProvider,
  FAKE_TRANSCRIPT_PROVIDER_KEY,
} from '../lib/provider/fake/fake-conversation-transcript-provider.js';
import type { InteractionReferencePort } from '../lib/ports/interaction-reference.port.js';
import type { TranscriptionAuthorization } from '../lib/ports/transcription-authorization.js';

// CI-B3 — persistence + contract proofs against real Postgres 17. Skipped unless
// ARAMO_RUN_INTEGRATION=1. This spec applies the communications migrations (to
// stand up a REAL CommunicationInteraction, proving tenant-safe linkage without
// importing @aramo/communications — no nx edge) AND the conversation_transcript
// migration. Cross-schema refs are UUID-only, no FK (directive §3.1/§3.3).

const ROOT = resolve(__dirname, '../../../..');

function migrationsIn(libDir: string): string[] {
  const dir = resolve(ROOT, libDir, 'prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

// Comment-aware splitter — drops whole `--` comment lines before splitting on
// `;` (older migrations carry `;` inside comments).
function splitDdl(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const AUTHORIZED: TranscriptionAuthorization = {
  transcription_authorized: true,
  consent_decision_ref: 'consent-decision-abc',
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CI-B3 conversation-transcript persistence — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: ConversationTranscriptRepository;
    let providers: ConversationTranscriptProviderRegistry;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();
    const CONNECTION = randomUUID();

    // Real-reader InteractionReferencePort querying communications (tenant-safe).
    const interactionPort: InteractionReferencePort = {
      async existsInTenant(tenantId: string, interactionId: string): Promise<boolean> {
        const res = await db.query(
          'SELECT 1 FROM communications."CommunicationInteraction" WHERE id = $1 AND tenant_id = $2',
          [interactionId, tenantId],
        );
        return (res.rowCount ?? 0) > 0;
      },
    };

    async function createInteraction(tenant: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO communications."CommunicationInteraction"
           (id, tenant_id, channel, direction, integration_connection_id, from_address, to_address)
         VALUES ($1, $2, 'voice', 'outbound', $3, '+15715550100', '+17035550111')`,
        [id, tenant, CONNECTION],
      );
      return id;
    }

    function newService(provider = new FakeConversationTranscriptProvider()) {
      const reg = new ConversationTranscriptProviderRegistry();
      reg.register(provider);
      return {
        provider,
        service: new ConversationTranscriptService(repo, reg, interactionPort),
      };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of migrationsIn('libs/communications')) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await db.query(stmt);
      }
      for (const p of migrationsIn('libs/conversation-transcript')) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await db.query(stmt);
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ConversationTranscriptRepository(prisma);
      providers = new ConversationTranscriptProviderRegistry();
      providers.register(new FakeConversationTranscriptProvider());
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    // ---- TEST 1 — no transcript body in DB -------------------------------
    it('TEST 1 — the schema persists NO transcript body / raw payload column', async () => {
      const res = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'conversation_transcript'
            AND table_name = 'ConversationTranscript'`,
      );
      const cols = res.rows.map((r) => r.column_name);
      for (const forbidden of [
        'body',
        'transcript',
        'transcript_body',
        'text',
        'content',
        'utterances',
        'raw_payload',
        'provider_payload',
        'payload',
      ]) {
        expect(cols, `column ${forbidden} must not exist`).not.toContain(forbidden);
      }
      // No JSON/JSONB column anywhere (no raw provider payload dump — §7.1/§30.5).
      const jsonCols = res.rows.filter((r) => /json/i.test(r.data_type));
      expect(jsonCols).toEqual([]);
    });

    // ---- TEST 2 — interaction authority preserved ------------------------
    it('TEST 2 — references CommunicationInteraction without duplicating it', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const { service } = newService();
      const t = await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: `pt-${randomUUID()}`,
      });
      expect(t.interaction_id).toBe(interactionId);
      // The transcript row holds only a UUID ref — no communication fields.
      expect(t).not.toHaveProperty('from_address');
      expect(t).not.toHaveProperty('channel');
      expect(t.state).toBe('source_available');
    });

    // ---- TEST 3 — wrong tenant link --------------------------------------
    it('TEST 3 — Tenant A cannot bind a transcript to a Tenant B interaction', async () => {
      const bInteraction = await createInteraction(TENANT_B);
      const { service } = newService();
      await expect(
        service.registerTranscriptAvailability({
          tenant_id: TENANT_A,
          interaction_id: bInteraction,
          provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
          provider_transcript_id: `pt-${randomUUID()}`,
        }),
      ).rejects.toBeInstanceOf(TranscriptInteractionNotFoundError);
      // No row leaked into Tenant A.
      const res = await db.query(
        'SELECT 1 FROM conversation_transcript."ConversationTranscript" WHERE tenant_id = $1 AND interaction_id = $2',
        [TENANT_A, bInteraction],
      );
      expect(res.rowCount).toBe(0);
    });

    // ---- TEST 4 — provider-neutral identity ------------------------------
    it('TEST 4 — the domain sees a provider-neutral (normalized-string) identity', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService();
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      const acquired = await service.acquire({
        tenant_id: TENANT_A,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
        authorization: AUTHORIZED,
      });
      expect(acquired.provider_key).toBe('fake_transcript');
      expect(typeof acquired.provider_key).toBe('string');
      expect(acquired.state).toBe('source_ready');
    });

    // ---- TEST 5 — replay (availability event) ----------------------------
    it('TEST 5 — replaying the same availability signal yields ONE aggregate', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService();
      const cmd = {
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      };
      const first = await service.registerTranscriptAvailability(cmd);
      const second = await service.registerTranscriptAvailability(cmd);
      expect(second.id).toBe(first.id);
      const res = await db.query(
        'SELECT count(*)::int AS n FROM conversation_transcript."ConversationTranscript" WHERE tenant_id = $1 AND provider_transcript_id = $2',
        [TENANT_A, providerTranscriptId],
      );
      expect(res.rows[0].n).toBe(1);
    });

    // ---- TEST 6 — provider transcript replay (acquire twice) -------------
    it('TEST 6 — acquiring twice converges idempotently (no duplicate, no re-fetch)', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { provider, service } = newService();
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      const a1 = await service.acquire({
        tenant_id: TENANT_A,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
        authorization: AUTHORIZED,
      });
      const a2 = await service.acquire({
        tenant_id: TENANT_A,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
        authorization: AUTHORIZED,
      });
      expect(a1.id).toBe(a2.id);
      expect(a1.source_artifact_ref).toBe(a2.source_artifact_ref);
      // Second call converged on the already-acquired row — provider NOT re-invoked.
      expect(provider.acquireCallCount).toBe(1);
      const res = await db.query(
        'SELECT count(*)::int AS n FROM conversation_transcript."ConversationTranscript" WHERE tenant_id = $1 AND provider_transcript_id = $2',
        [TENANT_A, providerTranscriptId],
      );
      expect(res.rows[0].n).toBe(1);
    });

    // ---- TEST 7 — retryable failure --------------------------------------
    it('TEST 7 — a retryable provider failure yields failed_retryable + attempt count', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService(new FakeConversationTranscriptProvider({ mode: 'retryable' }));
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      const out = await service.acquire({
        tenant_id: TENANT_A,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
        authorization: AUTHORIZED,
      });
      expect(out.state).toBe('failed_retryable');
      expect(out.attempt_count).toBe(1);
      expect(out.last_error_code).toBe('PROVIDER_TEMPORARY');
    });

    // ---- TEST 8 — terminal / manual park ---------------------------------
    it('TEST 8 — bounded retries park the transcript at intervention_required', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService(new FakeConversationTranscriptProvider({ mode: 'retryable' }));
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      let last;
      for (let i = 0; i < MAX_ACQUISITION_ATTEMPTS; i += 1) {
        last = await service.acquire({
          tenant_id: TENANT_A,
          provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
          provider_transcript_id: providerTranscriptId,
          authorization: AUTHORIZED,
        });
      }
      expect(last?.attempt_count).toBe(MAX_ACQUISITION_ATTEMPTS);
      expect(last?.state).toBe('intervention_required');
    });

    // ---- TEST 9 — custody mode -------------------------------------------
    it('TEST 9 — each custody mode persists with preserved semantics', async () => {
      for (const custody of ['provider_referenced', 'temporarily_cached', 'aramo_retained'] as const) {
        const interactionId = await createInteraction(TENANT_A);
        const { service } = newService();
        const t = await service.registerTranscriptAvailability({
          tenant_id: TENANT_A,
          interaction_id: interactionId,
          provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
          provider_transcript_id: `pt-${randomUUID()}`,
          custody_mode: custody,
        });
        expect(t.custody_mode).toBe(custody);
      }
    });

    // ---- TEST 10 — source artifact (opaque ref + hash, no body) ----------
    it('TEST 10 — acquisition stores an OPAQUE source ref + hash, never content or a URL', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService();
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      const t = await service.acquire({
        tenant_id: TENANT_A,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
        authorization: AUTHORIZED,
      });
      expect(t.source_artifact_ref).toBeTruthy();
      expect(t.source_sha256).toMatch(/^[0-9a-f]{64}$/);
      // Opaque handle — no URL scheme, no bucket enumeration surface (§28).
      expect(t.source_artifact_ref).not.toMatch(/^https?:|^s3:|:\/\//);
    });

    // ---- TEST 11 — normalized placeholder --------------------------------
    it('TEST 11 — normalized artifact ref/hash remain null before CI-B4', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService();
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      const t = await service.acquire({
        tenant_id: TENANT_A,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
        authorization: AUTHORIZED,
      });
      expect(t.state).toBe('source_ready');
      expect(t.normalized_artifact_ref).toBeNull();
      expect(t.normalized_sha256).toBeNull();
      expect(t.normalized_at).toBeNull();
    });

    // ---- TEST 12 — no consent duplication --------------------------------
    it('TEST 12 — the schema creates NO consent/scope authority table', async () => {
      const res = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'conversation_transcript'`,
      );
      const tables = res.rows.map((r) => r.table_name);
      expect(tables).toEqual(['ConversationTranscript']);
      for (const t of tables) {
        expect(t.toLowerCase()).not.toContain('consent');
        expect(t.toLowerCase()).not.toContain('scope');
        expect(t.toLowerCase()).not.toContain('policy');
      }
    });

    // ---- TEST 13 — no provider-specific leakage --------------------------
    it('TEST 13 — no vendor-named column exists on the aggregate', async () => {
      const res = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'conversation_transcript' AND table_name = 'ConversationTranscript'`,
      );
      for (const c of res.rows.map((r) => r.column_name.toLowerCase())) {
        expect(c).not.toMatch(/zoom|teams|msgraph|rtms/);
      }
    });

    // ---- TEST 14 — no AI/recruiting mutation -----------------------------
    it('TEST 14 — the lib imports no Requisition/Talent/Pipeline/AI authority', () => {
      // Structural proof: the acquisition path cannot mutate other domains
      // because the lib depends on none of them (no nx edge, no import).
      const scan = [
        'lib/conversation-transcript.service.ts',
        'lib/conversation-transcript.repository.ts',
        'index.ts',
      ];
      const banned = /@aramo\/(requisition|talent|talent-record|pipeline|ai-draft|selection|submittal|placement|consent)/;
      for (const f of scan) {
        const text = readFileSync(resolve(__dirname, '..', f), 'utf8');
        expect(text, `${f} must not import a downstream authority`).not.toMatch(banned);
      }
    });

    // ---- SECURITY ---------------------------------------------------------
    it('SECURITY — fail-closed: acquisition without authorization proof is denied, no state change', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { provider, service } = newService();
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      await expect(
        service.acquire({
          tenant_id: TENANT_A,
          provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
          provider_transcript_id: providerTranscriptId,
          authorization: { transcription_authorized: false },
        }),
      ).rejects.toBeInstanceOf(TranscriptAcquisitionNotAuthorizedError);
      // Provider never called; state unchanged.
      expect(provider.acquireCallCount).toBe(0);
      const row = await repo.findByProviderRef(TENANT_A, FAKE_TRANSCRIPT_PROVIDER_KEY, providerTranscriptId);
      expect(row?.state).toBe('source_available');
    });

    it('SECURITY — tenant isolation: a wrong-tenant id cannot read the aggregate', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService();
      const t = await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      expect(await repo.findByIdInTenant(TENANT_A, t.id)).not.toBeNull();
      // Tenant B cannot read Tenant A's transcript metadata.
      expect(await repo.findByIdInTenant(TENANT_B, t.id)).toBeNull();
    });

    it('SECURITY — no provider secret / credential / token column exists', async () => {
      const res = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'conversation_transcript' AND table_name = 'ConversationTranscript'`,
      );
      for (const c of res.rows.map((r) => r.column_name.toLowerCase())) {
        expect(c).not.toMatch(/secret|credential|password|token|access_key/);
      }
    });

    it('SECURITY — artifact deletion clears the ref but preserves the metadata aggregate', async () => {
      const interactionId = await createInteraction(TENANT_A);
      const providerTranscriptId = `pt-${randomUUID()}`;
      const { service } = newService();
      await service.registerTranscriptAvailability({
        tenant_id: TENANT_A,
        interaction_id: interactionId,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
      });
      const acquired = await service.acquire({
        tenant_id: TENANT_A,
        provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
        provider_transcript_id: providerTranscriptId,
        authorization: AUTHORIZED,
      });
      expect(acquired.source_artifact_ref).toBeTruthy();
      const deleted = await service.markSourceArtifactDeleted(TENANT_A, acquired.id);
      // Artifact deletion != metadata deletion (§7.3/§8.2): row + provenance stay.
      expect(deleted.deleted_at).not.toBeNull();
      expect(deleted.source_artifact_ref).toBeNull();
      expect(deleted.source_sha256).toBeNull();
      const stillThere = await repo.findByIdInTenant(TENANT_A, acquired.id);
      expect(stillThere).not.toBeNull();
      expect(stillThere?.provider_transcript_id).toBe(providerTranscriptId);
    });
  },
);
