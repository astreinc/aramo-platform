import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService, envelopeExpiresAt } from '../lib/esign.service.js';
import { EnvelopeNotificationService } from '../lib/envelope-notification.service.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { DisclosureVersionInvalidError, SigningSessionExpiredError, SigningSessionInvalidError } from '../lib/domain/errors.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { type SigningNotification, type SigningNotificationPort } from '../lib/ports/signing-notification.port.js';
import { type SenderDirectoryPort } from '../lib/ports/sender-directory.port.js';
import { type ExecutionProducerPort } from '../lib/ports/execution-producer.port.js';
import { hashSigningToken } from '../lib/signing-token.js';

// Aramo Sign launch (Aramo-Sign-Standalone-Product-Final-Implementation-
// Authorization-v1_0) — product completeness on real Postgres 17:
//   1. Envelopes get an expiry date on send; the sweep expires overdue ones
//      (including legacy rows without expires_at) exactly once.
//   2. Disclosure acceptance requires a server-held version + its exact hash.
//   3. Lifecycle notifications reach signers and the console sender, every attempt
//      is recorded, and a delivery failure is recorded — never thrown.
//   4. Completion mints a signer download link that works only for that COMPLETED
//      envelope, only within its window; only the hash is stored.

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

class RecordingNotifier implements SigningNotificationPort {
  readonly sent: SigningNotification[] = [];
  failFor: string | null = null;
  async notify(n: SigningNotification) {
    if (this.failFor !== null && n.to_email === this.failFor) throw new Error('SES throttled');
    this.sent.push(n);
    return { delivered: true, provider_message_id: `msg-${this.sent.length}` };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Aramo Sign launch — lifecycle completeness (Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let notifier: RecordingNotifier;
  let notifications: EnvelopeNotificationService;
  let service: EsignService;

  const TENANT = randomUUID();
  const SENDER_USER = randomUUID();
  const directory: SenderDirectoryPort = {
    findSender: async (tenant_id, user_id) =>
      tenant_id === TENANT && user_id === SENDER_USER ? { email: 'sender@acme.test', name: 'Sam Sender' } : null,
  };
  const savedEnv = { ...process.env };

  // A SENT envelope; OWNED = authored in the Sign console, CORE_REF = from ATS.
  async function sendEnvelope(opts: { signers: number; owned: boolean; consoleTemplate?: boolean }) {
    // CORE_REF envelopes come from the ATS ('aramo-ats', as the native provider records);
    // DOC-TEMPLATE-LIB-1 T-5 — a console CORE_REF envelope ('aramo-sign') notifies the sender.
    const env = await repo.createEnvelope({
      tenant_id: TENANT, subject: 'Master Services Agreement', execution_mode: opts.signers > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE', created_by: SENDER_USER,
      ...(opts.owned || opts.consoleTemplate === true ? {} : { source_application: 'aramo-ats' }),
    });
    const doc = opts.owned
      ? await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, source_mode: 'OWNED', source_object_key: `k/${env.id}`, content_type: 'application/pdf', byte_size: 10, title: 'msa.pdf', source_sha256: 'abc', ordinal: 1 })
      : await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'rtr.pdf', source_sha256: 'abc', ordinal: 1 });
    const signers = [];
    for (let i = 1; i <= opts.signers; i++) {
      const s = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: `s${i}@x.test`, name: `Signer ${i}`, signing_order: i });
      const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: s.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100 + i * 40, required: true });
      signers.push({ id: s.id, fieldId: f.id });
    }
    const { sessions } = await service.send(TENANT, env.id, SENDER_USER);
    return { envelopeId: env.id, signers: signers.map((s) => ({ ...s, token: sessions.find((x) => x.signer_id === s.id)!.raw_token })) };
  }

  async function signAll(e: Awaited<ReturnType<typeof sendEnvelope>>) {
    for (const s of e.signers) {
      const ctx = await service.exchangeToken(s.token);
      await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
      await service.fillField(ctx, s.fieldId, { value: 'Signed', signature_method: 'TYPED' });
      await service.completeSigner(ctx);
    }
  }

  async function deliveries(envelopeId: string) {
    const r = await db.query(
      `SELECT notification_kind, signer_id, status, last_error FROM "sign"."NotificationDelivery" WHERE envelope_id = $1 ORDER BY created_at`,
      [envelopeId],
    );
    return r.rows as Array<{ notification_kind: string; signer_id: string | null; status: string; last_error: string | null }>;
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
  }, 120_000);

  beforeEach(() => {
    process.env['SIGN_WEB_BASE_URL'] = 'https://sign.example.test';
    process.env['SIGN_SENDER_WEB_BASE_URL'] = 'https://esign.example.test';
    notifier = new RecordingNotifier();
    notifications = new EnvelopeNotificationService(prisma, repo, notifier, directory);
    // Completion notifications run inside the execution producer in production;
    // here a producer that only notifies stands in for executed-bytes production.
    const producer: ExecutionProducerPort = {
      produce: async (tenant_id, envelope_id) => {
        await notifications.envelopeCompleted(tenant_id, envelope_id);
        return [];
      },
    };
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner(), producer);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  // ── 1. Expiry ──────────────────────────────────────────────────────────────
  describe('expiry', () => {
    it('send stamps an expiry date SIGN_ENVELOPE_TTL_DAYS ahead (default 30)', async () => {
      const before = Date.now();
      const e = await sendEnvelope({ signers: 1, owned: true });
      const env = await repo.getEnvelope(TENANT, e.envelopeId);
      const expected = envelopeExpiresAt(new Date(before)).getTime();
      expect(env.expires_at).not.toBeNull();
      expect(Math.abs(env.expires_at!.getTime() - expected)).toBeLessThan(60_000);
    });

    it('the sweep expires overdue envelopes once, revokes their links, and skips finished ones', async () => {
      const overdue = await sendEnvelope({ signers: 1, owned: true });
      const legacy = await sendEnvelope({ signers: 1, owned: true });
      const done = await sendEnvelope({ signers: 1, owned: true });
      await signAll(done);
      const past = new Date(Date.now() - 60_000);
      await db.query(`UPDATE "sign"."SignatureEnvelope" SET expires_at = $2 WHERE id = $1`, [overdue.envelopeId, past]);
      await db.query(`UPDATE "sign"."SignatureEnvelope" SET expires_at = NULL, sent_at = now() - interval '400 days' WHERE id = $1`, [legacy.envelopeId]);
      await db.query(`UPDATE "sign"."SignatureEnvelope" SET expires_at = $2 WHERE id = $1`, [done.envelopeId, past]);

      const first = await service.expireDueEnvelopes(new Date());
      const expiredIds = first.map((x) => x.envelope_id);
      expect(expiredIds).toEqual(expect.arrayContaining([overdue.envelopeId, legacy.envelopeId]));
      expect(expiredIds).not.toContain(done.envelopeId);
      expect((await repo.getEnvelope(TENANT, overdue.envelopeId)).status).toBe('EXPIRED');
      expect((await repo.getEnvelope(TENANT, done.envelopeId)).status).toBe('COMPLETED');
      await expect(service.exchangeToken(overdue.signers[0]!.token)).rejects.toBeTruthy();

      const second = await service.expireDueEnvelopes(new Date());
      expect(second.map((x) => x.envelope_id)).not.toContain(overdue.envelopeId);
    });

    it('expiry notifies open signers and the console sender', async () => {
      const e = await sendEnvelope({ signers: 1, owned: true });
      await db.query(`UPDATE "sign"."SignatureEnvelope" SET expires_at = now() - interval '1 minute' WHERE id = $1`, [e.envelopeId]);
      const expired = await service.expireDueEnvelopes(new Date());
      for (const x of expired.filter((y) => y.envelope_id === e.envelopeId)) await notifications.envelopeExpired(x.tenant_id, x.envelope_id);
      const kinds = notifier.sent.filter((n) => n.kind === 'SIGNATURE_EXPIRED');
      expect(kinds.map((n) => n.audience ?? 'SIGNER').sort()).toEqual(['SENDER', 'SIGNER']);
      // Sign Unified Product S-2 — one Sign origin: the console link uses the same
      // base as signer links (SIGN_WEB_BASE_URL wins over the pre-S-2 sender name).
      expect(kinds.find((n) => n.audience === 'SENDER')?.console_url).toBe(`https://sign.example.test/sign/envelopes/${e.envelopeId}`);
    });
  });

  // ── 2. Disclosure ──────────────────────────────────────────────────────────
  describe('server-held disclosure', () => {
    it('refuses an unknown version or a mismatching hash, accepts the current one', async () => {
      const e = await sendEnvelope({ signers: 1, owned: true });
      const ctx = await service.exchangeToken(e.signers[0]!.token);
      await expect(service.acceptDisclosure(ctx, { disclosure_version: 'v999', disclosure_text_hash: DISCLOSURE.text_sha256 })).rejects.toBeInstanceOf(DisclosureVersionInvalidError);
      await expect(service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: 'a'.repeat(64) })).rejects.toBeInstanceOf(DisclosureVersionInvalidError);
      await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
      const r = await db.query(`SELECT disclosure_version, disclosure_text_hash FROM "sign"."SignerDisclosureAcceptance" WHERE signer_id = $1`, [ctx.signer_id]);
      expect(r.rows).toEqual([{ disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 }]);
    });
  });

  // ── 3. Notifications ───────────────────────────────────────────────────────
  describe('lifecycle notifications', () => {
    it('completion: every signer gets a download link, the console sender is told, all recorded SENT', async () => {
      const e = await sendEnvelope({ signers: 2, owned: true });
      await signAll(e);
      const done = notifier.sent.filter((n) => n.kind === 'SIGNATURE_COMPLETED');
      const toSigners = done.filter((n) => (n.audience ?? 'SIGNER') === 'SIGNER');
      expect(toSigners).toHaveLength(2);
      for (const n of toSigners) expect(n.download_url).toMatch(/^https:\/\/sign\.example\.test\/d\/[A-Za-z0-9_-]{40,}$/);
      expect(done.filter((n) => n.audience === 'SENDER').map((n) => n.to_email)).toEqual(['sender@acme.test']);
      const rows = (await deliveries(e.envelopeId)).filter((r) => r.notification_kind === 'SIGNATURE_COMPLETED');
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === 'SENT')).toBe(true);
    });

    it('an ATS-originated (CORE_REF) envelope does not email a sender — ATS behaviour unchanged', async () => {
      const e = await sendEnvelope({ signers: 1, owned: false });
      await signAll(e);
      expect(notifier.sent.filter((n) => n.audience === 'SENDER')).toHaveLength(0);
      expect(notifier.sent.filter((n) => n.kind === 'SIGNATURE_COMPLETED')).toHaveLength(1);
    });

    // DOC-TEMPLATE-LIB-1 T-5 — a console envelope started from a template holds a CORE_REF
    // document but is Sign-authored ('aramo-sign'): its sender is told like any console sender.
    it('a console envelope started from a template (CORE_REF, aramo-sign) emails its sender', async () => {
      const e = await sendEnvelope({ signers: 1, owned: false, consoleTemplate: true });
      await signAll(e);
      expect(notifier.sent.filter((n) => n.audience === 'SENDER' && n.kind === 'SIGNATURE_COMPLETED').map((n) => n.to_email)).toEqual(['sender@acme.test']);
    });

    it('decline: the sender gets the reason, other open signers are told, the decliner is not', async () => {
      const e = await sendEnvelope({ signers: 2, owned: true });
      const ctx = await service.exchangeToken(e.signers[0]!.token);
      await service.decline(TENANT, e.envelopeId, ctx.signer_id, 'Wrong rate', ctx.session_id);
      await notifications.envelopeDeclined(TENANT, e.envelopeId, ctx.signer_id, 'Wrong rate');
      const declined = notifier.sent.filter((n) => n.kind === 'SIGNATURE_DECLINED');
      expect(declined.find((n) => n.audience === 'SENDER')?.reason).toBe('Signer 1: Wrong rate');
      expect(declined.filter((n) => (n.audience ?? 'SIGNER') === 'SIGNER').map((n) => n.to_email)).toEqual(['s2@x.test']);
    });

    it('void: open signers learn the request was withdrawn, with the reason', async () => {
      const e = await sendEnvelope({ signers: 2, owned: true });
      await service.voidEnvelope(TENANT, e.envelopeId, SENDER_USER, 'Sent by mistake');
      await notifications.envelopeVoided(TENANT, e.envelopeId, 'Sent by mistake');
      const voided = notifier.sent.filter((n) => n.kind === 'SIGNATURE_VOIDED');
      expect(voided.map((n) => n.to_email).sort()).toEqual(['s1@x.test', 's2@x.test']);
      expect(voided.every((n) => n.reason === 'Sent by mistake')).toBe(true);
    });

    it('a delivery failure is recorded FAILED with the error, never thrown', async () => {
      const e = await sendEnvelope({ signers: 2, owned: true });
      notifier.failFor = 's2@x.test';
      await service.voidEnvelope(TENANT, e.envelopeId, SENDER_USER, 'Superseded');
      await expect(notifications.envelopeVoided(TENANT, e.envelopeId, 'Superseded')).resolves.toBeUndefined();
      const rows = (await deliveries(e.envelopeId)).filter((r) => r.notification_kind === 'SIGNATURE_VOIDED');
      expect(rows.map((r) => r.status).sort()).toEqual(['FAILED', 'SENT']);
      expect(rows.find((r) => r.status === 'FAILED')?.last_error).toBe('SES throttled');
    });
  });

  // ── 4. Signed-copy access ──────────────────────────────────────────────────
  describe('signer signed-copy access', () => {
    it('the emailed link resolves to its own completed envelope; only the hash is stored', async () => {
      const e = await sendEnvelope({ signers: 1, owned: true });
      await signAll(e);
      const url = notifier.sent.find((n) => n.kind === 'SIGNATURE_COMPLETED' && n.download_url)!.download_url!;
      const raw = url.split('/d/')[1]!;
      const grant = await service.resolveExecutedAccess(raw);
      expect(grant).toEqual({ tenant_id: TENANT, envelope_id: e.envelopeId, signer_id: e.signers[0]!.id });
      const stored = await db.query(`SELECT count(*)::int AS n FROM "sign"."ExecutedAccessGrant" WHERE token_hash = $1`, [raw]);
      expect(stored.rows[0].n).toBe(0);
      const hashed = await db.query(`SELECT access_count FROM "sign"."ExecutedAccessGrant" WHERE token_hash = $1`, [hashSigningToken(raw)]);
      expect(hashed.rows[0].access_count).toBe(1);
    });

    it('an unknown or expired link is refused', async () => {
      await expect(service.resolveExecutedAccess('not-a-real-token')).rejects.toBeInstanceOf(SigningSessionInvalidError);
      const e = await sendEnvelope({ signers: 1, owned: true });
      await signAll(e);
      const raw = notifier.sent.find((n) => n.download_url)!.download_url!.split('/d/')[1]!;
      await db.query(`UPDATE "sign"."ExecutedAccessGrant" SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [hashSigningToken(raw)]);
      await expect(service.resolveExecutedAccess(raw)).rejects.toBeInstanceOf(SigningSessionExpiredError);
    });

    it('no link is minted when no Sign origin is configured', async () => {
      // Sign Unified Product S-2 — ARAMO_SIGN_BASE_URL, then the two pre-S-2 names.
      delete process.env['ARAMO_SIGN_BASE_URL'];
      delete process.env['SIGN_WEB_BASE_URL'];
      delete process.env['SIGN_SENDER_WEB_BASE_URL'];
      const e = await sendEnvelope({ signers: 1, owned: true });
      await signAll(e);
      const n = notifier.sent.find((x) => x.kind === 'SIGNATURE_COMPLETED' && (x.audience ?? 'SIGNER') === 'SIGNER')!;
      expect(n.download_url).toBeUndefined();
      const grants = await db.query(`SELECT count(*)::int AS n FROM "sign"."ExecutedAccessGrant" WHERE envelope_id = $1`, [e.envelopeId]);
      expect(grants.rows[0].n).toBe(0);
    });
  });
});
