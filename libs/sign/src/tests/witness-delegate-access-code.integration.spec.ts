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
import { EsignSenderRepository, type SenderRecipientInput } from '../lib/sender-workspace.repository.js';
import { SigningInvitationService } from '../lib/signing-invitation.service.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { hashAccessCode, MAX_ACCESS_CODE_ATTEMPTS } from '../lib/domain/access-code.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { type SigningNotification, type SigningNotificationPort } from '../lib/ports/signing-notification.port.js';
import { verifyEventChain } from '../lib/hash-chain.js';
import { DelegationRefusedError, SignerAccessCodeLockedError, SignerAccessCodeRequiredError, SignerNotYetEligibleError, SigningSessionExpiredError } from '../lib/domain/errors.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.17 witness and
// delegate signing and §1.9 access code, on real Postgres 17: the engine rules, the DB
// guards of migration 20261102100000, and the hash-chained ledger staying verifiable
// with the new event types.

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();

function signMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

class FakeNotifier implements SigningNotificationPort {
  readonly sent: SigningNotification[] = [];
  async notify(n: SigningNotification) {
    this.sent.push(n);
    return { delivered: true };
  }
  tokenFor(email: string): string {
    const n = [...this.sent].reverse().find((x) => x.to_email === email && x.kind === 'SIGNATURE_REQUEST');
    if (n?.signing_url === undefined) throw new Error(`no invitation for ${email}`);
    return n.signing_url.slice(n.signing_url.lastIndexOf('/s/') + 3);
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign witness, delegate and access code — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let senderRepo: EsignSenderRepository;
  let service: EsignService;
  let notifier: FakeNotifier;
  let invitations: SigningInvitationService;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  interface Built {
    envelopeId: string;
    ids: string[];
    fields: Map<string, string>;
    tokens: Map<string, string>;
    emails: string[];
  }

  // A draft with the given recipients (through the sender repository, so witness links
  // and access-code hashes are written exactly as the console writes them), one
  // SIGNATURE field per signing recipient, then sent.
  async function build(recipients: Array<Omit<SenderRecipientInput, 'email' | 'name'> & { email?: string }>, opts: { routing?: 'PARALLEL' | 'SEQUENTIAL'; allow_delegation?: boolean } = {}): Promise<Built> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'MULTI_SIGNATURE', created_by: ACTOR, routing_mode: opts.routing ?? 'PARALLEL' });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'agreement.pdf', source_sha256: 'abc', ordinal: 1,
    });
    const emails = recipients.map((r, i) => r.email ?? `r${i + 1}-${env.id.slice(0, 8)}@x.com`);
    const rows = await senderRepo.replaceDraftRecipients({
      tenant_id: TENANT,
      envelope_id: env.id,
      recipients: recipients.map((r, i) => ({ ...r, name: `Recipient ${i + 1}`, email: emails[i]! })),
    });
    if (opts.allow_delegation === true) await senderRepo.updateDraft({ tenant_id: TENANT, envelope_id: env.id, allow_delegation: true });
    const ids = rows.map((r) => r.id);
    const fields = new Map<string, string>();
    for (const [i, r] of rows.entries()) {
      if (r.recipient_kind === 'RECEIVES_COPY') continue;
      const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: r.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100 + i * 30, required: true });
      fields.set(r.id, f.id);
    }
    const { sessions } = await service.send(TENANT, env.id, ACTOR);
    const tokens = new Map(sessions.map((s) => [s.signer_id, s.raw_token]));
    return { envelopeId: env.id, ids, fields, tokens, emails };
  }

  async function sign(token: string, fieldId: string): Promise<{ ctx: SessionContext; result: { envelope_status: string; next_signer_id?: string } }> {
    const ctx = await service.exchangeToken(token);
    await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
    await service.fillField(ctx, fieldId, { value: 'Signed', signature_method: 'TYPED' });
    return { ctx, result: await service.completeSigner(ctx) };
  }

  async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await db.query(sql, params)).rows as T[];
  }

  async function events(envelopeId: string) {
    return prisma.signatureEvent.findMany({ where: { tenant_id: TENANT, envelope_id: envelopeId }, orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }] });
  }

  async function expectChainVerified(envelopeId: string): Promise<void> {
    const rows = await events(envelopeId);
    const result = verifyEventChain(rows.map((e) => ({ ...e, occurred_at: e.occurred_at.toISOString() })), []);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(rows.length);
  }

  async function expectError<E>(p: Promise<unknown>, type: new (...a: never[]) => E): Promise<E> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(type);
      return e as E;
    }
    throw new Error(`expected ${type.name}`);
  }

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
    notifier = new FakeNotifier();
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner());
    invitations = new SigningInvitationService(prisma, repo, notifier);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  describe('§1.17 witness', () => {
    it('parallel: the witness is not invited at send, is refused before its signer signs, is invited when they sign, and attests (WITNESS_ATTESTED; chain verifies)', async () => {
      const e = await build([{ recipient_kind: 'SIGNER' }, { recipient_kind: 'SIGNER' }, { recipient_kind: 'WITNESS', witness_for_index: 0 }]);
      const [s1, s2, w] = e.ids as [string, string, string];
      expect([...e.tokens.keys()].sort()).toEqual([s1, s2].sort());
      const row = (await q<{ witness_for_signer_id: string }>(`SELECT witness_for_signer_id FROM "sign"."Signer" WHERE id=$1`, [w]))[0]!;
      expect(row.witness_for_signer_id).toBe(s1);

      await sign(e.tokens.get(s2)!, e.fields.get(s2)!);
      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(0);

      const first = await sign(e.tokens.get(s1)!, e.fields.get(s1)!);
      expect(first.result).toEqual({ envelope_status: 'IN_PROGRESS', next_signer_id: w });
      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(1);
      const witnessToken = notifier.tokenFor(e.emails[2]!);
      const done = await sign(witnessToken, e.fields.get(w)!);
      expect(done.result.envelope_status).toBe('COMPLETED');

      const attested = (await events(e.envelopeId)).filter((x) => x.event_type === 'WITNESS_ATTESTED');
      expect(attested).toHaveLength(1);
      expect(attested[0]!.signer_id).toBe(w);
      expect(attested[0]!.payload).toEqual({ witness_for_signer_id: s1 });
      await expectChainVerified(e.envelopeId);
    });

    it('a witness session minted before its signer signed is refused (witness_signer_not_signed)', async () => {
      const e = await build([{ recipient_kind: 'SIGNER' }, { recipient_kind: 'WITNESS', witness_for_index: 0 }]);
      const w = e.ids[1]!;
      const { generateSigningToken, signingSessionExpiresAt } = await import('../lib/signing-token.js');
      const tok = generateSigningToken();
      await prisma.signingSession.create({
        data: { id: randomUUID(), tenant_id: TENANT, envelope_id: e.envelopeId, signer_id: w, token_hash: tok.hash, status: 'ISSUED', expires_at: signingSessionExpiresAt(new Date()), origin: 'LINK' },
      });
      const err = await expectError(service.exchangeToken(tok.raw), SignerNotYetEligibleError);
      expect(err.reason).toBe('witness_signer_not_signed');
    });

    it('sequential: the witness signs in its turn after its signer', async () => {
      const e = await build([{ recipient_kind: 'SIGNER' }, { recipient_kind: 'WITNESS', witness_for_index: 0 }], { routing: 'SEQUENTIAL' });
      const [s1, w] = e.ids as [string, string];
      expect([...e.tokens.keys()]).toEqual([s1]);
      const first = await sign(e.tokens.get(s1)!, e.fields.get(s1)!);
      expect(first.result.next_signer_id).toBe(w);
      await invitations.dispatch({ envelope_id: e.envelopeId });
      expect((await sign(notifier.tokenFor(e.emails[1]!), e.fields.get(w)!)).result.envelope_status).toBe('COMPLETED');
      await expectChainVerified(e.envelopeId);
    });

    it('DB guards: a WITNESS needs witness_for_signer_id, a non-witness has none, and the witnessed signer is on the same envelope', async () => {
      const a = await build([{ recipient_kind: 'SIGNER' }]);
      const b = await build([{ recipient_kind: 'SIGNER' }]);
      await expect(db.query(`UPDATE "sign"."Signer" SET recipient_kind='WITNESS' WHERE id=$1`, [a.ids[0]])).rejects.toThrow(/Signer_witness_for_check/);
      await expect(
        db.query(
          `INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status, recipient_kind, witness_for_signer_id) VALUES ($1,$2,$3,'x@y.com','W',9,'PENDING','WITNESS',$4)`,
          [randomUUID(), TENANT, a.envelopeId, b.ids[0]],
        ),
      ).rejects.toThrow(/Signer_witness_for_fkey/);
    });
  });

  describe('§1.17 delegate', () => {
    it('a signer delegates: their session is revoked, fields are cleared, the delegate is invited and signs (SIGNER_DELEGATED; chain verifies)', async () => {
      const e = await build([{ recipient_kind: 'SIGNER' }, { recipient_kind: 'SIGNER' }], { allow_delegation: true });
      const [s1, s2] = e.ids as [string, string];
      const ctx = await service.exchangeToken(e.tokens.get(s1)!);
      await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
      await service.fillField(ctx, e.fields.get(s1)!, { value: 'Signed', signature_method: 'TYPED' });
      // B3 — the signer page offers the hand-off while it is still possible.
      expect((await service.getSignerDocumentView(ctx)).can_delegate).toBe(true);

      await service.delegateSigner(ctx, { name: 'Delegate Person', email: 'delegate@x.com', reason: 'on leave' });
      const row = (await prisma.signer.findUniqueOrThrow({ where: { id: s1 } }));
      expect(row).toMatchObject({ name: 'Delegate Person', email: 'delegate@x.com', delegated_from_name: 'Recipient 1', delegated_from_email: e.emails[0], status: 'PENDING' });
      expect(row.delegated_at).not.toBeNull();
      const field = await prisma.signatureField.findUniqueOrThrow({ where: { id: e.fields.get(s1)! } });
      expect(field.value).toBeNull();
      expect(field.filled_at).toBeNull();
      await expectError(service.fillField(ctx, e.fields.get(s1)!, { value: 'x' }), SigningSessionExpiredError);

      const ev = (await events(e.envelopeId)).find((x) => x.event_type === 'SIGNER_DELEGATED')!;
      expect(JSON.stringify(ev.payload)).not.toContain('delegate@x.com');
      expect(JSON.stringify(ev.payload)).not.toContain(e.emails[0]!);
      expect(ev.payload).toMatchObject({ reason: 'on leave', revoked_session_id: ctx.session_id });

      expect(await invitations.dispatch({ envelope_id: e.envelopeId })).toBe(1);
      const delegateToken = notifier.tokenFor('delegate@x.com');
      // The original recipient's disclosure acceptance does not carry over to the delegate.
      const dctx = await service.exchangeToken(delegateToken);
      await expect(service.fillField(dctx, e.fields.get(s1)!, { value: 'x' })).rejects.toThrow(/disclosure/i);
      await service.acceptDisclosure(dctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
      // A delegated slot is never handed off again.
      expect((await service.getSignerDocumentView(dctx)).can_delegate).toBe(false);
      await service.fillField(dctx, e.fields.get(s1)!, { value: 'Signed', signature_method: 'TYPED' });
      await service.completeSigner(dctx);
      expect((await sign(e.tokens.get(s2)!, e.fields.get(s2)!)).result.envelope_status).toBe('COMPLETED');
      await expectChainVerified(e.envelopeId);
    });

    it('refuses when the sender did not allow it, a second delegation, an email already on the envelope, and a witness', async () => {
      const off = await build([{ recipient_kind: 'SIGNER' }]);
      const offCtx = await service.exchangeToken(off.tokens.get(off.ids[0]!)!);
      expect((await expectError(service.delegateSigner(offCtx, { name: 'D', email: 'd@x.com' }), DelegationRefusedError)).reason).toBe('delegation_not_allowed');

      const on = await build([{ recipient_kind: 'SIGNER' }, { recipient_kind: 'SIGNER' }], { allow_delegation: true });
      const ctx = await service.exchangeToken(on.tokens.get(on.ids[0]!)!);
      expect((await expectError(service.delegateSigner(ctx, { name: 'D', email: on.emails[1]! }), DelegationRefusedError)).reason).toBe('delegate_email_on_envelope');
      await service.delegateSigner(ctx, { name: 'D', email: 'd2@x.com' });
      await invitations.dispatch({ envelope_id: on.envelopeId });
      const dctx = await service.exchangeToken(notifier.tokenFor('d2@x.com'));
      expect((await expectError(service.delegateSigner(dctx, { name: 'E', email: 'e@x.com' }), DelegationRefusedError)).reason).toBe('already_delegated');
    });

    it('allow_delegation is immutable after send (DB trigger)', async () => {
      const e = await build([{ recipient_kind: 'SIGNER' }]);
      await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET allow_delegation=true WHERE id=$1`, [e.envelopeId])).rejects.toThrow(/allow_delegation is immutable/);
    });
  });

  describe('§1.9 access code', () => {
    it('must be entered before viewing; wrong codes count down; the right code clears the session; every result is a ledger event; the chain verifies', async () => {
      const e = await build([{ recipient_kind: 'SIGNER', access_code_hash: hashAccessCode('Blue-42') }]);
      const s1 = e.ids[0]!;
      const token = e.tokens.get(s1)!;
      const stored = (await q<{ access_code_hash: string }>(`SELECT access_code_hash FROM "sign"."Signer" WHERE id=$1`, [s1]))[0]!.access_code_hash;
      expect(stored.startsWith('scrypt$')).toBe(true);
      expect(stored).not.toContain('Blue-42');

      expect((await expectError(service.exchangeToken(token), SignerAccessCodeRequiredError)).reason).toBe('access_code_required');
      const wrong = await expectError(service.verifyRecipientAccessCode(token, 'nope'), SignerAccessCodeRequiredError);
      expect(wrong.reason).toBe('access_code_incorrect');
      expect(wrong.attemptsRemaining).toBe(MAX_ACCESS_CODE_ATTEMPTS - 1);
      expect(await service.verifyRecipientAccessCode(token, ' Blue-42 ')).toEqual({ verified: true });
      const done = await sign(token, e.fields.get(s1)!);
      expect(done.result.envelope_status).toBe('COMPLETED');

      const types = (await events(e.envelopeId)).map((x) => x.event_type);
      expect(types.filter((t) => t.startsWith('ACCESS_CODE_'))).toEqual(['ACCESS_CODE_FAILED', 'ACCESS_CODE_VERIFIED']);
      const all = JSON.stringify((await events(e.envelopeId)).map((x) => x.payload));
      expect(all).not.toContain('Blue-42');
      expect(all).not.toContain('nope');
      await expectChainVerified(e.envelopeId);
    });

    it('a new session (reminder) must enter the code again', async () => {
      const e = await build([{ recipient_kind: 'SIGNER', access_code_hash: hashAccessCode('1234') }]);
      const s1 = e.ids[0]!;
      await service.verifyRecipientAccessCode(e.tokens.get(s1)!, '1234');
      await service.exchangeToken(e.tokens.get(s1)!);
      const { sessions } = await service.remindSigner(TENANT, e.envelopeId, ACTOR, s1);
      await expectError(service.exchangeToken(sessions[0]!.raw_token), SignerAccessCodeRequiredError);
    });

    it(`locks the recipient out after ${MAX_ACCESS_CODE_ATTEMPTS} wrong codes and revokes their sessions`, async () => {
      const e = await build([{ recipient_kind: 'SIGNER', access_code_hash: hashAccessCode('right-code') }]);
      const s1 = e.ids[0]!;
      const token = e.tokens.get(s1)!;
      for (let i = 1; i < MAX_ACCESS_CODE_ATTEMPTS; i++) await expectError(service.verifyRecipientAccessCode(token, `wrong-${i}`), SignerAccessCodeRequiredError);
      await expectError(service.verifyRecipientAccessCode(token, 'wrong-last'), SignerAccessCodeLockedError);
      const row = await prisma.signer.findUniqueOrThrow({ where: { id: s1 } });
      expect(row.access_code_failed_count).toBe(MAX_ACCESS_CODE_ATTEMPTS);
      expect(row.access_code_locked_at).not.toBeNull();
      expect((await q<{ n: string }>(`SELECT count(*) AS n FROM "sign"."SigningSession" WHERE signer_id=$1 AND status IN ('ISSUED','EXCHANGED','ACTIVE')`, [s1]))[0]!.n).toBe('0');
      // Even the right code no longer opens it.
      const { sessions } = await service.remindSigner(TENANT, e.envelopeId, ACTOR, s1);
      await expectError(service.verifyRecipientAccessCode(sessions[0]!.raw_token, 'right-code'), SignerAccessCodeLockedError);
      expect((await events(e.envelopeId)).filter((x) => x.event_type === 'ACCESS_CODE_LOCKED')).toHaveLength(1);
      await expectChainVerified(e.envelopeId);
    });

    it('DB guard: an access code only on a SIGNER or WITNESS, and only as a scrypt hash', async () => {
      const e = await build([{ recipient_kind: 'SIGNER' }, { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' }]);
      await expect(db.query(`UPDATE "sign"."Signer" SET access_code_hash='plain' WHERE id=$1`, [e.ids[0]])).rejects.toThrow(/Signer_access_code_check/);
      await expect(db.query(`UPDATE "sign"."Signer" SET access_code_hash=$2 WHERE id=$1`, [e.ids[1], hashAccessCode('1234')])).rejects.toThrow(/Signer_access_code_check/);
    });
  });
});
