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
import { EsignSenderRepository, type SenderRecipientInput } from '../lib/sender-workspace.repository.js';
import { readVerifiedEmailProof, RecipientInboxRepository, RECIPIENT_INBOX_SESSION_EVENT, RECIPIENT_SESSION_TTL_MS, type VerifiedEmailProof } from '../lib/recipient-inbox.repository.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { hashAccessCode } from '../lib/domain/access-code.js';
import { InboxSigningRefusedError } from '../lib/domain/envelope-contract-errors.js';
import { SignerAccessCodeRequiredError } from '../lib/domain/errors.js';

// Aramo Sign W2 — Aramo-Sign-W2-Inbox-Discovery-Gate5-Plan-and-Amendment-v1_0-LOCKED §A3.1
// (rules 1-6, Lead C1 + C2), §A3.2 (turn), §A3.3 (binding-less mint, Lead C3 revalidation),
// §A5 rows 2-4, 6-14, 16, 18-20, 24, 25, 27, on real Postgres 17 with the sign AND identity
// schemas (the discovery proof reads identity."User" / "ExternalIdentity" /
// "ExternalIdentityIdp", which the sign-service role aramo_sign_rw may SELECT:
// deploy/db-roles/aramo-domain-roles.sql grants it every table of the identity schema).

