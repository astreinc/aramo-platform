import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TalentErasureService, type ErasureObjectStore, type PgExec } from '../talent-identity/talent-erasure.service.js';

import { fakeSignErasure } from './helpers/fake-sign-erasure.js';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-2/R-5, §4 D-4 — the
// Sign boundary enforced by PostgreSQL itself, not only by code. Against real Postgres 17 with
// every repo migration applied, deploy/db-roles/aramo-domain-roles.sql is run as the migration
// owner, then:
//   (1) the ATS role is DENIED (42501) SELECT, INSERT, UPDATE and DELETE on EVERY Sign table;
//   (2) the Sign role can do all four on every Sign table, and cannot read an ATS table;
//   (3) the ATS role keeps full use of its own tables;
//   (4) the talent-erasure engine runs to COMPLETED as the ATS role, with no Sign privilege —
//       the documents trigger it fires no longer reads the Sign schema, and Sign is asked
//       through its contract instead;
//   (5) the script is idempotent and converges grants for a table a later migration adds;
//   (6) the platform operator role reaches Sign (by design) and the auth role does not;
//   (7) the engine ↔ Sign contract is fail-closed: Sign unreachable or reporting a holder
//       BLOCKS with nothing deleted; a holder appearing before COMMIT rolls the pass back;
//       a failed Sign erase leaves the run STORAGE_PENDING (no marker) until --resume.
// The production rollout of these roles is separately authorized (rollout plan).

const ROOT = resolve(__dirname, '../../../..');
const ROLES_SQL = readFileSync(resolve(ROOT, 'deploy/db-roles/aramo-domain-roles.sql'), 'utf8');

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

