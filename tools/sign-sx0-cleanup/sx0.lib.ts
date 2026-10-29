// SX-0 — one-off clean start of STANDALONE Aramo Sign data.
//
// Governing: Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED,
// section SX-0 and Lead Clarification LC-2. This is an operations tool, NOT a
// migration: it never runs in any environment by itself. LC-2 authorizes the
// implementation, the read-only inventory, the dry-run and the validation tests.
// Production execution of `execute` / `s3-execute` is NOT authorized by that
// directive and needs its own written PO authorization naming the manifest SHA-256.
//
// Selection: a standalone envelope is an envelope with NO sign."EnvelopeDocument"
// row whose document_ref is set. Any envelope with such a row is ATS-linked and is
// kept, with every row and stored object under it.
//
// Pure where possible: every database call goes through `Queryable` (a pg Client)
// and every S3 call through `S3Port`, so the specs drive both with real Postgres
// and a mock S3.

import { createHash } from 'node:crypto';

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export const MANIFEST_KIND = 'aramo.sign.sx0.manifest';
export const S3_MANIFEST_KIND = 'aramo.sign.sx0.s3-manifest';
export const S3_SOURCE_PREFIX = 'esign/source/';
export const APPEND_ONLY_TRIGGER = 'signature_event_append_only';
export const SX1_IMMUTABILITY_MIGRATION = '20261031100100_sign_executed_artifact_immutability';
export const EXECUTION_ENV = 'SX0_EXECUTION_AUTHORIZED';
export const S3_EXECUTION_ENV = 'SX0_S3_EXECUTION_AUTHORIZED';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class Sx0Refusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'Sx0Refusal';
  }
}

