import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ERASURE_EXIT_CODES,
  TalentErasureService,
  type ErasureObjectStore,
  type PgExec,
} from '../talent-identity/talent-erasure.service.js';

// S2 Talent Erasure Integrity (Architect rulings F1/F3/F5; TM-L12 auditable
// completion) — against real Postgres 17 with every repo migration applied.
// Acceptance: Aramo never reports a talent erasure as COMPLETED while governed
// personal data remains.
//   (1) the ORIGINAL false-success defect (pipeline + note + document) now
//       BLOCKS before any write: the TalentRecord survives, no marker, exit 2;
//   (2) a forced mid-pass database failure rolls the WHOLE pass back;
//   (3) missing-holder detection: commercial / restriction / legal-hold /
//       shared rows BLOCK; the newly classified DELETE holders are erased;
//   (4) object-storage failure → STORAGE_PENDING (DB committed, no marker,
//       is_anonymized false, key held only while pending) → --resume → COMPLETED;
//   (5) cross-tenant isolation;
//   (6) immutable tables keep refusing direct mutation; the erasure path adds
//       no session marker and no bypass.

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
  const erasure = new TalentErasureService();

  const count = async (table: string, where: string, params: unknown[] = []): Promise<number> =>
    Number((await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0]!.n);

  // Insert one row, filling every NOT NULL column without a default from its
  // type (overrides win). Keeps the seed honest across many holder tables.
  async function seed(table: string, overrides: Record<string, unknown>): Promise<void> {
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
    await db.query(
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

  it('(1) the original false-success defect now BLOCKS before any write (pipeline + talent note + document)', async () => {
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
    expect(dry.blockers.map((b) => b.holder).sort()).toEqual(['activity."ActivityNoteEvent"', 'documents."DocumentEvent"', 'pipeline."PipelineStatusHistory"']);

    const r = await erasure.execute(pg, TENANT, rec, okStore());
    expect(r.outcome).toBe('BLOCKED');
    expect(ERASURE_EXIT_CODES[r.outcome as 'BLOCKED']).toBe(2);
    expect(r.blockers.every((b) => b.classification === 'BLOCKED_PENDING_AUTHORITY')).toBe(true);
    expect(r.erasure_marker_appended).toBe(false);
    expect(r.is_anonymized_flipped).toBe(false);
    expect(r.total_rows).toBe(0);
    // NOTHING was deleted — before S2 the TalentRecord went while these survived.
    expect(await count('talent_record."TalentRecord"', 'id = $1', [rec])).toBe(1);
    expect(await count('pipeline."Pipeline"', 'id = $1', [pipe])).toBe(1);
    expect(await count('activity."Activity"', 'id = $1', [act])).toBe(1);
    expect(await count('documents."Document"', 'id = $1', [doc])).toBe(1);
    expect(await count('audit."ConsentAuditEvent"', `subject_id = $1 AND event_type = 'consent.erased'`, [rec])).toBe(0);
    expect(await count('consent."TalentErasureRun"', 'record_id = $1', [rec])).toBe(0);
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
    } finally {
      await db.query(`DROP TRIGGER s2_test_fail ON talent_evidence."TalentCertificationEntry"; DROP FUNCTION public.s2_test_fail();`);
    }
    const again = await erasure.execute(pg, TENANT, rec, okStore());
    expect(again.outcome).toBe('COMPLETED');
    expect(await count('talent_evidence."TalentSkillEvidence"', 'talent_id = $1', [rec])).toBe(0);
  });

  it('(3a) missing holders that need authority / PO-Legal / a hold / another person BLOCK — nothing deleted', async () => {
    const cases: Array<[string, (rec: string) => Promise<void>, string]> = [
      ['offer."Offer"', (rec) => seed('offer."Offer"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: rec }), 'PENDING_PO_LEGAL'],
      ['client_talent_restriction."ClientTalentRestriction"', (rec) => seed('client_talent_restriction."ClientTalentRestriction"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: rec }), 'BLOCKED_PENDING_AUTHORITY'],
      ['pipeline."TalentRequisitionResume"', (rec) => seed('pipeline."TalentRequisitionResume"', { id: uuidv7(), tenant_id: TENANT, talent_record_id: rec }), 'BLOCKED_PENDING_AUTHORITY'],
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

  it('(3b) the newly classified DELETE holders + general communications + raw payloads are erased with their artifacts', async () => {
    const rec = await talent();
    const subject = uuidv7();
    await db.query(`INSERT INTO talent_trust."ResolutionSubject"(id, tenant_id) VALUES ($1,$2)`, [subject, TENANT]);
    await db.query(`INSERT INTO talent_trust."ResolutionSubjectRef"(id,subject_id,tenant_id,ref_type,ref_id,link_source) VALUES ($1,$2,$3,'ATS_TALENT_RECORD',$4,'test')`, [uuidv7(), subject, TENANT, rec]);
    await seed('talent_evidence."TalentProjectExperience"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await seed('talent_evidence."TalentResumeDefault"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await seed('talent_evidence."TalentResumeEdition"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    await seed('talent_evidence."ResumeExtractionDraft"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec });
    const draft = uuidv7();
    await seed('talent_evidence."TalentIntakeDraft"', { id: draft, tenant_id: TENANT, promoted_talent_record_id: rec, storage_key: `${TENANT}/intake/${draft}-Ada_Lovelace.pdf` });
    await seed('talent_evidence."TalentIntakeOutboxEvent"', { id: uuidv7(), subject_type: 'talent_intake_draft', subject_id: draft });
    await seed('examination."CanonicalMatchShadowObservation"', { id: uuidv7(), tenant_id: TENANT, talent_id: rec, match_class: 'CANONICAL_EXACT' });
    await seed('ingestion."RawPayloadReference"', { id: uuidv7(), tenant_id: TENANT, resolved_subject_id: subject, storage_ref: `${TENANT}/ingestion/raw/${uuidv7()}.json`, verified_email: 'ada@pii.example' });
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
      ['ingestion."RawPayloadReference"', 'resolved_subject_id = $1', subject],
      ['communications."CommunicationInteraction"', 'id = $1', call],
      ['conversation_transcript."ConversationTranscript"', 'id = $1', tr],
      ['talent_record."TalentRecord"', 'id = $1', rec],
    ] as const) {
      expect(await count(t, w, [p]), t).toBe(0);
    }
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
});