const ROOT = resolve(__dirname, '../../../..');
function migrationsOf(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign W2 inbox discovery — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let service: EsignService;
  let sender: EsignSenderRepository;
  let inbox: RecipientInboxRepository;

  const SENDER_TENANT = randomUUID();
  const SENDER = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of [...migrationsOf('sign'), ...migrationsOf('identity')]) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    const repo = new EsignRepository(prisma);
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner());
    sender = new EsignSenderRepository(prisma, repo);
    inbox = new RecipientInboxRepository(prisma, repo);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  // ── identity fixtures ──────────────────────────────────────────────────────
  // An account in its OWN organization (never the sender's), with optional links.
  async function account(email: string): Promise<{ id: string; tenant_id: string }> {
    const tenant_id = randomUUID();
    const id = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1, $2, $2, 'BUSINESS', 'ACTIVE', true, now())`, [tenant_id, `t-${tenant_id.slice(0, 8)}`]);
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1, $2, 'U', $3, now())`, [id, email, tenant_id]);
    return { id, tenant_id };
  }
  // A link; `idp` null = an admin-created link (no recorded provider).
  async function link(user_id: string, snapshot: string, created_at: Date, idp: 'google' | 'microsoft' | null = 'google'): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO identity."ExternalIdentity" (id, provider, provider_subject, user_id, email_snapshot, created_at, updated_at) VALUES ($1, 'cognito', $2, $3, $4, $5, now())`,
      [id, `sub-${id}`, user_id, snapshot, created_at],
    );
    if (idp !== null) await db.query(`INSERT INTO identity."ExternalIdentityIdp" (external_identity_id, idp) VALUES ($1, $2)`, [id, idp]);
    return id;
  }
  const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

  // ── envelope fixtures (always another organization's) ─────────────────────
  async function sent(recipients: SenderRecipientInput[], routing: 'PARALLEL' | 'SEQUENTIAL' = 'PARALLEL') {
    const env = await sender.createDraft({ tenant_id: SENDER_TENANT, subject: 'Agreement', created_by: SENDER });
    if (routing === 'SEQUENTIAL') await sender.updateDraft({ tenant_id: SENDER_TENANT, envelope_id: env.id, routing_mode: 'SEQUENTIAL' });
    const doc = await sender.addDraftDocument({
      tenant_id: SENDER_TENANT, envelope_id: env.id, actor_ref: SENDER, title: 'Agreement', source_object_key: `k/${env.id}`,
      content_type: 'application/pdf', byte_size: 100, source_sha256: 'a'.repeat(64),
    });
    const people = await sender.replaceDraftRecipients({ tenant_id: SENDER_TENANT, envelope_id: env.id, recipients });
    await sender.replaceDraftFields({
      tenant_id: SENDER_TENANT, envelope_id: env.id,
      fields: people
        .filter((p) => p.recipient_kind !== 'RECEIVES_COPY')
        .map((p, i) => ({ envelope_document_id: doc.id, signer_id: p.id, field_type: 'SIGNATURE', page_number: 0, x: 10 + i * 50, y: 10, width: 40, height: 20, required: true })),
    });
    const { sessions } = await service.send(SENDER_TENANT, env.id, SENDER);
    const sent_at = (await db.query(`SELECT sent_at FROM "sign"."SignatureEnvelope" WHERE id = $1`, [env.id])).rows[0].sent_at as Date;
    return { id: env.id, signers: people, sessions, sent_at };
  }
  const signer = (name: string, email: string, extra: Partial<SenderRecipientInput> = {}): SenderRecipientInput => ({ name, email, ...extra });

  const proofOf = (user_id: string) => readVerifiedEmailProof(prisma, user_id);
  async function discovered(user_id: string): Promise<Array<{ signer_id: string; envelope_id: string; turn: string; link_live: boolean; source: string }>> {
    const proof = await proofOf(user_id);
    return proof === null ? [] : inbox.listDiscoveredForUser(user_id, proof);
  }
  const reason = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'issued';
    } catch (e) {
      if (e instanceof InboxSigningRefusedError) return e.reason;
      throw e;
    }
  };
  async function markSigned(signer_id: string): Promise<void> {
    await db.query(`UPDATE "sign"."Signer" SET status = 'SIGNED', signed_at = now() WHERE id = $1`, [signer_id]);
  }

  describe('rule 1 (W-1, Lead C1) — verified control of the CURRENT email', () => {
    it('a federated link with a recorded provider and matching snapshot proves the email (earliest such link)', async () => {
      const u = await account('Proof.One@Example.test');
      await link(u.id, 'proof.one@example.test', new Date('2026-03-01T00:00:00.000Z'), 'microsoft');
      await link(u.id, ' PROOF.ONE@example.TEST ', new Date('2026-02-01T00:00:00.000Z'), 'google');
      expect(await proofOf(u.id)).toEqual({ email: 'proof.one@example.test', proven_at: new Date('2026-02-01T00:00:00.000Z') });
    });

    it('row 18: an admin-created link (no recorded provider) with a matching email never qualifies', async () => {
      const u = await account('admin.made@example.test');
      await link(u.id, 'admin.made@example.test', LONG_AGO, null);
      expect(await proofOf(u.id)).toBeNull();
      await sent([signer('A', 'admin.made@example.test')]);
      expect(await discovered(u.id)).toEqual([]);
    });

    it('row 11: a user who never signed in (no link), an inactive user, a deactivated user → no proof', async () => {
      const never = await account('never@example.test');
      expect(await proofOf(never.id)).toBeNull();
      const off = await account('off@example.test');
      await link(off.id, 'off@example.test', LONG_AGO);
      await db.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [off.id]);
      expect(await proofOf(off.id)).toBeNull();
      const gone = await account('gone@example.test');
      await link(gone.id, 'gone@example.test', LONG_AGO);
      await db.query(`UPDATE identity."User" SET deactivated_at = now() WHERE id = $1`, [gone.id]);
      expect(await proofOf(gone.id)).toBeNull();
    });

    it('row 19: after an email change, nothing is discovered until a new federated link proves the new address (and only from then on, C2)', async () => {
      const u = await account('before@example.test');
      await link(u.id, 'before@example.test', LONG_AGO);
      await db.query(`UPDATE identity."User" SET email = 'after@example.test' WHERE id = $1`, [u.id]);
      const early = await sent([signer('A', 'after@example.test')]);
      expect(await proofOf(u.id)).toBeNull();
      expect(await discovered(u.id)).toEqual([]);
      await link(u.id, 'after@example.test', new Date(early.sent_at.getTime() + 1));
      await new Promise((r) => setTimeout(r, 5));
      const late = await sent([signer('A', 'after@example.test')]);
      expect((await discovered(u.id)).map((d) => d.envelope_id)).toEqual([late.id]);
    });
  });

  describe('rules 2-5 — what is discovered', () => {
    it('rows 3 / 10 / 14: another organization’s envelope, matched case- and space-insensitively; nothing is written to U’s organization', async () => {
      const u = await account('dana.w2@example.test');
      await link(u.id, 'dana.w2@example.test', LONG_AGO);
      const e = await sent([signer('Dana', 'DANA.W2@Example.Test')]);
      const other = await sent([signer('Zed', 'not.dana@example.test')]);
      const before = (await db.query(`SELECT count(*)::int AS n FROM "sign"."SignRecipientBinding" WHERE user_id = $1`, [u.id])).rows[0].n;
      const found = await discovered(u.id);
      expect(found).toEqual([expect.objectContaining({ source: 'discovered', envelope_id: e.id, signer_id: e.signers[0]!.id, turn: 'now', link_live: true })]);
      expect(found.map((f) => f.envelope_id)).not.toContain(other.id);
      // i_am_sender input: the creator is read for the comparison only (the service never returns it).
      expect((await inbox.listDiscoveredForUser(u.id, (await proofOf(u.id))!))[0]!.envelope.created_by).toBe(SENDER);
      expect(before).toBe(0);
      expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignRecipientBinding" WHERE user_id = $1`, [u.id])).rows[0].n).toBe(0);
      expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureEnvelope" WHERE tenant_id = $1`, [u.tenant_id])).rows[0].n).toBe(0);
    });

    it('rule 2: copy recipients and in-person signers are never discovered', async () => {
      const u = await account('kinds@example.test');
      await link(u.id, 'kinds@example.test', LONG_AGO);
      await sent([signer('Other', 'other.kinds@example.test'), signer('Copy', 'kinds@example.test', { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' })]);
      await sent([signer('Host', 'kinds@example.test', { recipient_kind: 'IN_PERSON_SIGNER' })]);
      expect(await discovered(u.id)).toEqual([]);
    });

    it('row 20 (C2): an envelope sent before U’s first qualifying link is not discovered; one sent at that instant is', async () => {
      const u = await account('interval@example.test');
      const before = await sent([signer('I', 'interval@example.test')]);
      await link(u.id, 'interval@example.test', new Date(before.sent_at.getTime() + 1));
      expect(await discovered(u.id)).toEqual([]);
      const v = await account('interval2@example.test');
      const at = await sent([signer('I', 'interval2@example.test')]);
      await link(v.id, 'interval2@example.test', at.sent_at);
      expect((await discovered(v.id)).map((d) => d.envelope_id)).toEqual([at.id]);
    });

    it('row 12: M-A8 tombstone then re-signup at the same address — the previous holder’s envelopes are not discovered', async () => {
      const paul = await account('shared.box@example.test');
      await link(paul.id, 'shared.box@example.test', LONG_AGO);
      const old = await sent([signer('P', 'shared.box@example.test')]);
      expect((await discovered(paul.id)).map((d) => d.envelope_id)).toEqual([old.id]);
      // The tombstone deletes the previous holder's links and frees the address.
      await db.query(`DELETE FROM identity."ExternalIdentityIdp" WHERE external_identity_id IN (SELECT id FROM identity."ExternalIdentity" WHERE user_id = $1)`, [paul.id]);
      await db.query(`DELETE FROM identity."ExternalIdentity" WHERE user_id = $1`, [paul.id]);
      await db.query(`UPDATE identity."User" SET email = $2, is_active = false, deactivated_at = now() WHERE id = $1`, [paul.id, `tombstone+${paul.id}@invalid`]);
      const nina = await account('shared.box@example.test');
      await link(nina.id, 'shared.box@example.test', new Date(old.sent_at.getTime() + 1));
      expect(await discovered(nina.id)).toEqual([]);
      await new Promise((r) => setTimeout(r, 5));
      const fresh = await sent([signer('N', 'shared.box@example.test')]);
      expect((await discovered(nina.id)).map((d) => d.envelope_id)).toEqual([fresh.id]);
    });

    it('rows 2 / 8 (rule 5): a bound recipient is not discovered; a removed binding keeps it out of the inbox', async () => {
      const u = await account('bound.w2@example.test');
      await link(u.id, 'bound.w2@example.test', LONG_AGO);
      const e = await sent([signer('B', 'bound.w2@example.test')]);
      const b = await inbox.bind({ envelope_tenant_id: SENDER_TENANT, envelope_id: e.id, signer_id: e.signers[0]!.id, user_id: u.id, user_tenant_id: u.tenant_id, email: 'bound.w2@example.test' });
      expect(await discovered(u.id)).toEqual([]);
      expect((await inbox.listForUser(u.id)).map((r) => ({ id: r.id, source: r.source, turn: r.turn, link_live: r.link_live }))).toEqual([{ id: b.id, source: 'bound', turn: 'now', link_live: true }]);
      // my_inbox_item_id inputs: this user's live binding; another user sees none.
      expect([...(await inbox.liveBindingIds(u.id, [e.signers[0]!.id])).entries()]).toEqual([[e.signers[0]!.id, b.id]]);
      expect((await inbox.liveBindingIds(randomUUID(), [e.signers[0]!.id])).size).toBe(0);
      await inbox.revoke(u.id, b.id);
      expect((await inbox.liveBindingIds(u.id, [e.signers[0]!.id])).size).toBe(0);
      expect([...(await inbox.anyBindingSignerIds(u.id, [e.signers[0]!.id]))]).toEqual([e.signers[0]!.id]);
      expect(await discovered(u.id)).toEqual([]);
      expect(await inbox.listForUser(u.id)).toEqual([]);
    });

    it('rule 3 / rows 6 / 7: open envelopes (any status of mine); terminal ones only where I signed', async () => {
      const u = await account('history@example.test');
      await link(u.id, 'history@example.test', LONG_AGO);
      const voidedUnsigned = await sent([signer('H', 'history@example.test')]);
      await service.voidEnvelope(SENDER_TENANT, voidedUnsigned.id, SENDER, 'no longer needed');
      const signedThenVoided = await sent([signer('H', 'history@example.test'), signer('O', 'other.history@example.test')]);
      await markSigned(signedThenVoided.signers[0]!.id);
      const inProgress = (await discovered(u.id)).find((d) => d.envelope_id === signedThenVoided.id);
      expect(inProgress).toBeDefined(); // row 6: listed (history), never actionable (status SIGNED)
      await service.voidEnvelope(SENDER_TENANT, signedThenVoided.id, SENDER, 'stop');
      const ids = (await discovered(u.id)).map((d) => d.envelope_id);
      expect(ids).toContain(signedThenVoided.id);
      expect(ids).not.toContain(voidedUnsigned.id);
    });
  });

  describe('§A3.2 — turn and link liveness', () => {
    it('row 4: SEQUENTIAL with U second → turn later; after signer 1 signs and U’s link is issued → turn now, link live', async () => {
      const u = await account('second@example.test');
      await link(u.id, 'second@example.test', LONG_AGO);
      const e = await sent([signer('First', 'first.seq@example.test'), signer('Second', 'second@example.test')], 'SEQUENTIAL');
      expect(await discovered(u.id)).toEqual([expect.objectContaining({ turn: 'later', link_live: false })]);
      await markSigned(e.signers[0]!.id);
      await db.query(
        `INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at, origin) VALUES ($1, $2, $3, $4, $5, 'ISSUED', now() + interval '7 days', 'LINK')`,
        [randomUUID(), SENDER_TENANT, e.id, e.signers[1]!.id, `h-${randomUUID()}`],
      );
      expect(await discovered(u.id)).toEqual([expect.objectContaining({ turn: 'now', link_live: true })]);
    });

    it('row 17 (W-3): with every emailed link revoked the item is not live', async () => {
      const u = await account('nolink@example.test');
      await link(u.id, 'nolink@example.test', LONG_AGO);
      const e = await sent([signer('N', 'nolink@example.test')]);
      await db.query(`UPDATE "sign"."SigningSession" SET status = 'REVOKED' WHERE signer_id = $1`, [e.signers[0]!.id]);
      expect(await discovered(u.id)).toEqual([expect.objectContaining({ turn: 'now', link_live: false })]);
      expect(await reason(inbox.issueDiscoveredRecipientSession(u.id, e.signers[0]!.id))).toBe('session_revoked');
    });
  });

  describe('§A3.3 — the binding-less mint re-runs the rule and today’s revalidation', () => {
    async function ready(email: string, recipients?: (email: string) => SenderRecipientInput[], routing: 'PARALLEL' | 'SEQUENTIAL' = 'PARALLEL') {
      const u = await account(email);
      await link(u.id, email, LONG_AGO);
      const e = await sent(recipients?.(email) ?? [signer('M', email)], routing);
      const mine = e.signers.find((s) => s.email?.toLowerCase() === email)!;
      return { u, e, mine };
    }

    it('mints an INBOX session (≤ 30 min, ≤ the emailed link), audits {origin, session_id, discovery}, and persists no binding', async () => {
      const { u, e, mine } = await ready('mint.ok@example.test');
      const t0 = Date.now();
      const out = await inbox.issueDiscoveredRecipientSession(u.id, mine.id);
      expect(out.expires_at.getTime()).toBeLessThanOrEqual(t0 + RECIPIENT_SESSION_TTL_MS + 5_000);
      const s = (await db.query(`SELECT origin, status, signer_id FROM "sign"."SigningSession" WHERE id = $1`, [out.session_id])).rows[0];
      expect(s).toEqual({ origin: 'INBOX', status: 'ISSUED', signer_id: mine.id });
      const ev = (await db.query(`SELECT payload, actor_type FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = $2`, [e.id, RECIPIENT_INBOX_SESSION_EVENT])).rows;
      expect(ev).toEqual([{ actor_type: 'SIGNER', payload: { origin: 'inbox', session_id: out.session_id, discovery: 'verified_account_email' } }]);
      expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignRecipientBinding" WHERE user_id = $1`, [u.id])).rows[0].n).toBe(0);
      // Row 9 — the emailed link (guest signing) is untouched and still opens.
      await expect(service.exchangeToken(e.sessions[0]!.raw_token)).resolves.toMatchObject({ signer_id: mine.id });
    });

    it('rows 13 / 25: a recipient with an access code still gets a session, and the token path still demands the code', async () => {
      const { u, mine } = await ready('coded@example.test', (email) => [signer('C', email, { access_code_hash: hashAccessCode('Blue-42') })]);
      const out = await inbox.issueDiscoveredRecipientSession(u.id, mine.id);
      await expect(service.exchangeToken(out.raw_token)).rejects.toBeInstanceOf(SignerAccessCodeRequiredError);
    });

    it('row 24: replay after the signer signed → signer_ineligible; after void → envelope_not_signable', async () => {
      const a = await ready('replay.signed@example.test');
      await markSigned(a.mine.id);
      expect(await reason(inbox.issueDiscoveredRecipientSession(a.u.id, a.mine.id))).toBe('signer_ineligible');
      const b = await ready('replay.void@example.test');
      await service.voidEnvelope(SENDER_TENANT, b.e.id, SENDER, 'void');
      expect(await reason(inbox.issueDiscoveredRecipientSession(b.u.id, b.mine.id))).toBe('envelope_not_signable');
    });

    it('row 16: after delegation (the slot names someone else) → not discovered, sign refused signer_ineligible', async () => {
      const { u, mine } = await ready('delegated@example.test');
      await db.query(`UPDATE "sign"."Signer" SET email = 'delegate@example.test', name = 'Del', delegated_from_name = 'M', delegated_from_email = 'delegated@example.test', delegated_at = now() WHERE id = $1`, [mine.id]);
      expect(await discovered(u.id)).toEqual([]);
      expect(await reason(inbox.issueDiscoveredRecipientSession(u.id, mine.id))).toBe('signer_ineligible');
    });

    it('row 27: deactivated, or email changed, before redemption → association_inactive', async () => {
      const a = await ready('later.off@example.test');
      await db.query(`UPDATE identity."User" SET deactivated_at = now() WHERE id = $1`, [a.u.id]);
      expect(await reason(inbox.issueDiscoveredRecipientSession(a.u.id, a.mine.id))).toBe('association_inactive');
      const b = await ready('later.moved@example.test');
      await db.query(`UPDATE identity."User" SET email = 'moved.on@example.test' WHERE id = $1`, [b.u.id]);
      expect(await reason(inbox.issueDiscoveredRecipientSession(b.u.id, b.mine.id))).toBe('association_inactive');
    });

    it('C2 at redemption: an envelope sent before the proof → association_inactive', async () => {
      const u = await account('mint.early@example.test');
      const e = await sent([signer('E', 'mint.early@example.test')]);
      await link(u.id, 'mint.early@example.test', new Date(e.sent_at.getTime() + 1));
      expect(await reason(inbox.issueDiscoveredRecipientSession(u.id, e.signers[0]!.id))).toBe('association_inactive');
    });

    it('rule 5 at redemption: a recipient the user holds a binding for → association_inactive (sign through the binding)', async () => {
      const { u, e, mine } = await ready('mint.bound@example.test');
      await inbox.bind({ envelope_tenant_id: SENDER_TENANT, envelope_id: e.id, signer_id: mine.id, user_id: u.id, user_tenant_id: u.tenant_id, email: 'mint.bound@example.test' });
      expect(await reason(inbox.issueDiscoveredRecipientSession(u.id, mine.id))).toBe('association_inactive');
    });

    it('a recipient of another email (a guessed signer id) → signer_ineligible; SEQUENTIAL not yet my turn → not_your_turn', async () => {
      const { u } = await ready('guess@example.test');
      const foreign = await sent([signer('F', 'foreign@example.test')]);
      expect(await reason(inbox.issueDiscoveredRecipientSession(u.id, foreign.signers[0]!.id))).toBe('signer_ineligible');
      const seq = await ready('seq.mint@example.test', (email) => [signer('F', 'first.mint@example.test'), signer('S', email)], 'SEQUENTIAL');
      expect(await reason(inbox.issueDiscoveredRecipientSession(seq.u.id, seq.mine.id))).toBe('not_your_turn');
    });
  });

  it('the proof type is what the service passes back to the repository', async () => {
    const u = await account('shape@example.test');
    await link(u.id, 'shape@example.test', LONG_AGO);
    const p: VerifiedEmailProof | null = await inbox.verifiedEmailProof(u.id);
    expect(p).toEqual({ email: 'shape@example.test', proven_at: LONG_AGO });
  });
});
