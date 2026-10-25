import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService } from '../lib/esign.service.js';
import { EsignSenderRepository } from '../lib/sender-workspace.repository.js';
import { RecipientInboxRepository, RECIPIENT_INBOX_SESSION_EVENT, RECIPIENT_SESSION_TTL_MS } from '../lib/recipient-inbox.repository.js';
import { SignIdempotencyRepository } from '../lib/sign-idempotency.repository.js';
import { SignSavedSignatureRepository } from '../lib/sign-saved-signature.repository.js';
import { SignContactDuplicateError, SignContactRepository } from '../lib/sign-contact.repository.js';
import { SIGN_REMINDER_LIMITS } from '../lib/reminder-limits.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { hashSigningToken } from '../lib/signing-token.js';
import {
  EnvelopeRevisionMismatchError,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  InboxSigningRefusedError,
  ReminderLimitError,
} from '../lib/domain/envelope-contract-errors.js';

// Aramo Sign Mobile — the envelope contracts on real Postgres 17:
//   M-A3 §6  the DB-owned revision: exactly +1 per transaction on EVERY write path
//            (enumerated below, plus the trigger inventory), If-Match under the row lock;
//   M-A3 §3  the sender message is immutable after send (DB-enforced);
//   M-A3 §7  reminder limits hold under PARALLEL requests;
//   M-A3 §7/§8 request idempotency (scope, reuse, replay, expiry, concurrency);
//   M-A2 §2.2 inbox signing revalidation (every refusal reason) + the ledger audit;
//   M-A3 §4/§5/§9 saved signatures and contacts: owner isolation, and deleting a
//            saved signature never changes an executed document's evidence.

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign Mobile envelope contracts — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;
  let sender: EsignSenderRepository;
  let inbox: RecipientInboxRepository;
  let idem: SignIdempotencyRepository;
  let saved: SignSavedSignatureRepository;
  let contacts: SignContactRepository;

  const TENANT = randomUUID();
  const OTHER_TENANT = randomUUID();
  const USER = randomUUID();
  const OTHER_USER = randomUUID();

  const rev = async (id: string): Promise<number> => (await db.query(`SELECT revision FROM "sign"."SignatureEnvelope" WHERE id = $1`, [id])).rows[0].revision as number;

  // A Sign-console draft with one document, `signers` recipients and a SIGNATURE field each.
  async function readyDraft(signers = 1, routing: 'PARALLEL' | 'SEQUENTIAL' = 'PARALLEL') {
    const env = await sender.createDraft({ tenant_id: TENANT, subject: 'Agreement', created_by: USER });
    if (routing === 'SEQUENTIAL') await sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, routing_mode: 'SEQUENTIAL' });
    const doc = await sender.addDraftDocument({
      tenant_id: TENANT, envelope_id: env.id, actor_ref: USER, title: 'Agreement', source_object_key: `k/${env.id}`,
      content_type: 'application/pdf', byte_size: 100, source_sha256: 'a'.repeat(64),
    });
    const people = await sender.replaceDraftRecipients({
      tenant_id: TENANT, envelope_id: env.id,
      recipients: Array.from({ length: signers }, (_, i) => ({ name: `Signer ${i + 1}`, email: `s${i + 1}.${env.id.slice(0, 8)}@x.test` })),
    });
    await sender.replaceDraftFields({
      tenant_id: TENANT, envelope_id: env.id,
      fields: people.map((p, i) => ({ envelope_document_id: doc.id, signer_id: p.id, field_type: 'SIGNATURE', page_number: 0, x: 10 + i * 50, y: 10, width: 40, height: 20, required: true })),
    });
    return { id: env.id, doc, signers: people };
  }

  async function sent(signers = 1, routing: 'PARALLEL' | 'SEQUENTIAL' = 'PARALLEL') {
    const d = await readyDraft(signers, routing);
    const { sessions } = await service.send(TENANT, d.id, USER);
    return { ...d, sessions };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner());
    sender = new EsignSenderRepository(prisma, repo);
    inbox = new RecipientInboxRepository(prisma, repo);
    idem = new SignIdempotencyRepository(prisma);
    saved = new SignSavedSignatureRepository(prisma);
    contacts = new SignContactRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  describe('M-A3 §6 — the revision validator', () => {
    it('trigger inventory: the envelope and every child table that holds envelope state carry the revision trigger', async () => {
      const rows = await db.query(
        `SELECT c.relname AS table, t.tgname AS trigger FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'sign' AND NOT t.tgisinternal AND t.tgname LIKE '%revision%' ORDER BY 1, 2`,
      );
      expect(rows.rows).toEqual([
        { table: 'EnvelopeDocument', trigger: 'envelope_document_revision_touch' },
        { table: 'SignatureEnvelope', trigger: 'signature_envelope_revision_bump' },
        { table: 'SignatureEnvelope', trigger: 'signature_envelope_revision_insert' },
        { table: 'SignatureEvent', trigger: 'signature_event_revision_touch' },
        { table: 'SignatureField', trigger: 'signature_field_revision_touch' },
        { table: 'Signer', trigger: 'signer_revision_touch' },
        { table: 'SignerDisclosureAcceptance', trigger: 'signer_disclosure_revision_touch' },
      ]);
    });

    it('a new envelope starts at 1 — its creating transaction (with the ENVELOPE_CREATED event) does not count', async () => {
      const env = await sender.createDraft({ tenant_id: TENANT, subject: 'New', created_by: USER });
      expect(await rev(env.id)).toBe(1);
    });

    it('every sender authoring path raises it by exactly one per transaction, however many rows it writes', async () => {
      const env = await sender.createDraft({ tenant_id: TENANT, subject: 'A', created_by: USER });
      const steps: Array<[string, () => Promise<unknown>]> = [];
      let doc1 = '';
      let doc2 = '';
      let signer = '';
      steps.push(['subject', () => sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, subject: 'B' })]);
      steps.push(['routing', () => sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, routing_mode: 'SEQUENTIAL' })]);
      steps.push(['message', () => sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, message: 'Hi' })]);
      steps.push(['document upload', async () => {
        doc1 = (await sender.addDraftDocument({ tenant_id: TENANT, envelope_id: env.id, actor_ref: USER, title: 'One', source_object_key: 'k1', content_type: 'application/pdf', byte_size: 1, source_sha256: 'a'.repeat(64) })).id;
      }]);
      steps.push(['template (CORE_REF) document', async () => {
        doc2 = (await sender.addDraftCoreRefDocument({ tenant_id: TENANT, envelope_id: env.id, actor_ref: USER, title: 'Two', document_ref: randomUUID(), document_revision_ref: randomUUID(), source_sha256: 'b'.repeat(64) })).id;
      }]);
      steps.push(['rename', () => sender.renameDraftDocument({ tenant_id: TENANT, envelope_id: env.id, document_id: doc1, title: 'One!' })]);
      steps.push(['reorder (4 row updates)', () => sender.reorderDraftDocuments({ tenant_id: TENANT, envelope_id: env.id, order: [doc2, doc1] })]);
      steps.push(['recipients', async () => {
        signer = (await sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: env.id, recipients: [{ name: 'A', email: 'a@x.test' }, { name: 'B', email: 'b@x.test' }] }))[0]!.id;
      }]);
      steps.push(['fields', () => sender.replaceDraftFields({ tenant_id: TENANT, envelope_id: env.id, fields: [{ envelope_document_id: doc1, signer_id: signer, field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true }] })]);
      steps.push(['remove document (fields + document + reorder + event)', () => sender.removeDraftDocument({ tenant_id: TENANT, envelope_id: env.id, document_id: doc2, actor_ref: USER })]);
      let expected = 1;
      for (const [name, run] of steps) {
        await run();
        expected += 1;
        expect({ step: name, revision: await rev(env.id) }).toEqual({ step: name, revision: expected });
      }
      // updateDraft returns the revision its own transaction produced.
      expect(await sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, subject: 'C' })).toBe(expected + 1);
    });

    it('every lifecycle, signer, reminder, expiry, inbox and ATS path raises it', async () => {
      const bump = async (name: string, id: string, run: () => Promise<unknown>) => {
        const before = await rev(id);
        await run();
        expect({ path: name, delta: (await rev(id)) - before }).toEqual({ path: name, delta: 1 });
      };
      // send → exchange → disclosure → fill → complete (first of two) → remind → complete (last)
      const d = await readyDraft(2);
      let sessions: Awaited<ReturnType<EsignService['send']>>['sessions'] = [];
      await bump('send', d.id, async () => {
        sessions = (await service.send(TENANT, d.id, USER)).sessions;
      });
      const ctx1 = await service.resolveSession(sessions[0]!.raw_token);
      await bump('exchange (view)', d.id, () => service.exchangeToken(sessions[0]!.raw_token));
      await bump('disclosure', d.id, () => service.acceptDisclosure(ctx1, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 }));
      const f1 = (await db.query(`SELECT id FROM "sign"."SignatureField" WHERE signer_id = $1`, [d.signers[0]!.id])).rows[0].id;
      await bump('signer fill', d.id, () => service.fillField(ctx1, f1, { value: PNG, signature_method: 'DRAWN' }));
      await bump('complete (not last)', d.id, () => service.completeSigner(ctx1));
      await bump('remind', d.id, () => service.remindSigner(TENANT, d.id, USER));
      const fresh = (await db.query(`SELECT id FROM "sign"."SigningSession" WHERE signer_id = $1 AND status = 'ISSUED'`, [d.signers[1]!.id])).rows;
      expect(fresh).toHaveLength(1);

      const v = await sent();
      await bump('void', v.id, () => service.voidEnvelope(TENANT, v.id, USER, 'wrong'));
      const dec = await sent();
      await bump('decline', dec.id, () => service.decline(TENANT, dec.id, dec.signers[0]!.id, 'no'));
      const ex = await sent();
      await db.query(`UPDATE "sign"."SignatureEnvelope" SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ex.id]);
      await bump('expiry sweep', ex.id, () => service.expireDueEnvelopes(new Date()));
      expect((await db.query(`SELECT status FROM "sign"."SignatureEnvelope" WHERE id = $1`, [ex.id])).rows[0].status).toBe('EXPIRED');

      const ib = await sent();
      const session = (await db.query(`SELECT id FROM "sign"."SigningSession" WHERE signer_id = $1`, [ib.signers[0]!.id])).rows[0].id as string;
      const binding = await inbox.bind({ envelope_tenant_id: TENANT, envelope_id: ib.id, signer_id: ib.signers[0]!.id, user_id: OTHER_USER, user_tenant_id: OTHER_TENANT, email: ib.signers[0]!.email.toLowerCase(), claim_session_id: session });
      await bump('inbox session', ib.id, () => inbox.issueRevalidatedRecipientSession(OTHER_USER, binding.id));

      // ATS internal create path: one statement per transaction.
      const ats = await repo.createEnvelope({ tenant_id: TENANT, subject: 'RTR', execution_mode: 'SINGLE_SIGNATURE', created_by: USER, source_application: 'aramo-ats' });
      expect(await rev(ats.id)).toBe(1);
      let atsDoc = '';
      let atsSigner = '';
      await bump('ATS add document', ats.id, async () => {
        atsDoc = (await repo.addDocument({ tenant_id: TENANT, envelope_id: ats.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'rtr', source_sha256: 'c'.repeat(64), ordinal: 1 })).id;
      });
      await bump('ATS add signer', ats.id, async () => {
        atsSigner = (await repo.addSigner({ tenant_id: TENANT, envelope_id: ats.id, email: 'r@x.test', name: 'R', signing_order: 1 })).id;
      });
      await bump('ATS add field', ats.id, () => repo.addField({ tenant_id: TENANT, envelope_document_id: atsDoc, signer_id: atsSigner, field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1 }));
    });

    it('the application can never set the revision itself', async () => {
      const env = await sender.createDraft({ tenant_id: TENANT, subject: 'A', created_by: USER });
      await db.query(`UPDATE "sign"."SignatureEnvelope" SET revision = 999 WHERE id = $1`, [env.id]);
      expect(await rev(env.id)).toBe(2);
    });

    it('If-Match under the row lock: of parallel writers holding the same revision exactly one wins', async () => {
      const env = await sender.createDraft({ tenant_id: TENANT, subject: 'A', created_by: USER });
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, subject: `writer ${i}`, expected_revision: 1 })),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(4);
      for (const l of lost) {
        expect(l.reason).toBeInstanceOf(EnvelopeRevisionMismatchError);
        expect((l.reason as EnvelopeRevisionMismatchError).currentRevision).toBe(2);
      }
      expect(await rev(env.id)).toBe(2);
    });

    it('a stale If-Match refuses send and void without any change; the current one succeeds', async () => {
      const d = await readyDraft();
      const current = await rev(d.id);
      await expect(service.send(TENANT, d.id, USER, { expected_revision: current - 1 })).rejects.toBeInstanceOf(EnvelopeRevisionMismatchError);
      expect((await db.query(`SELECT status FROM "sign"."SignatureEnvelope" WHERE id = $1`, [d.id])).rows[0].status).toBe('DRAFT');
      expect((await db.query(`SELECT count(*)::int n FROM "sign"."SigningSession" WHERE envelope_id = $1`, [d.id])).rows[0].n).toBe(0);
      await service.send(TENANT, d.id, USER, { expected_revision: current });
      const afterSend = await rev(d.id);
      await expect(service.voidEnvelope(TENANT, d.id, USER, 'x', { expected_revision: afterSend - 1 })).rejects.toBeInstanceOf(EnvelopeRevisionMismatchError);
      expect((await db.query(`SELECT status FROM "sign"."SignatureEnvelope" WHERE id = $1`, [d.id])).rows[0].status).toBe('SENT');
      await service.voidEnvelope(TENANT, d.id, USER, 'x', { expected_revision: afterSend });
      expect((await db.query(`SELECT status FROM "sign"."SignatureEnvelope" WHERE id = $1`, [d.id])).rows[0].status).toBe('VOIDED');
    });
  });

  describe('M-A3 §3 — the sender message', () => {
    it('is settable in DRAFT, recorded on ENVELOPE_SENT as sender-supplied text, and immutable after send', async () => {
      const d = await readyDraft();
      await sender.updateDraft({ tenant_id: TENANT, envelope_id: d.id, message: 'Please sign by Friday.' });
      await service.send(TENANT, d.id, USER);
      const ev = (await db.query(`SELECT payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = 'ENVELOPE_SENT'`, [d.id])).rows[0];
      expect(ev.payload).toEqual({ sender_message: 'Please sign by Friday.', sender_message_source: 'SENDER_SUPPLIED' });
      await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET message = 'changed' WHERE id = $1`, [d.id])).rejects.toThrow(/immutable after send/);
      await expect(sender.updateDraft({ tenant_id: TENANT, envelope_id: d.id, message: 'x' })).rejects.toThrow();
      // Not in the evidence manifest's fields.
      const manifest = await service.evidenceManifest(TENANT, d.id);
      expect(JSON.stringify(manifest)).not.toContain('Please sign by Friday.');
    });

    it('the database refuses more than 1000 characters', async () => {
      const env = await sender.createDraft({ tenant_id: TENANT, subject: 'A', created_by: USER });
      await expect(sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, message: 'x'.repeat(1001) })).rejects.toThrow();
    });
  });

  describe('M-A3 §7 — reminder limits are race-safe', () => {
    it('six PARALLEL reminders to one signer: exactly one is sent, five meet the 60-minute cooldown', async () => {
      const s = await sent(1);
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.remindSigner(TENANT, s.id, USER, s.signers[0]!.id, { limits: SIGN_REMINDER_LIMITS })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused).toHaveLength(5);
      for (const r of refused) expect((r.reason as ReminderLimitError).reason).toBe('reminder_cooldown');
      const n = (await db.query(`SELECT count(*)::int n FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = 'SIGNATURE_REMINDER_SENT'`, [s.id])).rows[0].n;
      expect(n).toBe(1);
      const live = (await db.query(`SELECT count(*)::int n FROM "sign"."SigningSession" WHERE signer_id = $1 AND status = 'ISSUED'`, [s.signers[0]!.id])).rows[0].n;
      expect(live).toBe(1);
    });

    it('six PARALLEL reminders to six different signers: exactly five are sent, one meets the rolling 24-hour limit', async () => {
      const s = await sent(6);
      const results = await Promise.allSettled(s.signers.map((g) => service.remindSigner(TENANT, s.id, USER, g.id, { limits: SIGN_REMINDER_LIMITS })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0]!.reason as ReminderLimitError).reason).toBe('reminder_daily_limit');
      const n = (await db.query(`SELECT count(*)::int n FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = 'SIGNATURE_REMINDER_SENT'`, [s.id])).rows[0].n;
      expect(n).toBe(5);
    });

    it('the cooldown ends after 60 minutes; without limits (ATS / integration paths) nothing changes', async () => {
      const s = await sent(1);
      await service.remindSigner(TENANT, s.id, USER, undefined, { limits: SIGN_REMINDER_LIMITS });
      await db.query(`SET session_replication_role = replica`);
      await db.query(`UPDATE "sign"."SignatureEvent" SET occurred_at = now() - interval '61 minutes' WHERE envelope_id = $1 AND event_type = 'SIGNATURE_REMINDER_SENT'`, [s.id]);
      await db.query(`SET session_replication_role = origin`);
      await expect(service.remindSigner(TENANT, s.id, USER, undefined, { limits: SIGN_REMINDER_LIMITS })).resolves.toBeDefined();
      const u = await sent(1);
      await service.remindSigner(TENANT, u.id, USER);
      await expect(service.remindSigner(TENANT, u.id, USER)).resolves.toBeDefined();
    });
  });

  describe('M-A3 §7/§8 — request idempotency', () => {
    const scope = (over: Partial<{ tenant_id: string; actor_id: string; operation: string; key: string }> = {}) => ({ tenant_id: TENANT, actor_id: USER, operation: 'remind:x', key: `k-${randomUUID()}`, ...over });

    it('replay returns the stored response; another body is reuse; scope is (tenant, actor, operation, key)', async () => {
      const s = scope();
      const first = await idem.begin(s, 'h1');
      expect(first.kind).toBe('fresh');
      await expect(idem.begin(s, 'h1')).rejects.toBeInstanceOf(IdempotencyRequestInProgressError);
      await idem.complete((first as { id: string }).id, 200, { ok: 1 });
      await expect(idem.begin(s, 'h1')).resolves.toEqual({ kind: 'replay', status: 200, body: { ok: 1 } });
      await expect(idem.begin(s, 'h2')).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
      for (const other of [{ actor_id: OTHER_USER }, { tenant_id: OTHER_TENANT }, { operation: 'upload:x' }]) {
        expect((await idem.begin({ ...s, ...other }, 'h2')).kind).toBe('fresh');
      }
    });

    it('a key expires after 24 hours; a released key may be used again', async () => {
      const s = scope();
      const a = await idem.begin(s, 'h1');
      await idem.complete((a as { id: string }).id, 200, { n: 1 });
      await db.query(`UPDATE "sign"."SignIdempotencyKey" SET created_at = now() - interval '25 hours' WHERE key = $1`, [s.key]);
      expect((await idem.begin(s, 'other-body')).kind).toBe('fresh');
      const t = scope();
      const b = await idem.begin(t, 'h');
      await idem.release((b as { id: string }).id);
      expect((await idem.begin(t, 'h')).kind).toBe('fresh');
    });

    it('PARALLEL first requests with one key: exactly one runs', async () => {
      const s = scope();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => idem.begin(s, 'h')));
      expect(results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'fresh')).toHaveLength(1);
      const others = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(others).toHaveLength(5);
      for (const o of others) expect(o.reason).toBeInstanceOf(IdempotencyRequestInProgressError);
    });
  });

  describe('M-A2 §2.2 — inbox signing revalidates every time', () => {
    const BOB = randomUUID();
    async function claimed(opts: { signers?: number; routing?: 'PARALLEL' | 'SEQUENTIAL'; index?: number } = {}) {
      const s = await sent(opts.signers ?? 1, opts.routing ?? 'PARALLEL');
      const signer = s.signers[opts.index ?? 0]!;
      const raw = s.sessions.find((x) => x.signer_id === signer.id)?.raw_token;
      const session = raw === undefined ? null : (await db.query(`SELECT id FROM "sign"."SigningSession" WHERE token_hash = $1`, [hashSigningToken(raw)])).rows[0].id as string;
      const user = randomUUID();
      const b = await inbox.bind({ envelope_tenant_id: TENANT, envelope_id: s.id, signer_id: signer.id, user_id: user, user_tenant_id: OTHER_TENANT, email: signer.email.toLowerCase(), ...(session !== null ? { claim_session_id: session } : {}) });
      return { ...s, signer, session, user, binding: b.id };
    }
    const reason = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'issued';
      } catch (e) {
        if (e instanceof InboxSigningRefusedError) return e.reason;
        throw e;
      }
    };

    it('issues a single-signer session of at most 30 minutes, audited on the ledger; a foreign binding is not found', async () => {
      const c = await claimed();
      const before = Date.now();
      const out = await inbox.issueRevalidatedRecipientSession(c.user, c.binding);
      expect(out).not.toBeNull();
      expect(out!.expires_at.getTime()).toBeLessThanOrEqual(before + RECIPIENT_SESSION_TTL_MS + 1000);
      const row = (await db.query(`SELECT signer_id, envelope_id, status FROM "sign"."SigningSession" WHERE token_hash = $1`, [hashSigningToken(out!.raw_token)])).rows[0];
      expect(row).toEqual({ signer_id: c.signer.id, envelope_id: c.id, status: 'ISSUED' });
      const ev = (await db.query(`SELECT signer_id, actor_type, payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = $2`, [c.id, RECIPIENT_INBOX_SESSION_EVENT])).rows;
      expect(ev).toEqual([{ signer_id: c.signer.id, actor_type: 'SIGNER', payload: { origin: 'inbox', session_id: out!.session_id, binding_id: c.binding } }]);
      expect(await inbox.issueRevalidatedRecipientSession(BOB, c.binding)).toBeNull();
    });

    it('association_inactive — the user removed it', async () => {
      const c = await claimed();
      await inbox.revoke(c.user, c.binding);
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('association_inactive');
    });

    it('envelope_not_signable — voided, or past its expiry', async () => {
      const c = await claimed();
      await service.voidEnvelope(TENANT, c.id, USER, 'x');
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('envelope_not_signable');
      const e = await claimed();
      await db.query(`UPDATE "sign"."SignatureEnvelope" SET expires_at = now() - interval '1 second' WHERE id = $1`, [e.id]);
      expect(await reason(inbox.issueRevalidatedRecipientSession(e.user, e.binding))).toBe('envelope_not_signable');
    });

    it('signer_ineligible — already signed elsewhere, or the recipient email changed since the claim', async () => {
      const c = await claimed();
      await db.query(`UPDATE "sign"."Signer" SET status = 'SIGNED', signed_at = now() WHERE id = $1`, [c.signer.id]);
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('signer_ineligible');
      const m = await claimed();
      await db.query(`UPDATE "sign"."Signer" SET email = 'someone.else@x.test' WHERE id = $1`, [m.signer.id]);
      expect(await reason(inbox.issueRevalidatedRecipientSession(m.user, m.binding))).toBe('signer_ineligible');
    });

    it('not_your_turn — signing in order, an earlier signer has not signed', async () => {
      const c = await claimed({ signers: 2, routing: 'SEQUENTIAL', index: 1 });
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('not_your_turn');
    });

    it('session_revoked — a reminder replaced the claimed link; re-claiming with the newest link restores it (C-21)', async () => {
      const c = await claimed();
      const { sessions } = await service.remindSigner(TENANT, c.id, USER);
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('session_revoked');
      const newest = (await db.query(`SELECT id FROM "sign"."SigningSession" WHERE token_hash = $1`, [hashSigningToken(sessions[0]!.raw_token)])).rows[0].id as string;
      await inbox.bind({ envelope_tenant_id: TENANT, envelope_id: c.id, signer_id: c.signer.id, user_id: c.user, user_tenant_id: OTHER_TENANT, email: c.signer.email.toLowerCase(), claim_session_id: newest });
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('issued');
    });

    it('link_expired — and the inbox session never outlives the claimed link', async () => {
      const c = await claimed();
      await db.query(`UPDATE "sign"."SigningSession" SET expires_at = now() + interval '5 minutes' WHERE id = $1`, [c.session]);
      const linkEnd = (await db.query(`SELECT expires_at FROM "sign"."SigningSession" WHERE id = $1`, [c.session])).rows[0].expires_at as Date;
      const out = await inbox.issueRevalidatedRecipientSession(c.user, c.binding);
      expect(out!.expires_at.getTime()).toBe(linkEnd.getTime());
      await db.query(`UPDATE "sign"."SigningSession" SET expires_at = now() - interval '1 second' WHERE id = $1`, [c.session]);
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('link_expired');
    });

    it('a binding claimed before claim_session_id existed needs a live EMAILED link (an inbox session never extends it)', async () => {
      const c = await claimed();
      await db.query(`UPDATE "sign"."SignRecipientBinding" SET claim_session_id = NULL WHERE id = $1`, [c.binding]);
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('issued');
      await db.query(`UPDATE "sign"."SigningSession" SET status = 'REVOKED' WHERE id = $1`, [c.session]);
      // Only the 30-minute inbox session is live now.
      expect(await reason(inbox.issueRevalidatedRecipientSession(c.user, c.binding))).toBe('session_revoked');
    });
  });

  describe('M-A3 §4/§9 — saved signatures never touch executed records', () => {
    it('complete a document with the saved value, delete the saved signature, and the evidence is unchanged', async () => {
      await saved.put(TENANT, USER, 'signature', { kind: 'DRAWN', typed_name: null, font_key: null, image_data_url: PNG });
      const value = (await saved.list(TENANT, USER)).find((r) => r.slot === 'signature')!.image_data_url;
      const d = await readyDraft(1);
      const { sessions } = await service.send(TENANT, d.id, USER);
      const ctx = await service.exchangeToken(sessions[0]!.raw_token);
      await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
      const fieldId = (await db.query(`SELECT id FROM "sign"."SignatureField" WHERE signer_id = $1`, [d.signers[0]!.id])).rows[0].id as string;
      await service.fillField(ctx, fieldId, { value, signature_method: 'DRAWN' });
      expect((await service.completeSigner(ctx)).envelope_status).toBe('COMPLETED');
      const read = async () => ({
        field: (await db.query(`SELECT value, signature_method, filled_at FROM "sign"."SignatureField" WHERE id = $1`, [fieldId])).rows[0],
        chain: await repo.terminalEventHash(TENANT, d.id),
        events: (await db.query(`SELECT count(*)::int n FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [d.id])).rows[0].n,
        revision: await rev(d.id),
        manifest: (await service.evidenceManifest(TENANT, d.id)).manifest,
      });
      const before = await read();
      expect(before.field).toMatchObject({ value: PNG, signature_method: 'DRAWN' });
      expect(await saved.remove(TENANT, USER, 'signature')).toBe(true);
      expect(await saved.list(TENANT, USER)).toEqual([]);
      expect(await read()).toEqual(before);
    });

    it('owner isolation: another user or tenant can neither read nor delete it', async () => {
      await saved.put(TENANT, USER, 'initials', { kind: 'TYPED', typed_name: 'AL', font_key: 'caveat', image_data_url: PNG });
      expect(await saved.list(TENANT, OTHER_USER)).toEqual([]);
      expect(await saved.list(OTHER_TENANT, USER)).toEqual([]);
      expect(await saved.remove(TENANT, OTHER_USER, 'initials')).toBe(false);
      expect(await saved.remove(OTHER_TENANT, USER, 'initials')).toBe(false);
      expect((await saved.list(TENANT, USER)).map((r) => r.slot)).toEqual(['initials']);
      await expect(db.query(`INSERT INTO "sign"."SignSavedSignature" (id, tenant_id, user_id, slot, kind, image_data_url) VALUES (gen_random_uuid(), $1, $2, 'signature', 'DRAWN', 'data:image/svg+xml;base64,AAAA')`, [TENANT, OTHER_USER])).rejects.toThrow();
      expect(await saved.removeAllForUser(TENANT, USER)).toBe(1);
    });
  });

  describe('M-A3 §5/§9 — contacts are private per (tenant, owner)', () => {
    it('isolation across users and tenants; one contact per email (case-insensitive); account close removes them', async () => {
      const c = await contacts.create(TENANT, USER, { name: 'Ann', email: ' Ann@X.test ', organization: 'Acme' });
      expect(c).toMatchObject({ name: 'Ann', email: 'Ann@X.test', organization: 'Acme' });
      await expect(contacts.create(TENANT, USER, { name: 'Ann 2', email: 'ann@x.TEST', organization: null })).rejects.toBeInstanceOf(SignContactDuplicateError);
      // The same email is fine for another owner or tenant.
      await contacts.create(TENANT, OTHER_USER, { name: 'Ann', email: 'ann@x.test', organization: null });
      expect(await contacts.list(TENANT, OTHER_USER)).toHaveLength(1);
      expect(await contacts.list(OTHER_TENANT, USER)).toEqual([]);
      expect(await contacts.update(TENANT, OTHER_USER, c.id, { name: 'Hijack' })).toBeNull();
      expect(await contacts.update(OTHER_TENANT, USER, c.id, { name: 'Hijack' })).toBeNull();
      expect(await contacts.remove(TENANT, OTHER_USER, c.id)).toBe(false);
      expect((await contacts.update(TENANT, USER, c.id, { organization: null }))?.organization).toBeNull();
      await contacts.touchUsed(TENANT, USER, ['ANN@x.test']);
      expect((await contacts.list(TENANT, USER))[0]!.last_used_at).not.toBeNull();
      expect(await contacts.removeAllForUser(TENANT, USER)).toBe(1);
      expect(await contacts.list(TENANT, OTHER_USER)).toHaveLength(1);
    });
  });
});
