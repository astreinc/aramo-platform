import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fakeSignErasure } from './helpers/fake-sign-erasure.js';

import {
  ERASURE_EXIT_CODES,
  ERASURE_HOLDER_GUARDS,
  ERASURE_REACHED_HOLDERS,
  RETAINED,
  TalentErasureService,
  type ErasureObjectStore,
  type PgExec,
} from '../talent-identity/talent-erasure.service.js';

// S2 Talent Erasure Integrity (Architect rulings F1/F3/F5; TM-L12 auditable
// completion; ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED) — against
// real Postgres 17 with every repo migration applied. Acceptance: Aramo never
// reports a talent erasure as COMPLETED while governed personal data remains in
// its custody, and the append-only exceptions are bound at the database boundary
// to ONE transaction, tenant, talent, operation and exact redaction.
//   (1) the ORIGINAL false-success defect (pipeline + note + document) now
//       COMPLETES truthfully: history redacted + tombstoned, events deleted;
//   (2) a forced mid-pass database failure rolls the WHOLE pass back;
//   (3) missing-holder detection: commercial / restriction / legal-hold / shared /
//       undrained-outbox / unclassified rows BLOCK; DELETE holders are erased;
//   (4) object-storage failure → STORAGE_PENDING → --resume → COMPLETED;
//   (5) cross-tenant isolation;
//   (6) immutable tables keep refusing direct mutation;
//   (7) §2 database-boundary negative controls + deferred-commit rejection;
//   (8) report-grain preservation + full identifier scan + bystander;
//   (9) rollback AFTER redaction and tombstoning, then a clean retry;
//  (10) shared interactions / documents block (pipeline-routed sharing too);
//  (11) safeguard 1: ordinary roles cannot create or arm a run;
//  (12) schema-driven holder coverage: every talent-keyed table is classified.

const ROOT = resolve(__dirname, '../../../..');
function allMigrations(): string[] {
  const out: Array<{ ts: string; path: string }> = [];
  for (const lib of readdirSync(resolve(ROOT, 'libs'))) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, 'libs', lib, 'prisma', 'migrations'));
    } catch {
      continue;
    }
    for (const d of entries) if (/^\d{14}_/.test(d)) out.push({ ts: d, path: resolve(ROOT, 'libs', lib, 'prisma', 'migrations', d, 'migration.sql') });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts)).map((m) => m.path);
}

