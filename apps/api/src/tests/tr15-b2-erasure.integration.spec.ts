import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';


import {
  TalentErasureService,
  type PgExec,
  type ErasureObjectStore,
} from '../talent-identity/talent-erasure.service.js';
import { TalentDataInventoryService } from '../talent-identity/talent-data-inventory.service.js';

import { fakeSignErasure } from './helpers/fake-sign-erasure.js';

// TR-15 B2 (DDR §5/§6 / directive §5b-e) — the erase engine + the DSAR
// assembly against real Postgres. NO Nest boot — both services take a raw
// PgExec. Applies every repo migration (so all inventory tables EXIST → the
// dry-run counts none as 'failed'), seeds ONE rich human across both keyspaces
// (a superseded husk + a linked sourced arrival with its raw payload [ATI-SEP-1
// T10 WP4 — replaces the retired trust subject] + a duplicate advisory +
// education [the TR-7 HALT-note holder] + consent ledger + retained audit), and
// proves:
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
const SOURCED = '01900000-0000-7000-8000-0000000000e4'; // linked sourced arrival (ATI-SEP-1 WP2)
const EV = '01900000-0000-7000-8000-0000000000e5'; // an opaque published-evidence id (screening)
const SCREENING_ACTOR = '01900000-0000-7000-8000-0000000000e6'; // TIP-E2E INC-3 recruiter

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-15 B2 — erase-talent + data-inventory (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let pg: PgExec;
    const erasure = new TalentErasureService(fakeSignErasure());
    const inventory = new TalentDataInventoryService(fakeSignErasure());
    const s3Recorded: string[] = [];
    const s3Delete: ErasureObjectStore = {
      purge: async (key) => {
        s3Recorded.push(key);
        return { remaining: 0 };
      },
    };

    async function count(table: string, where: string, params: unknown[]): Promise<number> {
      const r = await db.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
      return Number(r.rows[0]!.n);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
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
      // ATI-SEP-1 T10 WP4 — the sourced arrival linked to the record (PROMOTED), its
      // raw payload (keyed by sourced_talent_id), and a duplicate advisory REC↔HUSK.
      await db.query(
        `INSERT INTO sourced_talent."SourcedTalent" (id, tenant_id, source_channel, external_source_id, provenance, legal_basis, arrived_at) VALUES ($1::uuid,$2::uuid,'INDEED','ext-ada','{}'::jsonb,'{}'::jsonb,now())`,
        [SOURCED, TENANT],
      );
      await db.query(
        `INSERT INTO talent_record."talent_record_sourced_arrival" (tenant_id, sourced_talent_id, talent_record_id, link_kind) VALUES ($1::uuid,$2::uuid,$3::uuid,'PROMOTED')`,
        [TENANT, SOURCED, REC],
      );
      await db.query(
        `INSERT INTO ingestion."RawPayloadReference" (id, tenant_id, source, source_class, storage_ref, sha256, content_type, captured_at, sourced_talent_id, updated_at)
         VALUES ($1::uuid,$2::uuid,'indeed','THIRD_PARTY_UNVERIFIED','raw/ada.json','h','application/json',now(),$3::uuid,now())`,
        [uuidv7(), TENANT, SOURCED],
      );
      {
        const [a, b] = REC < HUSK ? [REC, HUSK] : [HUSK, REC];
        await db.query(
          `INSERT INTO talent_record."talent_duplicate_advisory" (id, tenant_id, talent_record_a_id, talent_record_b_id, basis, shared_kinds) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'EMAIL',ARRAY['EMAIL'])`,
          [uuidv7(), TENANT, a, b],
        );
      }
      // Education (the TR-7 HALT-note holder) — one for the live record AND one
      // for the HUSK, to prove the husk chain is reached.
      for (const rid of [REC, HUSK]) {
        await db.query(
          `INSERT INTO talent_evidence."TalentEducationEntry" (id, talent_id, tenant_id, institution_name, degree_name, source, created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'MIT','BSc','resume',now())`,
          [uuidv7(), rid, TENANT],
        );
      }
      // Enterprise Search GS-2A semantic index (record keyspace) — one for the live record AND the
      // HUSK, to prove the erase inventory reaches the embedding across the husk chain (UUID ref, no FK).
      for (const rid of [REC, HUSK]) {
        await db.query(
          `INSERT INTO talent_embedding."TalentEmbedding" (id, tenant_id, talent_record_id, created_at, updated_at) VALUES ($1::uuid,$2::uuid,$3::uuid,now(),now())`,
          [uuidv7(), TENANT, rid],
        );
      }
      // TIP-E2E INC-3 (directive §10.2) — technical screening: a CONFIRMED session
      // with a finding, a PUBLISHED intent and events on the live record, plus a
      // DRAFT session with a finding on the HUSK (the husk chain must be reached).
      // The tables carry NO delete trigger — erasure deletes them as plain rows.
      for (const [rid, confirmed] of [[REC, true], [HUSK, false]] as const) {
        const sessionId = uuidv7();
        const findingId = uuidv7();
        if (confirmed) {
          await db.query(
            `INSERT INTO technical_screening."ScreeningSession" (id, tenant_id, talent_record_id, state, version, created_by_actor_id, confirmed_by_actor_id, confirmed_at, confirmed_version, confirmation_attested)
             VALUES ($1::uuid,$2::uuid,$3::uuid,'CONFIRMED',3,$4::uuid,$4::uuid,now(),2,true)`,
            [sessionId, TENANT, rid, SCREENING_ACTOR],
          );
        } else {
          await db.query(
            `INSERT INTO technical_screening."ScreeningSession" (id, tenant_id, talent_record_id, state, version, created_by_actor_id) VALUES ($1::uuid,$2::uuid,$3::uuid,'DRAFT',1,$4::uuid)`,
            [sessionId, TENANT, rid, SCREENING_ACTOR],
          );
        }
        await db.query(
          `INSERT INTO technical_screening."ScreeningFinding" (id, tenant_id, session_id, skill_raw, basis, observation_raw) VALUES ($1::uuid,$2::uuid,$3::uuid,'Go','RECRUITER_OBSERVED','observed')`,
          [findingId, TENANT, sessionId],
        );
        await db.query(
          `INSERT INTO technical_screening."ScreeningEvent" (id, tenant_id, session_id, event_type, actor_id, session_version, payload) VALUES ($1::uuid,$2::uuid,$3::uuid,'SESSION_CREATED',$4,1,'{}'::jsonb)`,
          [uuidv7(), TENANT, sessionId, SCREENING_ACTOR],
        );
        if (confirmed) {
          await db.query(
            `INSERT INTO technical_screening."ScreeningEvidencePublication" (id, tenant_id, session_id, finding_id, evidence_record_id, talent_record_id_at_confirm, canonical_payload, payload_hash, collected_at, state, published_at)
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'{}'::jsonb,'h',now(),'PUBLISHED',now())`,
            [uuidv7(), TENANT, sessionId, findingId, EV, rid],
          );
        }
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

      // Scope: the husk chain is both records; the one linked sourced arrival.
      expect(report.scope.record_ids.sort()).toEqual([REC, HUSK].sort());
      expect(report.scope.sourced_talent_ids).toEqual([SOURCED]);

      // Every inventory step exists (migrations applied) → none 'failed'.
      expect(report.steps.every((s) => s.status === 'counted')).toBe(true);
      expect(report.steps.length).toBeGreaterThanOrEqual(30);

      const c = (t: string): number => report.steps.find((s) => s.table === t)!.count;
      expect(c('talent_record."TalentRecord"')).toBe(2); // live + husk
      expect(c('talent_evidence."TalentEducationEntry"')).toBe(2); // record + husk (the HALT-note holder, reached)
      expect(c('talent_embedding."TalentEmbedding"')).toBe(2); // GS-2A semantic index: record + husk, reached
      expect(c('consent."TalentConsentEvent"')).toBe(1);
      // TIP-E2E INC-3 — screening holders reached through the session, husk included.
      expect(c('technical_screening."ScreeningSession"')).toBe(2);
      expect(c('technical_screening."ScreeningFinding"')).toBe(2);
      expect(c('technical_screening."ScreeningEvent"')).toBe(2);
      expect(c('technical_screening."ScreeningEvidencePublication"')).toBe(1);
      // ATI-SEP-1 T10 WP4 — ATS-local sourcing holders.
      expect(c('sourced_talent."SourcedTalent"')).toBe(1);
      expect(c('ingestion."RawPayloadReference"')).toBe(1);
      expect(c('talent_record."talent_duplicate_advisory"')).toBe(1);
      expect(c('talent_record."talent_record_sourced_arrival"')).toBe(1);
      expect(report.steps.some((s) => s.table.startsWith('talent_trust.'))).toBe(false);

      // Audit is NOT in the delete inventory (retained).
      expect(report.retained).toContain('audit."ConsentAuditEvent"');
      expect(report.retained.some((t) => t.startsWith('talent_trust.'))).toBe(false);

      // ZERO writes: the row count is unchanged, nothing was deleted/appended.
      expect(await count('talent_record."TalentRecord"', 'true', [])).toBe(before);
      expect(await count('audit."ConsentAuditEvent"', `event_type='consent.erased'`, [])).toBe(0);
    });

    // ---- (d) the assembly: every element, read-only ------------------------
    it('(d) data-inventory assembles every element and writes NOTHING', async () => {
      const beforeRows = await count('sourced_talent."SourcedTalent"', 'true', []);
      const inv = await inventory.assemble(pg, TENANT, REC);

      expect(inv.scope.record_ids.sort()).toEqual([REC, HUSK].sort());
      expect(inv.scope.sourced_talent_ids).toEqual([SOURCED]);
      expect(inv.per_holder_counts.length).toBeGreaterThanOrEqual(30);
      expect(inv.consent_ledger.length).toBe(1);
      expect(inv.sourced_arrivals.length).toBe(1);
      expect(inv.raw_payload_refs.length).toBe(1);
      expect(inv.duplicate_advisories.length).toBe(1);
      expect(inv.is_anonymized).toBe(false); // not yet erased
      expect(inv.total_rows).toBeGreaterThan(0);

      // Read-only: unchanged.
      expect(await count('sourced_talent."SourcedTalent"', 'true', [])).toBe(beforeRows);
    });

    // ---- (c) the live erase: every holder emptied + audit retained + idempotent
    it('(c) live erase empties every holder incl. the husk, retains audit, appends the marker, flips is_anonymized', async () => {
      const report = await erasure.execute(pg, TENANT, REC, s3Delete);

      expect(report.mode).toBe('execute');
      // S2 — the truthful verdict: no blockers in this seed, the DB pass committed
      // and there are no artifacts → COMPLETED, marker appended, is_anonymized true.
      expect(report.outcome).toBe('COMPLETED');
      expect(report.blockers).toEqual([]);
      // S2 LOCKED §3.2 — the pass also redacts / tombstones retained history (never 'failed').
      expect(report.steps.filter((st) => !['deleted', 'redacted', 'tombstoned'].includes(st.status))).toEqual([]);
      expect(report.erasure_marker_appended).toBe(true);
      expect(report.is_anonymized_flipped).toBe(true);

      // Every seeded holder is emptied of this human — both keyspaces + the husk.
      expect(await count('talent_record."TalentRecord"', 'id = ANY($1::uuid[])', [[REC, HUSK]])).toBe(0);
      expect(await count('talent_evidence."TalentEducationEntry"', 'talent_id = ANY($1::uuid[])', [[REC, HUSK]])).toBe(0); // HALT-note holder reached, incl husk
      expect(await count('talent_embedding."TalentEmbedding"', 'talent_record_id = ANY($1::uuid[])', [[REC, HUSK]])).toBe(0); // GS-2A residue: zero embedding rows survive erase
      expect(await count('consent."TalentConsentEvent"', 'talent_record_id = $1::uuid', [REC])).toBe(0);
      expect(await count('sourced_talent."SourcedTalent"', 'id = $1::uuid', [SOURCED])).toBe(0);
      expect(await count('ingestion."RawPayloadReference"', 'sourced_talent_id = $1::uuid', [SOURCED])).toBe(0);
      expect(await count('talent_record."talent_record_sourced_arrival"', 'sourced_talent_id = $1::uuid', [SOURCED])).toBe(0);
      expect(await count('talent_record."talent_duplicate_advisory"', 'tenant_id = $1::uuid', [TENANT])).toBe(0);
      // The retired trust schemas do not exist (ATI-SEP-1 T10 WP5 drop migration).
      expect((await db.query(`SELECT to_regnamespace('talent_trust') AS n`)).rows[0].n).toBeNull();

      // TIP-E2E INC-3 (§13 rows 25/47) — zero screening residue; every screening step
      // reports 'deleted' (plain governed DELETEs; no trigger refused them).
      for (const t of ['ScreeningEvent', 'ScreeningEvidencePublication', 'ScreeningFinding', 'ScreeningSession']) {
        expect(await count(`technical_screening."${t}"`, 'tenant_id = $1::uuid', [TENANT])).toBe(0);
        expect(report.steps.find((st) => st.table === `technical_screening."${t}"`)?.status).toBe('deleted');
      }

      // S3 stub received the (zero, in this seed) blob keys — no doc/attachment seeded.
      expect(Array.isArray(s3Recorded)).toBe(true);

      // Audit RETAINED: the grant audit row stays; the erased marker is appended.
      expect(await count('audit."ConsentAuditEvent"', `subject_id=$1::uuid AND event_type='consent.grant.recorded'`, [REC])).toBe(1);
      expect(await count('audit."ConsentAuditEvent"', `subject_id=$1::uuid AND event_type='consent.erased'`, [REC])).toBe(1);

      // Idempotent second run: nothing left, marker not re-appended.
      const second = await erasure.execute(pg, TENANT, REC, s3Delete);
      expect(second.outcome).toBe('COMPLETED'); // idempotent: the recorded run is complete
      expect(second.total_rows).toBe(0);
      expect(second.erasure_marker_appended).toBe(false);
      expect(await count('audit."ConsentAuditEvent"', `subject_id=$1::uuid AND event_type='consent.erased'`, [REC])).toBe(1);
    });
  },
);
