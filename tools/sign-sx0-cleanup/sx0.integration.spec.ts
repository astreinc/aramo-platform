// SX-0 on real Postgres 17 with every libs/sign migration applied (the same image and
// migration replay the libs/sign integration specs use). Gated like them:
//   ARAMO_RUN_INTEGRATION=1 npx vitest run --config tools/vitest.config.ts sign-sx0-cleanup
//
// Proves: the standalone selection, the frozen manifest, the dry-run rollback, the
// execute path (only the standalone tree goes; ATS-linked, other tenants and user-level
// data stay; the append-only trigger is back on), every refusal (no authorization,
// manifest drift, SX-1 already applied, tenant mismatch), and the S3 version step
// against a mock S3 (exact pairs, retained keys excluded, out-of-prefix refused).

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from './sx0.js';
import { type FixtureEnvelope, seedEnvelope, seedIntegration, seedUserLevel } from './sx0.fixture.js';
import {
  APPEND_ONLY_TRIGGER,
  EXECUTION_ENV,
  KEPT_TABLES,
  type Manifest,
  type Queryable,
  S3_EXECUTION_ENV,
  type S3Manifest,
  type S3Port,
  Sx0Refusal,
  appendOnlyTriggerState,
  assertExecutionAuthorized,
  assertS3ExecutionAuthorized,
  assertS3KeysUnreferenced,
  buildInventory,
  buildS3Inventory,
  digest,
  executeS3Deletes,
  makeManifest,
  runWipe,
  signTableTotals,
} from './sx0.lib.js';

// Same image as @aramo/common ARAMO_POSTGRES_TEST_IMAGE (tools specs take no @aramo aliases).
const PG_IMAGE = 'pgvector/pgvector:pg17';
const ROOT = resolve(__dirname, '../..');
const T = 120_000;

// SX-0 runs BEFORE the SX-1/SX-2 migrations (directive deployment order), so the
// schema under test stops short of them — production's state at wipe time.
const FIRST_POST_SX0_MIGRATION = '20261031100000';

function signMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n) && n < FIRST_POST_SX0_MIGRATION)
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

async function refusal(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    if (typeof p === 'function') p();
    else await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Sx0Refusal);
    expect((e as Sx0Refusal).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
}