const TENANT = '01900000-0000-7000-8000-0000000059a1';
const OPERATOR_ROLE = ['aramo', 'erasure', 'operator'].join('_');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign domain roles — PostgreSQL-enforced boundary (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let owner: Client;
  const logins: Record<string, Client> = {};
  let signTables: Array<{ table: string; column: string }> = [];

  const login = async (name: string, group: string): Promise<Client> => {
    await owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} LOGIN PASSWORD '${name}'; END IF; END $$`);
    await owner.query(`GRANT ${group} TO ${name}`);
    const c = new Client({ host: container.getHost(), port: container.getPort(), database: container.getDatabase(), user: name, password: name });
    await c.connect();
    logins[name] = c;
    return c;
  };

  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'error';
    }
  };

  // Insert one row, filling every NOT NULL column without a default from its type.
  async function seed(table: string, overrides: Record<string, unknown>, via: Client): Promise<void> {
    const [schema, name] = table.replace(/"/g, '').split('.') as [string, string];
    const cols = await owner.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND is_nullable = 'NO' AND column_default IS NULL`,
      [schema, name],
    );
    const values: Record<string, unknown> = {};
    for (const c of cols.rows) {
      if (c.column_name in overrides) continue;
      if (c.data_type === 'uuid') values[c.column_name] = uuidv7();
      else if (c.data_type === 'boolean') values[c.column_name] = false;
      else if (['integer', 'bigint', 'smallint', 'numeric'].includes(c.data_type)) values[c.column_name] = 0;
      else if (c.data_type.startsWith('timestamp') || c.data_type === 'date') values[c.column_name] = new Date();
      else if (c.data_type === 'jsonb' || c.data_type === 'json') values[c.column_name] = '{}';
      else if (c.data_type === 'ARRAY') values[c.column_name] = '{}';
      else values[c.column_name] = 'x';
    }
    Object.assign(values, overrides);
    const keys = Object.keys(values);
    await via.query(
      `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((k) => values[k]),
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
    for (const p of allMigrations()) await owner.query(readFileSync(p, 'utf8'));
    await owner.query(ROLES_SQL);
    signTables = (
      await owner.query<{ table: string; column: string }>(
        `SELECT format('%I.%I', c.table_schema, c.table_name) AS table, min(c.column_name) AS column
           FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'sign' GROUP BY 1 ORDER BY 1`,
      )
    ).rows;
    await login('iso_ats', 'aramo_ats_rw');
    await login('iso_sign', 'aramo_sign_rw');
    await login('iso_auth', 'aramo_auth_rw');
    await login('iso_platform', 'aramo_platform_rw');
  }, 600_000);

  afterAll(async () => {
    for (const c of Object.values(logins)) await c.end().catch(() => undefined);
    await owner?.end();
    await container?.stop();
  }, 60_000);

  it('(1) the ATS role is denied SELECT, INSERT, UPDATE and DELETE on every Sign table', async () => {
    expect(signTables.length, 'the Sign schema must have tables (a vacuous proof is no proof)').toBeGreaterThan(20);
    const ats = logins['iso_ats']!;
    const allowed: string[] = [];
    for (const { table, column } of signTables) {
      const results = {
        select: await code(ats.query(`SELECT 1 FROM ${table} LIMIT 1`)),
        insert: await code(ats.query(`INSERT INTO ${table} DEFAULT VALUES`)),
        update: await code(ats.query(`UPDATE ${table} SET "${column}" = "${column}" WHERE false`)),
        delete: await code(ats.query(`DELETE FROM ${table} WHERE false`)),
      };
      for (const [op, c] of Object.entries(results)) if (c !== '42501') allowed.push(`${op} ${table} → ${c}`);
    }
    expect(allowed, 'every ATS operation on a Sign table must be refused by PostgreSQL (42501)').toEqual([]);
  });

  it('(2) the Sign role reads and writes every Sign table, and cannot read an ATS table', async () => {
    const sign = logins['iso_sign']!;
    const refused: string[] = [];
    for (const { table, column } of signTables) {
      for (const [op, sql] of [
        ['select', `SELECT 1 FROM ${table} LIMIT 1`],
        ['update', `UPDATE ${table} SET "${column}" = "${column}" WHERE false`],
        ['delete', `DELETE FROM ${table} WHERE false`],
      ] as const) {
        const c = await code(sign.query(sql));
        if (c !== 'ok') refused.push(`${op} ${table} → ${c}`);
      }
    }
    expect(refused).toEqual([]);
    // A real round trip on a Sign table (insert → read → delete).
    const id = uuidv7();
    await sign.query(`INSERT INTO sign."IdempotencyKey" (id, tenant_id, key, request_hash) VALUES ($1, $2, 'iso-key', 'h')`, [id, TENANT]);
    expect((await sign.query(`SELECT count(*)::int AS n FROM sign."IdempotencyKey" WHERE id = $1`, [id])).rows[0].n).toBe(1);
    await sign.query(`DELETE FROM sign."IdempotencyKey" WHERE id = $1`, [id]);
    expect(await code(sign.query(`SELECT 1 FROM talent_record."TalentRecord" LIMIT 1`))).toBe('42501');
  });

  it('(3) the ATS role keeps full use of its own tables', async () => {
    const ats = logins['iso_ats']!;
    const id = uuidv7();
    await seed('talent_record."TalentRecord"', { id, tenant_id: TENANT, first_name: 'Iso', last_name: 'Late' }, ats);
    expect((await ats.query(`SELECT count(*)::int AS n FROM talent_record."TalentRecord" WHERE id = $1`, [id])).rows[0].n).toBe(1);
    expect(await code(ats.query(`UPDATE talent_record."TalentRecord" SET first_name = 'Isa' WHERE id = $1`, [id]))).toBe('ok');
    expect(await code(ats.query(`SELECT 1 FROM documents."Document" LIMIT 1`))).toBe('ok');
    expect(await code(ats.query(`SELECT 1 FROM identity."Tenant" LIMIT 1`))).toBe('ok');
  });

  it('(4) the talent erasure runs to COMPLETED as the ATS role, with no Sign privilege', async () => {
    const ats = logins['iso_ats']!;
    // The operator membership the erase-talent runbook grants to the login that runs the CLI.
    await owner.query(`GRANT ${OPERATOR_ROLE} TO iso_ats`);
    const rec = uuidv7();
    await seed('talent_record."TalentRecord"', { id: rec, tenant_id: TENANT, first_name: 'Ada', last_name: 'Lovelace' }, ats);
    // A talent document with an event: deleting the event fires documents.reject_document_event_mutation,
    // which before this reconciliation read sign."EnvelopeDocument".
    const doc = uuidv7();
    await ats.query(
      `INSERT INTO documents."Document"(id,tenant_id,document_type_id,title,status,execution_mode,source_kind,created_by)
       SELECT $1,$2,id,'doc','DRAFT','NO_SIGNATURE','UPLOADED',$3 FROM documents."DocumentType" LIMIT 1`,
      [doc, TENANT, uuidv7()],
    );
    await ats.query(
      `INSERT INTO documents."DocumentAssociation"(id,tenant_id,document_id,resource_type,resource_id,relationship,created_by) VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5)`,
      [uuidv7(), TENANT, doc, rec, uuidv7()],
    );
    await ats.query(`INSERT INTO documents."DocumentEvent"(id,tenant_id,document_id,event_type,actor_type) VALUES ($1,$2,$3,'CREATED','USER')`, [uuidv7(), TENANT, doc]);

    const pg: PgExec = {
      async query<T>(sql: string, ps?: unknown[]) {
        const r = await ats.query(sql, ps as unknown[] | undefined);
        return { rows: r.rows as T[], rowCount: r.rowCount };
      },
    };
    const sign = fakeSignErasure();
    const store: ErasureObjectStore = { purge: async () => ({ remaining: 0 }) };
    const report = await new TalentErasureService(sign).execute(pg, TENANT, rec, store);
    expect([report.outcome, report.failure, report.blockers]).toEqual(['COMPLETED', undefined, []]);
    expect(report.sign.erased).toBe(true);
    // Sign was asked through its contract (preflight + the pre-COMMIT recheck), with the talent's document.
    expect(sign.preflights.length).toBe(2);
    expect(sign.preflights[0]!.document_refs).toEqual([doc]);
    expect(sign.erasures.map((e) => [e.tenant_id, e.record_ids])).toEqual([[TENANT, [rec]]]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM documents."DocumentEvent" WHERE document_id = $1`, [doc])).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT sign_erased_at IS NOT NULL AS ok FROM consent."TalentErasureRun" WHERE record_id = $1`, [rec])).rows[0].ok).toBe(true);
    await owner.query(`REVOKE ${OPERATOR_ROLE} FROM iso_ats`);
  });

  it('(4b) non-vacuous: with the PRE-reconciliation documents trigger restored, the same ATS-role erasure is refused by PostgreSQL', async () => {
    const ats = logins['iso_ats']!;
    const legacy = readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations/20261020130500_sign_naming_erasure_guard/migration.sql'), 'utf8');
    const current = readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations/20261030040000_sign_isolation_document_event_guard/migration.sql'), 'utf8');
    await owner.query(`GRANT ${OPERATOR_ROLE} TO iso_ats`);
    try {
      await owner.query(legacy);
      const rec = uuidv7();
      await seed('talent_record."TalentRecord"', { id: rec, tenant_id: TENANT, first_name: 'Bea', last_name: 'Legacy' }, ats);
      const doc = uuidv7();
      await ats.query(
        `INSERT INTO documents."Document"(id,tenant_id,document_type_id,title,status,execution_mode,source_kind,created_by)
         SELECT $1,$2,id,'doc','DRAFT','NO_SIGNATURE','UPLOADED',$3 FROM documents."DocumentType" LIMIT 1`,
        [doc, TENANT, uuidv7()],
      );
      await ats.query(
        `INSERT INTO documents."DocumentAssociation"(id,tenant_id,document_id,resource_type,resource_id,relationship,created_by) VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5)`,
        [uuidv7(), TENANT, doc, rec, uuidv7()],
      );
      await ats.query(`INSERT INTO documents."DocumentEvent"(id,tenant_id,document_id,event_type,actor_type) VALUES ($1,$2,$3,'CREATED','USER')`, [uuidv7(), TENANT, doc]);
      const pg: PgExec = {
        async query<T>(sql: string, ps?: unknown[]) {
          const r = await ats.query(sql, ps as unknown[] | undefined);
          return { rows: r.rows as T[], rowCount: r.rowCount };
        },
      };
      const report = await new TalentErasureService(fakeSignErasure()).execute(pg, TENANT, rec, { purge: async () => ({ remaining: 0 }) });
      expect(report.outcome).toBe('FAILED');
      expect(report.steps.find((st) => st.status === 'failed')?.error).toMatch(/permission denied for schema sign/);
      // Nothing was deleted: the whole pass rolled back.
      expect((await owner.query(`SELECT count(*)::int AS n FROM documents."DocumentEvent" WHERE document_id = $1`, [doc])).rows[0].n).toBe(1);
    } finally {
      await owner.query(current);
      await owner.query(`REVOKE ${OPERATOR_ROLE} FROM iso_ats`);
    }
  });

  it('(5) re-running the script is idempotent and converges a table added by a later migration', async () => {
    await owner.query(`CREATE TABLE sign."IsoLaterTable" (id uuid PRIMARY KEY)`);
    await owner.query(`CREATE TABLE talent_record."IsoLaterTable" (id uuid PRIMARY KEY)`);
    // Default privileges already cover tables the owner creates later …
    expect(await code(logins['iso_sign']!.query(`SELECT 1 FROM sign."IsoLaterTable"`))).toBe('ok');
    expect(await code(logins['iso_ats']!.query(`SELECT 1 FROM talent_record."IsoLaterTable"`))).toBe('ok');
    expect(await code(logins['iso_ats']!.query(`SELECT 1 FROM sign."IsoLaterTable"`))).toBe('42501');
    // … and a re-run converges and re-verifies without error.
    await owner.query(ROLES_SQL);
    await owner.query(ROLES_SQL);
    expect(await code(logins['iso_ats']!.query(`DELETE FROM sign."IsoLaterTable" WHERE false`))).toBe('42501');
    await owner.query(`DROP TABLE sign."IsoLaterTable"`);
    await owner.query(`DROP TABLE talent_record."IsoLaterTable"`);
  });

  it('(6) the platform operator role reaches Sign by design; the auth role does not', async () => {
    expect(await code(logins['iso_platform']!.query(`SELECT 1 FROM sign."AbuseReport" LIMIT 1`))).toBe('ok');
    expect(await code(logins['iso_auth']!.query(`SELECT 1 FROM sign."SignatureEnvelope" LIMIT 1`))).toBe('42501');
    expect(await code(logins['iso_auth']!.query(`SELECT 1 FROM auth_storage."RefreshToken" LIMIT 1`))).not.toBe('42501');
  });

  describe('(7) engine ↔ Sign contract (fail closed)', () => {
    const pgOwner = (): PgExec => ({
      async query<T>(sql: string, ps?: unknown[]) {
        const r = await owner.query(sql, ps as unknown[] | undefined);
        return { rows: r.rows as T[], rowCount: r.rowCount };
      },
    });
    const store: ErasureObjectStore = { purge: async () => ({ remaining: 0 }) };
    const talent = async (): Promise<string> => {
      const id = uuidv7();
      await seed('talent_record."TalentRecord"', { id, tenant_id: TENANT, first_name: 'Cy', last_name: 'Contract' }, owner);
      return id;
    };
    const present = async (id: string): Promise<number> => (await owner.query(`SELECT count(*)::int AS n FROM talent_record."TalentRecord" WHERE id = $1`, [id])).rows[0].n;
    const runs = async (id: string): Promise<number> => (await owner.query(`SELECT count(*)::int AS n FROM consent."TalentErasureRun" WHERE record_id = $1`, [id])).rows[0].n;
    const marker = async (id: string): Promise<number> =>
      (await owner.query(`SELECT count(*)::int AS n FROM audit."ConsentAuditEvent" WHERE subject_id = $1 AND event_type = 'consent.erased'`, [id])).rows[0].n;

    it('Sign unreachable → BLOCKED (PENDING_EXTERNAL); nothing deleted, no run', async () => {
      const rec = await talent();
      const sign = fakeSignErasure();
      sign.fail = 'connect ECONNREFUSED sign-service:3003';
      const dry = await new TalentErasureService(sign).dryRun(pgOwner(), TENANT, rec);
      expect(dry.blockers.map((b) => b.classification)).toEqual(['PENDING_EXTERNAL']);
      const r = await new TalentErasureService(sign).execute(pgOwner(), TENANT, rec, store);
      expect([r.outcome, r.blockers.map((b) => [b.holder, b.classification])]).toEqual(['BLOCKED', [['Aramo Sign (talent-erasure contract)', 'PENDING_EXTERNAL']]]);
      expect([await present(rec), await runs(rec)]).toEqual([1, 0]);
    });

    it('a Sign holder → BLOCKED with its classification and authority; nothing deleted', async () => {
      const rec = await talent();
      const sign = fakeSignErasure();
      sign.holders = [{ holder: 'sign."EnvelopeDocument"', classification: 'PENDING_PO_LEGAL', count: 1, reason: 'envelope over a talent document' }];
      const r = await new TalentErasureService(sign).execute(pgOwner(), TENANT, rec, store);
      expect(r.outcome).toBe('BLOCKED');
      expect(r.blockers).toEqual([
        { holder: 'Aramo Sign: sign."EnvelopeDocument"', classification: 'PENDING_PO_LEGAL', count: 1, reason: 'envelope over a talent document', authority: expect.stringContaining('PO/Legal') },
      ]);
      expect([await present(rec), await runs(rec), sign.erasures.length]).toEqual([1, 0, 0]);
    });

    it('a holder appearing before COMMIT (the recheck) rolls the whole pass back', async () => {
      const rec = await talent();
      const sign = fakeSignErasure();
      const first = sign.preflight.bind(sign);
      let calls = 0;
      sign.preflight = async (scope) => {
        calls += 1;
        const out = await first(scope);
        return calls === 1 ? out : { ...out, holders: [{ holder: 'sign."EnvelopeDocument"', classification: 'PENDING_PO_LEGAL', count: 1, reason: 'created meanwhile' }] };
      };
      const r = await new TalentErasureService(sign).execute(pgOwner(), TENANT, rec, store);
      expect([r.outcome, calls]).toEqual(['BLOCKED', 2]);
      expect(r.steps.every((st) => st.status === 'rolled_back' || st.status === 'failed')).toBe(true);
      expect([await present(rec), await runs(rec)]).toEqual([1, 0]);
    });

    it('Sign erase failing → STORAGE_PENDING (no marker); --resume once Sign answers → COMPLETED', async () => {
      const rec = await talent();
      const sign = fakeSignErasure();
      const realErase = sign.erase.bind(sign);
      sign.erase = async () => {
        throw new Error('HTTP 503');
      };
      const svc = new TalentErasureService(sign);
      const r = await svc.execute(pgOwner(), TENANT, rec, store);
      expect([r.outcome, r.sign.erased, r.erasure_marker_appended]).toEqual(['STORAGE_PENDING', false, false]);
      expect(r.failure).toMatch(/Aramo Sign has not yet confirmed its erasure \(HTTP 503\)/);
      expect([await present(rec), await marker(rec)]).toEqual([0, 0]);
      sign.erase = realErase;
      const resumed = await svc.resume(pgOwner(), TENANT, rec, store);
      expect([resumed.outcome, resumed.sign.erased, resumed.is_anonymized_flipped]).toEqual(['COMPLETED', true, true]);
      expect(await marker(rec)).toBe(1);
      // COMPLETED is terminal: another resume asks Sign nothing more.
      const before = sign.erasures.length;
      expect((await svc.resume(pgOwner(), TENANT, rec, store)).outcome).toBe('COMPLETED');
      expect(sign.erasures.length).toBe(before);
    });
  });
});
