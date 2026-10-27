import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';
import { EsignSenderRepository } from '../lib/sender-workspace.repository.js';
import { SigningInvitationService } from '../lib/signing-invitation.service.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { type ExecutionProducerPort } from '../lib/ports/execution-producer.port.js';
import { type SigningNotification, type SigningNotificationPort } from '../lib/ports/signing-notification.port.js';
import { generateSigningToken, signingSessionExpiresAt } from '../lib/signing-token.js';
import { ReminderNotAllowedError, SignerNotYetEligibleError } from '../lib/domain/errors.js';
import { AttestedNameRequiredError, SessionIssueRefusedError } from '../lib/domain/envelope-contract-errors.js';
import { hashSigningToken } from '../lib/signing-token.js';

// Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED (§3, §4, §6, §8) on real Postgres 17:
// parallel and sequential signing enforced by the ENGINE, the durable next-signer
// invitation (claim, issue, deliver, retry, cancel), per-signer reminders, reorder-
// safe signing order and per-signer field privacy.

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();

function signMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

class CountingProducer implements ExecutionProducerPort {
  readonly calls = new Map<string, number>();
  async produce(_tenant_id: string, envelope_id: string) {
    this.calls.set(envelope_id, (this.calls.get(envelope_id) ?? 0) + 1);
    return [];
  }
  produced(envelope_id: string): number {
    return this.calls.get(envelope_id) ?? 0;
  }
}