const TENANT = '01900000-0000-7000-8000-0000000052a1';
const TENANT_B = '01900000-0000-7000-8000-0000000052b1';
const HOLD_TENANT = '01900000-0000-7000-8000-0000000052c1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('S2 — talent erasure integrity (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pg: PgExec;
  const erasure = new TalentErasureService(fakeSignErasure());

  const count = async (table: string, where: string, params: unknown[] = []): Promise<number> =>
    Number((await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0]!.n);

  // Insert one row, filling every NOT NULL column without a default from its
  // type (overrides win). Keeps the seed honest across many holder tables.
  async function seed(table: string, overrides: Record<string, unknown>, via: Client = db): Promise<void> {
    const [schema, name] = table.replace(/"/g, '').split('.') as [string, string];
    const cols = await db.query<{ column_name: string; data_type: string; udt_schema: string; udt_name: string }>(
      `SELECT column_name, data_type, udt_schema, udt_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND is_nullable = 'NO' AND column_default IS NULL`,
      [schema, name],
    );
    const values: Record<string, unknown> = {};
    for (const c of cols.rows) {
      if (c.column_name in overrides) continue;
      if (c.data_type === 'uuid') values[c.column_name] = uuidv7();
      else if (c.data_type === 'boolean') values[c.column_name] = false;
      else if (['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real'].includes(c.data_type)) values[c.column_name] = 0;
      else if (c.data_type.startsWith('timestamp') || c.data_type === 'date') values[c.column_name] = new Date();
      else if (c.data_type === 'jsonb' || c.data_type === 'json') values[c.column_name] = '{}';
      else if (c.data_type === 'ARRAY') values[c.column_name] = '{}';
      else if (c.data_type === 'USER-DEFINED') {
        const e = await db.query<{ v: string }>(
          `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder LIMIT 1`,
          [c.udt_schema, c.udt_name],
        );
        values[c.column_name] = e.rows[0]?.v;
      } else values[c.column_name] = 'x';
    }
    Object.assign(values, overrides);
    const keys = Object.keys(values);
    await via.query(
      `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((k) => values[k]),
    );
  }

  const talent = async (tenant: string = TENANT): Promise<string> => {
    const id = uuidv7();
    await seed('talent_record."TalentRecord"', { id, tenant_id: tenant, first_name: 'Ada', last_name: 'Lovelace' });
    return id;
  };
  const okStore = (): ErasureObjectStore & { keys: string[] } => {
    const keys: string[] = [];
    return { keys, purge: async (k) => (keys.push(k), { remaining: 0 }) };
  };

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
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('(1) the original false-success defect (pipeline + talent note + document) now COMPLETES truthfully', async () => {
    const rec = await talent();
    const pipe = uuidv7();
    await seed('pipeline."Pipeline"', { id: pipe, tenant_id: TENANT, talent_record_id: rec, requisition_id: uuidv7() });
    await seed('pipeline."PipelineStatusHistory"', { id: uuidv7(), tenant_id: TENANT, pipeline_id: pipe, status_to: 'contacted' });
    const act = uuidv7();
    await db.query(`INSERT INTO activity."Activity"(id,tenant_id,type,subject_type,subject_id,notes) VALUES ($1,$2,'note','talent_record',$3,'note body')`, [act, TENANT, rec]);
    await db.query(`INSERT INTO activity."ActivityNote"(activity_id) VALUES ($1)`, [act]);
    await db.query(`INSERT INTO activity."ActivityNoteEvent"(id,tenant_id,activity_id,event_type,actor_user_id) VALUES ($1,$2,$3,'CREATED',$4)`, [uuidv7(), TENANT, act, uuidv7()]);
    const doc = uuidv7();
    await db.query(
      `INSERT INTO documents."Document"(id,tenant_id,document_type_id,title,status,execution_mode,source_kind,created_by)
       SELECT $1,$2,id,'doc','DRAFT','NO_SIGNATURE','UPLOADED',$3 FROM documents."DocumentType" LIMIT 1`,
      [doc, TENANT, uuidv7()],
    );
    await db.query(`INSERT INTO documents."DocumentAssociation"(id,tenant_id,document_id,resource_type,resource_id,relationship,created_by) VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5)`, [uuidv7(), TENANT, doc, rec, uuidv7()]);
    await db.query(`INSERT INTO documents."DocumentEvent"(id,tenant_id,document_id,event_type,actor_type) VALUES ($1,$2,$3,'CREATED','USER')`, [uuidv7(), TENANT, doc]);

    const dry = await erasure.dryRun(pg, TENANT, rec);
    expect(dry.blockers).toEqual([]);
    expect(dry.redacted_rows).toBeGreaterThan(0);

    const r = await erasure.execute(pg, TENANT, rec, okStore());
    expect(r.outcome).toBe('COMPLETED');
    expect(ERASURE_EXIT_CODES[r.outcome as 'COMPLETED']).toBe(0);
    expect([r.erasure_marker_appended, r.is_anonymized_flipped]).toEqual([true, true]);
    // The record, the talent note (+ its append-only events) and the document (+ its
    // events) are gone; the pipeline and its history are RETAINED, re-pointed to a
    // tombstone that resolves to nothing (S2 LOCKED §3.1 / §3.2).
    expect(await count('talent_record."TalentRecord"', 'id = $1', [rec])).toBe(0);
    expect(await count('activity."Activity"', 'id = $1', [act])).toBe(0);
    expect(await count('activity."ActivityNoteEvent"', 'activity_id = $1', [act])).toBe(0);
    expect(await count('documents."Document"', 'id = $1', [doc])).toBe(0);
    expect(await count('documents."DocumentEvent"', 'document_id = $1', [doc])).toBe(0);
    const kept = await db.query<{ talent_record_id: string }>(`SELECT talent_record_id FROM pipeline."Pipeline" WHERE id = $1`, [pipe]);
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]!.talent_record_id).not.toBe(rec);
    expect(await count('talent_record."TalentRecord"', 'id = $1', [kept.rows[0]!.talent_record_id])).toBe(0);
    expect(await count('pipeline."PipelineStatusHistory"', 'pipeline_id = $1', [pipe])).toBe(1);
    expect(await count('consent."TalentErasureRun"', `record_id = $1 AND state = 'COMPLETED'`, [rec])).toBe(1);
  });

  it('(2) a forced mid-pass database failure rolls the whole pass back; the fixed re-run COMPLETES', async () => {
    const rec = await talent();
    await seed('talent_evidence."TalentSkillEvidence"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await seed('talent_evidence."TalentCertificationEntry"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await db.query(`
      CREATE OR REPLACE FUNCTION public.s2_test_fail() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 's2 injected failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER s2_test_fail BEFORE DELETE ON talent_evidence."TalentCertificationEntry" FOR EACH ROW EXECUTE FUNCTION public.s2_test_fail();`);
    try {
      const r = await erasure.execute(pg, TENANT, rec, okStore());
      expect(r.outcome).toBe('FAILED');
      expect(ERASURE_EXIT_CODES[r.outcome as 'FAILED']).toBe(4);
      expect(r.steps.at(-1)).toMatchObject({ table: 'talent_evidence."TalentCertificationEntry"', status: 'failed' });
      expect(r.steps.slice(0, -1).every((st) => st.status === 'rolled_back')).toBe(true);
      // Rolled back: the earlier-step row and the record are intact; no run, no marker.
      expect(await count('talent_evidence."TalentSkillEvidence"', 'talent_id = $1', [rec])).toBe(1);
      expect(await count('talent_record."TalentRecord"', 'id = $1', [rec])).toBe(1);
      expect(await count('consent."TalentErasureRun"', 'record_id = $1', [rec])).toBe(0);
      expect(await count('audit."ConsentAuditEvent"', `subject_id = $1 AND event_type = 'consent.erased'`, [rec])).toBe(0);
      // ATI-SEP-1 A3 — no talent.erased without the committed erasure.
      expect(await count('talent_record."TalentEventOutbox"', `subject_id = $1 AND event_type = 'talent.erased'`, [rec])).toBe(0);
    } finally {
      await db.query(`DROP TRIGGER s2_test_fail ON talent_evidence."TalentCertificationEntry"; DROP FUNCTION public.s2_test_fail();`);
    }
    const again = await erasure.execute(pg, TENANT, rec, okStore());
    expect(again.outcome).toBe('COMPLETED');
    expect(await count('talent_evidence."TalentSkillEvidence"', 'talent_id = $1', [rec])).toBe(0);
  });

  it('(3a) holders that need PO-Legal / a hold / another person / a drain / a classification BLOCK — nothing deleted', async () => {
    const cases: Array<[string, (rec: string) => Promise<void>, string]> = [
      ['offer."Offer"', (rec) => seed('offer."Offer"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: rec }), 'PENDING_PO_LEGAL'],
      // S2 LOCKED §3.3 — no Legal-recorded retention class yet: every restriction blocks.
      ['client_talent_restriction."ClientTalentRestriction"', (rec) => seed('client_talent_restriction."ClientTalentRestriction"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: rec }), 'PENDING_PO_LEGAL'],
      ['submittal_policy."SubmittalConsumption"', (rec) => seed('submittal_policy."SubmittalConsumption"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: rec }), 'PENDING_PO_LEGAL'],
      ['offer."OutboxEvent" / placement."OutboxEvent"', (rec) => seed('placement."OutboxEvent"', { id: uuidv7(), tenant_id: TENANT, event_payload: JSON.stringify({ talent_record_id: rec }) }), 'PENDING_PO_LEGAL'],
      ['policy_store."PolicyDecisionRecord"', (rec) => seed('policy_store."PolicyDecisionRecord"', { id: uuidv7(), tenant_id: TENANT, inputs: JSON.stringify({ talent_record_id: rec }) }), 'PENDING_CLASSIFICATION'],
      ['sourced_talent."SourcedTalent"', async (rec) => {
        await seed('talent_evidence."TalentContactMethod"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec, value: `src-${rec.slice(-6)}@pii.example` });
        await seed('sourced_talent."SourcedTalent"', { id: uuidv7(), tenant_id: TENANT, normalized_email: `src-${rec.slice(-6)}@pii.example` });
      }, 'PENDING_CLASSIFICATION'],
    ];
    for (const [holder, add, cls] of cases) {
      const rec = await talent();
      await add(rec);
      const r = await erasure.execute(pg, TENANT, rec, okStore());
      expect([r.outcome, r.blockers.map((b) => [b.holder, b.classification])], holder).toEqual(['BLOCKED', [[holder, cls]]]);
      expect(await count('talent_record."TalentRecord"', 'id = $1', [rec]), holder).toBe(1);
    }
    // A BLOCKED run leaves no partial state (no run row, no marker), so once the
    // blocker is resolved through its own governed path the SAME --execute
    // completes — blocked erasures stay retryable.
    const retry = await talent();
    const offer = uuidv7();
    await seed('offer."Offer"', { id: offer, tenant_id: TENANT, talent_record_id: retry });
    const first = await erasure.execute(pg, TENANT, retry, okStore());
    expect(first.outcome).toBe('BLOCKED');
    expect(await count('consent."TalentErasureRun"', 'record_id = $1', [retry])).toBe(0);
    await db.query(`DELETE FROM offer."Offer" WHERE id = $1`, [offer]); // the blocker resolved (test stand-in)
    const second = await erasure.execute(pg, TENANT, retry, okStore());
    expect([second.outcome, second.erasure_marker_appended]).toEqual(['COMPLETED', true]);
    expect(await count('talent_record."TalentRecord"', 'id = $1', [retry])).toBe(0);
    // An UNPUBLISHED outbox event naming the talent blocks until it drains; once it is
    // published the same --execute completes and removes it.
    const drain = await talent();
    const ev = uuidv7();
    await seed('pipeline."OutboxEvent"', { id: ev, tenant_id: TENANT, event_type: 'pipeline.created', event_payload: JSON.stringify({ talent_record_id: drain }) });
    const pending = await erasure.execute(pg, TENANT, drain, okStore());
    expect([pending.outcome, pending.blockers.map((b) => b.classification)]).toEqual(['BLOCKED', ['PENDING_OUTBOX_DRAIN']]);
    await db.query(`UPDATE pipeline."OutboxEvent" SET published_at = now() WHERE id = $1`, [ev]);
    expect((await erasure.execute(pg, TENANT, drain, okStore())).outcome).toBe('COMPLETED');
    expect(await count('pipeline."OutboxEvent"', 'id = $1', [ev])).toBe(0);
    // A tenant under legal hold blocks every erasure in it.
    await seed('identity."Tenant"', { id: HOLD_TENANT, name: 'Hold Co', legal_hold: true });
    const held = await talent(HOLD_TENANT);
    const h = await erasure.execute(pg, HOLD_TENANT, held, okStore());
    expect([h.outcome, h.blockers.map((b) => b.classification)]).toEqual(['BLOCKED', ['LEGAL_HOLD']]);
    // An interaction that also names ANOTHER talent is never deleted with this one.
    const a = await talent();
    const b = await talent();
    const shared = uuidv7();
    await db.query(`INSERT INTO communications."CommunicationInteraction"(id,tenant_id,channel,direction,from_address,to_address) VALUES ($1,$2,'email','outbound','r@x','t@x')`, [shared, TENANT]);
    for (const subject of [a, b]) {
      await db.query(`INSERT INTO communications."CommunicationAssociation"(id,tenant_id,interaction_id,subject_type,subject_id,relation_type) VALUES ($1,$2,$3,'talent_record',$4,'subject')`, [uuidv7(), TENANT, shared, subject]);
    }
    const s = await erasure.execute(pg, TENANT, a, okStore());
    expect([s.outcome, s.blockers.map((x) => x.classification)]).toEqual(['BLOCKED', ['BLOCKED_SHARED']]);
    expect(await count('communications."CommunicationInteraction"', 'id = $1', [shared])).toBe(1);
  });

  it('(3b) the newly classified DELETE holders + general communications + linked sourced arrivals + raw payloads are erased with their artifacts', async () => {
    const rec = await talent();
    const other = await talent(); // a bystander record named by a duplicate advisory
    // ATI-SEP-1 T10 WP4 — the ATS-local sourced arrival LINKED to the record (WP2),
    // its raw payload (by sourced_talent_id), and a pending duplicate advisory.
    const sourced = uuidv7();
    await seed('sourced_talent."SourcedTalent"', { id: sourced, tenant_id: TENANT, source_channel: 'INDEED', external_source_id: `ext-${sourced}` });
    await db.query(`INSERT INTO talent_record."talent_record_sourced_arrival"(tenant_id,sourced_talent_id,talent_record_id,link_kind) VALUES ($1,$2,$3,'PROMOTED')`, [TENANT, sourced, rec]);
    const [pa, pb] = rec < other ? [rec, other] : [other, rec];
    const advisory = uuidv7();
    await db.query(`INSERT INTO talent_record."talent_duplicate_advisory"(id,tenant_id,talent_record_a_id,talent_record_b_id,basis,shared_kinds) VALUES ($1,$2,$3,$4,'EMAIL',ARRAY['EMAIL'])`, [advisory, TENANT, pa, pb]);
    await seed('talent_evidence."TalentProjectExperience"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await seed('talent_evidence."TalentResumeDefault"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await seed('talent_evidence."TalentResumeEdition"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await seed('talent_evidence."ResumeExtractionDraft"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    const draft = uuidv7();
    await seed('talent_evidence."TalentIntakeDraft"', { id: draft, tenant_id: TENANT, promoted_talent_record_id: rec, storage_key: `${TENANT}/intake/${draft}-Ada_Lovelace.pdf` });
    await seed('talent_evidence."TalentIntakeOutboxEvent"', { id: uuidv7(), subject_type: 'talent_intake_draft', subject_id: draft });
    await seed('examination."CanonicalMatchShadowObservation"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec, match_class: 'CANONICAL_EXACT' });
    await seed('ingestion."RawPayloadReference"', { id: uuidv7(), tenant_id: TENANT, sourced_talent_id: sourced, storage_ref: `${TENANT}/ingestion/raw/${uuidv7()}.json`, verified_email: 'ada@pii.example' });
    const call = uuidv7();
    await db.query(`INSERT INTO communications."CommunicationInteraction"(id,tenant_id,channel,direction,from_address,to_address,body) VALUES ($1,$2,'email','outbound','r@x','ada@pii.example','hello Ada')`, [call, TENANT]);
    await db.query(`INSERT INTO communications."CommunicationAssociation"(id,tenant_id,interaction_id,subject_type,subject_id,relation_type) VALUES ($1,$2,$3,'talent_record',$4,'subject')`, [uuidv7(), TENANT, call, rec]);
    const tr = uuidv7();
    await db.query(
      `INSERT INTO conversation_transcript."ConversationTranscript"(id,tenant_id,interaction_id,provider_key,provider_transcript_id,state,source_artifact_ref,normalized_artifact_ref,updated_at)
       VALUES ($1,$2,$3,'zoom',$6,'normalized',$4,$5,now())`,
      [tr, TENANT, call, `conversation-transcript/${TENANT}/source/${tr}`, `conversation-transcript/${TENANT}/normalized/${tr}`, `zoom-${tr}`],
    );
    await seed('attachment."Attachment"', { id: uuidv7(), tenant_id: TENANT, owner_type: 'talent', owner_id: rec, storage_key: `${TENANT}/talent/${rec}/resume/u-Ada_Lovelace.pdf` });

    const store = okStore();
    const r = await erasure.execute(pg, TENANT, rec, store);
    expect(r.blockers).toEqual([]);
    expect(r.outcome).toBe('COMPLETED');
    expect(r.storage).toEqual({ total: 5, purged: 5, pending: 0, failed: 0 });
    expect(store.keys.length).toBe(5);
    for (const [t, w, p] of [
      ['talent_evidence."TalentProjectExperience"', 'talent_id = $1', rec],
      ['talent_evidence."TalentResumeDefault"', 'talent_id = $1', rec],
      ['talent_evidence."TalentResumeEdition"', 'talent_id = $1', rec],
      ['talent_evidence."ResumeExtractionDraft"', 'talent_id = $1', rec],
      ['talent_evidence."TalentIntakeDraft"', 'id = $1', draft],
      ['talent_evidence."TalentIntakeOutboxEvent"', 'subject_id = $1', draft],
      ['examination."CanonicalMatchShadowObservation"', 'talent_id = $1', rec],
      ['ingestion."RawPayloadReference"', 'sourced_talent_id = $1', sourced],
      ['sourced_talent."SourcedTalent"', 'id = $1', sourced],
      ['talent_record."talent_record_sourced_arrival"', 'sourced_talent_id = $1', sourced],
      ['talent_record."talent_duplicate_advisory"', 'id = $1', advisory],
      ['communications."CommunicationInteraction"', 'id = $1', call],
      ['conversation_transcript."ConversationTranscript"', 'id = $1', tr],
      ['talent_record."TalentRecord"', 'id = $1', rec],
    ] as const) {
      expect(await count(t, w, [p]), t).toBe(0);
    }
    // The bystander record named only by the (erased) advisory survives.
    expect(await count('talent_record."TalentRecord"', 'id = $1', [other])).toBe(1);
    // Exactly one completion marker, carrying the run id; purged artifacts hold no key.
    const marker = await db.query<{ event_payload: { run_id: string } }>(`SELECT event_payload FROM audit."ConsentAuditEvent" WHERE subject_id = $1 AND event_type = 'consent.erased'`, [rec]);
    expect(marker.rows).toHaveLength(1);
    expect(marker.rows[0]!.event_payload.run_id).toBe(r.run_id);
    expect(await count('consent."TalentErasureArtifact"', `run_id = $1 AND state = 'PURGED' AND storage_key IS NULL`, [r.run_id])).toBe(5);
  });

  it('(4) object-storage failure → STORAGE_PENDING (no marker, key held only while pending) → --resume → COMPLETED, once', async () => {
    const rec = await talent();
    const key = `${TENANT}/talent/${rec}/resume/u-Ada_Lovelace.pdf`;
    await seed('attachment."Attachment"', { id: uuidv7(), tenant_id: TENANT, owner_type: 'talent', owner_id: rec, storage_key: key });
    const failing: ErasureObjectStore = { purge: async (k) => { throw new Error(`AccessDenied on ${k}`); } };
    const r = await erasure.execute(pg, TENANT, rec, failing);
    expect(r.outcome).toBe('STORAGE_PENDING');
    expect(ERASURE_EXIT_CODES[r.outcome as 'STORAGE_PENDING']).toBe(3);
    expect(r.erasure_marker_appended).toBe(false);
    expect(r.is_anonymized_flipped).toBe(false);
    expect(await count('talent_record."TalentRecord"', 'id = $1', [rec])).toBe(0); // the DB pass committed
    expect(await count('audit."ConsentAuditEvent"', `subject_id = $1 AND event_type = 'consent.erased'`, [rec])).toBe(0);
    const art = await db.query<{ state: string; storage_key: string | null; last_error: string }>(`SELECT state, storage_key, last_error FROM consent."TalentErasureArtifact" WHERE run_id = $1`, [r.run_id]);
    expect(art.rows[0]).toMatchObject({ state: 'FAILED', storage_key: key });
    expect(art.rows[0]!.last_error).not.toContain('Ada_Lovelace'); // the key never lands in the error text

    // A purge that leaves versions behind is still not success.
    const partial: ErasureObjectStore = { purge: async () => ({ remaining: 2 }) };
    expect((await erasure.resume(pg, TENANT, rec, partial)).outcome).toBe('STORAGE_PENDING');

    const store = okStore();
    const done = await erasure.resume(pg, TENANT, rec, store);
    expect(done.outcome).toBe('COMPLETED');
    expect(done.erasure_marker_appended).toBe(true);
    expect(done.is_anonymized_flipped).toBe(true);
    expect(store.keys).toEqual([key]);
    expect(await count('consent."TalentErasureArtifact"', `run_id = $1 AND state = 'PURGED' AND storage_key IS NULL`, [r.run_id])).toBe(1);
    // Idempotent: re-running --execute or --resume changes nothing and adds no marker.
    expect((await erasure.execute(pg, TENANT, rec, store)).outcome).toBe('COMPLETED');
    expect((await erasure.resume(pg, TENANT, rec, store)).outcome).toBe('COMPLETED');
    expect(await count('audit."ConsentAuditEvent"', `subject_id = $1 AND event_type = 'consent.erased'`, [rec])).toBe(1);
  });

  it('(5) tenant isolation: another tenant id refuses, and tenant B rows survive tenant A erasure', async () => {
    const rec = await talent();
    const recB = await talent(TENANT_B);
    await seed('talent_evidence."TalentProjectExperience"', { id: uuidv7(), tenant_id: TENANT_B, talent_id: recB });
    const wrong = await erasure.execute(pg, TENANT_B, rec, okStore());
    expect([wrong.outcome, wrong.failure?.startsWith('record_not_found')]).toEqual(['FAILED', true]);
    expect(await count('talent_record."TalentRecord"', 'id = $1', [rec])).toBe(1);
    expect((await erasure.execute(pg, TENANT, rec, okStore())).outcome).toBe('COMPLETED');
    expect(await count('talent_record."TalentRecord"', 'id = $1', [recB])).toBe(1);
    expect(await count('talent_evidence."TalentProjectExperience"', 'talent_id = $1', [recB])).toBe(1);
  });

  it('(6) immutable tables still refuse direct mutation; the erasure path adds no marker or bypass', async () => {
    const pipe = uuidv7();
    await seed('pipeline."Pipeline"', { id: pipe, tenant_id: TENANT, talent_record_id: uuidv7(), requisition_id: uuidv7() });
    await seed('pipeline."PipelineStatusHistory"', { id: uuidv7(), tenant_id: TENANT, pipeline_id: pipe, status_to: 'contacted' });
    await expect(db.query(`DELETE FROM pipeline."PipelineStatusHistory" WHERE pipeline_id = $1`, [pipe])).rejects.toThrow(/append-only/);
    const act = uuidv7();
    await db.query(`INSERT INTO activity."Activity"(id,tenant_id,type,subject_type,subject_id) VALUES ($1,$2,'note','requisition',$3)`, [act, TENANT, uuidv7()]);
    const ev = uuidv7();
    await db.query(`INSERT INTO activity."ActivityNoteEvent"(id,tenant_id,activity_id,event_type,actor_user_id) VALUES ($1,$2,$3,'CREATED',$4)`, [ev, TENANT, act, uuidv7()]);
    await expect(db.query(`DELETE FROM activity."ActivityNoteEvent" WHERE id = $1`, [ev])).rejects.toThrow(/append-only/);
    // Under the T0 reset marker a DELETE passes (F4) — but an UPDATE never does.
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL app.tenant_reset = 'authorized'`);
      await expect(db.query(`UPDATE activity."ActivityNoteEvent" SET event_type = event_type WHERE id = $1`, [ev])).rejects.toThrow(/append-only/);
    } finally {
      await db.query('ROLLBACK');
    }
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL app.tenant_reset = 'not-authorized'`);
      await expect(db.query(`DELETE FROM activity."ActivityNoteEvent" WHERE id = $1`, [ev])).rejects.toThrow(/append-only/);
    } finally {
      await db.query('ROLLBACK');
    }
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_reset = 'authorized'`);
    expect((await db.query(`DELETE FROM activity."ActivityNoteEvent" WHERE id = $1`, [ev])).rowCount).toBe(1);
    await db.query('ROLLBACK');
    // The erasure ledger keeps its terminal states.
    const run = (await db.query<{ id: string }>(`SELECT id FROM consent."TalentErasureRun" WHERE state = 'COMPLETED' LIMIT 1`)).rows[0]!.id;
    await expect(db.query(`UPDATE consent."TalentErasureRun" SET state = 'STORAGE_PENDING', completed_at = NULL WHERE id = $1`, [run])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE consent."TalentErasureArtifact" SET storage_key = 'x', state = 'PENDING', purged_at = NULL WHERE state = 'PURGED'`)).rejects.toThrow(/immutable/);
    // No erasure bypass: the service sets no session marker and touches no trigger.
    const src = readFileSync(resolve(ROOT, 'apps/api/src/talent-identity/talent-erasure.service.ts'), 'utf8');
    expect(src).not.toMatch(/SET LOCAL|set_config|app\.tenant_reset|app\.talent_erasure|DISABLE TRIGGER|session_replication_role/i);
  });

  // ---------------------------------------------------------------------------
  // S2 LOCKED §2 / §7 — the authorization, exercised at the database boundary.
  // ---------------------------------------------------------------------------
  const RUN_SETTING = 'app.talent_erasure_run';
  const begin = (tenant: string, rec: string) =>
    db.query(`SELECT consent.s2_begin_talent_erasure_run($1::uuid, $2::uuid, $3::uuid, '{}'::uuid[]) AS ids`, [uuidv7(), tenant, rec]);
  // Each attempt runs in its own transaction that is always rolled back.
  async function refused(label: string, body: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
    await db.query('BEGIN');
    try {
      await expect(body(), label).rejects.toThrow(pattern);
    } finally {
      await db.query('ROLLBACK');
    }
  }

  // ADA's full immutable footprint + BOB as the bystander (same tenant).
  async function footprint(tag: string, restriction = true) {
    const ada = await talent();
    const bob = await talent();
    const r1 = uuidv7();
    const r2 = uuidv7();
    const p1 = uuidv7();
    const p2 = uuidv7();
    const pb = uuidv7();
    for (const [pid, who, req] of [[p1, ada, r1], [p2, ada, r2], [pb, bob, r1]] as const) {
      await seed('pipeline."Pipeline"', { id: pid, tenant_id: TENANT, talent_record_id: who, requisition_id: req });
      await seed('pipeline."PipelineStatusHistory"', { id: uuidv7(), tenant_id: TENANT, pipeline_id: pid, status_to: 'contacted', note: who === ada ? `spoke with Ada about salary ${tag}` : 'bob note' });
      await seed('pipeline."PipelineEntryProvenance"', { id: uuidv7(), tenant_id: TENANT, pipeline_id: pid, external_object_id: who === ada ? `ATS-ADA-${tag}` : 'ATS-BOB', metadata: JSON.stringify({ email: who === ada ? `ada-${tag}@pii.example` : 'bob@x' }) });
    }
    await seed('pipeline."PipelineDisposition"', { id: uuidv7(), tenant_id: TENANT, pipeline_id: p2, reason: `Ada asked to withdraw ${tag}`, note: `Ada asked to withdraw ${tag}` });
    const csp = uuidv7();
    const iv = uuidv7();
    await seed('client_selection."ClientSelectionProcess"', { id: csp, tenant_id: TENANT, talent_id: ada, requisition_id: r1 });
    await seed('client_selection."InterviewSession"', { id: iv, tenant_id: TENANT, client_selection_process_id: csp, talent_record_id: ada, requisition_id: r1 });
    await seed('client_selection."ClientSelectionEvent"', { id: uuidv7(), tenant_id: TENANT, subject_type: 'process', subject_id: csp, event_payload: JSON.stringify({ talent_name: `Ada Lovelace ${tag}` }) });
    await seed('client_selection."ClientSelectionEvent"', { id: uuidv7(), tenant_id: TENANT, subject_type: 'session', subject_id: iv, event_payload: JSON.stringify({ feedback: `Ada Lovelace ${tag}` }) });
    if (restriction) {
      await seed('client_talent_restriction."ClientTalentRestriction"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: ada, source_reference: `ATS-ADA-${tag}`, raw_source_value: `Ada Lovelace ${tag}` });
    }
    await seed('pipeline."TalentRequisitionResume"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: ada, requisition_id: r1, note: `spoke with Ada about salary ${tag}` });
    const act = uuidv7();
    await db.query(`INSERT INTO activity."Activity"(id,tenant_id,type,subject_type,subject_id,notes) VALUES ($1,$2,'note','talent_record',$3,$4)`, [act, TENANT, ada, `Ada Lovelace ${tag} note`]);
    await db.query(`INSERT INTO activity."ActivityNote"(activity_id) VALUES ($1)`, [act]);
    await db.query(`INSERT INTO activity."ActivityNoteEvent"(id,tenant_id,activity_id,event_type,actor_user_id) VALUES ($1,$2,$3,'CREATED',$4)`, [uuidv7(), TENANT, act, uuidv7()]);
    const doc = async (owners: string[], hold = false) => {
      const d = uuidv7();
      await db.query(
        `INSERT INTO documents."Document"(id,tenant_id,document_type_id,title,status,execution_mode,source_kind,created_by)
         SELECT $1,$2,id,'doc','DRAFT','NO_SIGNATURE','UPLOADED',$3 FROM documents."DocumentType" LIMIT 1`,
        [d, TENANT, uuidv7()],
      );
      for (const o of owners) {
        await db.query(`INSERT INTO documents."DocumentAssociation"(id,tenant_id,document_id,resource_type,resource_id,relationship,created_by) VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5)`, [uuidv7(), TENANT, d, o, uuidv7()]);
      }
      await db.query(`INSERT INTO documents."DocumentEvent"(id,tenant_id,document_id,event_type,actor_type,payload) VALUES ($1,$2,$3,'CREATED','USER',$4)`, [uuidv7(), TENANT, d, JSON.stringify({ title: `Ada Lovelace ${tag}` })]);
      if (hold) {
        const rev = uuidv7();
        await seed('documents."DocumentRevision"', { id: rev, tenant_id: TENANT, document_id: d });
        await seed('documents."DocumentArtifact"', { id: uuidv7(), tenant_id: TENANT, document_id: d, revision_id: rev, legal_hold: true, immutability_state: 'MUTABLE', artifact_role: 'SOURCE_UPLOAD', storage_locator: `${TENANT}/doc/${d}` });
      }
      return d;
    };
    return { ada, bob, r1, r2, p1, p2, pb, csp, iv, act, doc };
  }

  it('(7) §2 database boundary: only a run armed by THIS transaction for this tenant + talent admits the exact operation', async () => {
    const tag = uuidv7().slice(-8);
    const f = await footprint(tag);
    const ownDoc = await f.doc([f.ada]);
    const sharedDoc = await f.doc([f.ada, f.bob]);
    const heldDoc = await f.doc([f.ada], true);
    const recB = await talent(TENANT_B);
    const delNotes = () => db.query(`DELETE FROM activity."ActivityNoteEvent" WHERE activity_id = $1`, [f.act]);
    const setRun = (id: string) => db.query(`SELECT set_config($1, $2, true)`, [RUN_SETTING, id]);

    // A run committed by an EARLIER transaction (a completed erasure): possession of its id grants nothing.
    const done = await talent();
    const doneRun = (await erasure.execute(pg, TENANT, done, okStore())).run_id as string;

    await refused('the setting alone (no run row)', async () => { await setRun(uuidv7()); await delNotes(); }, /append-only/);
    await refused('a run committed by an earlier transaction', async () => { await setRun(doneRun); await delNotes(); }, /append-only/);
    await refused('a run created inside a SAVEPOINT', async () => {
      await db.query('SAVEPOINT s'); await begin(TENANT, f.ada); await db.query('RELEASE SAVEPOINT s'); await delNotes();
    }, /append-only/);
    await refused('another tenant', async () => { await begin(TENANT_B, recB); await delNotes(); }, /append-only/);
    await refused('another talent', async () => { await begin(TENANT, f.bob); await delNotes(); }, /append-only/);
    // A row of ANOTHER tenant that carries the authorized talent's id is still refused.
    const foreign = uuidv7();
    await seed('pipeline."TalentRequisitionResume"', { id: foreign, tenant_id: TENANT_B, talent_record_id: f.ada });
    await refused("another tenant's row naming the authorized talent", async () => { await begin(TENANT, f.ada); await db.query(`DELETE FROM pipeline."TalentRequisitionResume" WHERE id = $1`, [foreign]); }, /append-only/);
    await refused('a run no longer in DB_PASS_IN_PROGRESS', async () => {
      await begin(TENANT, f.ada);
      await db.query(`UPDATE consent."TalentErasureRun" SET state = 'STORAGE_PENDING' WHERE state = 'DB_PASS_IN_PROGRESS'`);
      await delNotes();
    }, /append-only/);
    await refused('DELETE on retained history', async () => { await begin(TENANT, f.ada); await db.query(`DELETE FROM pipeline."PipelineStatusHistory" WHERE pipeline_id = $1`, [f.p1]); }, /append-only/);
    await refused('UPDATE on a delete-only table', async () => { await begin(TENANT, f.ada); await db.query(`UPDATE activity."ActivityNoteEvent" SET metadata = '{}' WHERE activity_id = $1`, [f.act]); }, /append-only/);
    await refused('a non-enumerated column', async () => { await begin(TENANT, f.ada); await db.query(`UPDATE pipeline."PipelineStatusHistory" SET note = NULL, changed_at = changed_at + interval '1 second' WHERE pipeline_id = $1`, [f.p1]); }, /append-only/);
    await refused('a non-redacted value', async () => { await begin(TENANT, f.ada); await db.query(`UPDATE pipeline."PipelineStatusHistory" SET note = 'rewritten' WHERE pipeline_id = $1`, [f.p1]); }, /append-only/);
    await refused("the bystander's row in an authorized transaction", async () => { await begin(TENANT, f.ada); await db.query(`UPDATE pipeline."PipelineStatusHistory" SET note = NULL WHERE pipeline_id = $1`, [f.pb]); }, /append-only/);
    await refused('a restriction left linkable', async () => { await begin(TENANT, f.ada); await db.query(`UPDATE client_talent_restriction."ClientTalentRestriction" SET talent_record_id = gen_random_uuid(), source_reference = $2 WHERE talent_record_id = $1`, [f.ada, `ATS-ADA-${tag}`]); }, /append-and-close-only/);
    await refused('a restriction re-pointed at another real talent', async () => { await begin(TENANT, f.ada); await db.query(`UPDATE client_talent_restriction."ClientTalentRestriction" SET talent_record_id = $2, source_reference = 'erased:' || gen_random_uuid(), raw_source_value = NULL WHERE talent_record_id = $1`, [f.ada, f.bob]); }, /append-and-close-only/);
    await refused('a document also associated with another talent', async () => { await begin(TENANT, f.ada); await db.query(`DELETE FROM documents."DocumentEvent" WHERE document_id = $1`, [sharedDoc]); }, /append-only/);
    await refused('a document under legal hold', async () => { await begin(TENANT, f.ada); await db.query(`DELETE FROM documents."DocumentEvent" WHERE document_id = $1`, [heldDoc]); }, /append-only/);
    await refused('no setting at all', delNotes, /append-only/);
    // Safeguard 1 — a run cannot be forged, revived, doubled or pointed at a missing record.
    await refused('a directly inserted run', () => db.query(`INSERT INTO consent."TalentErasureRun"(id,tenant_id,record_id,record_ids,subject_ids,state,artifact_count) VALUES ($1,$2,$3,ARRAY[$3]::uuid[],'{}','DB_PASS_IN_PROGRESS',0)`, [uuidv7(), TENANT, f.ada]), /created only by/);
    await refused('a committed run revived', () => db.query(`UPDATE consent."TalentErasureRun" SET state = 'DB_PASS_IN_PROGRESS', completed_at = NULL WHERE id = $1`, [doneRun]), /immutable/);
    await refused('a second run in one transaction', async () => { await begin(TENANT, f.ada); await begin(TENANT, f.bob); }, /already authorized/);
    await refused('a record that does not exist', () => begin(TENANT, uuidv7()), /no TalentRecord/);
    await refused("another tenant's record", () => begin(TENANT_B, f.ada), /no TalentRecord/);
    // §2.2 — a run can never COMMIT while it still authorizes.
    await db.query('BEGIN');
    await begin(TENANT, f.ada);
    await expect(db.query('COMMIT'), 'COMMIT left in DB_PASS_IN_PROGRESS').rejects.toThrow(/cannot commit in DB_PASS_IN_PROGRESS/);
    expect(await count('consent."TalentErasureRun"', 'record_id = $1', [f.ada])).toBe(0);

    // The entry point computes the authorized set itself — the whole husk chain.
    const husk = uuidv7();
    await seed('talent_record."TalentRecord"', { id: husk, tenant_id: TENANT, first_name: 'Husk', last_name: 'Record', superseded_by_record_id: f.ada });
    // Positive control: inside ONE armed transaction every enumerated operation passes.
    await db.query('BEGIN');
    try {
      const ids = (await begin(TENANT, f.ada)).rows[0]!.ids as string[];
      expect([...ids].sort()).toEqual([f.ada, husk].sort());
      expect((await delNotes()).rowCount).toBe(1);
      expect((await db.query(`DELETE FROM pipeline."TalentRequisitionResume" WHERE talent_record_id = $1 AND tenant_id = $2`, [f.ada, TENANT])).rowCount).toBe(1);
      expect((await db.query(`DELETE FROM documents."DocumentEvent" WHERE document_id = $1`, [ownDoc])).rowCount).toBe(1);
      expect((await db.query(`UPDATE pipeline."PipelineStatusHistory" SET note = NULL WHERE pipeline_id IN ($1, $2)`, [f.p1, f.p2])).rowCount).toBe(2);
      expect((await db.query(`UPDATE pipeline."PipelineDisposition" SET reason = 'REDACTED', note = NULL, source_provenance = NULL WHERE pipeline_id = $1`, [f.p2])).rowCount).toBe(1);
      expect((await db.query(`UPDATE client_selection."ClientSelectionEvent" SET event_payload = '{}' WHERE subject_id IN ($1, $2)`, [f.csp, f.iv])).rowCount).toBe(2);
      expect((await db.query(`UPDATE client_talent_restriction."ClientTalentRestriction" SET talent_record_id = gen_random_uuid(), source_reference = 'erased:' || gen_random_uuid(), raw_source_value = NULL, asserting_organization_reference = NULL, asserting_contact_reference = NULL, close_source_reference = NULL WHERE talent_record_id = $1`, [f.ada])).rowCount).toBe(1);
    } finally {
      await db.query('ROLLBACK');
    }
    // Nothing above persisted.
    expect(await count('activity."ActivityNoteEvent"', 'activity_id = $1', [f.act])).toBe(1);
    expect(await count('pipeline."PipelineStatusHistory"', 'pipeline_id = $1 AND note IS NOT NULL', [f.p1])).toBe(1);
  });

  it('(8) per-requisition tombstones keep every report grain; no direct or indirect identifier survives; the bystander is untouched', async () => {
    const tag = uuidv7().slice(-8);
    // No restriction here: §3.3 restrictions still block (no Legal class) — proven in (3a);
    // the §3.3 patch itself is proven at the database boundary in (7).
    const f = await footprint(tag, false);

    // The rest of the footprint: the talent's own document, a pipeline-subject activity, a
    // pipeline-routed email, a document requirement, a cached response, a published outbox
    // event, a contact method, and a placement for the BYSTANDER only (commercial records block).
    const ownDoc = await f.doc([f.ada]);
    const packet = uuidv7();
    await seed('documents."DocumentPacket"', { id: packet, tenant_id: TENANT, status: 'OPEN' });
    await seed('documents."DocumentPacketItem"', { id: uuidv7(), tenant_id: TENANT, packet_id: packet, document_id: ownDoc });
    await db.query(
      `INSERT INTO documents."DocumentRequirement"(id,tenant_id,document_type_id,resource_type,resource_id,status,waived_reason,created_by)
       SELECT $1,$2,id,'TALENT',$3,'WAIVED',$4,$5 FROM documents."DocumentType" LIMIT 1`,
      [uuidv7(), TENANT, f.ada, `Ada Lovelace ${tag} waiver`, uuidv7()],
    );
    await db.query(`INSERT INTO activity."Activity"(id,tenant_id,type,subject_type,subject_id,notes) VALUES ($1,$2,'note','pipeline',$3,$4)`, [uuidv7(), TENANT, f.p1, `spoke with Ada about salary ${tag}`]);
    await db.query(`INSERT INTO activity."Activity"(id,tenant_id,type,subject_type,subject_id,notes) VALUES ($1,$2,'note','pipeline',$3,'bob pipeline note')`, [uuidv7(), TENANT, f.pb]);
    const mail = uuidv7();
    await db.query(`INSERT INTO communications."CommunicationInteraction"(id,tenant_id,channel,direction,from_address,to_address,body) VALUES ($1,$2,'email','outbound','r@x',$3,$4)`, [mail, TENANT, `ada-${tag}@pii.example`, `hello ${tag}`]);
    await db.query(`INSERT INTO communications."CommunicationAssociation"(id,tenant_id,interaction_id,subject_type,subject_id,relation_type) VALUES ($1,$2,$3,'pipeline',$4,'subject')`, [uuidv7(), TENANT, mail, f.p2]);
    await seed('talent_evidence."TalentContactMethod"', { id: uuidv7(), tenant_id: TENANT, talent_id: f.ada, value: `ada-${tag}@pii.example` });
    await seed('consent."IdempotencyKey"', { id: uuidv7(), tenant_id: TENANT, key: uuidv7(), response_body: JSON.stringify({ talent_record_id: f.ada }) });
    await seed('pipeline."OutboxEvent"', { id: uuidv7(), tenant_id: TENANT, event_type: 'pipeline.created', event_payload: JSON.stringify({ talent_record_id: f.ada }), published_at: new Date() });
    await seed('placement."PlacementProcess"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: f.bob, requisition_id: f.r1 });

    const reports = async () => {
      const r = async (sql: string) => (await db.query(sql, [TENANT])).rows;
      return {
        episodes: await r(`SELECT requisition_id, status, count(*)::int n FROM pipeline."Pipeline" WHERE tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`),
        transitions: await r(`SELECT p.requisition_id, h.status_to, count(*)::int n FROM pipeline."PipelineStatusHistory" h JOIN pipeline."Pipeline" p ON p.id = h.pipeline_id WHERE p.tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`),
        dispositions: await r(`SELECT p.requisition_id, d.authority_class, count(*)::int n FROM pipeline."PipelineDisposition" d JOIN pipeline."Pipeline" p ON p.id = d.pipeline_id WHERE p.tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`),
        sources: await r(`SELECT p.requisition_id, e.origin_type, count(*)::int n FROM pipeline."PipelineEntryProvenance" e JOIN pipeline."Pipeline" p ON p.id = e.pipeline_id WHERE p.tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`),
        established_grain: await r(`SELECT p.requisition_id, count(*)::int n FROM pipeline."Pipeline" p JOIN placement."PlacementProcess" pp ON pp.tenant_id = p.tenant_id AND pp.requisition_id = p.requisition_id AND pp.talent_record_id = p.talent_record_id WHERE p.tenant_id = $1 GROUP BY 1 ORDER BY 1`),
        selection_grain: await r(`SELECT p.requisition_id, count(*)::int n FROM pipeline."Pipeline" p JOIN client_selection."ClientSelectionProcess" c ON c.tenant_id = p.tenant_id AND c.requisition_id = p.requisition_id AND c.talent_id = p.talent_record_id WHERE p.tenant_id = $1 GROUP BY 1 ORDER BY 1`),
        interview_grain: await r(`SELECT i.requisition_id, count(*)::int n FROM client_selection."InterviewSession" i JOIN client_selection."ClientSelectionProcess" c ON c.id = i.client_selection_process_id AND c.talent_id = i.talent_record_id WHERE i.tenant_id = $1 GROUP BY 1 ORDER BY 1`),
        distinct_talent_req: await r(`SELECT count(DISTINCT (requisition_id, talent_record_id))::int n FROM pipeline."Pipeline" WHERE tenant_id = $1`),
        selection_events: await r(`SELECT subject_type, event_type, count(*)::int n FROM client_selection."ClientSelectionEvent" WHERE tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`),
        pipeline_activity: await r(`SELECT p.requisition_id, a.type, count(*)::int n FROM activity."Activity" a JOIN pipeline."Pipeline" p ON a.subject_type = 'pipeline' AND a.subject_id = p.id WHERE p.tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`),
      };
    };
    // Every uuid / text / json / array column of every base table, outside the declared
    // retained ledger (S2 LOCKED §6): the run ledger and the consent erasure marker.
    const residue = async (needles: string[]) => {
      const cols = await db.query<{ s: string; t: string; c: string }>(
        `SELECT c.table_schema s, c.table_name t, c.column_name c FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.data_type IN ('uuid', 'text', 'character varying', 'jsonb', 'json', 'ARRAY')`,
      );
      // ONE query per table: every scanned column, concatenated, against every needle.
      const byTable = new Map<string, string[]>();
      for (const { s, t, c } of cols.rows) {
        if ((s === 'consent' && t.startsWith('TalentErasure')) || (s === 'audit' && t === 'ConsentAuditEvent')) continue;
        const key = `"${s}"."${t}"`;
        byTable.set(key, [...(byTable.get(key) ?? []), `COALESCE("${c}"::text, '')`]);
      }
      const hits: string[] = [];
      for (const [table, exprs] of byTable) {
        // ATI-SEP-1 A3 (Addendum A1 §1) — the talent.erased propagation row carries the
        // erased record id ONLY (like the consent.erased marker above); every other
        // talent.* outbox row of the record must be gone.
        const only = table === '"talent_record"."TalentEventOutbox"' ? ` AND event_type <> 'talent.erased'` : '';
        const r = await db.query<{ n: string }>(
          `SELECT n FROM unnest($1::text[]) n WHERE EXISTS (SELECT 1 FROM ${table} WHERE concat_ws('|', ${exprs.join(', ')}) LIKE '%' || n || '%'${only})`,
          [needles],
        );
        for (const row of r.rows) hits.push(`${table} ~ ${row.n}`);
      }
      return hits;
    };
    const needles = [f.ada, `ada-${tag}@pii.example`, `ATS-ADA-${tag}`, `spoke with Ada about salary ${tag}`, `Ada asked to withdraw ${tag}`, `Ada Lovelace ${tag}`, `hello ${tag}`];
    const before = await reports();
    const seen = await residue(needles);
    for (const n of needles) expect(seen.some((h) => h.endsWith(`~ ${n}`)), `seeded: ${n}`).toBe(true);

    const r = await erasure.execute(pg, TENANT, f.ada, okStore());
    expect(r.blockers).toEqual([]);
    expect(r.outcome).toBe('COMPLETED');
    expect(r.redacted_rows).toBeGreaterThan(0);

    expect(await reports()).toEqual(before);
    expect(await residue(needles)).toEqual([]);
    // One tombstone per requisition; the selection process and interview share R1's.
    const tombs = (await db.query<{ requisition_id: string; talent_record_id: string }>(`SELECT requisition_id, talent_record_id FROM pipeline."Pipeline" WHERE id IN ($1, $2)`, [f.p1, f.p2])).rows;
    expect(new Set(tombs.map((t) => t.talent_record_id)).size).toBe(2);
    const r1Tomb = tombs.find((t) => t.requisition_id === f.r1)!.talent_record_id;
    expect((await db.query(`SELECT talent_id FROM client_selection."ClientSelectionProcess" WHERE id = $1`, [f.csp])).rows[0].talent_id).toBe(r1Tomb);
    expect((await db.query(`SELECT talent_record_id, meeting_interaction_id FROM client_selection."InterviewSession" WHERE id = $1`, [f.iv])).rows[0]).toEqual({ talent_record_id: r1Tomb, meeting_interaction_id: null });
    expect(await count('talent_record."TalentRecord"', 'id = ANY($1::uuid[])', [tombs.map((t) => t.talent_record_id)])).toBe(0);
    expect(await count('communications."CommunicationInteraction"', 'id = $1', [mail])).toBe(0);
    // The bystander is untouched.
    expect((await db.query(`SELECT note FROM pipeline."PipelineStatusHistory" WHERE pipeline_id = $1`, [f.pb])).rows[0].note).toBe('bob note');
    expect((await db.query(`SELECT talent_record_id FROM pipeline."Pipeline" WHERE id = $1`, [f.pb])).rows[0].talent_record_id).toBe(f.bob);
    expect(await count('activity."Activity"', `subject_id = $1 AND notes = 'bob pipeline note'`, [f.pb])).toBe(1);
    // The run left no tombstone behind and no authorization: after COMMIT nothing passes.
    await expect(db.query(`UPDATE pipeline."PipelineStatusHistory" SET note = NULL WHERE pipeline_id = $1`, [f.pb])).rejects.toThrow(/append-only/);
  });

  it('(9) a failure AFTER redaction and tombstoning rolls everything back; the retry completes', async () => {
    const tag = uuidv7().slice(-8);
    const rec = await talent();
    const pipe = uuidv7();
    await seed('pipeline."Pipeline"', { id: pipe, tenant_id: TENANT, talent_record_id: rec, requisition_id: uuidv7() });
    await seed('pipeline."PipelineStatusHistory"', { id: uuidv7(), tenant_id: TENANT, pipeline_id: pipe, status_to: 'contacted', note: `note ${tag}` });
    const act = uuidv7();
    await db.query(`INSERT INTO activity."Activity"(id,tenant_id,type,subject_type,subject_id,notes) VALUES ($1,$2,'note','talent_record',$3,'n')`, [act, TENANT, rec]);
    await db.query(`INSERT INTO activity."ActivityNoteEvent"(id,tenant_id,activity_id,event_type,actor_user_id) VALUES ($1,$2,$3,'CREATED',$4)`, [uuidv7(), TENANT, act, uuidv7()]);
    // The run-record update is the last write of the pass: fail it.
    await db.query(`
      CREATE OR REPLACE FUNCTION public.s2_test_fail_late() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 's2 injected late failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER s2_test_fail_late BEFORE UPDATE ON consent."TalentErasureRun" FOR EACH ROW EXECUTE FUNCTION public.s2_test_fail_late();`);
    try {
      const r = await erasure.execute(pg, TENANT, rec, okStore());
      expect(r.outcome).toBe('FAILED');
      expect(r.steps.some((st) => st.table === 'pipeline."Pipeline"' && st.status === 'rolled_back')).toBe(true);
      expect(await count('pipeline."PipelineStatusHistory"', 'pipeline_id = $1 AND note = $2', [pipe, `note ${tag}`])).toBe(1);
      expect(await count('pipeline."Pipeline"', 'id = $1 AND talent_record_id = $2', [pipe, rec])).toBe(1);
      expect(await count('activity."ActivityNoteEvent"', 'activity_id = $1', [act])).toBe(1);
      expect(await count('consent."TalentErasureRun"', 'record_id = $1', [rec])).toBe(0);
    } finally {
      await db.query(`DROP TRIGGER s2_test_fail_late ON consent."TalentErasureRun"; DROP FUNCTION public.s2_test_fail_late();`);
    }
    expect((await erasure.execute(pg, TENANT, rec, okStore())).outcome).toBe('COMPLETED');
    expect(await count('pipeline."PipelineStatusHistory"', 'pipeline_id = $1 AND note IS NULL', [pipe])).toBe(1);
    expect(await count('pipeline."Pipeline"', 'id = $1 AND talent_record_id = $2', [pipe, rec])).toBe(0);
  });

  it('(10) shared interactions (also through another talent’s pipeline) and shared documents BLOCK — nothing deleted', async () => {
    const a = await talent();
    const b = await talent();
    const pa = uuidv7();
    const pb = uuidv7();
    const req = uuidv7();
    await seed('pipeline."Pipeline"', { id: pa, tenant_id: TENANT, talent_record_id: a, requisition_id: req });
    await seed('pipeline."Pipeline"', { id: pb, tenant_id: TENANT, talent_record_id: b, requisition_id: req });
    const meeting = uuidv7();
    await db.query(`INSERT INTO communications."CommunicationInteraction"(id,tenant_id,channel,direction,from_address,to_address) VALUES ($1,$2,'email','outbound','r@x','group@x')`, [meeting, TENANT]);
    for (const p of [pa, pb]) {
      await db.query(`INSERT INTO communications."CommunicationAssociation"(id,tenant_id,interaction_id,subject_type,subject_id,relation_type) VALUES ($1,$2,$3,'pipeline',$4,'subject')`, [uuidv7(), TENANT, meeting, p]);
    }
    const tr = uuidv7();
    await db.query(
      `INSERT INTO conversation_transcript."ConversationTranscript"(id,tenant_id,interaction_id,provider_key,provider_transcript_id,state,source_artifact_ref,normalized_artifact_ref,updated_at)
       VALUES ($1,$2,$3,'zoom',$4,'normalized',$5,$6,now())`,
      [tr, TENANT, meeting, `zoom-${tr}`, `conversation-transcript/${TENANT}/source/${tr}`, `conversation-transcript/${TENANT}/normalized/${tr}`],
    );
    const r = await erasure.execute(pg, TENANT, a, okStore());
    expect([r.outcome, r.blockers.map((x) => x.classification)]).toEqual(['BLOCKED', ['BLOCKED_SHARED']]);
    expect(await count('communications."CommunicationInteraction"', 'id = $1', [meeting])).toBe(1);
    expect(await count('conversation_transcript."ConversationTranscript"', 'id = $1', [tr])).toBe(1);
    expect(await count('pipeline."Pipeline"', 'id = $1 AND talent_record_id = $2', [pa, a])).toBe(1);

    const c = await talent();
    const d = await talent();
    const doc = uuidv7();
    await db.query(
      `INSERT INTO documents."Document"(id,tenant_id,document_type_id,title,status,execution_mode,source_kind,created_by)
       SELECT $1,$2,id,'doc','DRAFT','NO_SIGNATURE','UPLOADED',$3 FROM documents."DocumentType" LIMIT 1`,
      [doc, TENANT, uuidv7()],
    );
    for (const o of [c, d]) {
      await db.query(`INSERT INTO documents."DocumentAssociation"(id,tenant_id,document_id,resource_type,resource_id,relationship,created_by) VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5)`, [uuidv7(), TENANT, doc, o, uuidv7()]);
    }
    const s2 = await erasure.execute(pg, TENANT, c, okStore());
    expect([s2.outcome, s2.blockers.map((x) => x.holder)]).toEqual(['BLOCKED', ['documents."Document" (shared)']]);
    expect(await count('documents."Document"', 'id = $1', [doc])).toBe(1);
  });

  it('(11) safeguard 1: an ordinary database role can neither create nor arm a run; only an operator member can', async () => {
    const rec = await talent();
    await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's2_app') THEN CREATE ROLE s2_app LOGIN PASSWORD 's2app'; END IF; END $$`);
    await db.query(`GRANT USAGE ON SCHEMA consent, talent_record, activity TO s2_app`);
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA consent TO s2_app`);
    const app = new Client({ host: container.getHost(), port: container.getPort(), database: container.getDatabase(), user: 's2_app', password: 's2app' });
    await app.connect();
    try {
      await expect(app.query(`SELECT consent.s2_begin_talent_erasure_run($1::uuid, $2::uuid, $3::uuid, '{}'::uuid[])`, [uuidv7(), TENANT, rec])).rejects.toThrow(/permission denied/);
      await expect(app.query(`INSERT INTO consent."TalentErasureRun"(id,tenant_id,record_id,record_ids,subject_ids,state,artifact_count) VALUES ($1,$2,$3,ARRAY[$3]::uuid[],'{}','DB_PASS_IN_PROGRESS',0)`, [uuidv7(), TENANT, rec])).rejects.toThrow(/created only by/);
      await expect(app.query(`SET ROLE aramo_erasure_definer`)).rejects.toThrow(/permission denied/);
      await db.query(`GRANT aramo_erasure_operator TO s2_app`);
      await app.query('BEGIN');
      const ids = (await app.query(`SELECT consent.s2_begin_talent_erasure_run($1::uuid, $2::uuid, $3::uuid, '{}'::uuid[]) AS ids`, [uuidv7(), TENANT, rec])).rows[0].ids;
      expect(ids).toEqual([rec]);
      await app.query('ROLLBACK');
      // Operator membership never extends to the definer role.
      await expect(app.query(`SET ROLE aramo_erasure_definer`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
      await db.query(`REVOKE aramo_erasure_operator FROM s2_app`);
    }
  });

  it('(12) holder coverage: every talent-keyed table is reached, guarded, retained or explicitly not a talent holder', async () => {
    const cols = await db.query<{ s: string; t: string; c: string }>(
      `SELECT c.table_schema s, c.table_name t, c.column_name c FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        -- ATI-SEP-1 (ADR-0036 Decision 2): the intelligence schema is the Talent Intelligence
        -- service's OWN database (only co-located by this spec's migration glob); TI erases on
        -- the talent.erased event, never through this pass.
        -- Aramo-Sign-Domain-Isolation-Reconciliation-V1 §2 R-1: the sign schema is Aramo Sign's;
        -- this pass never reads it — Sign answers for and erases its own rows through its
        -- talent-erasure contract (proven in sign-service's talent-erasure integration spec).
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'intelligence', 'sign')
          AND (c.column_name ~ 'talent' OR c.table_name IN ('OutboxEvent', 'IdempotencyKey')
            OR (c.table_schema, c.table_name, c.column_name) IN (
              ('activity', 'Activity', 'subject_id'), ('attachment', 'Attachment', 'owner_id'), ('communications', 'CommunicationAssociation', 'subject_id'),
              ('documents', 'DocumentAssociation', 'resource_id'), ('documents', 'DocumentRequirement', 'resource_id'),
              ('saved_list', 'SavedListEntry', 'item_id'), ('task', 'Task', 'owner_id'), ('talent_evidence', 'TalentIntakeOutboxEvent', 'subject_id')))`,
    );
    // Reached by an ON DELETE CASCADE from a reached parent (TalentRecord / Document), and
    // the erasure ledger itself.
    const notReachedDirectly = new Set([
      'documents."DocumentAssociation"',
      'talent_record."talent_profile_field_state"',
      'talent_record."talent_record_field_provenance"',
      'talent_record."talent_record_reconcile_contradiction"',
      'consent."TalentErasureRun"',
    ]);
    const guarded = ERASURE_HOLDER_GUARDS.map((g) => g.holder);
    const unclassified = [...new Set(cols.rows.map((r) => `${r.s}."${r.t}"`))].filter(
      (label) =>
        !ERASURE_REACHED_HOLDERS.includes(label) &&
        !RETAINED.includes(label) &&
        !notReachedDirectly.has(label) &&
        !guarded.some((h) => h.includes(label)),
    );
    expect(unclassified, 'a talent-keyed holder is neither erased, guarded nor declared retained').toEqual([]);

    // Gate-5 C — every table with a DIRECT talent key serializes with the erasure: it carries
    // the write-guard trigger. Exempt: the retained audit streams, the ledger, TalentRecord's
    // same-schema FK children (the FK already locks the record), and a screening child keyed
    // through its session (locked FOR UPDATE by the pass).
    const direct = await db.query<{ label: string; guarded: boolean }>(
      `SELECT format('%s."%s"', c.table_schema, c.table_name) AS label,
              EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class k ON k.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = k.relnamespace
                       WHERE n.nspname = c.table_schema AND k.relname = c.table_name AND tg.tgname = 'trg_s2_guard_talent_write') AS guarded
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.column_name IN ('talent_id', 'talent_record_id', 'promoted_talent_record_id')
           OR (c.table_schema, c.table_name, c.column_name) IN (
                ('activity', 'Activity', 'subject_id'), ('attachment', 'Attachment', 'owner_id'), ('communications', 'CommunicationAssociation', 'subject_id'),
                ('documents', 'DocumentAssociation', 'resource_id'), ('documents', 'DocumentRequirement', 'resource_id'),
                ('saved_list', 'SavedListEntry', 'item_id'), ('task', 'Task', 'owner_id'))`,
    );
    // ATI-SEP-1 T10 WP2/WP4 — talent_record_sourced_arrival is a same-schema FK child of
    // TalentRecord (ON DELETE CASCADE; erased explicitly by the pass) — the FK locks the record.
    // talent_record."intelligence_link" is likewise an FK child of TalentRecord; the TI inbound
    // inbox (talent_intelligence_inbound_event) holds ids only and is erased by the pass.
    const exempt = new Set([...RETAINED, ...notReachedDirectly, 'talent_record."talent_resume_text"', 'talent_record."talent_record_sourced_arrival"', 'talent_record."intelligence_link"', 'talent_record."talent_intelligence_inbound_event"']);
    expect(direct.rows.filter((r) => !r.guarded && !exempt.has(r.label)).map((r) => r.label), 'a talent-keyed table without the S2 write guard').toEqual([]);
  });

  it('(14) ATI-SEP-1 A3 — the pass writes talent.erased (ids only) in its transaction, drops the earlier talent.* rows and a mid-Save intake draft', async () => {
    const rec = await talent();
    await seed('talent_record."TalentEventOutbox"', {
      id: uuidv7(), tenant_id: TENANT, event_type: 'talent.created', event_payload: JSON.stringify({ talent_record_id: rec }),
      event_version: 'v1', source: 'ats-talent-record', subject_type: 'talent_record', subject_id: rec,
    });
    // A Save that created the record but had not yet marked the draft PROMOTED.
    const draftId = uuidv7();
    await seed('talent_evidence."TalentIntakeDraft"', { id: draftId, tenant_id: TENANT, save_reserved_talent_record_id: rec });
    const r = await erasure.execute(pg, TENANT, rec, okStore());
    expect(r.outcome).toBe('COMPLETED');
    expect(await count('talent_record."TalentEventOutbox"', `subject_id = $1 AND event_type <> 'talent.erased'`, [rec])).toBe(0);
    const erased = await db.query<{ event_payload: unknown; event_version: string }>(
      `SELECT event_payload, event_version FROM talent_record."TalentEventOutbox" WHERE subject_id = $1 AND event_type = 'talent.erased'`,
      [rec],
    );
    expect(erased.rows).toEqual([{ event_payload: { talent_record_id: rec }, event_version: 'v1' }]);
    expect(await count('talent_evidence."TalentIntakeDraft"', 'id = $1', [draftId])).toBe(0);
  });

  it('(13) replay identity: tombstones never collide or re-link — across husks, retries, re-runs and later erasures', async () => {
    const ada = await talent();
    const husk = uuidv7();
    await seed('talent_record."TalentRecord"', { id: husk, tenant_id: TENANT, first_name: 'Husk', last_name: 'Record', superseded_by_record_id: ada });
    const r1 = uuidv7();
    const r2 = uuidv7();
    const pa1 = uuidv7();
    const pa2 = uuidv7();
    const ph1 = uuidv7();
    // The husk and its survivor BOTH hold an episode on R1 (distinct ids, so the unique key allows it).
    for (const [id, who, req] of [[pa1, ada, r1], [pa2, ada, r2], [ph1, husk, r1]] as const) {
      await seed('pipeline."Pipeline"', { id, tenant_id: TENANT, talent_record_id: who, requisition_id: req });
    }
    await seed('client_selection."ClientSelectionProcess"', { id: uuidv7(), tenant_id: TENANT, talent_id: ada, requisition_id: r1 });
    const grainR1 = `SELECT count(DISTINCT talent_record_id)::int AS n FROM pipeline."Pipeline" WHERE requisition_id = $1`;
    expect(await count('pipeline."Pipeline"', 'requisition_id = $1', [r1])).toBe(2);

    // Retry: a failed pass persists NO tombstone (the temp table and every re-point roll back).
    await db.query(`
      CREATE OR REPLACE FUNCTION public.s2_test_fail_replay() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 's2 injected replay failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER s2_test_fail_replay BEFORE UPDATE ON consent."TalentErasureRun" FOR EACH ROW EXECUTE FUNCTION public.s2_test_fail_replay();`);
    try {
      expect((await erasure.execute(pg, TENANT, ada, okStore())).outcome).toBe('FAILED');
    } finally {
      await db.query(`DROP TRIGGER s2_test_fail_replay ON consent."TalentErasureRun"; DROP FUNCTION public.s2_test_fail_replay();`);
    }
    expect(await count('pipeline."Pipeline"', 'id = ANY($1::uuid[]) AND talent_record_id = ANY($2::uuid[])', [[pa1, pa2, ph1], [ada, husk]])).toBe(3);

    const done = await erasure.execute(pg, TENANT, ada, okStore());
    expect(done.outcome).toBe('COMPLETED');
    const tombOf = async (id: string) => (await db.query<{ t: string }>(`SELECT talent_record_id AS t FROM pipeline."Pipeline" WHERE id = $1`, [id])).rows[0]!.t;
    const first = { pa1: await tombOf(pa1), pa2: await tombOf(pa2), ph1: await tombOf(ph1) };
    // One per (record, requisition): three distinct values, none an erased id; the R1 grain
    // keeps its two (talent, requisition) pairs; the selection process shares the survivor's R1 tombstone.
    expect(new Set(Object.values(first)).size).toBe(3);
    for (const t of Object.values(first)) expect([ada, husk]).not.toContain(t);
    expect((await db.query<{ n: number }>(grainR1, [r1])).rows[0]!.n).toBe(2);
    expect(await count('client_selection."ClientSelectionProcess"', 'requisition_id = $1 AND talent_id = $2', [r1, first.pa1])).toBe(1);
    // Unlinkable: no tombstone resolves to a record, and none is written to the retained ledger.
    expect(await count('talent_record."TalentRecord"', 'id = ANY($1::uuid[])', [Object.values(first)])).toBe(0);
    for (const t of Object.values(first)) {
      expect(await count('consent."TalentErasureRun"', `array_to_string(record_ids, ',') || array_to_string(subject_ids, ',') || id::text LIKE $1`, [`%${t}%`])).toBe(0);
      expect(await count('audit."ConsentAuditEvent"', `event_payload::text LIKE $1`, [`%${t}%`])).toBe(0);
    }
    // Stable once committed: a re-run is a no-op and re-points nothing.
    expect((await erasure.execute(pg, TENANT, ada, okStore())).outcome).toBe('COMPLETED');
    expect({ pa1: await tombOf(pa1), pa2: await tombOf(pa2), ph1: await tombOf(ph1) }).toEqual(first);
    // A later erasure of ANOTHER talent on the same requisition never reuses or merges a tombstone.
    const bob = await talent();
    const pb1 = uuidv7();
    await seed('pipeline."Pipeline"', { id: pb1, tenant_id: TENANT, talent_record_id: bob, requisition_id: r1 });
    expect((await erasure.execute(pg, TENANT, bob, okStore())).outcome).toBe('COMPLETED');
    expect(Object.values(first)).not.toContain(await tombOf(pb1));
    expect((await db.query<{ n: number }>(grainR1, [r1])).rows[0]!.n).toBe(3);
  });

  it('(14) concurrency: writers and the erasure serialize on the talent — no holder slips past the preflight', async () => {
    const connect = async () => {
      const c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      return c;
    };
    const writer = await connect();
    const observer = await connect();
    // The erasure runs on `db`: while it is in flight only `writer` / `observer` are used.
    const waitersOnLock = async (): Promise<number> =>
      Number((await observer.query<{ n: string }>(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)).rows[0]!.n);
    const untilWaiting = async (): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if ((await waitersOnLock()) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no transaction ever waited on a lock');
    };
    // A template row (seeded up front) lets the writer insert while `db` is busy with the pass.
    const templateOffer = uuidv7();
    await seed('offer."Offer"', { id: templateOffer, tenant_id: TENANT, talent_record_id: uuidv7() });
    const insertOfferAs = (c: Client, rec: string) =>
      c.query(
        `INSERT INTO offer."Offer" SELECT (jsonb_populate_record(o, jsonb_build_object('id', gen_random_uuid(), 'submittal_id', gen_random_uuid(), 'talent_record_id', $2::uuid))).*
           FROM offer."Offer" o WHERE o.id = $1`,
        [templateOffer, rec],
      );
    try {
      // (a) writer FIRST, a blocking holder: the erasure waits on the talent lock, then sees the
      //     committed offer and BLOCKS — nothing erased.
      const a = await talent();
      await writer.query('BEGIN');
      await insertOfferAs(writer, a);
      const ea = erasure.execute(pg, TENANT, a, okStore());
      await untilWaiting();
      await writer.query('COMMIT');
      const ra = await ea;
      expect([ra.outcome, ra.blockers.map((b) => b.holder)]).toEqual(['BLOCKED', ['offer."Offer"']]);
      expect(await count('talent_record."TalentRecord"', 'id = $1', [a])).toBe(1);

      // (b) writer FIRST, an erasable holder: the erasure waits, then erases the committed row.
      const b = await talent();
      await writer.query('BEGIN');
      await seed('talent_evidence."TalentProjectExperience"', { id: uuidv7(), tenant_id: TENANT, talent_id: b }, writer);
      const eb = erasure.execute(pg, TENANT, b, okStore());
      await untilWaiting();
      await writer.query('COMMIT');
      expect((await eb).outcome).toBe('COMPLETED');
      expect(await count('talent_evidence."TalentProjectExperience"', 'talent_id = $1', [b])).toBe(0);

      // (c) erasure FIRST: a writer arriving during the pass waits on the talent lock and, once
      //     the run commits, is refused — the erased record can never be named again.
      const c = await talent();
      await seed('talent_evidence."TalentSkillEvidence"', { id: uuidv7(), tenant_id: TENANT, talent_id: c });
      await db.query(`
        CREATE OR REPLACE FUNCTION public.s2_test_slow() RETURNS TRIGGER AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN OLD; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER s2_test_slow BEFORE DELETE ON talent_evidence."TalentSkillEvidence" FOR EACH ROW EXECUTE FUNCTION public.s2_test_slow();`);
      try {
        const ec = erasure.execute(pg, TENANT, c, okStore());
        // the pass is in flight once it holds the talent lock
        for (let i = 0; i < 100; i++) {
          const held = await observer.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND granted`);
          if ((held.rowCount ?? 0) > 0) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const wc = insertOfferAs(writer, c).then(() => 'inserted', (e: Error) => e.message);
        await untilWaiting();
        expect((await ec).outcome).toBe('COMPLETED');
        expect(await wc).toMatch(/has been erased/);
      } finally {
        await db.query(`DROP TRIGGER s2_test_slow ON talent_evidence."TalentSkillEvidence"; DROP FUNCTION public.s2_test_slow();`);
      }
      expect(await count('offer."Offer"', 'talent_record_id = $1', [c])).toBe(0);

      // (d) contact identity: a sourced record carrying the talent's email, written FIRST,
      //     makes the erasure wait on the contact lock (read before any delete) and then BLOCK.
      const d = await talent();
      const email = `cc-${d.slice(-8)}@pii.example`;
      await seed('talent_evidence."TalentContactMethod"', { id: uuidv7(), tenant_id: TENANT, talent_id: d, value: email });
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO sourced_talent."SourcedTalent"(id, tenant_id, source_channel, external_source_id, provenance, legal_basis, arrived_at, normalized_email) VALUES (gen_random_uuid(), $1, 'x', $2, '{}', '{}', now(), $3)`, [TENANT, uuidv7(), email]);
      const ed = erasure.execute(pg, TENANT, d, okStore());
      await untilWaiting();
      await writer.query('COMMIT');
      const rd = await ed;
      expect([rd.outcome, rd.blockers.map((x) => x.holder)]).toEqual(['BLOCKED', ['sourced_talent."SourcedTalent"']]);

      // (e) an FK-checked child written FIRST (a status-history note on the talent's pipeline)
      //     makes the erasure wait on the parent lock, then is redacted with the rest.
      const e = await talent();
      const pipe = uuidv7();
      await seed('pipeline."Pipeline"', { id: pipe, tenant_id: TENANT, talent_record_id: e, requisition_id: uuidv7() });
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO pipeline."PipelineStatusHistory"(id, tenant_id, pipeline_id, status_to, changed_at, note) VALUES (gen_random_uuid(), $1, $2, 'contacted', now(), 'late note about the talent')`, [TENANT, pipe]);
      const ee = erasure.execute(pg, TENANT, e, okStore());
      await untilWaiting();
      await writer.query('COMMIT');
      expect((await ee).outcome).toBe('COMPLETED');
      expect(await count('pipeline."PipelineStatusHistory"', `pipeline_id = $1 AND note IS NOT NULL`, [pipe])).toBe(0);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      await observer.end();
    }
  });
});
