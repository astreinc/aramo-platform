import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fakeSignErasure } from '../helpers/fake-sign-erasure.js';
import { TalentErasureService, type ErasureObjectStore, type PgExec } from '../../talent-identity/talent-erasure.service.js';

// TIP-E2E INC-3 A1-8 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part H, §B.8) — erasure of
// SCREENING-LINKED data against real Postgres 17 (every repo migration applied):
//   - the A1 screening tables (citation, generation, question, note, suggestion,
//     transcript link), child before parent through the session;
//   - the screening meeting interactions (the session's linked one AND one
//     scheduled but never linked, found by its screening_session association)
//     + their operations, identified by the operation's EXPLICIT
//     screening_session_id (incl. a FAILED operation with no interaction),
//     dispositions, associations;
//   - the linked conversation transcript AND both object-storage artifacts;
//   - the CI screening-profile run + claims + citations + draft.
// S2 (Talent Erasure Integrity, F3): the talent's GENERAL communications are
// erased too — the same talent's non-screening (requisition) meeting and its
// transcript + CI run are personal data of the erased person.
// Negative controls: ANOTHER talent's meeting / transcript / CI run in the same
// tenant, and another tenant, are untouched.

const ROOT = resolve(__dirname, '../../../../..');
function allMigrations(): string[] {
  const libs = resolve(ROOT, 'libs');
  const out: Array<{ ts: string; path: string }> = [];
  for (const lib of readdirSync(libs)) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(libs, lib, 'prisma', 'migrations'));
    } catch {
      continue;
    }
    for (const e of entries) if (/^\d{14}_/.test(e)) out.push({ ts: e, path: resolve(libs, lib, 'prisma', 'migrations', e, 'migration.sql') });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts)).map((m) => m.path);
}

