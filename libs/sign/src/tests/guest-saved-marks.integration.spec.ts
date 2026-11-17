import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';
import { EsignSenderRepository, type SenderRecipientInput } from '../lib/sender-workspace.repository.js';
import { GuestSavedMarksRepository } from '../lib/guest-saved-marks.repository.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';

// Aramo-Sign-Mobile-Amendment-M-A15-Guest-Saved-Signature-v1_0 §3 against real
// identity + sign migrations: whose saved signature a signing session may use.

const ROOT = resolve(__dirname, '../../../..');
function migrationsOf(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('M-A15 saved signature binding — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let service: EsignService;
  let sender: EsignSenderRepository;
  let bindings: GuestSavedMarksRepository;

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
    bindings = new GuestSavedMarksRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  async function account(email: string, kind: 'BUSINESS' | 'PERSONAL' = 'BUSINESS', active = true): Promise<{ id: string; tenant_id: string }> {
    const tenant_id = randomUUID();
    const id = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1, $2, $2, $3, 'ACTIVE', true, now())`, [tenant_id, `t-${tenant_id.slice(0, 8)}`, kind]);
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, is_active, updated_at) VALUES ($1, $2, 'U', $3, $4, now())`, [id, email, tenant_id, active]);
    return { id, tenant_id };
  }
  async function federated(user_id: string, snapshot: string): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO identity."ExternalIdentity" (id, provider, provider_subject, user_id, email_snapshot, created_at, updated_at) VALUES ($1, 'cognito', $2, $3, $4, now(), now())`,
      [id, `sub-${id}`, user_id, snapshot],
    );
    await db.query(`INSERT INTO identity."ExternalIdentityIdp" (external_identity_id, idp) VALUES ($1, 'google')`, [id]);
  }
  async function personalSignup(user_id: string, email: string, verified: boolean): Promise<void> {
    await db.query(
      `INSERT INTO identity."PersonalSignupRequest" (id, email, canonical_email, display_name, phone_e164, declared_residence, decision, expires_at, email_verified_at, owner_user_id, updated_at)
       VALUES ($1, $2, $2, 'P', '+14155550123', 'US', 'allow', now() + interval '1 day', $3, $4, now())`,
      [randomUUID(), email, verified ? new Date() : null, user_id],
    );
  }
  async function sessionFor(email: string, kind: SenderRecipientInput['recipient_kind'] = 'SIGNER'): Promise<SessionContext> {
    const env = await sender.createDraft({ tenant_id: SENDER_TENANT, subject: 'Agreement', created_by: SENDER });
    const doc = await sender.addDraftDocument({
      tenant_id: SENDER_TENANT, envelope_id: env.id, actor_ref: SENDER, title: 'Agreement', source_object_key: `k/${env.id}`,
      content_type: 'application/pdf', byte_size: 100, source_sha256: 'a'.repeat(64),
    });
    const people = await sender.replaceDraftRecipients({ tenant_id: SENDER_TENANT, envelope_id: env.id, recipients: [{ name: 'Pat', email, ...(kind ? { recipient_kind: kind } : {}) }] });
    const p = people[0];
    if (p === undefined) throw new Error('no signer');
    await sender.replaceDraftFields({
      tenant_id: SENDER_TENANT, envelope_id: env.id,
      fields: [{ envelope_document_id: doc.id, signer_id: p.id, field_type: 'SIGNATURE', page_number: 0, x: 10, y: 10, width: 40, height: 20, required: true }],
    });
    await service.send(SENDER_TENANT, env.id, SENDER);
    const s = (await db.query(`SELECT id FROM "sign"."SigningSession" WHERE envelope_id = $1 AND signer_id = $2 LIMIT 1`, [env.id, p.id])).rows[0] as { id: string };
    return { session_id: s.id, tenant_id: SENDER_TENANT, envelope_id: env.id, signer_id: p.id };
  }
  const setOrigin = (ctx: SessionContext, origin: string | null, user: string | null = null) =>
    db.query(`UPDATE "sign"."SigningSession" SET origin = $2, authenticated_user_id = $3 WHERE id = $1`, [ctx.session_id, origin, user]);

  it('§3.2 an emailed link matches a federated-verified account, case- and space-insensitively, under its own tenant', async () => {
    const a = await account('fed.user@example.test');
    await federated(a.id, 'Fed.User@Example.test');
    const ctx = await sessionFor('  FED.user@example.TEST ');
    await setOrigin(ctx, 'LINK');
    expect(await bindings.bindingFor(ctx)).toEqual({ kind: 'email_match', user_id: a.id, tenant_id: a.tenant_id });
    await setOrigin(ctx, null);
    expect(await bindings.bindingFor(ctx)).toEqual({ kind: 'email_match', user_id: a.id, tenant_id: a.tenant_id });
  });

  it('§3.2 a verified Personal signup also proves the email; an unverified one does not', async () => {
    const p = await account('personal.user@example.test', 'PERSONAL');
    await personalSignup(p.id, 'personal.user@example.test', true);
    const ctx = await sessionFor('personal.user@example.test');
    await setOrigin(ctx, 'LINK');
    expect(await bindings.bindingFor(ctx)).toEqual({ kind: 'email_match', user_id: p.id, tenant_id: p.tenant_id });

    const u = await account('unverified.user@example.test', 'PERSONAL');
    await personalSignup(u.id, 'unverified.user@example.test', false);
    const ctx2 = await sessionFor('unverified.user@example.test');
    await setOrigin(ctx2, 'LINK');
    expect(await bindings.bindingFor(ctx2)).toBeNull();
  });

  it('§3.2 nothing for an inactive account, or when two accounts share the email', async () => {
    const off = await account('inactive.user@example.test', 'BUSINESS', false);
    await federated(off.id, 'inactive.user@example.test');
    const ctx = await sessionFor('inactive.user@example.test');
    await setOrigin(ctx, 'LINK');
    expect(await bindings.bindingFor(ctx)).toBeNull();

    const one = await account('twin@example.test');
    const two = await account('Twin@example.test');
    await federated(one.id, 'twin@example.test');
    await federated(two.id, 'Twin@example.test');
    const ctx2 = await sessionFor('twin@example.test');
    await setOrigin(ctx2, 'LINK');
    expect(await bindings.bindingFor(ctx2)).toBeNull();
  });

  it('§3.1 a SELF session is the authenticated user, with no email match', async () => {
    const me = await account('someone.else@example.test');
    const ctx = await sessionFor('recipient@example.test');
    await setOrigin(ctx, 'SELF', me.id);
    expect(await bindings.bindingFor(ctx)).toEqual({ kind: 'signed_in', user_id: me.id, tenant_id: me.tenant_id });
  });

  it('D-1 an INBOX session (no user on the row) is the verified-email user, treated as signed in', async () => {
    const a = await account('inbox.user@example.test');
    await federated(a.id, 'inbox.user@example.test');
    const ctx = await sessionFor('inbox.user@example.test');
    await setOrigin(ctx, 'INBOX');
    expect(await bindings.bindingFor(ctx)).toEqual({ kind: 'signed_in', user_id: a.id, tenant_id: a.tenant_id });
  });

  it('§3.3 never for a HOSTED session', async () => {
    const a = await account('hosted.user@example.test');
    await federated(a.id, 'hosted.user@example.test');
    const ctx = await sessionFor('hosted.user@example.test');
    // A hosted session records its host (SigningSession_host_user_check).
    await db.query(`UPDATE "sign"."SigningSession" SET origin = 'HOSTED', authenticated_user_id = NULL, host_user_id = $2 WHERE id = $1`, [ctx.session_id, a.id]);
    expect(await bindings.bindingFor(ctx)).toBeNull();
  });
});
