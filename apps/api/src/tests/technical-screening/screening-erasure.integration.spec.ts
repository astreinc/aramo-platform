import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TalentErasureService, type PgExec, type S3Deleter } from '../../talent-identity/talent-erasure.service.js';

// TIP-E2E INC-3 A1-8 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part H, §B.8) — erasure of
// SCREENING-LINKED data against real Postgres 17 (every repo migration applied):
//   - the A1 screening tables (citation, generation, question, note, suggestion,
//     transcript link), child before parent through the session;
//   - the screening meeting interaction + its operations (incl. a FAILED
//     screening operation with no interaction: requisition_id IS NULL marks a
//     screening meeting, Part F), dispositions, associations;
//   - the linked conversation transcript AND both object-storage artifacts;
//   - the CI screening-profile run + claims + citations + draft.
// Negative controls: the same talent's NON-screening meeting, the other
// talent's transcript / CI run, and another tenant are untouched (the general
// communications / transcript / CI gap stays on the separate S2 track).

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
    const erasure = new TalentErasureService();
    const s3: string[] = [];
    const s3Delete: S3Deleter = async (keys) => {
      s3.push(...keys);
    };
    const ids = {
      session: uuidv7(),
      interaction: uuidv7(),
      otherInteraction: uuidv7(),
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
    async function operation(tenant: string, talent: string, interactionId: string | null, requisition: string | null) {
      await q(
        `INSERT INTO communications."MeetingSchedulingOperation" (id, tenant_id, idempotency_key, transaction_id, operation, interaction_id, organizer_id, talent_record_id, requisition_id)
         VALUES ($1::uuid,$2::uuid,$3,$3,'create',$4::uuid,$5::uuid,$6::uuid,$7::uuid)`,
        [uuidv7(), tenant, uuidv7(), interactionId, ACTOR, talent, requisition],
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
            normalized_sha256, model_provider, model_name, prompt_template_id, prompt_template_version, prompt_sha256, output_schema_version)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,'h','anthropic','m','t','v','s','o')`,
        [id, tenant, interactionId, transcriptId, sessionId === null ? uuidv7() : null, sessionId === null ? 'REQUISITION' : 'SCREENING', sessionId],
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
      await operation(TENANT, REC, ids.interaction, null);
      await operation(TENANT, REC, null, null); // a FAILED screening operation (no interaction)
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

      // ---- NEGATIVE CONTROLS ----
      // The same talent's NON-screening (requisition) meeting: S2 track, untouched.
      await interaction(ids.otherInteraction, TENANT, REC, [['requisition', uuidv7()]]);
      await operation(TENANT, REC, ids.otherInteraction, uuidv7());
      // Another talent's transcript + CI run in the same tenant.
      await transcript(ids.otherTranscript, TENANT, ids.otherInteraction);
      await ciRun(ids.otherRun, TENANT, ids.otherTranscript, ids.otherInteraction, null);
      // Another tenant's screening-shaped interaction.
      await interaction(ids.foreignInteraction, OTHER_TENANT, OTHER_TALENT, []);
    }, 300_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    }, 60_000);

    it('dry-run counts every screening-linked holder (and collects BOTH transcript artifacts) with zero writes', async () => {
      const report = await erasure.dryRun(pg, TENANT, REC);
      expect(report.steps.filter((s) => s.status !== 'counted')).toEqual([]);
      const c = (t: string): number => report.steps.find((s) => s.table === t)!.count;
      expect(c('conversation_intelligence."ConversationIntelligenceRun"')).toBe(1);
      expect(c('conversation_intelligence."ConversationIntelligenceClaim"')).toBe(1);
      expect(c('conversation_intelligence."ConversationIntelligenceCitation"')).toBe(1);
      expect(c('conversation_intelligence."ConversationIntelligenceDraft"')).toBe(1);
      expect(c('conversation_transcript."ConversationTranscript"')).toBe(1);
      expect(c('communications."CommunicationInteraction"')).toBe(1);
      expect(c('communications."CommunicationAssociation"')).toBe(2);
      expect(c('communications."MeetingSchedulingOperation"')).toBe(2); // linked + the failed screening op
      for (const t of ['ScreeningFindingCitation', 'ScreeningAssistSuggestion', 'ScreeningNote', 'ScreeningQuestion', 'ScreeningAiGeneration', 'ScreeningTranscriptLink']) {
        expect(c(`technical_screening."${t}"`), t).toBe(1);
      }
      expect(report.scope.s3_keys.sort()).toEqual([
        `conversation-transcript/${TENANT}/normalized/${ids.transcript}`,
        `conversation-transcript/${TENANT}/source/${ids.transcript}`,
      ]);
      expect(await count('technical_screening."ScreeningNote"', 'true', [])).toBe(1);
    });

    it('execute erases every screening-linked row + artifact and nothing else; a re-run is empty', async () => {
      const report = await erasure.execute(pg, TENANT, REC, s3Delete);
      expect(report.steps.filter((s) => s.status === 'failed')).toEqual([]);
      expect(s3.sort()).toEqual([
        `conversation-transcript/${TENANT}/normalized/${ids.transcript}`,
        `conversation-transcript/${TENANT}/source/${ids.transcript}`,
      ]);
      for (const t of ['ScreeningSession', 'ScreeningFinding', 'ScreeningFindingCitation', 'ScreeningAssistSuggestion', 'ScreeningNote', 'ScreeningQuestion', 'ScreeningAiGeneration', 'ScreeningTranscriptLink', 'ScreeningEvent']) {
        expect(await count(`technical_screening."${t}"`, 'tenant_id = $1::uuid', [TENANT]), t).toBe(0);
      }
      expect(await count('conversation_transcript."ConversationTranscript"', 'id = $1::uuid', [ids.transcript])).toBe(0);
      expect(await count('conversation_intelligence."ConversationIntelligenceRun"', 'id = $1::uuid', [ids.run])).toBe(0);
      expect(await count('conversation_intelligence."ConversationIntelligenceClaim"', 'run_id = $1::uuid', [ids.run])).toBe(0);
      expect(await count('communications."CommunicationInteraction"', 'id = $1::uuid', [ids.interaction])).toBe(0);
      expect(await count('communications."MeetingSchedulingOperation"', 'talent_record_id = $1::uuid AND requisition_id IS NULL', [REC])).toBe(0);

      // Negative controls — untouched.
      expect(await count('communications."CommunicationInteraction"', 'id = ANY($1::uuid[])', [[ids.otherInteraction, ids.foreignInteraction]])).toBe(2);
      expect(await count('communications."MeetingSchedulingOperation"', 'interaction_id = $1::uuid', [ids.otherInteraction])).toBe(1);
      expect(await count('conversation_transcript."ConversationTranscript"', 'id = $1::uuid', [ids.otherTranscript])).toBe(1);
      expect(await count('conversation_intelligence."ConversationIntelligenceRun"', 'id = $1::uuid', [ids.otherRun])).toBe(1);
      expect(await count('conversation_intelligence."ConversationIntelligenceClaim"', 'run_id = $1::uuid', [ids.otherRun])).toBe(1);
      expect(await count('talent_record."TalentRecord"', 'id = $1::uuid', [OTHER_TALENT])).toBe(1);

      const second = await erasure.execute(pg, TENANT, REC, s3Delete);
      expect(second.total_rows).toBe(0);
    });
  },
);