const TENANT = '01900000-0000-7000-8000-0000000a18e1';
const OTHER_TENANT = '01900000-0000-7000-8000-0000000a18e2';
const REC = '01900000-0000-7000-8000-0000000a18e3';
const OTHER_TALENT = '01900000-0000-7000-8000-0000000a18e4';
const ACTOR = '01900000-0000-7000-8000-0000000a18e5';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'INC-3 A1-8 — screening-linked erasure (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let pg: PgExec;
    const erasure = new TalentErasureService(fakeSignErasure());
    const s3: string[] = [];
    const s3Delete: ErasureObjectStore = {
      purge: async (key) => {
        s3.push(key);
        return { remaining: 0 };
      },
    };
    const ids = {
      session: uuidv7(),
      interaction: uuidv7(),
      pendingLinkInteraction: uuidv7(),
      otherInteraction: uuidv7(), // REC's general (requisition) meeting — erased under S2
      otherTalentInteraction: uuidv7(), // ANOTHER talent's meeting — must survive
      otherTalentTranscript: uuidv7(),
      otherTalentRun: uuidv7(),
      foreignInteraction: uuidv7(),
      transcript: uuidv7(),
      otherTranscript: uuidv7(),
      run: uuidv7(),
      otherRun: uuidv7(),
    };

    async function count(table: string, where: string, params: unknown[]): Promise<number> {
      const r = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
      return Number(r.rows[0]!.n);
    }
    const q = (sql: string, params: unknown[]) => db.query(sql, params);

    async function interaction(id: string, tenant: string, talent: string, subjects: Array<[string, string]>) {
      await q(
        `INSERT INTO communications."CommunicationInteraction" (id, tenant_id, channel, direction, from_address, to_address, initiated_by_id, join_reference)
         VALUES ($1::uuid,$2::uuid,'meeting','outbound','r@x.example','t@x.example',$3::uuid,'https://teams/join')`,
        [id, tenant, ACTOR],
      );
      for (const [type, subject] of [['talent_record', talent], ...subjects] as Array<[string, string]>) {
        await q(
          `INSERT INTO communications."CommunicationAssociation" (id, tenant_id, interaction_id, subject_type, subject_id, relation_type)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,'subject')`,
          [uuidv7(), tenant, id, type, subject],
        );
      }
    }
    async function operation(tenant: string, talent: string, interactionId: string | null, requisition: string | null, session: string | null = null) {
      await q(
        `INSERT INTO communications."MeetingSchedulingOperation" (id, tenant_id, idempotency_key, transaction_id, operation, interaction_id, organizer_id, talent_record_id, requisition_id, screening_session_id)
         VALUES ($1::uuid,$2::uuid,$3,$3,'create',$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid)`,
        [uuidv7(), tenant, uuidv7(), interactionId, ACTOR, talent, requisition, session],
      );
    }
    async function transcript(id: string, tenant: string, interactionId: string) {
      await q(
        `INSERT INTO conversation_transcript."ConversationTranscript" (id, tenant_id, interaction_id, provider_key, provider_transcript_id, state, source_artifact_ref, normalized_artifact_ref, updated_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'microsoft_teams',$1,'normalized',$4,$5,now())`,
        [id, tenant, interactionId, `conversation-transcript/${tenant}/source/${id}`, `conversation-transcript/${tenant}/normalized/${id}`],
      );
    }
    async function ciRun(id: string, tenant: string, transcriptId: string, interactionId: string, sessionId: string | null) {
      await q(
        `INSERT INTO conversation_intelligence."ConversationIntelligenceRun"
           (id, tenant_id, interaction_id, conversation_transcript_id, requisition_analysis_context_snapshot_id, analysis_profile, screening_session_id,
            screening_context_sha256, normalized_sha256, model_provider, model_name, prompt_template_id, prompt_template_version, prompt_sha256, output_schema_version)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,'h','anthropic','m','t','v','s','o')`,
        [id, tenant, interactionId, transcriptId, sessionId === null ? uuidv7() : null, sessionId === null ? 'REQUISITION' : 'SCREENING', sessionId, sessionId === null ? null : 'c'.repeat(64)],
      );
      const claim = uuidv7();
      await q(
        `INSERT INTO conversation_intelligence."ConversationIntelligenceClaim" (id, tenant_id, run_id, ordinal, claim_type, statement, status)
         VALUES ($1::uuid,$2::uuid,$3::uuid,0,'screening_finding_draft','said X','SUPPORTED_BY_STATEMENT')`,
        [claim, tenant, id],
      );
      await q(
        `INSERT INTO conversation_intelligence."ConversationIntelligenceCitation" (id, tenant_id, claim_id, conversation_transcript_id, normalized_sha256, utterance_id, start_offset, end_offset)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'h','u1',0,3)`,
        [uuidv7(), tenant, claim, transcriptId],
      );
      await q(
        `INSERT INTO conversation_intelligence."ConversationIntelligenceDraft" (id, tenant_id, run_id, schema_version, content) VALUES ($1::uuid,$2::uuid,$3::uuid,'v','{}'::jsonb)`,
        [uuidv7(), tenant, id],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      for (const p of allMigrations()) await db.query(readFileSync(p, 'utf8'));
      pg = {
        async query<T>(sql: string, ps?: unknown[]) {
          const r = await db.query(sql, ps as unknown[] | undefined);
          return { rows: r.rows as T[], rowCount: r.rowCount };
        },
      };

      for (const [t, tenant] of [[REC, TENANT], [OTHER_TALENT, TENANT]] as const) {
        await q(`INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name) VALUES ($1::uuid,$2::uuid,'Ada','L')`, [t, tenant]);
      }

      // ---- the erased talent's SCREENING session + its linked data ----
      await interaction(ids.interaction, TENANT, REC, [['screening_session', ids.session]]);
      await q(
        `INSERT INTO technical_screening."ScreeningSession" (id, tenant_id, talent_record_id, interaction_id, state, version, created_by_actor_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'DRAFT',2,$5::uuid)`,
        [ids.session, TENANT, REC, ids.interaction, ACTOR],
      );
      await operation(TENANT, REC, ids.interaction, null, ids.session);
      await operation(TENANT, REC, null, null, ids.session); // a FAILED screening operation (no interaction)
      // Scheduled but never linked to the session (e.g. a crash between steps):
      // reached through its screening_session association only.
      await interaction(ids.pendingLinkInteraction, TENANT, REC, [['screening_session', ids.session]]);
      await operation(TENANT, REC, ids.pendingLinkInteraction, null, ids.session);
      await transcript(ids.transcript, TENANT, ids.interaction);
      await ciRun(ids.run, TENANT, ids.transcript, ids.interaction, ids.session);
      const gen = uuidv7();
      const finding = uuidv7();
      await q(
        `INSERT INTO technical_screening."ScreeningAiGeneration" (id, tenant_id, session_id, kind, provider, model, prompt_version, input_sha256, used_talent_profile, used_requisition, used_transcript, output_count, actor_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'FOLLOW_UP','anthropic','m','v','h',false,false,true,1,$4)`,
        [gen, TENANT, ids.session, ACTOR],
      );
      await q(`INSERT INTO technical_screening."ScreeningQuestion" (id, tenant_id, session_id, text, intent, origin, status, position) VALUES ($1::uuid,$2::uuid,$3::uuid,'Q?','PROBE','RECRUITER_AUTHORED','SELECTED',0)`, [uuidv7(), TENANT, ids.session]);
      await q(`INSERT INTO technical_screening."ScreeningNote" (id, tenant_id, session_id, body, actor_id) VALUES ($1::uuid,$2::uuid,$3::uuid,'note',$4)`, [uuidv7(), TENANT, ids.session, ACTOR]);
      await q(
        `INSERT INTO technical_screening."ScreeningAssistSuggestion" (id, tenant_id, session_id, generation_id, text, trigger_kind, trigger_ref) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ask more','NOTE','{}'::jsonb)`,
        [uuidv7(), TENANT, ids.session, gen],
      );
      await q(`INSERT INTO technical_screening."ScreeningTranscriptLink" (id, tenant_id, session_id, conversation_transcript_id, source) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'TEAMS_GRAPH')`, [uuidv7(), TENANT, ids.session, ids.transcript]);
      await q(`INSERT INTO technical_screening."ScreeningFinding" (id, tenant_id, session_id, skill_raw, basis, observation_raw) VALUES ($1::uuid,$2::uuid,$3::uuid,'Go','SELF_REPORTED','said')`, [finding, TENANT, ids.session]);
      await q(
        `INSERT INTO technical_screening."ScreeningFindingCitation" (id, tenant_id, finding_id, conversation_transcript_id, utterance_id, start_offset, end_offset, normalized_sha256) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'u1',0,3,'h')`,
        [uuidv7(), TENANT, finding, ids.transcript],
      );

      // ---- The same talent's GENERAL (requisition) meeting — erased under S2 F3 ----
      await interaction(ids.otherInteraction, TENANT, REC, [['requisition', uuidv7()]]);
      await operation(TENANT, REC, ids.otherInteraction, uuidv7());
      await transcript(ids.otherTranscript, TENANT, ids.otherInteraction);
      await ciRun(ids.otherRun, TENANT, ids.otherTranscript, ids.otherInteraction, null);
      // ---- NEGATIVE CONTROLS ----
      // ANOTHER talent's meeting + transcript + CI run in the same tenant.
      await interaction(ids.otherTalentInteraction, TENANT, OTHER_TALENT, [['requisition', uuidv7()]]);
      await operation(TENANT, OTHER_TALENT, ids.otherTalentInteraction, uuidv7());
      await transcript(ids.otherTalentTranscript, TENANT, ids.otherTalentInteraction);
      await ciRun(ids.otherTalentRun, TENANT, ids.otherTalentTranscript, ids.otherTalentInteraction, null);
      // Another tenant's screening-shaped interaction.
      await interaction(ids.foreignInteraction, OTHER_TENANT, OTHER_TALENT, []);
    }, 300_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    }, 60_000);

    it('a scheduling operation always carries an authoritative association (DB CHECK)', async () => {
      await expect(operation(TENANT, REC, null, null, null)).rejects.toThrow(/MeetingSchedulingOperation_association_check/);
    });

    it('dry-run counts every screening-linked holder (and collects BOTH transcript artifacts) with zero writes', async () => {
      const report = await erasure.dryRun(pg, TENANT, REC);
      expect(report.steps.filter((s) => s.status !== 'counted')).toEqual([]);
      const c = (t: string): number => report.steps.find((s) => s.table === t)!.count;
      expect(report.blockers).toEqual([]);
      // screening run + the general meeting's run
      expect(c('conversation_intelligence."ConversationIntelligenceRun"')).toBe(2);
      expect(c('conversation_intelligence."ConversationIntelligenceClaim"')).toBe(2);
      expect(c('conversation_intelligence."ConversationIntelligenceCitation"')).toBe(2);
      expect(c('conversation_intelligence."ConversationIntelligenceDraft"')).toBe(2);
      expect(c('conversation_transcript."ConversationTranscript"')).toBe(2);
      expect(c('communications."CommunicationInteraction"')).toBe(3); // linked + scheduled-but-unlinked + general
      expect(c('communications."CommunicationAssociation"')).toBe(6);
      expect(c('communications."MeetingSchedulingOperation"')).toBe(4); // linked + unlinked + failed + general
      for (const t of ['ScreeningFindingCitation', 'ScreeningAssistSuggestion', 'ScreeningNote', 'ScreeningQuestion', 'ScreeningAiGeneration', 'ScreeningTranscriptLink']) {
        expect(c(`technical_screening."${t}"`), t).toBe(1);
      }
      expect(report.scope.s3_keys.sort()).toEqual([
        `conversation-transcript/${TENANT}/normalized/${ids.otherTranscript}`,
        `conversation-transcript/${TENANT}/normalized/${ids.transcript}`,
        `conversation-transcript/${TENANT}/source/${ids.otherTranscript}`,
        `conversation-transcript/${TENANT}/source/${ids.transcript}`,
      ].sort());
      expect(await count('technical_screening."ScreeningNote"', 'true', [])).toBe(1);
    });

    it('execute erases every screening-linked row + artifact and nothing else; a re-run is empty', async () => {
      const report = await erasure.execute(pg, TENANT, REC, s3Delete);
      expect(report.outcome).toBe('COMPLETED');
      // S2 LOCKED §3.2 — the pass also redacts / tombstones retained history (never 'failed').
      expect(report.steps.filter((s) => !['deleted', 'redacted', 'tombstoned'].includes(s.status))).toEqual([]);
      expect(report.storage).toEqual({ total: 4, purged: 4, pending: 0, failed: 0 });
      expect(s3.sort()).toEqual([
        `conversation-transcript/${TENANT}/normalized/${ids.otherTranscript}`,
        `conversation-transcript/${TENANT}/normalized/${ids.transcript}`,
        `conversation-transcript/${TENANT}/source/${ids.otherTranscript}`,
        `conversation-transcript/${TENANT}/source/${ids.transcript}`,
      ].sort());
      for (const t of ['ScreeningSession', 'ScreeningFinding', 'ScreeningFindingCitation', 'ScreeningAssistSuggestion', 'ScreeningNote', 'ScreeningQuestion', 'ScreeningAiGeneration', 'ScreeningTranscriptLink', 'ScreeningEvent']) {
        expect(await count(`technical_screening."${t}"`, 'tenant_id = $1::uuid', [TENANT]), t).toBe(0);
      }
      expect(await count('conversation_transcript."ConversationTranscript"', 'id = $1::uuid', [ids.transcript])).toBe(0);
      expect(await count('conversation_intelligence."ConversationIntelligenceRun"', 'id = $1::uuid', [ids.run])).toBe(0);
      expect(await count('conversation_intelligence."ConversationIntelligenceClaim"', 'run_id = $1::uuid', [ids.run])).toBe(0);
      expect(await count('communications."CommunicationInteraction"', 'id = $1::uuid', [ids.interaction])).toBe(0);
      expect(await count('communications."CommunicationInteraction"', 'id = $1::uuid', [ids.pendingLinkInteraction])).toBe(0);
      expect(await count('communications."MeetingSchedulingOperation"', 'screening_session_id = $1::uuid', [ids.session])).toBe(0);

      // S2 F3 — the same talent's GENERAL meeting, its transcript and CI run are gone too.
      expect(await count('communications."CommunicationInteraction"', 'id = $1::uuid', [ids.otherInteraction])).toBe(0);
      expect(await count('communications."MeetingSchedulingOperation"', 'talent_record_id = $1::uuid', [REC])).toBe(0);
      expect(await count('conversation_transcript."ConversationTranscript"', 'id = $1::uuid', [ids.otherTranscript])).toBe(0);
      expect(await count('conversation_intelligence."ConversationIntelligenceRun"', 'id = $1::uuid', [ids.otherRun])).toBe(0);

      // Negative controls — ANOTHER talent and ANOTHER tenant are untouched.
      expect(await count('communications."CommunicationInteraction"', 'id = ANY($1::uuid[])', [[ids.otherTalentInteraction, ids.foreignInteraction]])).toBe(2);
      expect(await count('communications."MeetingSchedulingOperation"', 'interaction_id = $1::uuid', [ids.otherTalentInteraction])).toBe(1);
      expect(await count('conversation_transcript."ConversationTranscript"', 'id = $1::uuid', [ids.otherTalentTranscript])).toBe(1);
      expect(await count('conversation_intelligence."ConversationIntelligenceRun"', 'id = $1::uuid', [ids.otherTalentRun])).toBe(1);
      expect(await count('conversation_intelligence."ConversationIntelligenceClaim"', 'run_id = $1::uuid', [ids.otherTalentRun])).toBe(1);
      expect(await count('talent_record."TalentRecord"', 'id = $1::uuid', [OTHER_TALENT])).toBe(1);

      const second = await erasure.execute(pg, TENANT, REC, s3Delete);
      expect(second.outcome).toBe('COMPLETED');
      expect(second.total_rows).toBe(0);
    });
  },
);
