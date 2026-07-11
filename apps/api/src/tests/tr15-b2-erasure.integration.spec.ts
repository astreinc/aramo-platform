import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TalentErasureService,
  type PgExec,
  type S3Deleter,
} from '../talent-identity/talent-erasure.service.js';
import { TalentDataInventoryService } from '../talent-identity/talent-data-inventory.service.js';

// TR-15 B2 (DDR §5/§6 / directive §5b-e) — the erase engine + the DSAR
// assembly against real Postgres. NO Nest boot — both services take a raw
// PgExec. Applies every repo migration (so all inventory tables EXIST → the
// dry-run counts none as 'failed'), seeds ONE rich human across both keyspaces
// (a superseded husk + trust subject + evidence/event/anchor + education [the
// TR-7 HALT-note holder] + consent ledger + retained audit), and proves:
//   (b) dry-run: full inventory counted, correct counts, ZERO writes;
//   (d) assembly: every element, read-only (row counts unchanged);
//   (c) live erase: every holder emptied, husk reached, marker appended, audit
//       retained, is_anonymized flips; a second run is empty-and-idempotent.

const ROOT = resolve(__dirname, '../../../..');

function allMigrations(): string[] {
  const libs = resolve(ROOT, 'libs');
  const out: Array<{ ts: string; path: string }> = [];
  for (const lib of readdirSync(libs)) {
    const migDir = resolve(libs, lib, 'prisma', 'migrations');
    let entries: string[];
    try {
      entries = readdirSync(migDir);
    } catch {
      continue;
    }
    for (const d of entries) {
      const file = resolve(migDir, d, 'migration.sql');
      try {
        readFileSync(file);
      } catch {
        continue;
      }
      out.push({ ts: d, path: file });
    }
  }
  // Apply in timestamp order (the fresh-DB order) — the dir name is timestamped.
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out.map((o) => o.path);
}