// Captures invitations (the raw link is kept in memory only, never logged).
class FakeNotifier implements SigningNotificationPort {
  readonly sent: SigningNotification[] = [];
  failNext = 0;
  async notify(n: SigningNotification) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('provider outage');
    }
    this.sent.push(n);
    return { delivered: true };
  }
  tokenFor(email: string): string {
    const n = [...this.sent].reverse().find((x) => x.to_email === email && x.kind === 'SIGNATURE_REQUEST');
    if (n?.signing_url === undefined) throw new Error(`no invitation for ${email}`);
    return n.signing_url.slice(n.signing_url.lastIndexOf('/s/') + 3);
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Multi-signer — parallel and sequential, real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let senderRepo: EsignSenderRepository;
  let service: EsignService;
  let producer: CountingProducer;
  let notifier: FakeNotifier;
  let invitations: SigningInvitationService;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  interface Signer {
    signerId: string;
    fieldId: string;
    email: string;
    token?: string;
  }
  interface Sent {
    envelopeId: string;
    signers: Signer[];
  }

  async function sendEnvelope(n: number, routing: 'PARALLEL' | 'SEQUENTIAL' = 'PARALLEL'): Promise<Sent> {
    const env = await repo.createEnvelope({
      tenant_id: TENANT, subject: 'Agreement', execution_mode: n > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE', created_by: ACTOR, routing_mode: routing,
    });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'agreement.pdf', source_sha256: 'abc', ordinal: 1,
    });
    const signers: Signer[] = [];
    for (let i = 1; i <= n; i++) {
      const email = `s${i}-${env.id.slice(0, 8)}@x.com`;
      const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email, name: `Signer ${i}`, signing_order: i });
      const field = await repo.addField({
        tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100 + i * 30, required: true,
      });
      signers.push({ signerId: signer.id, fieldId: field.id, email });
    }
    const { sessions } = await service.send(TENANT, env.id, ACTOR);
    for (const s of signers) s.token = sessions.find((x) => x.signer_id === s.signerId)?.raw_token;
    return { envelopeId: env.id, signers };
  }

  async function sign(s: { fieldId: string; token?: string }): Promise<{ ctx: SessionContext; result: { envelope_status: string; next_signer_id?: string } }> {
    if (s.token === undefined) throw new Error('signer holds no link');
    const ctx = await service.exchangeToken(s.token);
    await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
    await service.fillField(ctx, s.fieldId, { value: 'Signed', signature_method: 'TYPED' });
    return { ctx, result: await service.completeSigner(ctx) };
  }

  // A live session for a signer created directly — a leaked or guessed link that the
  // engine must still refuse while it is not that signer's turn.
  async function forgeSession(envelopeId: string, signerId: string): Promise<string> {
    const tok = generateSigningToken();
    await prisma.signingSession.create({
      data: { id: randomUUID(), tenant_id: TENANT, envelope_id: envelopeId, signer_id: signerId, token_hash: tok.hash, status: 'ISSUED', expires_at: signingSessionExpiresAt(new Date()) },
    });
    return tok.raw;
  }

  async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await db.query(sql, params)).rows as T[];
  }
  const status = async (id: string) => (await repo.getEnvelope(TENANT, id)).status;
  const liveSessions = async (envelopeId: string, signerId?: string) =>
    Number(
      (await q<{ n: string }>(
        `SELECT count(*) AS n FROM "sign"."SigningSession" WHERE envelope_id=$1 AND status IN ('ISSUED','EXCHANGED','ACTIVE')${signerId ? ' AND signer_id=$2' : ''}`,
        signerId ? [envelopeId, signerId] : [envelopeId],
      ))[0]!.n,
    );
  const intents = (envelopeId: string) =>
    q<{ signer_id: string; status: string; attempts: number }>(
      `SELECT signer_id, status, attempts FROM "sign"."NotificationDelivery" WHERE envelope_id=$1 AND notification_kind='SIGNATURE_REQUEST' ORDER BY created_at`,
      [envelopeId],
    );

  beforeAll(async () => {
    process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.test';
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of signMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    senderRepo = new EsignSenderRepository(prisma, repo);
  }, 120_000);

  beforeEach(() => {
    producer = new CountingProducer();
    notifier = new FakeNotifier();
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner(), producer);
    invitations = new SigningInvitationService(prisma, repo, notifier);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  describe('parallel (Sign in any order)', () => {
    it('10 signers each get a live link at send, sign in reverse order, and the envelope completes exactly once on the last', async () => {
      const e = await sendEnvelope(10);
      expect(e.signers.every((s) => s.token !== undefined)).toBe(true);
      expect(await liveSessions(e.envelopeId)).toBe(10);
      const reversed = [...e.signers].reverse();
      for (const [i, s] of reversed.entries()) {
        const { result } = await sign(s);
        expect(result.envelope_status).toBe(i === reversed.length - 1 ? 'COMPLETED' : 'IN_PROGRESS');
        expect(result.next_signer_id).toBeUndefined(); // parallel never records invitations
      }
      expect(await status(e.envelopeId)).toBe('COMPLETED');
      expect(producer.produced(e.envelopeId)).toBe(1);
      expect(await intents(e.envelopeId)).toEqual([]);
    });

    it('two final signatures racing complete the envelope exactly once', async () => {
      for (let round = 0; round < 6; round++) {
        const e = await sendEnvelope(3);
        await sign(e.signers[0]!);
        const prepared = await Promise.all(
          e.signers.slice(1).map(async (s) => {
            const ctx = await service.exchangeToken(s.token!);
            await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
            await service.fillField(ctx, s.fieldId, { value: 'Signed', signature_method: 'TYPED' });
            return ctx;
          }),
        );
        const results = await Promise.all(prepared.map((ctx) => service.completeSigner(ctx)));
        expect(results.filter((r) => r.envelope_status === 'COMPLETED')).toHaveLength(1);
        expect(producer.produced(e.envelopeId)).toBe(1);
        const completedEvents = await q(`SELECT 1 FROM "sign"."SignatureEvent" WHERE envelope_id=$1 AND event_type='ENVELOPE_COMPLETED'`, [e.envelopeId]);
        expect(completedEvents).toHaveLength(1);
      }
    });

    it('a signer sees only their own fields and never another signer’s value', async () => {
      const e = await sendEnvelope(2);
      await sign(e.signers[0]!);
      const ctx2 = await service.exchangeToken(e.signers[1]!.token!);
      await service.acceptDisclosure(ctx2, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
      const view = await service.getSignerDocumentView(ctx2);
      expect(view.fields.map((f) => f.field_id)).toEqual([e.signers[1]!.fieldId]);
      expect(view.fields.every((f) => f.value === null)).toBe(true);
      await expect(service.fillField(ctx2, e.signers[0]!.fieldId, { value: 'x' })).rejects.toThrow();
    });

    it('a reminder can target one signer; the others keep their links', async () => {
      const e = await sendEnvelope(3);
      const { sessions } = await service.remindSigner(TENANT, e.envelopeId, ACTOR, e.signers[1]!.signerId);
      expect(sessions.map((s) => s.signer_id)).toEqual([e.signers[1]!.signerId]);
      await expect(service.exchangeToken(e.signers[0]!.token!)).resolves.toBeDefined(); // untouched
      await expect(service.exchangeToken(e.signers[1]!.token!)).rejects.toThrow(); // re-issued
      await sign(e.signers[0]!);
      await expect(service.remindSigner(TENANT, e.envelopeId, ACTOR, e.signers[0]!.signerId)).rejects.toBeInstanceOf(ReminderNotAllowedError);
    });
  });

  describe('sequential (Sign in order)', () => {
    it('only the first signer holds a link at send', async () => {
      const e = await sendEnvelope(3, 'SEQUENTIAL');
      expect(e.signers.map((s) => s.token !== undefined)).toEqual([true, false, false]);
      expect(await liveSessions(e.envelopeId)).toBe(1);
    });

    it('the ENGINE refuses a later signer acting early, whatever link they hold (exchange, view, fill, complete)', async () => {
      const e = await sendEnvelope(3, 'SEQUENTIAL');
      const early = await forgeSession(e.envelopeId, e.signers[2]!.signerId);
      await expect(service.exchangeToken(early)).rejects.toBeInstanceOf(SignerNotYetEligibleError);
      const ctx: SessionContext = await service.resolveSession(early); // resolve is read-only
      await expect(service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 })).rejects.toBeInstanceOf(SignerNotYetEligibleError);
      await expect(service.getSignerDocumentView(ctx)).rejects.toBeInstanceOf(SignerNotYetEligibleError);
      await expect(service.fillField(ctx, e.signers[2]!.fieldId, { value: 'x' })).rejects.toBeInstanceOf(SignerNotYetEligibleError);
      await expect(service.completeSigner(ctx)).rejects.toBeInstanceOf(SignerNotYetEligibleError);
      await expect(service.decline(TENANT, e.envelopeId, ctx.signer_id, 'no', ctx.session_id)).rejects.toBeInstanceOf(SignerNotYetEligibleError);
      // nothing moved: signer 3 still PENDING, envelope still SENT
      expect((await q<{ status: string }>(`SELECT status FROM "sign"."Signer" WHERE id=$1`, [e.signers[2]!.signerId]))[0]!.status).toBe('PENDING');
      expect(await status(e.envelopeId)).toBe('SENT');
    });

    it('each completion records ONE durable invitation for the next signer; dispatch issues the link and emails it; the envelope completes only after the last', async () => {
      const e = await sendEnvelope(3, 'SEQUENTIAL');
      const r1 = await sign(e.signers[0]!);
      expect(r1.result).toEqual({ envelope_status: 'IN_PROGRESS', next_signer_id: e.signers[1]!.signerId });
      expect(await intents(e.envelopeId)).toEqual([{ signer_id: e.signers[1]!.signerId, status: 'PENDING', attempts: 0 }]);
      expect(await liveSessions(e.envelopeId, e.signers[1]!.signerId)).toBe(0); // the link is issued by the dispatcher

      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(1);
      expect(await intents(e.envelopeId)).toEqual([{ signer_id: e.signers[1]!.signerId, status: 'SENT', attempts: 1 }]);
      e.signers[1]!.token = notifier.tokenFor(e.signers[1]!.email);
      expect(await status(e.envelopeId)).not.toBe('COMPLETED');

      await sign(e.signers[1]!);
      await invitations.dispatch({ envelope_id: e.envelopeId });
      e.signers[2]!.token = notifier.tokenFor(e.signers[2]!.email);
      const last = await sign(e.signers[2]!);
      expect(last.result.envelope_status).toBe('COMPLETED');
      expect(producer.produced(e.envelopeId)).toBe(1);
      expect(notifier.sent.filter((n) => n.kind === 'SIGNATURE_REQUEST')).toHaveLength(2);
    });

    it('dispatch is idempotent: concurrent dispatchers deliver an invitation once', async () => {
      const e = await sendEnvelope(2, 'SEQUENTIAL');
      await sign(e.signers[0]!);
      const sent = await Promise.all([1, 2, 3, 4].map(() => invitations.dispatch({ envelope_id: e.envelopeId })));
      expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
      expect(notifier.sent.filter((n) => n.to_email === e.signers[1]!.email)).toHaveLength(1);
      expect(await liveSessions(e.envelopeId, e.signers[1]!.signerId)).toBe(1);
    });

    it('a failed delivery is retried; a stale claim (crash after claim) is reclaimed; the re-issued link revokes the earlier one', async () => {
      const e = await sendEnvelope(2, 'SEQUENTIAL');
      await sign(e.signers[0]!);
      notifier.failNext = 1;
      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(0);
      expect(await intents(e.envelopeId)).toEqual([{ signer_id: e.signers[1]!.signerId, status: 'FAILED', attempts: 1 }]);
      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(1);
      const first = notifier.tokenFor(e.signers[1]!.email);

      // crash simulation: the intent is stuck in DISPATCHING from long ago
      await db.query(`UPDATE "sign"."NotificationDelivery" SET status='DISPATCHING', claimed_at=now() - interval '1 hour' WHERE envelope_id=$1`, [e.envelopeId]);
      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(1);
      const second = notifier.tokenFor(e.signers[1]!.email);
      expect(second).not.toBe(first);
      await expect(service.exchangeToken(first)).rejects.toThrow(); // revoked
      e.signers[1]!.token = second;
      expect((await sign(e.signers[1]!)).result.envelope_status).toBe('COMPLETED');
    });

    it.each(['VOIDED', 'DECLINED', 'EXPIRED'] as const)('a %s envelope cancels the pending invitation — no link, no email', async (end) => {
      const e = await sendEnvelope(3, 'SEQUENTIAL');
      const { ctx } = await sign(e.signers[0]!);
      if (end === 'VOIDED') await service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'withdrawn');
      if (end === 'EXPIRED') await service.expireEnvelope(TENANT, e.envelopeId);
      if (end === 'DECLINED') {
        // the only signer who can decline now is the current one; record it directly (sender-side decline path)
        await service.decline(TENANT, e.envelopeId, e.signers[1]!.signerId, 'no');
      }
      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(0);
      expect((await intents(e.envelopeId))[0]!.status).toBe('CANCELLED');
      expect(notifier.sent).toHaveLength(0);
      expect(await liveSessions(e.envelopeId)).toBe(0);
      expect(ctx.signer_id).toBe(e.signers[0]!.signerId);
    });

    it('reminders reach only the signer whose turn it is', async () => {
      const e = await sendEnvelope(3, 'SEQUENTIAL');
      await expect(service.remindSigner(TENANT, e.envelopeId, ACTOR, e.signers[1]!.signerId)).rejects.toBeInstanceOf(ReminderNotAllowedError);
      const all = await service.remindSigner(TENANT, e.envelopeId, ACTOR);
      expect(all.sessions.map((s) => s.signer_id)).toEqual([e.signers[0]!.signerId]);
    });

    it('existing envelopes default to PARALLEL (backward compatible)', async () => {
      const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Legacy', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
      expect((await q<{ routing_mode: string }>(`SELECT routing_mode FROM "sign"."SignatureEnvelope" WHERE id=$1`, [env.id]))[0]!.routing_mode).toBe('PARALLEL');
      await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET routing_mode='RANDOM' WHERE id=$1`, [env.id])).rejects.toThrow(/routing_mode_check/);
    });
  });

  describe('sender workspace — recipients', () => {
    it('reordering kept recipients and inserting one ahead never collides on the signing order', async () => {
      const d = await senderRepo.createDraft({ tenant_id: TENANT, subject: 'Order', created_by: ACTOR });
      const three = await senderRepo.replaceDraftRecipients({
        tenant_id: TENANT,
        envelope_id: d.id,
        recipients: [{ name: 'A', email: 'a@x.test' }, { name: 'B', email: 'b@x.test' }, { name: 'C', email: 'c@x.test' }],
      });
      const [a, b, c] = three;
      const after = await senderRepo.replaceDraftRecipients({
        tenant_id: TENANT,
        envelope_id: d.id,
        recipients: [{ name: 'New', email: 'n@x.test' }, { id: c!.id, name: 'C', email: 'c@x.test' }, { id: a!.id, name: 'A', email: 'a@x.test' }, { id: b!.id, name: 'B', email: 'b@x.test' }],
      });
      expect(after.map((s) => [s.email, s.signing_order])).toEqual([['n@x.test', 1], ['c@x.test', 2], ['a@x.test', 3], ['b@x.test', 4]]);
    });
  });
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §1–§5 — recipient kinds, copies,
  // hosted (in-person) and self-signing, enforced by the ENGINE.
  describe('M-A5 — recipient kinds, hosted and self-signing', () => {
    const HOST = randomUUID();
    const SELF = randomUUID();
    type Kind = 'SIGNER' | 'IN_PERSON_SIGNER' | 'RECEIVES_COPY';
    interface R { kind: Kind; copy?: 'ON_SEND' | 'ON_COMPLETION' | 'BOTH'; email?: string | null; bound?: string }
    interface Built { envelopeId: string; ids: string[]; fields: Record<string, string>; tokens: Record<string, string | undefined>; copies: Record<string, string> }

    async function build(list: R[], routing: 'PARALLEL' | 'SEQUENTIAL' = 'SEQUENTIAL', send = true): Promise<Built> {
      const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Kinds', execution_mode: 'MULTI_SIGNATURE', created_by: ACTOR, routing_mode: routing });
      const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'k.pdf', source_sha256: 'abc', ordinal: 1 });
      const ids: string[] = [];
      const fields: Record<string, string> = {};
      for (const [i, r] of list.entries()) {
        const id = randomUUID();
        const email = r.email === undefined ? `k${i}-${env.id.slice(0, 8)}@x.com` : r.email;
        await prisma.signer.create({
          data: { id, tenant_id: TENANT, envelope_id: env.id, email, name: `R${i}`, signing_order: i + 1, status: 'PENDING', recipient_kind: r.kind, copy_delivery: r.copy ?? null, bound_user_id: r.bound ?? null },
        });
        ids.push(id);
        if (r.kind !== 'RECEIVES_COPY') {
          const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100 + i * 30, required: true });
          fields[id] = f.id;
        }
      }
      const tokens: Record<string, string | undefined> = {};
      const copies: Record<string, string> = {};
      if (send) {
        const out = await service.send(TENANT, env.id, ACTOR);
        for (const id of ids) tokens[id] = out.sessions.find((x) => x.signer_id === id)?.raw_token;
        for (const c of out.copies) copies[c.signer_id] = c.raw_token;
      }
      return { envelopeId: env.id, ids, fields, tokens, copies };
    }

    async function signWith(token: string, fieldId: string, attested?: string) {
      const ctx = await service.resolveSession(token);
      await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256, ...(attested !== undefined ? { attested_name: attested } : {}) });
      await service.fillField(ctx, fieldId, { value: 'Signed', signature_method: 'TYPED' });
      return service.completeSigner(ctx);
    }
    const events = (envelopeId: string) =>
      q<{ event_type: string; actor_type: string; actor_ref: string | null; signer_id: string | null; payload: Record<string, unknown> | null }>(
        `SELECT event_type, actor_type, actor_ref, signer_id, payload FROM "sign"."SignatureEvent" WHERE envelope_id=$1 ORDER BY occurred_at, id`,
        [envelopeId],
      );

    it('a copy recipient never takes a SEQUENTIAL turn, never gets a session, is never reminded and never blocks completion', async () => {
      const b = await build([{ kind: 'SIGNER' }, { kind: 'RECEIVES_COPY', copy: 'ON_COMPLETION' }, { kind: 'SIGNER' }]);
      const [first, cc, last] = b.ids as [string, string, string];
      expect(b.tokens[first]).toBeDefined();
      expect(b.tokens[cc]).toBeUndefined();
      expect(await liveSessions(b.envelopeId, cc)).toBe(0);
      const r1 = await signWith(b.tokens[first]!, b.fields[first]!);
      // The turn skips the copy recipient straight to the last signer.
      expect(r1).toEqual({ envelope_status: 'IN_PROGRESS', next_signer_id: last });
      expect((await intents(b.envelopeId)).map((i) => i.signer_id)).toEqual([last]);
      await expect(service.remindSigner(TENANT, b.envelopeId, ACTOR, cc)).rejects.toBeInstanceOf(ReminderNotAllowedError);
      await invitations.dispatch({ envelope_id: b.envelopeId });
      const r2 = await signWith(notifier.tokenFor(`k2-${b.envelopeId.slice(0, 8)}@x.com`), b.fields[last]!);
      expect(r2.envelope_status).toBe('COMPLETED');
      expect(producer.produced(b.envelopeId)).toBe(1);
      expect(await liveSessions(b.envelopeId, cc)).toBe(0);
      // The evidence manifest lists the signing recipients only.
      expect((await service.evidenceManifest(TENANT, b.envelopeId)).manifest.signers).toEqual([first, last]);
    });

    it('ON_SEND copy: a COPY_VIEW grant + COPY_DELIVERY_ISSUED at send; the link opens the source while signing is open and never the executed copy', async () => {
      const b = await build([{ kind: 'SIGNER' }, { kind: 'RECEIVES_COPY', copy: 'ON_SEND' }, { kind: 'RECEIVES_COPY', copy: 'ON_COMPLETION' }], 'PARALLEL');
      const [, onSend, onDone] = b.ids as [string, string, string];
      expect(Object.keys(b.copies)).toEqual([onSend]);
      const grants = await q<{ signer_id: string; access_kind: string }>(`SELECT signer_id, access_kind FROM "sign"."ExecutedAccessGrant" WHERE envelope_id=$1`, [b.envelopeId]);
      expect(grants).toEqual([{ signer_id: onSend, access_kind: 'COPY_VIEW' }]);
      const issued = (await events(b.envelopeId)).filter((e) => e.event_type === 'COPY_DELIVERY_ISSUED');
      expect(issued).toEqual([expect.objectContaining({ signer_id: onSend, actor_type: 'SERVICE', actor_ref: ACTOR, payload: { copy_delivery: 'ON_SEND', access_kind: 'COPY_VIEW' } })]);
      expect(await service.resolveCopyAccess(b.copies[onSend]!)).toEqual({ tenant_id: TENANT, envelope_id: b.envelopeId, signer_id: onSend });
      // A COPY_VIEW token never opens the executed copy, and an unknown token is refused.
      await expect(service.resolveExecutedAccess(b.copies[onSend]!)).rejects.toThrow(/unknown token/);
      await expect(service.resolveCopyAccess(generateSigningToken().raw)).rejects.toThrow(/unknown token/);
      expect(onDone).toBeDefined();
      // A voided envelope's copy link no longer opens.
      await service.voidEnvelope(TENANT, b.envelopeId, ACTOR, 'withdrawn');
      await expect(service.resolveCopyAccess(b.copies[onSend]!)).rejects.toThrow(/not available/);
    });

    it('no ledger event follows ENVELOPE_COMPLETED when copies exist (the chain hash stays final)', async () => {
      const b = await build([{ kind: 'SIGNER' }, { kind: 'RECEIVES_COPY', copy: 'BOTH' }], 'PARALLEL');
      await signWith(b.tokens[b.ids[0]!]!, b.fields[b.ids[0]!]!);
      const evs = await events(b.envelopeId);
      expect(evs[evs.length - 1]!.event_type).toBe('ENVELOPE_COMPLETED');
    });

    it('hosted session: only an IN_PERSON_SIGNER whose turn it is; 30-minute HOSTED session, other live sessions revoked, host evidence hashed', async () => {
      const b = await build([{ kind: 'SIGNER' }, { kind: 'IN_PERSON_SIGNER', email: null }, { kind: 'RECEIVES_COPY', copy: 'ON_COMPLETION' }]);
      const [first, inPerson, cc] = b.ids as [string, string, string];
      // A SIGNER is never hosted; a copy recipient is ineligible; the in-person signer must wait for their turn.
      await expect(service.issueHostedSession(TENANT, b.envelopeId, first, HOST)).rejects.toMatchObject({ reason: 'not_in_person_signer' });
      await expect(service.issueHostedSession(TENANT, b.envelopeId, cc, HOST)).rejects.toMatchObject({ reason: 'signer_ineligible' });
      await expect(service.issueHostedSession(TENANT, b.envelopeId, inPerson, HOST)).rejects.toMatchObject({ reason: 'not_your_turn' });
      await expect(service.issueHostedSession(randomUUID(), b.envelopeId, inPerson, HOST)).rejects.toBeInstanceOf(Error);
      // The in-person signer is never emailed: no invitation intent when their turn comes.
      const r1 = await signWith(b.tokens[first]!, b.fields[first]!);
      expect(r1).toEqual({ envelope_status: 'IN_PROGRESS' });
      expect(await intents(b.envelopeId)).toEqual([]);
      const leaked = await forgeSession(b.envelopeId, inPerson);
      const before = Date.now();
      const hosted = await service.issueHostedSession(TENANT, b.envelopeId, inPerson, HOST);
      expect(hosted.expires_at.getTime() - before).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
      expect(hosted.expires_at.getTime() - before).toBeGreaterThan(29 * 60 * 1000);
      await expect(service.resolveSession(leaked)).rejects.toThrow();
      const row = (await q<{ origin: string; host_user_id: string; authenticated_user_id: string | null }>(`SELECT origin, host_user_id, authenticated_user_id FROM "sign"."SigningSession" WHERE token_hash=$1`, [hashSigningToken(hosted.raw_token)]))[0]!;
      expect(row).toEqual({ origin: 'HOSTED', host_user_id: HOST, authenticated_user_id: null });
      const started = (await events(b.envelopeId)).find((e) => e.event_type === 'HOSTED_SESSION_STARTED');
      expect(started).toMatchObject({ actor_type: 'SERVICE', actor_ref: HOST, signer_id: inPerson });
      // The disclosure needs the attested name in a hosted session.
      const ctx = await service.resolveSession(hosted.raw_token);
      await expect(service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 })).rejects.toBeInstanceOf(AttestedNameRequiredError);
      const done = await signWith(hosted.raw_token, b.fields[inPerson]!, '  Pat   In-Person ');
      expect(done.envelope_status).toBe('COMPLETED');
      expect((await q<{ attested_name: string }>(`SELECT attested_name FROM "sign"."SignerDisclosureAcceptance" WHERE signer_id=$1`, [inPerson]))[0]!.attested_name).toBe('Pat In-Person');
      const evs = await events(b.envelopeId);
      expect(evs.find((e) => e.event_type === 'SIGNER_SIGNED' && e.signer_id === inPerson)!.payload).toEqual({ session_origin: 'HOSTED', host_user_id: HOST });
      expect(evs.find((e) => e.event_type === 'DISCLOSURE_ACCEPTED' && e.signer_id === inPerson)!.payload).toMatchObject({ session_origin: 'HOSTED', attested_name_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      // A completed envelope can no longer be hosted.
      await expect(service.issueHostedSession(TENANT, b.envelopeId, inPerson, HOST)).rejects.toMatchObject({ reason: 'envelope_not_signable' });
    });

    it('self-sign: only the recipient bound to the caller, with the verified email re-checked; SELF evidence on SIGNER_SIGNED', async () => {
      const email = `self-${randomUUID().slice(0, 8)}@x.com`;
      const b = await build([{ kind: 'SIGNER', email, bound: SELF }, { kind: 'SIGNER' }], 'PARALLEL');
      const [mine, other] = b.ids as [string, string];
      await expect(service.issueSelfSignSession(TENANT, b.envelopeId, randomUUID(), email)).rejects.toMatchObject({ reason: 'not_bound_to_you' });
      await expect(service.issueSelfSignSession(TENANT, b.envelopeId, SELF, email, other)).rejects.toMatchObject({ reason: 'not_bound_to_you' });
      await expect(service.issueSelfSignSession(TENANT, b.envelopeId, SELF, 'someone-else@x.com')).rejects.toMatchObject({ reason: 'email_not_verified' });
      await expect(service.issueSelfSignSession(TENANT, b.envelopeId, SELF, null)).rejects.toMatchObject({ reason: 'email_not_verified' });
      const self = await service.issueSelfSignSession(TENANT, b.envelopeId, SELF, email.toUpperCase());
      expect(self.signer_id).toBe(mine);
      expect(self.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
      // The emailed link stays valid (a self-sign session revokes nothing).
      expect(await liveSessions(b.envelopeId, mine)).toBe(2);
      const row = (await q<{ origin: string; authenticated_user_id: string }>(`SELECT origin, authenticated_user_id FROM "sign"."SigningSession" WHERE token_hash=$1`, [hashSigningToken(self.raw_token)]))[0]!;
      expect(row).toEqual({ origin: 'SELF', authenticated_user_id: SELF });
      await signWith(self.raw_token, b.fields[mine]!);
      const evs = await events(b.envelopeId);
      expect(evs.find((e) => e.event_type === 'SELF_SIGN_SESSION_ISSUED')).toMatchObject({ actor_type: 'SERVICE', actor_ref: SELF, signer_id: mine });
      expect(evs.find((e) => e.event_type === 'SIGNER_SIGNED' && e.signer_id === mine)!.payload).toEqual({ session_origin: 'SELF', authenticated_user_id: SELF });
      // Already signed: no second self-sign session.
      await expect(service.issueSelfSignSession(TENANT, b.envelopeId, SELF, email)).rejects.toMatchObject({ reason: 'signer_ineligible' });
      expect(SessionIssueRefusedError).toBeDefined();
    });

    it('new sessions carry their origin (LINK at send and remind); legacy rows stay NULL', async () => {
      const b = await build([{ kind: 'SIGNER' }], 'PARALLEL');
      expect((await q<{ origin: string }>(`SELECT origin FROM "sign"."SigningSession" WHERE envelope_id=$1`, [b.envelopeId])).map((r) => r.origin)).toEqual(['LINK']);
      await service.remindSigner(TENANT, b.envelopeId, ACTOR);
      expect((await q<{ origin: string }>(`SELECT origin FROM "sign"."SigningSession" WHERE envelope_id=$1 AND status='ISSUED'`, [b.envelopeId])).map((r) => r.origin)).toEqual(['LINK']);
      const legacy = await forgeSession(b.envelopeId, b.ids[0]!);
      expect((await q<{ origin: string | null }>(`SELECT origin FROM "sign"."SigningSession" WHERE token_hash=$1`, [hashSigningToken(legacy)]))[0]!.origin).toBeNull();
    });

    it('backward compatible: a signer created without a kind is a SIGNER; the database enforces the kind rules', async () => {
      const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Compat', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
      const s = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'c@x.com', name: 'C', signing_order: 1 });
      expect((await q<{ recipient_kind: string; copy_delivery: string | null }>(`SELECT recipient_kind, copy_delivery FROM "sign"."Signer" WHERE id=$1`, [s.id]))[0]).toEqual({ recipient_kind: 'SIGNER', copy_delivery: null });
      const ins = (kind: string, email: string | null, copy: string | null, order: number) =>
        db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status, recipient_kind, copy_delivery) VALUES ($1,$2,$3,$4,'X',$5,'PENDING',$6,$7)`, [randomUUID(), TENANT, env.id, email, order, kind, copy]);
      await expect(ins('SIGNER', null, null, 2)).rejects.toThrow(/Signer_email_required_check/);
      await expect(ins('RECEIVES_COPY', 'cc@x.com', null, 3)).rejects.toThrow(/Signer_copy_delivery_check/);
      await expect(ins('SIGNER', 'z@x.com', 'ON_SEND', 4)).rejects.toThrow(/Signer_copy_delivery_check/);
      await expect(ins('WATCHER', 'w@x.com', null, 5)).rejects.toThrow(/Signer_recipient_kind_check/);
      await ins('IN_PERSON_SIGNER', null, null, 6);
      await expect(db.query(`UPDATE "sign"."SigningSession" SET origin='HOSTED' WHERE envelope_id=$1`, [env.id])).resolves.toBeDefined(); // no rows
      await expect(
        db.query(`INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at, origin) VALUES ($1,$2,$3,$4,$5,'ISSUED', now(), 'HOSTED')`, [randomUUID(), TENANT, env.id, s.id, randomUUID()]),
      ).rejects.toThrow(/SigningSession_host_user_check/);
      // A legacy (NULL origin) row can never name a host or an authenticated user.
      await expect(
        db.query(`INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at, host_user_id) VALUES ($1,$2,$3,$4,$5,'ISSUED', now(), $6)`, [randomUUID(), TENANT, env.id, s.id, randomUUID(), HOST]),
      ).rejects.toThrow(/SigningSession_host_user_check/);
      await expect(
        db.query(`INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at, authenticated_user_id) VALUES ($1,$2,$3,$4,$5,'ISSUED', now(), $6)`, [randomUUID(), TENANT, env.id, s.id, randomUUID(), SELF]),
      ).rejects.toThrow(/SigningSession_authenticated_user_check/);
      await expect(ins('RECEIVES_COPY', 'cc2@x.com', 'SOMETIME', 7)).rejects.toThrow(/Signer_copy_delivery_check/);
    });
  });
});
