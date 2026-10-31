import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { EsignRepository, OutboxService, PrismaService, SignPurgeRepository, verifyEventChain } from '@aramo/sign';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Retention and Purge directive (ebd41d99) W1/W3/W4/W5 against real Postgres 17 with the full
// sign migration chain (incl. 20261101100000_sign_retention_purge). Proves the database guards
// admit the purge writes only inside the due window, each level removes what it should,
// an executed purge is final, ledger hashes never change and the chain still verifies (LD-2),
// Aramo legal hold blocks execution (R-12), a dequeue sticks, and the all-parties rule (R-10).

const ROOT = resolve(__dirname, '../../../..');
const migrations = (): string[] => {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};
const DAY = 86_400_000;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign retention and purge — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let purge: SignPurgeRepository;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  const SENDER_EMAIL = 'owner@astre.test';

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    // Minimal identity stand-ins (the legal hold and sender email reads).
    await db.query(`CREATE SCHEMA identity; CREATE TABLE identity."Tenant" (id uuid PRIMARY KEY, legal_hold boolean NOT NULL DEFAULT false); CREATE TABLE identity."User" (id uuid PRIMARY KEY, email text)`);
    await db.query(`INSERT INTO identity."Tenant" (id) VALUES ($1)`, [TENANT]);
    await db.query(`INSERT INTO identity."User" (id, email) VALUES ($1, $2)`, [ACTOR, SENDER_EMAIL]);
    for (const m of migrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    purge = new SignPurgeRepository(prisma, repo, new OutboxService(prisma));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  // A COMPLETED envelope with one executed document, a certificate, a signer with an email, a
  // disclosure, and ledger events carrying a title, an IP address and a user agent.
  async function completed(opts: { completedDaysAgo?: number } = {}): Promise<{ envelope_id: string; signer_id: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Offer for Jane', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'Jane offer.pdf', source_sha256: 'src', ordinal: 1 });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@example.test', name: 'Jane Doe', signing_order: 1 });
    await prisma.$transaction((tx) =>
      repo.appendEvent(tx as never, { tenant_id: TENANT, envelope_id: env.id, signer_id: signer.id, event_type: 'SIGNER_SIGNED', actor_type: 'SIGNER', payload: { name: 'Jane Doe' }, ip_address: '203.0.113.7', user_agent: 'Mozilla/5.0' }),
    );
    const completedAt = new Date(Date.now() - (opts.completedDaysAgo ?? 0) * DAY);
    await db.query(`UPDATE "sign"."SignatureEnvelope" SET status = 'COMPLETED', sent_at = $2, completed_at = $2 WHERE id = $1`, [env.id, completedAt]);
    await db.query(
      `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes) VALUES ($1, $2, $3, $4, 'src', 'exe', 3, '\\x010203')`,
      [randomUUID(), TENANT, env.id, (doc as { id: string }).id],
    );
    await db.query(
      `INSERT INTO "sign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes) VALUES ($1, $2, $3, 'cert', 2, '\\x0405')`,
      [randomUUID(), TENANT, env.id],
    );
    return { envelope_id: env.id, signer_id: (signer as { id: string }).id };
  }

  const NO_OBJECTS = { deleted: 0, locked: [] };
  const past = (days: number) => new Date(Date.now() - days * DAY);

  it('refuses every purge write outside the due window (DB guards)', async () => {
    const { envelope_id } = await completed();
    await expect(db.query(`UPDATE "sign"."ExecutedDocument" SET executed_bytes = NULL, purged_at = now() WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/write-once|purged_at/);
    expect(await purge.queue(TENANT, envelope_id, { level: 'DOCUMENTS', reason: 'manual', actor_user_id: ACTOR })).toBe('queued');
    // Queued but due in 14 days: still refused, and execute() reports not_due.
    await expect(db.query(`UPDATE "sign"."ExecutedDocument" SET executed_bytes = NULL, purged_at = now() WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/write-once|purged_at/);
    expect(await purge.execute(TENANT, envelope_id, NO_OBJECTS)).toEqual({ status: 'not_due' });
    await expect(db.query(`DELETE FROM "sign"."ExecutedDocument" WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/DELETE is rejected/);
    await expect(db.query(`UPDATE "sign"."SignatureEvent" SET ip_address = NULL WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/append-only/);
  });

  it('DOCUMENTS level: bytes purged, hashes and custody kept, metadata kept, executed purge is final', async () => {
    const { envelope_id } = await completed();
    expect(await purge.queue(TENANT, envelope_id, { level: 'DOCUMENTS', reason: 'manual', actor_user_id: ACTOR, now: past(15) })).toBe('queued');
    const out = await purge.execute(TENANT, envelope_id, { deleted: 3, locked: [] });
    expect(out).toMatchObject({ status: 'executed', level: 'DOCUMENTS', documents: 1, certificates: 1 });
    const doc = await db.query(`SELECT executed_bytes, purged_at, executed_sha256 FROM "sign"."ExecutedDocument" WHERE envelope_id = $1`, [envelope_id]);
    expect(doc.rows[0].executed_bytes).toBeNull();
    expect(doc.rows[0].purged_at).not.toBeNull();
    expect(doc.rows[0].executed_sha256).toBe('exe');
    const env = await db.query(`SELECT subject, purge_state FROM "sign"."SignatureEnvelope" WHERE id = $1`, [envelope_id]);
    expect(env.rows[0]).toEqual({ subject: 'Offer for Jane', purge_state: 'EXECUTED' });
    const signer = await db.query(`SELECT email FROM "sign"."Signer" WHERE envelope_id = $1`, [envelope_id]);
    expect(signer.rows[0].email).toBe('jane@example.test');
    const ev = await db.query(`SELECT payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = 'ENVELOPE_PURGED'`, [envelope_id]);
    expect(ev.rows[0].payload).toMatchObject({ level: 'DOCUMENTS', s3_versions_deleted: 3 });
    const outbox = await db.query(`SELECT event_payload FROM "sign"."OutboxEvent" WHERE event_type = 'sign.envelope.purge.v1' AND event_payload->>'envelope_id' = $1 ORDER BY created_at`, [envelope_id]);
    expect(outbox.rows.map((r) => r.event_payload.purge.purge_state)).toEqual(['documents_queued', 'executed']);
    // Final: the purge columns, the status and the bytes can never change again.
    await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET purge_state = 'DEQUEUED' WHERE id = $1`, [envelope_id])).rejects.toThrow(/final/);
    await expect(db.query(`UPDATE "sign"."ExecutedDocument" SET executed_bytes = '\\x00' WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/cannot be changed|write-once/);
    expect(await purge.execute(TENANT, envelope_id, NO_OBJECTS)).toEqual({ status: 'not_due' });
    expect(await purge.queue(TENANT, envelope_id, { level: 'DOCUMENTS_AND_METADATA_AND_REDACT', reason: 'manual' })).toBe('executed');
  });

  it('REDACT level: metadata and personal data removed, ledger hashes unchanged, chain still verifies', async () => {
    const { envelope_id } = await completed();
    const before = await db.query(`SELECT id, event_hash, previous_event_hash FROM "sign"."SignatureEvent" WHERE envelope_id = $1 ORDER BY occurred_at, id`, [envelope_id]);
    await purge.queue(TENANT, envelope_id, { level: 'DOCUMENTS_AND_METADATA_AND_REDACT', reason: 'targeted', actor_user_id: ACTOR, now: past(15) });
    const out = await purge.execute(TENANT, envelope_id, NO_OBJECTS);
    expect(out).toMatchObject({ status: 'executed', level: 'DOCUMENTS_AND_METADATA_AND_REDACT' });
    expect(out.status === 'executed' && out.events_redacted).toBeGreaterThan(0);

    const env = await db.query(`SELECT subject, message FROM "sign"."SignatureEnvelope" WHERE id = $1`, [envelope_id]);
    expect(env.rows[0]).toEqual({ subject: '[purged]', message: null });
    const docs = await db.query(`SELECT title FROM "sign"."EnvelopeDocument" WHERE envelope_id = $1`, [envelope_id]);
    expect(docs.rows.every((r) => r.title === '[purged]')).toBe(true);
    const signer = await db.query(`SELECT name, email FROM "sign"."Signer" WHERE envelope_id = $1`, [envelope_id]);
    expect(signer.rows[0]).toEqual({ name: '[redacted]', email: '[redacted]' });

    // No personal data left in the ledger rows that existed before the purge.
    const after = await db.query(`SELECT id, event_hash, previous_event_hash, ip_address, user_agent, payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 ORDER BY occurred_at, id`, [envelope_id]);
    const serialized = JSON.stringify(after.rows);
    for (const pii of ['Jane Doe', 'Jane offer.pdf', '203.0.113.7', 'Mozilla/5.0', 'jane@example.test']) expect(serialized).not.toContain(pii);
    // Historical hashes unchanged (LD-2).
    for (const b of before.rows) {
      const a = after.rows.find((r) => r.id === b.id);
      expect(a.event_hash).toBe(b.event_hash);
      expect(a.previous_event_hash).toBe(b.previous_event_hash);
    }
    // The verifier reports redacted events explicitly and the chain still links.
    const events = await prisma.signatureEvent.findMany({ where: { envelope_id }, orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }] });
    const redactions = await prisma.signatureEventRedaction.findMany({ where: { envelope_id } });
    const v = verifyEventChain(
      events.map((e) => ({ id: e.id, envelope_id: e.envelope_id, event_type: e.event_type, actor_type: e.actor_type, actor_ref: e.actor_ref, payload: e.payload, occurred_at: e.occurred_at.toISOString(), previous_event_hash: e.previous_event_hash, event_hash: e.event_hash })),
      redactions,
    );
    // Every event written in this test hashes in jsonb key order, so all are recomputable:
    // the redacted ones are REDACTED_ATTESTED, the rest VERIFIED, none LINK_ONLY or BROKEN.
    expect(v.ok).toBe(true);
    expect(v.redacted_attested).toBeGreaterThan(0);
    expect(v.link_only + v.redacted_link_only).toBe(0);
    expect(redactions.every((r) => r.verified_before_redaction)).toBe(true);
    // The purge's own enum fields are never redacted.
    const purged = events.find((e) => e.event_type === 'ENVELOPE_PURGED');
    expect(purged?.payload).toMatchObject({ purge_reason: 'targeted' });
    // The redaction records and redacted events stay append-only afterwards.
    await expect(db.query(`DELETE FROM "sign"."SignatureEventRedaction" WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE "sign"."SignatureEvent" SET user_agent = NULL WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/append-only/);
  });

  it('a tampered event is never reported VERIFIED', async () => {
    const { envelope_id } = await completed();
    const events = await prisma.signatureEvent.findMany({ where: { envelope_id }, orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }] });
    const rows = events.map((e) => ({ id: e.id, envelope_id: e.envelope_id, event_type: e.event_type, actor_type: e.actor_type, actor_ref: e.actor_ref, payload: e.payload, occurred_at: e.occurred_at.toISOString(), previous_event_hash: e.previous_event_hash, event_hash: e.event_hash }));
    expect(verifyEventChain(rows, []).ok).toBe(true);
    rows[rows.length - 1] = { ...rows[rows.length - 1]!, payload: { name: 'Someone else' } };
    const tampered = verifyEventChain(rows, []);
    expect(tampered.verified).toBe(rows.length - 1);
    expect(tampered.statuses[rows.length - 1]).toEqual({ event_id: rows[rows.length - 1]!.id, status: 'LINK_ONLY' });
  });

  it('Aramo legal hold blocks execution and keeps the envelope queued (R-12)', async () => {
    const { envelope_id } = await completed();
    await purge.queue(TENANT, envelope_id, { level: 'DOCUMENTS', reason: 'manual', now: past(15) });
    await db.query(`UPDATE identity."Tenant" SET legal_hold = true WHERE id = $1`, [TENANT]);
    try {
      expect(await purge.execute(TENANT, envelope_id, NO_OBJECTS)).toEqual({ status: 'held' });
      expect(await purge.dueForExecution(new Date(), 50)).not.toContainEqual(expect.objectContaining({ envelope_id }));
    } finally {
      await db.query(`UPDATE identity."Tenant" SET legal_hold = false WHERE id = $1`, [TENANT]);
    }
    expect((await purge.status(TENANT, envelope_id))?.state).toBe('QUEUED');
  });

  it('retention selects past-due envelopes; a dequeue sticks against retention', async () => {
    await purge.setPolicy(TENANT, { retention_days: 30, purge_level: 'DOCUMENTS_AND_METADATA' }, ACTOR);
    const old = await completed({ completedDaysAgo: 40 });
    const fresh = await completed({ completedDaysAgo: 5 });
    const due = await purge.retentionDue(new Date(), 500);
    expect(due).toContainEqual({ tenant_id: TENANT, envelope_id: old.envelope_id, level: 'DOCUMENTS_AND_METADATA' });
    expect(due.map((d) => d.envelope_id)).not.toContain(fresh.envelope_id);
    expect(await purge.queue(TENANT, old.envelope_id, { level: 'DOCUMENTS_AND_METADATA', reason: 'retention' })).toBe('queued');
    expect(await purge.dequeue(TENANT, old.envelope_id, ACTOR)).toBe('dequeued');
    expect(await purge.queue(TENANT, old.envelope_id, { level: 'DOCUMENTS_AND_METADATA', reason: 'retention' })).toBe('dequeued_by_admin');
    const history = await db.query(`SELECT new_retention_days, new_purge_level FROM "sign"."SignTenantRetentionPolicyEvent" WHERE tenant_id = $1`, [TENANT]);
    expect(history.rows).toContainEqual({ new_retention_days: 30, new_purge_level: 'DOCUMENTS_AND_METADATA' });
    await purge.setPolicy(TENANT, { retention_days: null, purge_level: 'DOCUMENTS' }, ACTOR);
    await expect(purge.setPolicy(TENANT, { retention_days: 10000, purge_level: 'DOCUMENTS' }, ACTOR)).rejects.toThrow(RangeError);
    await expect(db.query(`INSERT INTO "sign"."SignTenantRetentionPolicy" (tenant_id, retention_days, updated_by) VALUES ($1, 0, $2)`, [randomUUID(), ACTOR])).rejects.toThrow(/days_check/);
  });

  it('targeted purge finds envelopes by signer or sender email', async () => {
    const { envelope_id } = await completed();
    expect(await purge.targetedEnvelopeIds(TENANT, 'JANE@example.test')).toContain(envelope_id);
    expect(await purge.targetedEnvelopeIds(TENANT, SENDER_EMAIL)).toContain(envelope_id);
    expect(await purge.targetedEnvelopeIds(TENANT, 'nobody@example.test')).not.toContain(envelope_id);
  });

  it('R-13: an integration envelope is unconfirmed until its executed event is delivered or published', async () => {
    const { envelope_id } = await completed();
    expect(await purge.integrationCopyDelivered(TENANT, envelope_id)).toBeNull(); // created by the Sign app
    await db.query(`UPDATE "sign"."SignatureEnvelope" SET source_application = 'aramo-ats' WHERE id = $1`, [envelope_id]);
    expect(await purge.integrationCopyDelivered(TENANT, envelope_id)).toBe(false);
    await db.query(
      `INSERT INTO "sign"."OutboxEvent" (id, tenant_id, event_type, event_payload, published_at) VALUES ($1, $2, 'sign.envelope.executed.v1', $3, now())`,
      [randomUUID(), TENANT, JSON.stringify({ envelope_id, correlation_id: 'c', artifact_refs: { executed_document_ids: [], has_certificate: true } })],
    );
    expect(await purge.integrationCopyDelivered(TENANT, envelope_id)).toBe(true);
  });

  it('per-party delete: hidden for one party; queued only when every party deleted (R-10)', async () => {
    const { envelope_id, signer_id } = await completed();
    const RECIPIENT_USER = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignRecipientBinding" (id, envelope_tenant_id, envelope_id, signer_id, user_id, user_tenant_id, email) VALUES ($1, $2, $3, $4, $5, $6, 'jane@example.test')`,
      [randomUUID(), TENANT, envelope_id, signer_id, RECIPIENT_USER, randomUUID()],
    );
    expect(await purge.partyDelete(TENANT, envelope_id, { kind: 'SENDER', key: TENANT }, ACTOR)).toBe('deleted');
    expect(await purge.deletedEnvelopeIds({ kind: 'SENDER', key: TENANT })).toContain(envelope_id);
    expect((await purge.allPartiesDeletedDue(500)).map((r) => r.envelope_id)).not.toContain(envelope_id);
    expect(await purge.partyDelete(TENANT, envelope_id, { kind: 'RECIPIENT', key: RECIPIENT_USER }, RECIPIENT_USER)).toBe('deleted');
    expect((await purge.allPartiesDeletedDue(500)).map((r) => r.envelope_id)).toContain(envelope_id);
    expect(await purge.partyRestore(TENANT, envelope_id, { kind: 'RECIPIENT', key: RECIPIENT_USER }, RECIPIENT_USER)).toBe('restored');
    expect((await purge.allPartiesDeletedDue(500)).map((r) => r.envelope_id)).not.toContain(envelope_id);
  });
});