// ── Canonical JSON + digest ─────────────────────────────────────────────────

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digest(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

// ── The envelope tree, in FK-safe deletion order ────────────────────────────
//
// Each step's predicate depends only on tables deleted LATER, so counting every
// step before any delete and deleting in this order give identical numbers.
// $1 is the standalone envelope id list (text[]; cast to uuid[] where compared to uuid).

export interface TreeStep {
  table: string;
  where: string;
}

const ENV_UUID = `envelope_id = ANY($1::uuid[])`;
const DOCS = `SELECT d.id FROM "sign"."EnvelopeDocument" d WHERE d.envelope_id = ANY($1::uuid[])`;

export const TREE_STEPS: readonly TreeStep[] = [
  { table: 'SignPushJob', where: `notification_id IN (SELECT n.id FROM "sign"."SignUserNotification" n WHERE n.envelope_id = ANY($1::uuid[]))` },
  { table: 'SignUserNotification', where: ENV_UUID },
  { table: 'SignNotificationOutbox', where: ENV_UUID },
  { table: 'SignWebhookDelivery', where: ENV_UUID },
  { table: 'NotificationDelivery', where: ENV_UUID },
  { table: 'OutboxEvent', where: `(event_payload->>'envelope_id') = ANY($1::text[])` },
  // Sender-operation idempotency is scoped "upload:<envelope_id>" / "remind:<envelope_id>".
  { table: 'SignIdempotencyKey', where: `split_part(operation, ':', 2) = ANY($1::text[])` },
  // Legacy schema-local idempotency: no envelope column; a stored response naming the envelope.
  { table: 'IdempotencyKey', where: `response_body IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS x(id) WHERE response_body::text LIKE '%' || x.id || '%')` },
  // EVENT_ARTIFACT grants read ONE envelope's artifacts; STANDARD tokens carry no envelope.
  { table: 'SignAccessToken', where: ENV_UUID },
  { table: 'ExecutedAccessGrant', where: ENV_UUID },
  { table: 'ExecutedDocument', where: ENV_UUID },
  { table: 'ExecutionCertificate', where: ENV_UUID },
  { table: 'AbuseReport', where: ENV_UUID },
  { table: 'SignRecipientBinding', where: ENV_UUID },
  { table: 'SignerDisclosureAcceptance', where: `signer_id IN (SELECT s.id FROM "sign"."Signer" s WHERE s.envelope_id = ANY($1::uuid[]))` },
  { table: 'SigningSession', where: ENV_UUID },
  { table: 'SignEnvelopeDocumentPages', where: `envelope_document_id IN (${DOCS})` },
  { table: 'SignatureField', where: `envelope_document_id IN (${DOCS})` },
  { table: 'EnvelopeDocument', where: ENV_UUID },
  { table: 'Signer', where: ENV_UUID },
  // Append-only ledger: deleted only while signature_event_append_only is disabled.
  { table: 'SignatureEvent', where: ENV_UUID },
  { table: 'SignatureEnvelope', where: `id = ANY($1::uuid[])` },
];

// User-level Sign data and tenant-level configuration the PO ruling keeps (never touched).
export const KEPT_TABLES: readonly string[] = [
  'SignSavedSignature',
  'SignContact',
  'SignNotificationPreference',
  'SignPushDevice',
  'SignConvenienceDataPurge',
  'SignConvenienceDeletionRequest',
  'SignRetentionSweep',
  'SignApplication',
  'SignInstallation',
  'SignCredential',
  'SignRoleMapping',
  'SignWebhookSubscription',
];

const q = (table: string): string => `"sign"."${table}"`;

// ── Inventory ──────────────────────────────────────────────────────────────

export interface ManifestEnvelope {
  id: string;
  tenant_id: string;
  status: string;
  deleted: boolean;
  source_application: string;
}

export interface ManifestBody {
  kind: typeof MANIFEST_KIND;
  version: 1;
  tenant_filter: string | null;
  selection: string;
  envelopes: ManifestEnvelope[];
  envelope_status_counts: Record<string, number>;
  delete_counts: Array<{ table: string; rows: number }>;
  executed_documents: Array<{ id: string; envelope_id: string; envelope_document_id: string; source_sha256: string; executed_sha256: string; byte_size: number }>;
  execution_certificates: Array<{ id: string; envelope_id: string; certificate_sha256: string; byte_size: number }>;
  source_object_keys: string[];
  retained_ats_linked: AtsLinkedSnapshot;
}

export interface AtsLinkedSnapshot {
  envelope_count: number;
  envelope_ids_sha256: string;
  status_counts: Record<string, number>;
  executed_document_count: number;
  executed_sha256_digest: string;
  certificate_count: number;
  certificate_sha256_digest: string;
}

export interface Manifest {
  manifest_sha256: string;
  generated_at: string;
  body: ManifestBody;
  // Informational, NOT part of the frozen digest (it moves with unrelated traffic).
  report: InventoryReport;
}

export interface InventoryReport {
  kept_table_totals: Record<string, number>;
  out_of_scope_references: Record<string, number | string>;
}

export const SELECTION_SQL = `NOT EXISTS (SELECT 1 FROM "sign"."EnvelopeDocument" d WHERE d.envelope_id = e.id AND d.document_ref IS NOT NULL)`;
const ATS_LINKED_SQL = `EXISTS (SELECT 1 FROM "sign"."EnvelopeDocument" d WHERE d.envelope_id = e.id AND d.document_ref IS NOT NULL)`;

export function assertUuid(value: string | null | undefined, what: string): void {
  if (value === null || value === undefined) return;
  if (!UUID_RE.test(value)) throw new Sx0Refusal('BAD_ARGUMENT', `${what} is not a lowercase UUID: ${value}`);
}

function countBy(rows: Array<{ status: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export async function selectStandalone(db: Queryable, tenant: string | null): Promise<ManifestEnvelope[]> {
  assertUuid(tenant, '--tenant');
  const r = await db.query(
    `SELECT e.id::text AS id, e.tenant_id::text AS tenant_id, e.status, (e.deleted_at IS NOT NULL) AS deleted, e.source_application
       FROM "sign"."SignatureEnvelope" e
      WHERE ${SELECTION_SQL} AND ($1::uuid IS NULL OR e.tenant_id = $1::uuid)
      ORDER BY e.id`,
    [tenant],
  );
  return r.rows.map((x) => ({
    id: String(x['id']),
    tenant_id: String(x['tenant_id']),
    status: String(x['status']),
    deleted: x['deleted'] === true,
    source_application: String(x['source_application']),
  }));
}

export async function treeCounts(db: Queryable, ids: string[]): Promise<Array<{ table: string; rows: number }>> {
  const out: Array<{ table: string; rows: number }> = [];
  for (const s of TREE_STEPS) {
    const r = await db.query(`SELECT count(*)::int AS n FROM ${q(s.table)} WHERE ${s.where}`, [ids]);
    out.push({ table: s.table, rows: Number(r.rows[0]?.['n'] ?? 0) });
  }
  return out;
}

export async function atsLinkedSnapshot(db: Queryable): Promise<AtsLinkedSnapshot> {
  const env = await db.query(`SELECT e.id::text AS id, e.status FROM "sign"."SignatureEnvelope" e WHERE ${ATS_LINKED_SQL} ORDER BY e.id`);
  const ids = env.rows.map((r) => String(r['id']));
  const exe = await db.query(
    `SELECT x.id::text AS id, x.executed_sha256 FROM "sign"."ExecutedDocument" x WHERE x.envelope_id = ANY($1::uuid[]) ORDER BY x.id`,
    [ids],
  );
  const cert = await db.query(
    `SELECT c.id::text AS id, c.certificate_sha256 FROM "sign"."ExecutionCertificate" c WHERE c.envelope_id = ANY($1::uuid[]) ORDER BY c.id`,
    [ids],
  );
  return {
    envelope_count: ids.length,
    envelope_ids_sha256: sha256Hex(ids.join('\n')),
    status_counts: countBy(env.rows.map((r) => ({ status: String(r['status']) }))),
    executed_document_count: exe.rows.length,
    executed_sha256_digest: sha256Hex(exe.rows.map((r) => `${String(r['id'])}:${String(r['executed_sha256'])}`).join('\n')),
    certificate_count: cert.rows.length,
    certificate_sha256_digest: sha256Hex(cert.rows.map((r) => `${String(r['id'])}:${String(r['certificate_sha256'])}`).join('\n')),
  };
}

// Every sign table's row count (whole table), for the "only the tree moved" assertion.
export async function signTableTotals(db: Queryable): Promise<Record<string, number>> {
  const tables = [...new Set([...TREE_STEPS.map((s) => s.table), ...KEPT_TABLES])].sort();
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await db.query(`SELECT count(*)::int AS n FROM ${q(t)}`);
    out[t] = Number(r.rows[0]?.['n'] ?? 0);
  }
  return out;
}

async function regclassExists(db: Queryable, name: string): Promise<boolean> {
  const r = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
  return r.rows[0]?.['ok'] === true;
}

// Rows OUTSIDE the sign schema that name a standalone envelope or its artifacts. The PO
// ruling keeps tenant, plan and billing records: these are REPORTED, never changed.
export async function outOfScopeReferences(db: Queryable, envelopes: ManifestEnvelope[], executedIds: string[], keys: string[]): Promise<Record<string, number | string>> {
  const ids = envelopes.map((e) => e.id);
  const out: Record<string, number | string> = {};
  if (await regclassExists(db, 'subscription."AllowanceUsage"')) {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM subscription."AllowanceUsage" WHERE send_key = ANY(SELECT 'aramo-sign:envelope:' || x FROM unnest($1::text[]) AS x)`,
      [ids],
    );
    out['subscription.AllowanceUsage(send_key=aramo-sign:envelope:<id>)'] = Number(r.rows[0]?.['n'] ?? 0);
  } else out['subscription.AllowanceUsage'] = 'table not present';
  if (await regclassExists(db, 'subscription."CapacityUsage"')) {
    const refs = [
      ...executedIds.map((id) => `esign:executed:${id}`),
      ...ids.map((id) => `esign:certificate:${id}`),
      ...keys.map((k) => `sign:object:${k}`),
    ];
    const r = await db.query(
      `SELECT count(*)::int AS n, coalesce(sum(quantity) FILTER (WHERE state = 'ACTIVE'), 0)::text AS active_bytes
         FROM subscription."CapacityUsage" WHERE ref = ANY($1::text[])`,
      [refs],
    );
    out['subscription.CapacityUsage(ref=esign:executed|esign:certificate|sign:object)'] = Number(r.rows[0]?.['n'] ?? 0);
    out['subscription.CapacityUsage ACTIVE bytes for those refs'] = String(r.rows[0]?.['active_bytes'] ?? '0');
  } else out['subscription.CapacityUsage'] = 'table not present';
  if (await regclassExists(db, 'signature_routing."SignatureRequestRoute"')) {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM signature_routing."SignatureRequestRoute" WHERE provider_envelope_ref = ANY($1::text[])`,
      [ids],
    );
    out['signature_routing.SignatureRequestRoute(provider_envelope_ref)'] = Number(r.rows[0]?.['n'] ?? 0);
  } else out['signature_routing.SignatureRequestRoute'] = 'table not present';
  return out;
}

export async function buildInventory(db: Queryable, tenant: string | null): Promise<{ body: ManifestBody; report: InventoryReport }> {
  const envelopes = await selectStandalone(db, tenant);
  const ids = envelopes.map((e) => e.id);
  const exe = await db.query(
    `SELECT id::text AS id, envelope_id::text AS envelope_id, envelope_document_id::text AS envelope_document_id, source_sha256, executed_sha256, byte_size
       FROM "sign"."ExecutedDocument" WHERE envelope_id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  const cert = await db.query(
    `SELECT id::text AS id, envelope_id::text AS envelope_id, certificate_sha256, byte_size
       FROM "sign"."ExecutionCertificate" WHERE envelope_id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  const keys = await db.query(
    `SELECT DISTINCT source_object_key AS k FROM "sign"."EnvelopeDocument"
      WHERE envelope_id = ANY($1::uuid[]) AND source_object_key IS NOT NULL ORDER BY 1`,
    [ids],
  );
  const body: ManifestBody = {
    kind: MANIFEST_KIND,
    version: 1,
    tenant_filter: tenant,
    selection: 'SignatureEnvelope with NO EnvelopeDocument.document_ref IS NOT NULL',
    envelopes,
    envelope_status_counts: countBy(envelopes),
    delete_counts: await treeCounts(db, ids),
    executed_documents: exe.rows.map((r) => ({
      id: String(r['id']),
      envelope_id: String(r['envelope_id']),
      envelope_document_id: String(r['envelope_document_id']),
      source_sha256: String(r['source_sha256']),
      executed_sha256: String(r['executed_sha256']),
      byte_size: Number(r['byte_size']),
    })),
    execution_certificates: cert.rows.map((r) => ({
      id: String(r['id']),
      envelope_id: String(r['envelope_id']),
      certificate_sha256: String(r['certificate_sha256']),
      byte_size: Number(r['byte_size']),
    })),
    source_object_keys: keys.rows.map((r) => String(r['k'])),
    retained_ats_linked: await atsLinkedSnapshot(db),
  };
  const totals = await signTableTotals(db);
  const report: InventoryReport = {
    kept_table_totals: Object.fromEntries(KEPT_TABLES.map((t) => [t, totals[t] ?? 0])),
    out_of_scope_references: await outOfScopeReferences(db, envelopes, body.executed_documents.map((d) => d.id), body.source_object_keys),
  };
  return { body, report };
}

export function makeManifest(body: ManifestBody, report: InventoryReport, now = new Date()): Manifest {
  return { manifest_sha256: digest(body), generated_at: now.toISOString(), body, report };
}

// ── Guards ─────────────────────────────────────────────────────────────────

// SX-0 must precede SX-1: once the executed-artifact immutability migration exists the
// wipe would have to defeat it, so the tool refuses instead.
export async function assertNoImmutabilityTrigger(db: Queryable): Promise<void> {
  const t = await db.query(
    `SELECT t.tgname, c.relname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'sign' AND NOT t.tgisinternal
        AND (c.relname IN ('ExecutedDocument', 'ExecutionCertificate')
             OR t.tgname ILIKE '%executed_artifact%' OR t.tgname ILIKE '%immutability%')`,
  );
  if (t.rows.length > 0) {
    const names = t.rows.map((r) => `${String(r['relname'])}.${String(r['tgname'])}`).join(', ');
    throw new Sx0Refusal('SX1_ALREADY_APPLIED', `executed-artifact immutability trigger(s) present (${names}); SX-0 must run before SX-1`);
  }
  if (await regclassExists(db, 'public._local_migrations')) {
    const m = await db.query(`SELECT count(*)::int AS n FROM public._local_migrations WHERE name LIKE $1`, [`%${SX1_IMMUTABILITY_MIGRATION}%`]);
    if (Number(m.rows[0]?.['n'] ?? 0) > 0) {
      throw new Sx0Refusal('SX1_ALREADY_APPLIED', `migration ${SX1_IMMUTABILITY_MIGRATION} is recorded in the ledger; SX-0 must run before SX-1`);
    }
  }
}

export async function appendOnlyTriggerState(db: Queryable): Promise<string | null> {
  const r = await db.query(
    `SELECT t.tgenabled::text AS s FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'sign' AND c.relname = 'SignatureEvent' AND t.tgname = $1`,
    [APPEND_ONLY_TRIGGER],
  );
  return r.rows.length === 0 ? null : String(r.rows[0]?.['s']);
}

export function verifyManifestFile(m: Manifest, expectedSha: string | undefined): void {
  if (m?.body?.kind !== MANIFEST_KIND) throw new Sx0Refusal('BAD_MANIFEST', 'not an SX-0 manifest');
  const actual = digest(m.body);
  if (actual !== m.manifest_sha256) throw new Sx0Refusal('BAD_MANIFEST', `manifest body digest ${actual} does not match its recorded manifest_sha256 ${m.manifest_sha256}`);
  if (expectedSha === undefined || expectedSha !== actual) throw new Sx0Refusal('MANIFEST_SHA_MISMATCH', `--manifest-sha256 ${String(expectedSha)} does not match the manifest (${actual})`);
}

export interface ExecuteAuthorization {
  manifest: Manifest;
  manifestSha256: string | undefined;
  confirmTenant: string | undefined;
  env: Record<string, string | undefined>;
}

export function assertExecutionAuthorized(a: ExecuteAuthorization): void {
  verifyManifestFile(a.manifest, a.manifestSha256);
  const sha = a.manifest.manifest_sha256;
  const auth = a.env[EXECUTION_ENV];
  if (auth === undefined || auth === '') throw new Sx0Refusal('NOT_AUTHORIZED', `${EXECUTION_ENV} is not set; execution needs written PO authorization naming manifest ${sha}`);
  if (auth !== sha) throw new Sx0Refusal('NOT_AUTHORIZED', `${EXECUTION_ENV} (${auth}) does not name this manifest (${sha})`);
  const tf = a.manifest.body.tenant_filter;
  if (tf === null) throw new Sx0Refusal('TENANT_UNCONFIRMED', 'the manifest was produced without --tenant; execute needs a tenant-scoped manifest');
  if (a.confirmTenant !== tf) throw new Sx0Refusal('TENANT_UNCONFIRMED', `--confirm-tenant ${String(a.confirmTenant)} does not match the manifest tenant ${tf}`);
  const strays = a.manifest.body.envelopes.filter((e) => e.tenant_id !== tf);
  if (strays.length > 0) throw new Sx0Refusal('BAD_MANIFEST', `${strays.length} manifest envelope(s) are outside tenant ${tf}`);
}

// ── The wipe (dry-run and execute share one path) ─────────────────────────

export interface WipeResult {
  mode: 'dry-run' | 'execute';
  manifest_sha256: string;
  committed: boolean;
  before: { tree: Array<{ table: string; rows: number }>; sign_table_totals: Record<string, number>; ats_linked: AtsLinkedSnapshot };
  deleted: Array<{ table: string; rows: number }>;
  after_in_transaction: { standalone_envelopes: number; sign_table_totals: Record<string, number>; ats_linked: AtsLinkedSnapshot; append_only_trigger: string | null };
  after_close: { standalone_envelopes: number; sign_table_totals: Record<string, number>; ats_linked: AtsLinkedSnapshot; append_only_trigger: string | null };
}

function assertEqual(code: string, what: string, a: unknown, b: unknown): void {
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  if (ca !== cb) throw new Sx0Refusal(code, `${what} differs:\n  expected ${cb}\n  actual   ${ca}`);
}

export interface WipeOptions {
  mode: 'dry-run' | 'execute';
  tenant: string | null;
  // execute: the frozen manifest the live inventory must equal. dry-run: optional drift check.
  manifest?: Manifest;
  lockTimeoutMs?: number;
}

export async function runWipe(db: Queryable, opts: WipeOptions): Promise<WipeResult> {
  if (opts.mode === 'execute' && opts.manifest === undefined) throw new Sx0Refusal('BAD_ARGUMENT', 'execute needs a frozen manifest');
  await assertNoImmutabilityTrigger(db);
  const triggerBefore = await appendOnlyTriggerState(db);
  if (triggerBefore !== 'O') throw new Sx0Refusal('TRIGGER_STATE', `${APPEND_ONLY_TRIGGER} must be present and enabled before the run (state: ${String(triggerBefore)})`);

  await db.query('BEGIN');
  let committed = false;
  try {
    await db.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(opts.lockTimeoutMs ?? 10_000))}ms'`);
    // Freeze the envelope set for the life of the transaction: no envelope or document can be
    // written while the inventory is re-derived and the tree removed (reads continue).
    await db.query(`LOCK TABLE "sign"."SignatureEnvelope", "sign"."EnvelopeDocument" IN EXCLUSIVE MODE`);
    await assertNoImmutabilityTrigger(db);

    const live = await buildInventory(db, opts.tenant);
    const liveSha = digest(live.body);
    if (opts.manifest !== undefined) {
      if (liveSha !== opts.manifest.manifest_sha256) {
        assertEqual('INVENTORY_DRIFT', 'live inventory vs frozen manifest', live.body, opts.manifest.body);
        throw new Sx0Refusal('INVENTORY_DRIFT', `live inventory ${liveSha} differs from the frozen manifest ${opts.manifest.manifest_sha256}`);
      }
    }
    const ids = live.body.envelopes.map((e) => e.id);
    const beforeTotals = await signTableTotals(db);
    const beforeAts = live.body.retained_ats_linked;

    await db.query(`ALTER TABLE "sign"."SignatureEvent" DISABLE TRIGGER ${APPEND_ONLY_TRIGGER}`);
    const deleted: Array<{ table: string; rows: number }> = [];
    for (const s of TREE_STEPS) {
      const r = await db.query(`DELETE FROM ${q(s.table)} WHERE ${s.where}`, [ids]);
      deleted.push({ table: s.table, rows: r.rowCount ?? 0 });
    }
    await db.query(`ALTER TABLE "sign"."SignatureEvent" ENABLE TRIGGER ${APPEND_ONLY_TRIGGER}`);

    // Post-assertions, still inside the transaction.
    assertEqual('COUNT_MISMATCH', 'deleted rows per table vs inventory', deleted, live.body.delete_counts);
    const after = {
      standalone_envelopes: (await selectStandalone(db, opts.tenant)).length,
      sign_table_totals: await signTableTotals(db),
      ats_linked: await atsLinkedSnapshot(db),
      append_only_trigger: await appendOnlyTriggerState(db),
    };
    if (after.standalone_envelopes !== 0) throw new Sx0Refusal('POST_ASSERT', `${after.standalone_envelopes} standalone envelope(s) remain`);
    assertEqual('POST_ASSERT', 'ATS-linked snapshot', after.ats_linked, beforeAts);
    const expectedTotals = { ...beforeTotals };
    for (const d of deleted) expectedTotals[d.table] = (expectedTotals[d.table] ?? 0) - d.rows;
    assertEqual('POST_ASSERT', 'sign table totals (only the standalone tree may move)', after.sign_table_totals, expectedTotals);
    if (after.append_only_trigger !== 'O') throw new Sx0Refusal('POST_ASSERT', `${APPEND_ONLY_TRIGGER} is not re-enabled (state: ${String(after.append_only_trigger)})`);

    if (opts.mode === 'execute') {
      await db.query('COMMIT');
      committed = true;
    } else {
      await db.query('ROLLBACK');
    }

    const close = {
      standalone_envelopes: (await selectStandalone(db, opts.tenant)).length,
      sign_table_totals: await signTableTotals(db),
      ats_linked: await atsLinkedSnapshot(db),
      append_only_trigger: await appendOnlyTriggerState(db),
    };
    if (close.append_only_trigger !== 'O') throw new Sx0Refusal('POST_ASSERT', `${APPEND_ONLY_TRIGGER} is not enabled after the transaction`);
    assertEqual('POST_ASSERT', 'ATS-linked snapshot after the transaction', close.ats_linked, beforeAts);
    if (opts.mode === 'dry-run') {
      // A rolled-back run changes nothing. (Unrelated concurrent traffic would show here too:
      // the dry-run is meant to run under the send freeze.)
      assertEqual('POST_ASSERT', 'sign table totals after rollback', close.sign_table_totals, beforeTotals);
    } else {
      if (close.standalone_envelopes !== 0) throw new Sx0Refusal('POST_ASSERT', 'standalone envelopes reappeared after commit');
    }
    return {
      mode: opts.mode,
      manifest_sha256: liveSha,
      committed,
      before: { tree: live.body.delete_counts, sign_table_totals: beforeTotals, ats_linked: beforeAts },
      deleted,
      after_in_transaction: after,
      after_close: close,
    };
  } catch (err) {
    if (!committed) await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

// ── S3 (versions under esign/source/) ──────────────────────────────────────

export interface S3Version {
  key: string;
  version_id: string;
  is_delete_marker: boolean;
  is_latest: boolean;
  size: number | null;
  last_modified: string | null;
}

export interface S3Port {
  listObjectVersions(input: { Bucket: string; Prefix: string; KeyMarker?: string; VersionIdMarker?: string }): Promise<{
    Versions?: Array<{ Key?: string; VersionId?: string; IsLatest?: boolean; Size?: number; LastModified?: Date }>;
    DeleteMarkers?: Array<{ Key?: string; VersionId?: string; IsLatest?: boolean; LastModified?: Date }>;
    IsTruncated?: boolean;
    NextKeyMarker?: string;
    NextVersionIdMarker?: string;
  }>;
  deleteObjects(input: { Bucket: string; Delete: { Objects: Array<{ Key: string; VersionId: string }>; Quiet?: boolean } }): Promise<{
    Deleted?: Array<{ Key?: string; VersionId?: string }>;
    Errors?: Array<{ Key?: string; VersionId?: string; Code?: string; Message?: string }>;
  }>;
}

export async function listAllVersions(s3: S3Port, bucket: string, prefix: string): Promise<S3Version[]> {
  const out: S3Version[] = [];
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  for (let page = 0; page < 100_000; page += 1) {
    const r = await s3.listObjectVersions({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker });
    for (const v of r.Versions ?? []) {
      out.push({ key: String(v.Key), version_id: String(v.VersionId ?? 'null'), is_delete_marker: false, is_latest: v.IsLatest === true, size: v.Size ?? null, last_modified: v.LastModified?.toISOString() ?? null });
    }
    for (const d of r.DeleteMarkers ?? []) {
      out.push({ key: String(d.Key), version_id: String(d.VersionId ?? 'null'), is_delete_marker: true, is_latest: d.IsLatest === true, size: null, last_modified: d.LastModified?.toISOString() ?? null });
    }
    if (r.IsTruncated !== true) break;
    KeyMarker = r.NextKeyMarker;
    VersionIdMarker = r.NextVersionIdMarker;
  }
  return out.sort((a, b) => (a.key === b.key ? a.version_id.localeCompare(b.version_id) : a.key.localeCompare(b.key)));
}

// esign/source/<tenant>/<envelope>/<object_id>
export function parseSourceKey(key: string): { tenant: string; envelope: string } | null {
  if (!key.startsWith(S3_SOURCE_PREFIX)) return null;
  const parts = key.slice(S3_SOURCE_PREFIX.length).split('/');
  if (parts.length < 3) return null;
  return { tenant: parts[0] ?? '', envelope: parts[1] ?? '' };
}

export interface S3ManifestBody {
  kind: typeof S3_MANIFEST_KIND;
  version: 1;
  db_manifest_sha256: string;
  bucket: string;
  prefix: string;
  versions: Array<S3Version & { classification: string }>;
  key_counts: Record<string, number>;
  version_count: number;
  delete_marker_count: number;
  excluded_retained_keys: string[];
}

export interface S3Manifest {
  s3_manifest_sha256: string;
  generated_at: string;
  body: S3ManifestBody;
}

export function scopedPrefix(tenant: string | null): string {
  return tenant === null ? S3_SOURCE_PREFIX : `${S3_SOURCE_PREFIX}${tenant}/`;
}

// Retained = every envelope NOT in the frozen standalone set. Their referenced keys AND
// every key under their envelope path are excluded (two independent guards).
export async function retainedS3Guards(db: Queryable, standaloneIds: string[]): Promise<{ keys: Set<string>; envelopes: Set<string> }> {
  const k = await db.query(
    `SELECT DISTINCT source_object_key AS k FROM "sign"."EnvelopeDocument"
      WHERE source_object_key IS NOT NULL AND NOT (envelope_id = ANY($1::uuid[]))`,
    [standaloneIds],
  );
  const e = await db.query(`SELECT id::text AS id FROM "sign"."SignatureEnvelope" WHERE NOT (id = ANY($1::uuid[]))`, [standaloneIds]);
  return { keys: new Set(k.rows.map((r) => String(r['k']))), envelopes: new Set(e.rows.map((r) => String(r['id']))) };
}

export async function buildS3Inventory(db: Queryable, s3: S3Port, manifest: Manifest, bucket: string): Promise<S3Manifest> {
  const standaloneIds = new Set(manifest.body.envelopes.map((e) => e.id));
  const referenced = new Set(manifest.body.source_object_keys);
  const guards = await retainedS3Guards(db, [...standaloneIds]);
  const prefix = scopedPrefix(manifest.body.tenant_filter);
  const all = await listAllVersions(s3, bucket, prefix);
  const versions: S3ManifestBody['versions'] = [];
  const excluded = new Set<string>();
  for (const v of all) {
    const parsed = parseSourceKey(v.key);
    if (parsed === null || !v.key.startsWith(prefix)) continue;
    if (guards.keys.has(v.key) || guards.envelopes.has(parsed.envelope)) {
      excluded.add(v.key);
      continue;
    }
    const classification = referenced.has(v.key)
      ? 'STANDALONE_REFERENCED'
      : standaloneIds.has(parsed.envelope)
        ? 'ORPHAN_OF_STANDALONE_ENVELOPE'
        : 'ORPHAN_NO_ENVELOPE';
    versions.push({ ...v, classification });
  }
  const keyCounts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const v of versions) {
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    keyCounts[v.classification] = (keyCounts[v.classification] ?? 0) + 1;
  }
  const body: S3ManifestBody = {
    kind: S3_MANIFEST_KIND,
    version: 1,
    db_manifest_sha256: manifest.manifest_sha256,
    bucket,
    prefix,
    versions,
    key_counts: Object.fromEntries(Object.entries(keyCounts).sort(([a], [b]) => a.localeCompare(b))),
    version_count: versions.filter((v) => !v.is_delete_marker).length,
    delete_marker_count: versions.filter((v) => v.is_delete_marker).length,
    excluded_retained_keys: [...excluded].sort(),
  };
  return { s3_manifest_sha256: digest(body), generated_at: new Date().toISOString(), body };
}

export interface S3ExecuteOptions {
  manifest: S3Manifest;
  manifestSha256: string | undefined;
  bucket: string | undefined;
  env: Record<string, string | undefined>;
}

export function assertS3ExecutionAuthorized(o: S3ExecuteOptions): void {
  const m = o.manifest;
  if (m?.body?.kind !== S3_MANIFEST_KIND) throw new Sx0Refusal('BAD_MANIFEST', 'not an SX-0 S3 manifest');
  const actual = digest(m.body);
  if (actual !== m.s3_manifest_sha256) throw new Sx0Refusal('BAD_MANIFEST', `S3 manifest body digest ${actual} does not match its recorded sha ${m.s3_manifest_sha256}`);
  if (o.manifestSha256 !== actual) throw new Sx0Refusal('MANIFEST_SHA_MISMATCH', `--s3-manifest-sha256 ${String(o.manifestSha256)} does not match (${actual})`);
  const auth = o.env[S3_EXECUTION_ENV];
  if (auth === undefined || auth === '' || auth !== actual) throw new Sx0Refusal('NOT_AUTHORIZED', `${S3_EXECUTION_ENV} must name S3 manifest ${actual}`);
  if (o.bucket !== m.body.bucket) throw new Sx0Refusal('BAD_ARGUMENT', `--bucket ${String(o.bucket)} does not match the manifest bucket ${m.body.bucket}`);
  for (const v of m.body.versions) {
    if (!v.key.startsWith(S3_SOURCE_PREFIX) || !v.key.startsWith(m.body.prefix) || parseSourceKey(v.key) === null || v.key.includes('..')) {
      throw new Sx0Refusal('OUT_OF_PREFIX', `key ${v.key} is outside ${m.body.prefix}`);
    }
    if (v.version_id === '' || v.version_id === 'null') throw new Sx0Refusal('BAD_MANIFEST', `key ${v.key} has no version id (an unversioned delete is never issued)`);
  }
}

// After the DB wipe: no manifest key may still be referenced, and no manifest key may sit
// under a surviving envelope. Proves the DB side is done before any version is destroyed.
export async function assertS3KeysUnreferenced(db: Queryable, m: S3Manifest): Promise<void> {
  const keys = [...new Set(m.body.versions.map((v) => v.key))];
  const r = await db.query(`SELECT count(*)::int AS n FROM "sign"."EnvelopeDocument" WHERE source_object_key = ANY($1::text[])`, [keys]);
  if (Number(r.rows[0]?.['n'] ?? 0) > 0) throw new Sx0Refusal('KEY_STILL_REFERENCED', `${String(r.rows[0]?.['n'])} manifest key(s) are still referenced by EnvelopeDocument (run the DB wipe first)`);
  const envs = [...new Set(keys.map((k) => parseSourceKey(k)?.envelope ?? ''))].filter((x) => UUID_RE.test(x));
  const e = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureEnvelope" WHERE id = ANY($1::uuid[])`, [envs]);
  if (Number(e.rows[0]?.['n'] ?? 0) > 0) throw new Sx0Refusal('KEY_STILL_REFERENCED', `${String(e.rows[0]?.['n'])} manifest key(s) sit under an envelope that still exists`);
}

export interface S3DeleteResult {
  requested: number;
  deleted: Array<{ key: string; version_id: string }>;
  errors: Array<{ key: string; version_id: string; code: string; message: string }>;
}

export async function executeS3Deletes(s3: S3Port, m: S3Manifest): Promise<S3DeleteResult> {
  const objects = m.body.versions.map((v) => ({ Key: v.key, VersionId: v.version_id }));
  const result: S3DeleteResult = { requested: objects.length, deleted: [], errors: [] };
  for (let i = 0; i < objects.length; i += 1000) {
    const batch = objects.slice(i, i + 1000);
    for (const o of batch) {
      if (!o.Key.startsWith(S3_SOURCE_PREFIX)) throw new Sx0Refusal('OUT_OF_PREFIX', `refusing to delete ${o.Key}`);
    }
    const r = await s3.deleteObjects({ Bucket: m.body.bucket, Delete: { Objects: batch, Quiet: false } });
    for (const d of r.Deleted ?? []) result.deleted.push({ key: String(d.Key), version_id: String(d.VersionId) });
    for (const e of r.Errors ?? []) result.errors.push({ key: String(e.Key), version_id: String(e.VersionId), code: String(e.Code), message: String(e.Message) });
  }
  return result;
}
