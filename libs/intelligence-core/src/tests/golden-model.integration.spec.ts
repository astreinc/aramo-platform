import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GovIdTokenizer,
  IdentityMergeSplitService,
  IdentityResolutionService,
  IntelligencePrismaService,
  PrismaIntelligenceUnitOfWork,
  TalentIngestService,
} from '../index.js';

import { VERIFIED, snapshot } from './support/fixtures.js';

// ATI-SEP-1 T1–T3 on a real PostgreSQL 17 (own database aramo_intelligence):
// ingest idempotency (sequential + concurrent), the VERIFIED+ACTIVE partial
// unique index, immutability / append-only / no-delete triggers, the GOV_ID
// token-only CHECK, erasure → AUDIT_RETAINED, and a merge/split round trip whose
// re-point permission is transaction-local.

const MIGRATIONS = resolve(__dirname, '../../prisma/migrations');
const ATS = { client_id: 'ats', source_system_id: 'ARAMO_ATS' };

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(MIGRATIONS, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('intelligence Golden model — real database', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: IntelligencePrismaService;
  let ingest: TalentIngestService;
  let ms: IdentityMergeSplitService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).withDatabase('aramo_intelligence').start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const f of migrationFiles()) await db.query(readFileSync(f, 'utf8'));
    prisma = new IntelligencePrismaService(container.getConnectionUri());
    const uow = new PrismaIntelligenceUnitOfWork(prisma);
    ingest = new TalentIngestService(uow, new IdentityResolutionService(), GovIdTokenizer.withKey('g'.repeat(32)));
    ms = new IdentityMergeSplitService(uow);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
    Number((await db.query(`SELECT count(*)::int AS n FROM "intelligence"."${table}" WHERE ${where}`, params)).rows[0].n);

  it('ingest is idempotent per event — sequential replay and concurrent duplicates write once', async () => {
    const body = snapshot({ tenant: 'idem', talent: 'i-1' });
    const first = await ingest.ingest(body, ATS);
    const replay = await ingest.ingest(body, ATS);
    expect(replay).toEqual({ ...first, replayed: true });

    const dup = snapshot({ tenant: 'idem', talent: 'i-2' });
    const results = await Promise.all([ingest.ingest(dup, ATS), ingest.ingest(dup, ATS), ingest.ingest(dup, ATS)]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.intelligence_subject_id)).size).toBe(1);
    expect(await count('IntelligenceInbox', 'event_id = $1', [dup.source_event_id])).toBe(1);
    expect(await count('ExternalTalentReference', `source_tenant_id = 'idem' AND external_talent_id = 'i-2'`)).toBe(1);
  });

  it('two references with the same NEW verified email, concurrently → one subject, one VERIFIED binding', async () => {
    const email = [{ value: `race-${randomUUID()}@x.io`, is_primary: true, verification: { ...VERIFIED } }];
    const [a, b] = await Promise.all([
      ingest.ingest(snapshot({ tenant: 'race-a', identity: { emails: email } }), ATS),
      ingest.ingest(snapshot({ tenant: 'race-b', identity: { emails: email } }), ATS),
    ]);
    expect(a?.intelligence_subject_id).toBe(b?.intelligence_subject_id);
    expect(
      await count('SubjectIdentifier', `normalized_value = $1 AND verification_status = 'VERIFIED' AND status = 'ACTIVE'`, [
        email[0]!.value,
      ]),
    ).toBe(1);
  });

  it('Priya — verified email in another position links; verified phone + different name opens a conflict', async () => {
    const a = await ingest.ingest(
      snapshot({
        tenant: 'p-a',
        identity: {
          names: { first: 'Priya', last: 'Raman' },
          emails: [{ value: 'priya.it@example.com', is_primary: true, verification: { ...VERIFIED } }],
          phones: [{ value: '+1 555 777 0000', is_primary: true, verification: { ...VERIFIED, method: 'SMS_OTP' } }],
        },
      }),
      ATS,
    );
    const b = await ingest.ingest(
      snapshot({
        tenant: 'p-b',
        identity: {
          emails: [
            { value: 'work@corp.example', is_primary: true },
            { value: 'Priya.IT@example.com', is_primary: false, verification: { ...VERIFIED } },
          ],
        },
      }),
      ATS,
    );
    expect(b).toMatchObject({ resolution: 'VERIFIED_ANCHOR', intelligence_subject_id: a.intelligence_subject_id });
    const c = await ingest.ingest(
      snapshot({
        tenant: 'p-c',
        identity: { names: { first: 'Anita', last: 'Kumar' }, phones: [{ value: '5557770000', is_primary: true, verification: { ...VERIFIED, method: 'SMS_OTP' } }] },
      }),
      ATS,
    );
    expect(c.intelligence_subject_id).toBe(a.intelligence_subject_id);
    expect(await count('IdentityConflict', `subject_id = $1 AND conflict_type = 'IDENTITY_ATTRIBUTE_CONFLICT'`, [a.intelligence_subject_id])).toBe(1);
  });

  it('the partial unique index binds a VERIFIED+ACTIVE identifier to one row only', async () => {
    const s1 = randomUUID();
    const s2 = randomUUID();
    await db.query(`INSERT INTO "intelligence"."GoldenTalent" (id, updated_at) VALUES ($1, now()), ($2, now())`, [s1, s2]);
    const ins = (subject: string, verification: string, status = 'ACTIVE') =>
      db.query(
        `INSERT INTO "intelligence"."SubjectIdentifier" (id, subject_id, identifier_type, normalized_value, verification_status, status)
         VALUES ($1, $2, 'EMAIL', 'pui@x.io', $3, $4)`,
        [randomUUID(), subject, verification, status],
      );
    await ins(s1, 'VERIFIED');
    await expect(ins(s2, 'VERIFIED')).rejects.toThrow(/SubjectIdentifier_verified_active_unique/);
    await expect(ins(s1, 'VERIFIED')).rejects.toThrow(/SubjectIdentifier_verified_active_unique/);
    await ins(s2, 'UNVERIFIED');
    await ins(s2, 'UNVERIFIED');
    await ins(s2, 'VERIFIED', 'SUPERSEDED');
    expect(await count('SubjectIdentifier', `normalized_value = 'pui@x.io'`)).toBe(4);
  });

  it('GOV_ID rows accept a 64-hex token only, never a raw value', async () => {
    const s = randomUUID();
    await db.query(`INSERT INTO "intelligence"."GoldenTalent" (id, updated_at) VALUES ($1, now())`, [s]);
    await expect(
      db.query(
        `INSERT INTO "intelligence"."SubjectIdentifier" (id, subject_id, identifier_type, normalized_value) VALUES ($1, $2, 'GOV_ID', '123-45-6789')`,
        [randomUUID(), s],
      ),
    ).rejects.toThrow(/gov_id_token_only/);
  });

  it('Assertion content is immutable, status is mutable, subject_id needs a merge/split; logs are append-only; evidence is never deleted', async () => {
    const res = await ingest.ingest(snapshot({ tenant: 'trig' }), ATS);
    const { rows } = await db.query(`SELECT id FROM "intelligence"."Assertion" WHERE subject_id = $1 LIMIT 1`, [res.intelligence_subject_id]);
    const id = rows[0].id as string;
    const other = randomUUID();
    await db.query(`INSERT INTO "intelligence"."GoldenTalent" (id, updated_at) VALUES ($1, now())`, [other]);

    await expect(db.query(`UPDATE "intelligence"."Assertion" SET payload = '{"name":"x"}' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE "intelligence"."Assertion" SET content_hash = 'x' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE "intelligence"."Assertion" SET subject_id = $2 WHERE id = $1`, [id, other])).rejects.toThrow(/merge or split/);
    await db.query(`UPDATE "intelligence"."Assertion" SET current_status = 'DISPUTED' WHERE id = $1`, [id]);
    await expect(db.query(`UPDATE "intelligence"."Assertion" SET current_status = 'BOGUS' WHERE id = $1`, [id])).rejects.toThrow(/current_status_check/);

    await expect(db.query(`UPDATE "intelligence"."AssertionEvent" SET actor = 'x' WHERE assertion_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM "intelligence"."AssertionEvent" WHERE assertion_id = $1`, [id])).rejects.toThrow(/DELETE rejected/);
    await expect(db.query(`DELETE FROM "intelligence"."Assertion" WHERE id = $1`, [id])).rejects.toThrow(/DELETE rejected/);

    // re-pointing is allowed only inside a transaction that set intelligence.repoint, and only for that transaction
    await db.query('BEGIN');
    await db.query(`SELECT set_config('intelligence.repoint', 'on', true)`);
    await db.query(`UPDATE "intelligence"."Assertion" SET subject_id = $2 WHERE id = $1`, [id, other]);
    await db.query('ROLLBACK');
    await expect(db.query(`UPDATE "intelligence"."Assertion" SET subject_id = $2 WHERE id = $1`, [id, other])).rejects.toThrow(/merge or split/);
  });

  it('erasure → ERASED reference, AUDIT_RETAINED subject once no ACTIVE reference remains; evidence retained', async () => {
    const email = [{ value: `erase-${randomUUID()}@x.io`, is_primary: true, verification: { ...VERIFIED } }];
    const a = await ingest.ingest(snapshot({ tenant: 'er-a', identity: { emails: email } }), ATS);
    await ingest.ingest(snapshot({ tenant: 'er-b', identity: { emails: email } }), ATS);
    const before = await count('Assertion', 'subject_id = $1', [a.intelligence_subject_id]);
    const erase = (tenant: string) =>
      ingest.erase(
        { source_system_id: 'ARAMO_ATS', source_tenant_id: tenant, external_talent_id: 'talent-1', source_event_id: randomUUID(), occurred_at: '2026-10-25T00:00:00Z' },
        ATS,
      );
    expect((await erase('er-a')).subject_access_state).toBe('ACTIVE');
    expect((await erase('er-b')).subject_access_state).toBe('AUDIT_RETAINED');
    const s = await db.query(`SELECT access_state FROM "intelligence"."GoldenTalent" WHERE id = $1`, [a.intelligence_subject_id]);
    expect(s.rows[0].access_state).toBe('AUDIT_RETAINED');
    expect(await count('Assertion', 'subject_id = $1', [a.intelligence_subject_id])).toBe(before);
    expect(await count('ExternalTalentReference', `subject_id = $1 AND status = 'ERASED' AND erased_at IS NOT NULL`, [a.intelligence_subject_id])).toBe(2);
  });

  it('merge → split(restore) round-trips on the real database', async () => {
    const A = (await ingest.ingest(snapshot({ tenant: 'm-a', identity: { emails: [{ value: 'ma@x.io', is_primary: true }] } }), ATS)).intelligence_subject_id;
    const B = (await ingest.ingest(snapshot({ tenant: 'm-b', identity: { emails: [{ value: 'mb@x.io', is_primary: true }] } }), ATS)).intelligence_subject_id;
    const own = async () =>
      (
        await db.query(
          `SELECT 'a' AS k, id, subject_id FROM "intelligence"."Assertion" WHERE subject_id IN ($1, $2)
           UNION ALL SELECT 'r', id, subject_id FROM "intelligence"."ExternalTalentReference" WHERE subject_id IN ($1, $2)
           UNION ALL SELECT 'i', id, subject_id FROM "intelligence"."SubjectIdentifier" WHERE subject_id IN ($1, $2)
           ORDER BY 1, 2`,
          [A, B],
        )
      ).rows;
    const before = await own();
    const merge = await ms.merge(A, B, 'op', 'test');
    expect((await own()).every((r) => r.subject_id === B)).toBe(true);
    const status = await db.query(`SELECT resolution_status, merged_into_id FROM "intelligence"."GoldenTalent" WHERE id = $1`, [A]);
    expect(status.rows[0]).toEqual({ resolution_status: 'MERGED', merged_into_id: B });
    await ms.split(B, {}, 'op', 'undo', { restoreMergeEventId: merge.id });
    expect(await own()).toEqual(before);
    expect(await count('MergeSplitEvent', 'from_subject_id IN ($1, $2)', [A, B])).toBe(2);
    expect(await count('AssertionEvent', `event_type = 'REPOINTED'`)).toBeGreaterThan(0);
  });
});