const TENANT = '01900000-0000-7000-8000-0000000000e1';
const REC = '01900000-0000-7000-8000-0000000000e2'; // live record
const HUSK = '01900000-0000-7000-8000-0000000000e3'; // superseded husk of REC
const SUBJ = '01900000-0000-7000-8000-0000000000e4'; // trust subject
const EV = '01900000-0000-7000-8000-0000000000e5'; // evidence record

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-15 B2 — erase-talent + data-inventory (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let pg: PgExec;
    const erasure = new TalentErasureService();
    const inventory = new TalentDataInventoryService();
    const s3Recorded: string[] = [];
    const s3Delete: S3Deleter = async (keys) => {
      s3Recorded.push(...keys);
    };

    async function count(table: string, where: string, params: unknown[]): Promise<number> {
      const r = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
      return Number(r.rows[0]!.n);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      for (const p of allMigrations()) {
        await db.query(readFileSync(p, 'utf8'));
      }
      pg = {
        async query<T>(sql: string, ps?: unknown[]) {
          const r = await db.query(sql, ps as unknown[] | undefined);
          return { rows: r.rows as T[], rowCount: r.rowCount };
        },
      };

      // ---- Seed ONE rich human -------------------------------------------
      // TalentRecord: the live record + a superseded husk pointing at it.
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name) VALUES ($1::uuid,$2::uuid,'Ada','Lovelace')`,
        [REC, TENANT],
      );
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name, superseded_by_record_id) VALUES ($1::uuid,$2::uuid,'Ada','L',$3::uuid)`,
        [HUSK, TENANT, REC],
      );
      // Trust subject + the ATS ref (record→subject).
      await db.query(`INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id) VALUES ($1::uuid,$2::uuid)`, [SUBJ, TENANT]);
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef" (id, subject_id, tenant_id, ref_type, ref_id, link_source) VALUES ($1::uuid,$2::uuid,$3::uuid,'ATS_TALENT_RECORD',$4::uuid,'test')`,
        [uuidv7(), SUBJ, TENANT, REC],
      );
      // Evidence (subject keyspace) + its event child + an anchor (PII).
      await db.query(
        `INSERT INTO talent_trust."EvidenceRecord" (id, subject_id, tenant_id, dimension, assertion_type, assertion_payload, source_class, method, strength, collected_at, decay_profile, portability_class, current_status, created_by)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'CLAIMS','EMPLOYMENT','{}'::jsonb,'SELF','SELF_DECLARED',0.3,now(),'SLOW','TENANT_ONLY','VALID','test')`,
        [EV, SUBJ, TENANT],
      );
      await db.query(
        `INSERT INTO talent_trust."EvidenceEvent" (id, evidence_id, tenant_id, event_type) VALUES ($1::uuid,$2::uuid,$3::uuid,'CREATED')`,
        [uuidv7(), EV, TENANT],
      );
      await db.query(
        `INSERT INTO talent_trust."SubjectAnchor" (id, subject_id, tenant_id, anchor_kind, normalized_value, source_evidence_id, source_class) VALUES ($1::uuid,$2::uuid,$3::uuid,'EMAIL','ada@pii.example',$4::uuid,'SELF')`,
        [uuidv7(), SUBJ, TENANT, EV],
      );
      // Education (the TR-7 HALT-note holder) — one for the live record AND one
      // for the HUSK, to prove the husk chain is reached.
      for (const rid of [REC, HUSK]) {
        await db.query(
          `INSERT INTO talent_evidence."TalentEducationEntry" (id, talent_id, tenant_id, institution_name, degree_name, source, created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'MIT','BSc','resume',now())`,
          [uuidv7(), rid, TENANT],
        );
      }
      // Consent ledger (record keyspace) + a RETAINED audit grant row.
      await db.query(
        `INSERT INTO consent."TalentConsentEvent" (id, talent_record_id, tenant_id, scope, action, captured_method, consent_version, occurred_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'profile_storage','granted','import','source-derived-v1',now())`,
        [uuidv7(), REC, TENANT],
      );
      await db.query(
        `INSERT INTO audit."ConsentAuditEvent" (id, tenant_id, actor_type, event_type, subject_id, event_payload) VALUES ($1::uuid,$2::uuid,'system','consent.grant.recorded',$3::uuid,'{}'::jsonb)`,
        [uuidv7(), TENANT, REC],
      );
    }, 300_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    }, 60_000);

    // ---- (b) dry-run: full inventory, correct counts, ZERO writes ----------
    it('(b) dry-run lists the full would-delete inventory with correct counts and writes NOTHING', async () => {
      const before = await count('talent_record."TalentRecord"', 'true', []);
      const report = await erasure.dryRun(pg, TENANT, REC);

      // Scope: the husk chain is both records; the cluster is the one subject.
      expect(report.scope.record_ids.sort()).toEqual([REC, HUSK].sort());
      expect(report.scope.subject_ids).toEqual([SUBJ]);

      // Every inventory step exists (migrations applied) → none 'failed'.
      expect(report.steps.every((s) => s.status === 'counted')).toBe(true);
      expect(report.steps.length).toBeGreaterThanOrEqual(30);

      const c = (t: string): number => report.steps.find((s) => s.table === t)!.count;
      expect(c('talent_record."TalentRecord"')).toBe(2); // live + husk
      expect(c('talent_evidence."TalentEducationEntry"')).toBe(2); // record + husk (the HALT-note holder, reached)
      expect(c('consent."TalentConsentEvent"')).toBe(1);
      expect(c('talent_trust."EvidenceRecord"')).toBe(1);
      expect(c('talent_trust."EvidenceEvent"')).toBe(1);
      expect(c('talent_trust."SubjectAnchor"')).toBe(1);
      expect(c('talent_trust."ResolutionSubject"')).toBe(1);

      // Audit is NOT in the delete inventory (retained).
      expect(report.retained).toContain('audit."ConsentAuditEvent"');
      expect(report.retained).toContain('talent_trust."SubjectMergeOperation"');

      // ZERO writes: the row count is unchanged, nothing was deleted/appended.
      expect(await count('talent_record."TalentRecord"', 'true', [])).toBe(before);
      expect(await count('audit."ConsentAuditEvent"', `event_type='consent.erased'`, [])).toBe(0);
    });

    // ---- (d) the assembly: every element, read-only ------------------------
    it('(d) data-inventory assembles every element and writes NOTHING', async () => {
      const beforeRows = await count('talent_trust."EvidenceRecord"', 'true', []);
      const inv = await inventory.assemble(pg, TENANT, REC);

      expect(inv.scope.record_ids.sort()).toEqual([REC, HUSK].sort());
      expect(inv.scope.subject_ids).toEqual([SUBJ]);
      expect(inv.per_holder_counts.length).toBeGreaterThanOrEqual(30);
      expect(inv.consent_ledger.length).toBe(1);
      expect(inv.evidence_timeline.length).toBe(1); // the CREATED event
      expect(inv.is_anonymized).toBe(false); // not yet erased
      expect(inv.total_rows).toBeGreaterThan(0);

      // Read-only: unchanged.
      expect(await count('talent_trust."EvidenceRecord"', 'true', [])).toBe(beforeRows);
    });

    // ---- (c) the live erase: every holder emptied + audit retained + idempotent
    it('(c) live erase empties every holder incl. the husk, retains audit, appends the marker, flips is_anonymized', async () => {
      const report = await erasure.execute(pg, TENANT, REC, s3Delete);

      expect(report.mode).toBe('execute');
      expect(report.erasure_marker_appended).toBe(true);
      expect(report.is_anonymized_flipped).toBe(true);

      // Every seeded holder is emptied of this human — both keyspaces + the husk.
      expect(await count('talent_record."TalentRecord"', 'id = ANY($1::uuid[])', [[REC, HUSK]])).toBe(0);
      expect(await count('talent_evidence."TalentEducationEntry"', 'talent_id = ANY($1::uuid[])', [[REC, HUSK]])).toBe(0); // HALT-note holder reached, incl husk
      expect(await count('consent."TalentConsentEvent"', 'talent_record_id = $1::uuid', [REC])).toBe(0);
      expect(await count('talent_trust."EvidenceRecord"', 'subject_id = $1::uuid', [SUBJ])).toBe(0);
      expect(await count('talent_trust."EvidenceEvent"', 'evidence_id = $1::uuid', [EV])).toBe(0);
      expect(await count('talent_trust."SubjectAnchor"', 'subject_id = $1::uuid', [SUBJ])).toBe(0);
      expect(await count('talent_trust."ResolutionSubject"', 'id = $1::uuid', [SUBJ])).toBe(0);
      expect(await count('talent_trust."ResolutionSubjectRef"', 'subject_id = $1::uuid', [SUBJ])).toBe(0);

      // S3 stub received the (zero, in this seed) blob keys — no doc/attachment seeded.
      expect(Array.isArray(s3Recorded)).toBe(true);

      // Audit RETAINED: the grant audit row stays; the erased marker is appended.
      expect(await count('audit."ConsentAuditEvent"', `subject_id=$1::uuid AND event_type='consent.grant.recorded'`, [REC])).toBe(1);
      expect(await count('audit."ConsentAuditEvent"', `subject_id=$1::uuid AND event_type='consent.erased'`, [REC])).toBe(1);

      // Idempotent second run: nothing left, marker not re-appended.
      const second = await erasure.execute(pg, TENANT, REC, s3Delete);
      expect(second.total_rows).toBe(0);
      expect(second.erasure_marker_appended).toBe(false);
      expect(await count('audit."ConsentAuditEvent"', `subject_id=$1::uuid AND event_type='consent.erased'`, [REC])).toBe(1);
    });
  },
);
