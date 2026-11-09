import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, createAramoLogger, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityLinkService, PENDING_LINK_TTL_MS, hashLinkHandle } from '../lib/account-link/identity-link.service.js';
import { hashLinkOtp } from '../lib/account-link/link-otp.js';
import { IdentityProviderPolicyService } from '../lib/identity-provider-policy.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// Aramo Sign Apple Platform Go-Live v1.0 (LOCKED) W1 + Amendment A1 (LOCKED) —
// on real Postgres 17:
//   - the ExternalIdentityIdp CHECK widened to apple (still refuses others);
//   - R-4 Personal allowed set {google, apple}, Microsoft refused; L-6 returning
//     Personal sign-in by any recorded provider; Business keeps strict pin equality;
//   - L-2 pending links (hash only, single use, expiry, cleanup);
//   - L-1/L-5 attach for path 3 (conflict) by provider proof and by code, path 2
//     (no match) by provider proof and by code to a typed email, path 1 (signed in);
//   - refusals: handle expired / reused / unknown, BUSINESS pin mismatch, PERSONAL
//     Microsoft, identity_already_linked, idp_already_linked, user_inactive, last
//     method removal;
//   - email/start answers the same (null, nothing stored) for unknown emails;
//   - audit linked / unlinked written.

const ROOT = resolve(__dirname, '../../../..');
const OWNER_ROLE = '01900000-0000-7000-8000-000000000014';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Apple Go-Live A1 — proven account linking (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let policy: IdentityProviderPolicyService;
  let links: IdentityLinkService;
  let repo: IdentityRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1, 'tenant_owner', 'Owner', true, now())`, [OWNER_ROLE]);
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    policy = new IdentityProviderPolicyService(prisma);
    links = new IdentityLinkService(prisma, new IdentityAuditService(new IdentityAuditRepository(prisma), createAramoLogger('apple-go-live-spec')));
    repo = new IdentityRepository(prisma);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  async function tenant(opts: { kind?: 'PERSONAL' | 'BUSINESS'; enforced: boolean; pin?: string | null }): Promise<string> {
    const id = uuidv7();
    await db.query(`INSERT INTO identity."Tenant" (id, name, identity_provider, kind, updated_at) VALUES ($1, $2, $3, $4, now())`, [id, `T ${id}`, opts.pin ?? null, opts.kind ?? 'BUSINESS']);
    if (opts.enforced) await policy.enrollEnforcedTenant(id);
    return id;
  }
  async function owner(tenant_id: string, email?: string): Promise<{ id: string; email: string }> {
    const id = uuidv7();
    const m = uuidv7();
    const e = email ?? `u-${id}@acme.test`;
    await db.query(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [id, e, tenant_id]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [m, id, tenant_id]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), m, OWNER_ROLE]);
    return { id, email: e };
  }
  async function linkWith(user_id: string, idp: 'google' | 'microsoft' | 'apple'): Promise<string> {
    const sub = `${idp}-${uuidv7()}`;
    const l = await repo.linkExternalIdentity({ user_id, provider: 'cognito', provider_subject: sub, email_snapshot: null });
    await policy.recordLinkIdp(l.id, idp);
    return sub;
  }
  const appleIdentity = () => ({ provider: 'cognito', provider_subject: `apple-${uuidv7()}`, idp: 'apple' as const, email_snapshot: 'x7k2@privaterelay.appleid.com' });
  const auditCount = async (type: string, subject: string) =>
    Number((await db.query(`SELECT count(*)::int AS n FROM identity."IdentityAuditEvent" WHERE event_type = $1 AND subject_id = $2`, [type, subject])).rows[0].n);

  it('W1: the ExternalIdentityIdp CHECK accepts apple and still refuses unknown providers', async () => {
    const t = await tenant({ enforced: false });
    const u = await owner(t);
    await linkWith(u.id, 'apple');
    expect(await policy.recordedIdpsOf(u.id)).toEqual(['apple']);
    await expect(db.query(`INSERT INTO identity."ExternalIdentityIdp" (external_identity_id, idp) VALUES ($1, 'facebook')`, [uuidv7()])).rejects.toThrow();
    await expect(db.query(`INSERT INTO identity."PendingIdentityLink" (id, handle_hash, provider, provider_subject, idp, reason, expires_at) VALUES ($1, 'h', 'cognito', 's', 'okta', 'user_not_provisioned', now())`, [uuidv7()])).rejects.toThrow();
  });

  it('R-4: an unpinned enforced PERSONAL tenant — the owner\'s first Apple federation pins apple; Microsoft is refused', async () => {
    const t = await tenant({ kind: 'PERSONAL', enforced: true });
    const u = await owner(t);
    expect(await policy.evaluate({ user_id: u.id, idp: 'microsoft', linking: true })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    expect(await policy.evaluate({ user_id: u.id, idp: 'apple', linking: true })).toEqual({ ok: true, pinned_now: true });
    expect(await policy.evaluate({ user_id: u.id, tenant_id: t, idp: 'microsoft', linking: false })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
  });

  it('L-6: a PERSONAL returning sign-in is allowed by the pin or a recorded link; BUSINESS stays strict', async () => {
    const p = await tenant({ kind: 'PERSONAL', enforced: true, pin: 'google' });
    const pu = await owner(p);
    await linkWith(pu.id, 'google');
    expect(await policy.evaluate({ user_id: pu.id, tenant_id: p, idp: 'apple', linking: false })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    await linkWith(pu.id, 'apple');
    expect(await policy.evaluate({ user_id: pu.id, tenant_id: p, idp: 'apple', linking: false })).toEqual({ ok: true, pinned_now: false });
    expect(await policy.evaluate({ user_id: pu.id, tenant_id: p, idp: 'google', linking: false })).toEqual({ ok: true, pinned_now: false });
    const b = await tenant({ kind: 'BUSINESS', enforced: true, pin: 'microsoft' });
    const bu = await owner(b);
    await linkWith(bu.id, 'microsoft');
    await linkWith(bu.id, 'apple'); // even a recorded second link does not widen a Business pin
    expect(await policy.evaluate({ user_id: bu.id, tenant_id: b, idp: 'apple', linking: false })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
  });

  it('L-1: email equality alone still never links (conflict refusal unchanged)', async () => {
    const t = await tenant({ enforced: false });
    const u = await owner(t);
    await linkWith(u.id, 'google');
    expect(await policy.evaluate({ user_id: u.id, idp: 'apple', linking: true })).toEqual({ ok: false, reason: 'idp_identity_conflict' });
  });

  it('L-2: a pending link stores only the hash, expires in 10 minutes, and is single use', async () => {
    const t = await tenant({ enforced: false });
    const u = await owner(t);
    await linkWith(u.id, 'google');
    const now = new Date();
    const { handle, expires_at } = await links.createPendingLink({ ...appleIdentity(), reason: 'idp_identity_conflict', matched_user_id: u.id }, now);
    expect(expires_at.getTime() - now.getTime()).toBe(PENDING_LINK_TTL_MS);
    const rows = (await db.query(`SELECT * FROM identity."PendingIdentityLink" WHERE handle_hash = $1`, [hashLinkHandle(handle)])).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(handle);
    // Path 3 by provider proof (a).
    expect(await links.attachPendingLink({ handle, user_id: u.id, proof: 'existing_provider' })).toMatchObject({ ok: true, idp: 'apple', user_id: u.id });
    expect((await policy.recordedIdpsOf(u.id)).sort()).toEqual(['apple', 'google']);
    expect(await auditCount('identity.external_identity.linked', u.id)).toBe(1);
    // Reused.
    expect(await links.attachPendingLink({ handle, user_id: u.id, proof: 'existing_provider' })).toEqual({ ok: false, reason: 'link_expired' });
    // Unknown.
    expect(await links.attachPendingLink({ handle: 'Z'.repeat(43), user_id: u.id, proof: 'existing_provider' })).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('L-2: an expired handle is refused; rows expired for more than a day are deleted on the next write', async () => {
    const t = await tenant({ enforced: false });
    const u = await owner(t);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const stale = await links.createPendingLink({ ...appleIdentity(), reason: 'user_not_provisioned', matched_user_id: null }, old);
    const recent = await links.createPendingLink({ ...appleIdentity(), reason: 'user_not_provisioned', matched_user_id: null }, new Date(Date.now() - 11 * 60 * 1000));
    expect(await links.attachPendingLink({ handle: recent.handle, user_id: u.id, proof: 'existing_provider' })).toEqual({ ok: false, reason: 'link_expired' });
    await links.createPendingLink({ ...appleIdentity(), reason: 'user_not_provisioned', matched_user_id: null });
    const left = await db.query(`SELECT handle_hash FROM identity."PendingIdentityLink" WHERE handle_hash = ANY($1)`, [[hashLinkHandle(stale.handle), hashLinkHandle(recent.handle)]]);
    expect(left.rows.map((r) => r.handle_hash)).toEqual([hashLinkHandle(recent.handle)]);
  });

  it('path 3 by code: the code goes to the matched account (email ignored); verify attaches', async () => {
    const t = await tenant({ enforced: false });
    const u = await owner(t);
    await linkWith(u.id, 'microsoft');
    const { handle } = await links.createPendingLink({ ...appleIdentity(), reason: 'idp_identity_conflict', matched_user_id: u.id });
    const sent = await links.startEmailProof({ handle, email: 'attacker@evil.test' });
    expect(sent).toMatchObject({ to: u.email, idp: 'apple' });
    expect(await links.verifyEmailProof({ handle, code: '000000' === sent!.code ? '111111' : '000000' })).toEqual({ ok: false, reason: 'code_invalid', attempts_remaining: 4 });
    expect(await links.verifyEmailProof({ handle, code: sent!.code })).toMatchObject({ ok: true, idp: 'apple', user_id: u.id });
    expect(await links.verifyEmailProof({ handle, code: sent!.code })).toEqual({ ok: false, reason: 'link_expired' });
  });

  it('path 2 by code to a typed email; unknown email answers the same (null) and stores nothing; resend gap', async () => {
    const t = await tenant({ kind: 'PERSONAL', enforced: true, pin: 'google' });
    const u = await owner(t, `p-${uuidv7()}@gmail.com`);
    await linkWith(u.id, 'google');
    const { handle } = await links.createPendingLink({ ...appleIdentity(), reason: 'user_not_provisioned', matched_user_id: null });
    expect(await links.startEmailProof({ handle, email: 'nobody@nowhere.test' })).toBeNull();
    const row = (await db.query(`SELECT code_hash, code_send_count FROM identity."PendingIdentityLink" WHERE handle_hash = $1`, [hashLinkHandle(handle)])).rows[0];
    expect(row).toEqual({ code_hash: null, code_send_count: 0 });
    // A code entered when none was sent is counted like a wrong code (no oracle).
    expect(await links.verifyEmailProof({ handle, code: '123456' })).toEqual({ ok: false, reason: 'code_invalid', attempts_remaining: 4 });
    const sent = await links.startEmailProof({ handle, email: ` ${u.email.toUpperCase()} ` });
    expect(sent?.to).toBe(u.email);
    expect(await links.startEmailProof({ handle, email: u.email })).toBeNull(); // inside 60 s
    expect(await links.verifyEmailProof({ handle, code: sent!.code })).toMatchObject({ ok: true, idp: 'apple' });
    // L-6: the Personal user may now sign in with Apple (recorded link).
    expect(await policy.evaluate({ user_id: u.id, tenant_id: t, idp: 'apple', linking: false })).toEqual({ ok: true, pinned_now: false });
  });

  it('code expiry and attempt cap', async () => {
    const t = await tenant({ enforced: false });
    const u = await owner(t);
    const { handle } = await links.createPendingLink({ ...appleIdentity(), reason: 'idp_identity_conflict', matched_user_id: u.id });
    const sent = await links.startEmailProof({ handle, email: null });
    for (let i = 4; i >= 1; i -= 1) expect(await links.verifyEmailProof({ handle, code: 'x' })).toEqual({ ok: false, reason: 'code_invalid', attempts_remaining: i });
    expect(await links.verifyEmailProof({ handle, code: 'x' })).toEqual({ ok: false, reason: 'code_attempts_exceeded' });
    expect(await links.verifyEmailProof({ handle, code: sent!.code })).toEqual({ ok: false, reason: 'code_attempts_exceeded' });
    const second = await links.createPendingLink({ ...appleIdentity(), reason: 'idp_identity_conflict', matched_user_id: u.id });
    const row = (await db.query(`SELECT id FROM identity."PendingIdentityLink" WHERE handle_hash = $1`, [hashLinkHandle(second.handle)])).rows[0];
    await db.query(`UPDATE identity."PendingIdentityLink" SET code_hash = $2, code_expires_at = now() - interval '1 second' WHERE id = $1`, [row.id, hashLinkOtp(row.id, '123456')]);
    expect(await links.verifyEmailProof({ handle: second.handle, code: '123456' })).toEqual({ ok: false, reason: 'code_expired' });
  });

  it('L-5 refusals: BUSINESS pin mismatch, PERSONAL microsoft, identity_already_linked, idp_already_linked, user_inactive', async () => {
    const b = await tenant({ kind: 'BUSINESS', enforced: true, pin: 'microsoft' });
    const bu = await owner(b);
    expect(await links.attachIdentity({ ...appleIdentity(), user_id: bu.id, proof: 'signed_in' })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    const p = await tenant({ kind: 'PERSONAL', enforced: true, pin: 'google' });
    const pu = await owner(p);
    expect(await links.attachIdentity({ provider: 'cognito', provider_subject: `ms-${uuidv7()}`, idp: 'microsoft', email_snapshot: null, user_id: pu.id, proof: 'signed_in' })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    const open = await tenant({ enforced: false });
    const ou = await owner(open);
    const other = await owner(open);
    const takenSub = await linkWith(other.id, 'apple');
    expect(await links.attachIdentity({ provider: 'cognito', provider_subject: takenSub, idp: 'apple', email_snapshot: null, user_id: ou.id, proof: 'signed_in' })).toEqual({ ok: false, reason: 'identity_already_linked' });
    await linkWith(ou.id, 'apple');
    expect(await links.attachIdentity({ ...appleIdentity(), user_id: ou.id, proof: 'signed_in' })).toEqual({ ok: false, reason: 'idp_already_linked' });
    await db.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [other.id]);
    expect(await links.attachIdentity({ provider: 'cognito', provider_subject: `g-${uuidv7()}`, idp: 'google', email_snapshot: null, user_id: other.id, proof: 'signed_in' })).toEqual({ ok: false, reason: 'user_inactive' });
    // Path 1 succeeds where the policy allows it (unenforced Business).
    expect(await links.attachIdentity({ provider: 'cognito', provider_subject: `g-${uuidv7()}`, idp: 'google', email_snapshot: null, user_id: ou.id, proof: 'signed_in' })).toMatchObject({ ok: true, idp: 'google' });
  });

  it('methods: list, remove with unlinked audit, and the last method is never removed', async () => {
    const t = await tenant({ enforced: false });
    const u = await owner(t);
    await linkWith(u.id, 'google');
    await linkWith(u.id, 'apple');
    expect((await links.listSignInMethods(u.id)).map((m) => m.idp)).toEqual(['google', 'apple']);
    expect(await links.removeSignInMethod({ user_id: u.id, idp: 'google' })).toMatchObject({ ok: true, idp: 'google', account_email: u.email });
    expect(await auditCount('identity.external_identity.unlinked', u.id)).toBe(1);
    expect(await links.removeSignInMethod({ user_id: u.id, idp: 'apple' })).toEqual({ ok: false, reason: 'last_sign_in_method' });
    expect(await links.removeSignInMethod({ user_id: u.id, idp: 'microsoft' })).toEqual({ ok: false, reason: 'sign_in_method_not_found' });
    expect((await links.listSignInMethods(u.id)).map((m) => m.idp)).toEqual(['apple']);
  });
});