class MockS3 implements S3Port {
  objects: Array<{ Key: string; VersionId: string; marker: boolean }> = [];
  deleteCalls: Array<Array<{ Key: string; VersionId: string }>> = [];
  async listObjectVersions(input: { Bucket: string; Prefix: string; KeyMarker?: string }) {
    // Two pages, to prove pagination is followed.
    const all = this.objects.filter((o) => o.Key.startsWith(input.Prefix));
    const half = Math.ceil(all.length / 2);
    const page = input.KeyMarker === undefined ? all.slice(0, half) : all.slice(half);
    const out = {
      Versions: page.filter((o) => !o.marker).map((o) => ({ Key: o.Key, VersionId: o.VersionId, IsLatest: false, Size: 10, LastModified: new Date('2026-10-01T00:00:00Z') })),
      DeleteMarkers: page.filter((o) => o.marker).map((o) => ({ Key: o.Key, VersionId: o.VersionId, IsLatest: true, LastModified: new Date('2026-10-02T00:00:00Z') })),
      IsTruncated: input.KeyMarker === undefined && all.length > half,
      NextKeyMarker: 'page2',
      NextVersionIdMarker: 'v',
    };
    return out;
  }
  async deleteObjects(input: { Bucket: string; Delete: { Objects: Array<{ Key: string; VersionId: string }> } }) {
    this.deleteCalls.push(input.Delete.Objects);
    this.objects = this.objects.filter((o) => !input.Delete.Objects.some((d) => d.Key === o.Key && d.VersionId === o.VersionId));
    return { Deleted: input.Delete.Objects.map((o) => ({ Key: o.Key, VersionId: o.VersionId })) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('SX-0 standalone Sign clean start — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  const qdb = (): Queryable => db as unknown as Queryable;

  const TENANT = randomUUID();
  const OTHER = randomUUID();
  const USER = randomUUID();
  const standalone: FixtureEnvelope[] = [];
  const ats: FixtureEnvelope[] = [];
  let otherStandalone: FixtureEnvelope;
  let manifest: Manifest;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(PG_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const m of signMigrations()) await db.query(readFileSync(m, 'utf8'));
    // The billing tables the report reads (shape-only stand-ins; the tool never writes them).
    await db.query(`CREATE SCHEMA subscription`);
    await db.query(`CREATE TABLE subscription."AllowanceUsage" (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, allowance_key text NOT NULL, send_key text NOT NULL)`);
    await db.query(`CREATE TABLE subscription."CapacityUsage" (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, capacity_key text NOT NULL, ref text NOT NULL, quantity bigint NOT NULL, state text NOT NULL DEFAULT 'ACTIVE')`);

    const integration = await seedIntegration(qdb(), TENANT);
    const device = await seedUserLevel(qdb(), TENANT, USER);
    await seedUserLevel(qdb(), OTHER, USER);
    // Standalone in every production status (F-5): COMPLETED, SENT, VOIDED, deleted DRAFT, plus a live DRAFT.
    for (const status of ['COMPLETED', 'COMPLETED', 'SENT', 'VOIDED', 'DRAFT'] as const) {
      standalone.push(await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status, integration, pushDevice: device }));
    }
    standalone.push(await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status: 'DRAFT', deletedDraft: true }));
    standalone.push(await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status: 'DRAFT', deletedDraft: true }));
    // ATS-linked (F-6): COMPLETED with executed rows, SENT, DECLINED; one also has an OWNED doc.
    ats.push(await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status: 'COMPLETED', ats: true, ownedDocument: true, integration, pushDevice: device }));
    ats.push(await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status: 'COMPLETED', ats: true }));
    ats.push(await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status: 'SENT', ats: true }));
    ats.push(await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status: 'DECLINED', ats: true }));
    // Another tenant's standalone envelope: outside the --tenant scope, so kept.
    otherStandalone = await seedEnvelope(qdb(), { tenant: OTHER, user: USER, status: 'COMPLETED' });

    const c = standalone[0] as FixtureEnvelope;
    await db.query(`INSERT INTO subscription."AllowanceUsage" VALUES ($1, $2, 'sign.envelopes', $3)`, [randomUUID(), TENANT, `aramo-sign:envelope:${c.id}`]);
    await db.query(`INSERT INTO subscription."CapacityUsage" (id, tenant_id, capacity_key, ref, quantity) VALUES ($1, $2, 'sign.storage', $3, 3)`, [randomUUID(), TENANT, `esign:executed:${c.executedIds[0]}`]);
    await db.query(`INSERT INTO subscription."CapacityUsage" (id, tenant_id, capacity_key, ref, quantity) VALUES ($1, $2, 'sign.storage', $3, 100)`, [randomUUID(), TENANT, `sign:object:${c.keys[0]}`]);
  }, T);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('inventory selects exactly the tenant\'s standalone envelopes, in every status, and freezes a stable digest', async () => {
    const inv = await buildInventory(qdb(), TENANT);
    expect(inv.body.envelopes.map((e) => e.id)).toEqual(standalone.map((e) => e.id).sort());
    expect(inv.body.envelope_status_counts).toEqual({ COMPLETED: 2, DRAFT: 3, SENT: 1, VOIDED: 1 });
    expect(inv.body.envelopes.filter((e) => e.deleted)).toHaveLength(2);
    const counts = Object.fromEntries(inv.body.delete_counts.map((d) => [d.table, d.rows]));
    expect(counts).toEqual({
      SignPushJob: 4, SignUserNotification: 4, SignNotificationOutbox: 4, SignWebhookDelivery: 4, NotificationDelivery: 4,
      OutboxEvent: 4, SignIdempotencyKey: 4, IdempotencyKey: 4, SignAccessToken: 4, ExecutedAccessGrant: 2,
      ExecutedDocument: 2, ExecutionCertificate: 2, AbuseReport: 4, SignRecipientBinding: 4, SignerDisclosureAcceptance: 4,
      SigningSession: 4, SignEnvelopeDocumentPages: 5, SignatureField: 5, EnvelopeDocument: 5, Signer: 5,
      // ENVELOPE_CREATED for all 7; +ENVELOPE_SENT for the 4 sent; +ENVELOPE_COMPLETED for the 2 completed.
      SignatureEvent: 13, SignatureEnvelope: 7,
    });
    expect(inv.body.executed_documents.map((d) => d.id).sort()).toEqual(standalone.flatMap((e) => e.executedIds).sort());
    expect(inv.body.execution_certificates).toHaveLength(2);
    expect(inv.body.source_object_keys).toEqual(standalone.flatMap((e) => e.keys).sort());
    expect(inv.body.retained_ats_linked.envelope_count).toBe(4);
    expect(inv.body.retained_ats_linked.executed_document_count).toBe(2);
    expect(inv.body.retained_ats_linked.certificate_count).toBe(2);
    expect(inv.report.out_of_scope_references).toMatchObject({
      'subscription.AllowanceUsage(send_key=aramo-sign:envelope:<id>)': 1,
      'subscription.CapacityUsage(ref=esign:executed|esign:certificate|sign:object)': 2,
      'subscription.CapacityUsage ACTIVE bytes for those refs': '103',
      'signature_routing.SignatureRequestRoute': 'table not present',
    });
    const again = await buildInventory(qdb(), TENANT);
    expect(digest(again.body)).toBe(digest(inv.body));
    // Without a tenant filter the other tenant's standalone envelope is selected too.
    const all = await buildInventory(qdb(), null);
    expect(all.body.envelopes.map((e) => e.id)).toContain(otherStandalone.id);
    manifest = makeManifest(inv.body, inv.report);
  });

  it('the command line writes the same frozen manifest (read-only transaction) and dry-runs against it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sx0-'));
    const saved = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = container.getConnectionUri();
    try {
      expect(await main(['inventory', '--tenant', TENANT, '--out', resolve(dir, 'm.json')])).toBe(0);
      const file = JSON.parse(readFileSync(resolve(dir, 'm.json'), 'utf8')) as Manifest;
      expect(file.manifest_sha256).toBe(manifest.manifest_sha256);
      expect(await main(['dry-run', '--tenant', TENANT, '--manifest', resolve(dir, 'm.json'), '--out', resolve(dir, 'd.json')])).toBe(0);
      // execute without the authorization env is refused before any connection is made.
      await expect(main(['execute', '--manifest', resolve(dir, 'm.json'), '--manifest-sha256', file.manifest_sha256, '--confirm-tenant', TENANT])).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    } finally {
      if (saved === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
    expect((await buildInventory(qdb(), TENANT)).body.envelopes).toHaveLength(7);
  }, T);

  it('dry-run deletes the whole tree inside the transaction, then rolls back: nothing changes and the trigger is on', async () => {
    const before = await signTableTotals(qdb());
    const r = await runWipe(qdb(), { mode: 'dry-run', tenant: TENANT, manifest });
    expect(r.committed).toBe(false);
    expect(r.deleted).toEqual(manifest.body.delete_counts);
    expect(r.after_in_transaction.standalone_envelopes).toBe(0);
    expect(r.after_close.standalone_envelopes).toBe(7);
    expect(await signTableTotals(qdb())).toEqual(before);
    expect(await appendOnlyTriggerState(qdb())).toBe('O');
  }, T);

  it('execute is refused without the authorization env, with a wrong SHA, a tampered body or an unconfirmed tenant', async () => {
    const sha = manifest.manifest_sha256;
    await refusal(() => assertExecutionAuthorized({ manifest, manifestSha256: sha, confirmTenant: TENANT, env: {} }), 'NOT_AUTHORIZED');
    await refusal(() => assertExecutionAuthorized({ manifest, manifestSha256: sha, confirmTenant: TENANT, env: { [EXECUTION_ENV]: 'f'.repeat(64) } }), 'NOT_AUTHORIZED');
    await refusal(() => assertExecutionAuthorized({ manifest, manifestSha256: 'a'.repeat(64), confirmTenant: TENANT, env: { [EXECUTION_ENV]: sha } }), 'MANIFEST_SHA_MISMATCH');
    await refusal(() => assertExecutionAuthorized({ manifest, manifestSha256: sha, confirmTenant: OTHER, env: { [EXECUTION_ENV]: sha } }), 'TENANT_UNCONFIRMED');
    const tampered: Manifest = JSON.parse(JSON.stringify(manifest));
    tampered.body.envelopes.pop();
    await refusal(() => assertExecutionAuthorized({ manifest: tampered, manifestSha256: sha, confirmTenant: TENANT, env: { [EXECUTION_ENV]: sha } }), 'BAD_MANIFEST');
    const untenanted = makeManifest({ ...manifest.body, tenant_filter: null }, manifest.report);
    await refusal(
      () => assertExecutionAuthorized({ manifest: untenanted, manifestSha256: untenanted.manifest_sha256, confirmTenant: TENANT, env: { [EXECUTION_ENV]: untenanted.manifest_sha256 } }),
      'TENANT_UNCONFIRMED',
    );
    expect(() => assertExecutionAuthorized({ manifest, manifestSha256: sha, confirmTenant: TENANT, env: { [EXECUTION_ENV]: sha } })).not.toThrow();
  });

  it('execute refuses on manifest drift (frozen inventory) and changes nothing', async () => {
    const before = await signTableTotals(qdb());
    // A new standalone draft (no ledger events, so it can be removed again afterwards).
    const extra = await seedEnvelope(qdb(), { tenant: TENANT, user: USER, status: 'DRAFT', withEvents: false });
    await refusal(runWipe(qdb(), { mode: 'execute', tenant: TENANT, manifest }), 'INVENTORY_DRIFT');
    await db.query(`DELETE FROM "sign"."SignatureField" WHERE envelope_document_id = ANY($1::uuid[])`, [extra.docIds]);
    await db.query(`DELETE FROM "sign"."SignatureEnvelope" WHERE id = $1`, [extra.id]);
    expect(await signTableTotals(qdb())).toEqual(before);
    expect(await appendOnlyTriggerState(qdb())).toBe('O');
  }, T);

  it('execute (and dry-run) refuse when the SX-1 executed-artifact immutability trigger exists', async () => {
    await db.query(`CREATE FUNCTION "sign".sx1_stub() RETURNS trigger AS $$ BEGIN RETURN OLD; END; $$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER sign_executed_artifact_immutability BEFORE DELETE ON "sign"."ExecutedDocument" FOR EACH ROW EXECUTE FUNCTION "sign".sx1_stub()`);
    try {
      await refusal(runWipe(qdb(), { mode: 'execute', tenant: TENANT, manifest }), 'SX1_ALREADY_APPLIED');
      await refusal(runWipe(qdb(), { mode: 'dry-run', tenant: TENANT }), 'SX1_ALREADY_APPLIED');
    } finally {
      await db.query(`DROP TRIGGER sign_executed_artifact_immutability ON "sign"."ExecutedDocument"`);
      await db.query(`DROP FUNCTION "sign".sx1_stub()`);
    }
    // The ledger row alone (migration applied by db-sync) is also refused.
    await db.query(`CREATE TABLE public._local_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`INSERT INTO public._local_migrations(name) VALUES ('libs/sign/prisma/migrations/20261031100100_sign_executed_artifact_immutability')`);
    try {
      await refusal(runWipe(qdb(), { mode: 'execute', tenant: TENANT, manifest }), 'SX1_ALREADY_APPLIED');
    } finally {
      await db.query(`DROP TABLE public._local_migrations`);
    }
  }, T);

  let s3: MockS3;
  let s3Manifest: S3Manifest;
  const BUCKET = 'aramo-test-bucket';

  it('s3-inventory lists exact versions + delete markers of standalone and orphan keys, never a retained key', async () => {
    s3 = new MockS3();
    const refKey = (standalone[0] as FixtureEnvelope).keys[0] as string;
    const atsOwnedKey = (ats[0] as FixtureEnvelope).keys[0] as string;
    const deletedDraft = standalone[5] as FixtureEnvelope;
    const orphanUnderStandalone = `esign/source/${TENANT}/${deletedDraft.id}/${randomUUID()}`;
    const orphanNoEnvelope = `esign/source/${TENANT}/${randomUUID()}/${randomUUID()}`;
    const unreferencedUnderAts = `esign/source/${TENANT}/${(ats[1] as FixtureEnvelope).id}/${randomUUID()}`;
    const otherTenantKey = otherStandalone.keys[0] as string;
    s3.objects = [
      { Key: refKey, VersionId: 'v1', marker: false },
      { Key: refKey, VersionId: 'v2', marker: false },
      { Key: refKey, VersionId: 'dm1', marker: true },
      { Key: orphanUnderStandalone, VersionId: 'v1', marker: false },
      { Key: orphanNoEnvelope, VersionId: 'v1', marker: false },
      { Key: atsOwnedKey, VersionId: 'v1', marker: false },
      { Key: unreferencedUnderAts, VersionId: 'v1', marker: false },
      { Key: otherTenantKey, VersionId: 'v1', marker: false },
      { Key: `documents/${TENANT}/executed.pdf`, VersionId: 'v1', marker: false },
    ];
    s3Manifest = await buildS3Inventory(qdb(), s3, manifest, BUCKET);
    const pairs = s3Manifest.body.versions.map((v) => `${v.key}@${v.version_id}:${v.classification}`).sort();
    expect(pairs).toEqual(
      [
        `${refKey}@v1:STANDALONE_REFERENCED`,
        `${refKey}@v2:STANDALONE_REFERENCED`,
        `${refKey}@dm1:STANDALONE_REFERENCED`,
        `${orphanUnderStandalone}@v1:ORPHAN_OF_STANDALONE_ENVELOPE`,
        `${orphanNoEnvelope}@v1:ORPHAN_NO_ENVELOPE`,
      ].sort(),
    );
    expect(s3Manifest.body.version_count).toBe(4);
    expect(s3Manifest.body.delete_marker_count).toBe(1);
    expect(s3Manifest.body.excluded_retained_keys).toEqual([atsOwnedKey, unreferencedUnderAts].sort());
    expect(s3Manifest.body.prefix).toBe(`esign/source/${TENANT}/`);
    expect(s3Manifest.body.db_manifest_sha256).toBe(manifest.manifest_sha256);
  });

  it('s3-execute is refused before the DB wipe (keys still referenced)', async () => {
    await refusal(assertS3KeysUnreferenced(qdb(), s3Manifest), 'KEY_STILL_REFERENCED');
  });

  it('execute deletes only the standalone tree: ATS-linked, other-tenant and user-level data are kept; the trigger is back on', async () => {
    const sha = manifest.manifest_sha256;
    assertExecutionAuthorized({ manifest, manifestSha256: sha, confirmTenant: TENANT, env: { [EXECUTION_ENV]: sha } });
    const before = await signTableTotals(qdb());
    const r = await runWipe(qdb(), { mode: 'execute', tenant: TENANT, manifest });
    expect(r.committed).toBe(true);
    expect(r.manifest_sha256).toBe(sha);
    expect(r.deleted).toEqual(manifest.body.delete_counts);
    expect(r.after_close.standalone_envelopes).toBe(0);
    expect(r.after_close.ats_linked).toEqual(manifest.body.retained_ats_linked);

    const after = await signTableTotals(qdb());
    for (const t of KEPT_TABLES) expect(after[t], t).toBe(before[t]);
    const left = await db.query(`SELECT id::text AS id FROM "sign"."SignatureEnvelope" ORDER BY id`);
    expect(left.rows.map((x) => x['id'])).toEqual([...ats.map((e) => e.id), otherStandalone.id].sort());
    const exe = await db.query(`SELECT count(*)::int AS n FROM "sign"."ExecutedDocument"`);
    expect(exe.rows[0]?.['n']).toBe(3); // 2 ATS-linked + 1 other tenant
    const atsEvents = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE envelope_id = ANY($1::uuid[])`, [ats.map((e) => e.id)]);
    expect(atsEvents.rows[0]?.['n']).toBe(2 * 3 + 2 + 2);
    // ATS push job + notification and the access token survive; their devices too.
    const jobs = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignPushJob"`);
    expect(jobs.rows[0]?.['n']).toBe(1);

    expect(await appendOnlyTriggerState(qdb())).toBe('O');
    await expect(db.query(`DELETE FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [(ats[0] as FixtureEnvelope).id])).rejects.toThrow(/append-only/);
    // Billing / capacity records are reported, never changed.
    const usage = await db.query(`SELECT (SELECT count(*) FROM subscription."AllowanceUsage")::int AS a, (SELECT count(*) FROM subscription."CapacityUsage")::int AS c`);
    expect(usage.rows[0]).toEqual({ a: 1, c: 2 });
    // Re-running against the same manifest is drift (the inventory is now empty).
    await refusal(runWipe(qdb(), { mode: 'execute', tenant: TENANT, manifest }), 'INVENTORY_DRIFT');
  }, T);

  it('s3-execute deletes exactly the manifest key+versionId pairs after the DB wipe, and refuses out-of-prefix keys', async () => {
    const sha = s3Manifest.s3_manifest_sha256;
    const env = { [S3_EXECUTION_ENV]: sha };
    await refusal(() => assertS3ExecutionAuthorized({ manifest: s3Manifest, manifestSha256: sha, bucket: BUCKET, env: {} }), 'NOT_AUTHORIZED');
    await refusal(() => assertS3ExecutionAuthorized({ manifest: s3Manifest, manifestSha256: sha, bucket: 'other-bucket', env }), 'BAD_ARGUMENT');

    const evil: S3Manifest = JSON.parse(JSON.stringify(s3Manifest));
    evil.body.versions.push({ key: `documents/${TENANT}/executed.pdf`, version_id: 'v1', is_delete_marker: false, is_latest: true, size: 1, last_modified: null, classification: 'ORPHAN_NO_ENVELOPE' });
    evil.s3_manifest_sha256 = digest(evil.body);
    await refusal(() => assertS3ExecutionAuthorized({ manifest: evil, manifestSha256: evil.s3_manifest_sha256, bucket: BUCKET, env: { [S3_EXECUTION_ENV]: evil.s3_manifest_sha256 } }), 'OUT_OF_PREFIX');
    await refusal(executeS3Deletes(s3, evil), 'OUT_OF_PREFIX');
    expect(s3.deleteCalls).toHaveLength(0);

    assertS3ExecutionAuthorized({ manifest: s3Manifest, manifestSha256: sha, bucket: BUCKET, env });
    await assertS3KeysUnreferenced(qdb(), s3Manifest);
    const r = await executeS3Deletes(s3, s3Manifest);
    expect(r.errors).toEqual([]);
    expect(r.deleted).toHaveLength(5);
    expect(s3.deleteCalls.flat().map((o) => `${o.Key}@${o.VersionId}`).sort()).toEqual(s3Manifest.body.versions.map((v) => `${v.key}@${v.version_id}`).sort());
    // What is left: the ATS-linked keys, the other tenant's key, and the documents/ object.
    expect(s3.objects.map((o) => o.Key).sort()).toEqual(
      [...s3Manifest.body.excluded_retained_keys, otherStandalone.keys[0] as string, `documents/${TENANT}/executed.pdf`].sort(),
    );
    expect(APPEND_ONLY_TRIGGER).toBe('signature_event_append_only');
  });
});
