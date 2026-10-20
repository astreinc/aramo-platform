import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { IdentityProviderPolicyService } from '../lib/identity-provider-policy.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// AUTH-SIGNIN-1 (LOCKED) R1/R2 + Lead Architect HALT disposition 2026-10-20 —
// on real Postgres 17:
//   - Enforced-pin cohort (new Sign signup tenants): the OWNER's first federation
//     sets the pin exactly once (compare-and-set), concurrently too; a wrong
//     provider, an ambiguous (Cognito-merged) identity, or a non-owner is refused.
//   - Existing tenants (no policy row): never refused, pinned or not.
//   - R2 everywhere: a second provider is never merged into a user on email
//     equality; legacy links (no recorded provider) keep today's behaviour.

const ROOT = resolve(__dirname, '../../../..');
const ORG_ADMIN_ROLE = '01900000-0000-7000-8000-0000000002b0';
const RECRUITER_ROLE = '01900000-0000-7000-8000-000000000011';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('AUTH-SIGNIN-1 provider policy (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let policy: IdentityProviderPolicyService;
  let repo: IdentityRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1, 'org_admin', 'Org admin', true, now()), ($2, 'recruiter', 'Recruiter', true, now())`, [ORG_ADMIN_ROLE, RECRUITER_ROLE]);
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    policy = new IdentityProviderPolicyService(prisma);
    repo = new IdentityRepository(prisma);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  async function tenant(opts: { enforced: boolean; pin?: string | null }): Promise<string> {
    const id = uuidv7();
    await db.query(`INSERT INTO identity."Tenant" (id, name, identity_provider, updated_at) VALUES ($1, $2, $3, now())`, [id, `T ${id}`, opts.pin ?? null]);
    if (opts.enforced) await policy.enrollEnforcedTenant(id);
    return id;
  }
  async function member(tenant_id: string, role: string): Promise<string> {
    const user_id = uuidv7();
    const m = uuidv7();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `u-${user_id}@acme.test`, tenant_id]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [m, user_id, tenant_id]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), m, role]);
    return user_id;
  }
  const pinOf = async (t: string) => (await db.query(`SELECT identity_provider FROM identity."Tenant" WHERE id = $1`, [t])).rows[0].identity_provider as string | null;

  it('cohort: the owner\'s first federation pins the provider; later sign-ins must match', async () => {
    const t = await tenant({ enforced: true });
    const owner = await member(t, ORG_ADMIN_ROLE);
    expect(await policy.evaluate({ user_id: owner, idp: 'microsoft', linking: true })).toEqual({ ok: true, pinned_now: true });
    expect(await pinOf(t)).toBe('microsoft');
    expect(await policy.evaluate({ user_id: owner, tenant_id: t, idp: 'microsoft', linking: false })).toEqual({ ok: true, pinned_now: false });
    // Same email, other provider: refused, even with a matching email.
    expect(await policy.evaluate({ user_id: owner, tenant_id: t, idp: 'google', linking: false })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    const row = (await db.query(`SELECT pinned_by_user_id FROM identity."TenantIdentityProviderPolicy" WHERE tenant_id = $1`, [t])).rows[0];
    expect(row.pinned_by_user_id).toBe(owner);
  });

  it('cohort: concurrent first federations (Google vs Microsoft) — exactly one pin wins', async () => {
    const t = await tenant({ enforced: true });
    const owner = await member(t, ORG_ADMIN_ROLE);
    const [a, b] = await Promise.all([
      policy.evaluate({ user_id: owner, idp: 'google', linking: true }),
      policy.evaluate({ user_id: owner, idp: 'microsoft', linking: true }),
    ]);
    const pin = await pinOf(t);
    expect(['google', 'microsoft']).toContain(pin);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const winner = a.ok ? 'google' : 'microsoft';
    expect(pin).toBe(winner);
  });

  it('cohort: a non-owner cannot establish the pin; ambiguous or native identities are refused', async () => {
    const t = await tenant({ enforced: true });
    const recruiter = await member(t, RECRUITER_ROLE);
    expect(await policy.evaluate({ user_id: recruiter, idp: 'google', linking: true })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    expect(await pinOf(t)).toBeNull();
    const owner = await member(t, ORG_ADMIN_ROLE);
    expect(await policy.evaluate({ user_id: owner, idp: 'ambiguous', linking: true })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    expect(await policy.evaluate({ user_id: owner, idp: null, linking: true })).toEqual({ ok: false, reason: 'idp_not_permitted_for_tenant' });
    expect(await pinOf(t)).toBeNull();
  });

  it('existing tenants (no policy row) are never refused — pinned (e.g. Microsoft) or NULL — and never get a pin', async () => {
    const pinned = await tenant({ enforced: false, pin: 'microsoft' });
    const u1 = await member(pinned, ORG_ADMIN_ROLE);
    expect(await policy.evaluate({ user_id: u1, idp: 'google', linking: false })).toEqual({ ok: true, pinned_now: false });
    const open = await tenant({ enforced: false });
    const u2 = await member(open, ORG_ADMIN_ROLE);
    expect(await policy.evaluate({ user_id: u2, idp: 'google', linking: true })).toEqual({ ok: true, pinned_now: false });
    expect(await pinOf(open)).toBeNull();
    expect(await pinOf(pinned)).toBe('microsoft');
  });

  it('R2 (all tenants): a second provider is never merged into a user; legacy links keep today\'s behaviour', async () => {
    const t = await tenant({ enforced: false });
    const u = await member(t, ORG_ADMIN_ROLE);
    const link = await repo.linkExternalIdentity({ user_id: u, provider: 'cognito', provider_subject: `ms-${u}`, email_snapshot: null });
    await policy.recordLinkIdp(link.id, 'microsoft');
    expect(await policy.evaluate({ user_id: u, idp: 'google', linking: true })).toEqual({ ok: false, reason: 'idp_identity_conflict' });
    expect(await policy.evaluate({ user_id: u, idp: 'microsoft', linking: true })).toEqual({ ok: true, pinned_now: false });
    // A legacy link (no recorded provider) does not block — today's behaviour.
    const legacy = await member(t, ORG_ADMIN_ROLE);
    await repo.linkExternalIdentity({ user_id: legacy, provider: 'cognito', provider_subject: `legacy-${legacy}`, email_snapshot: null });
    expect(await policy.evaluate({ user_id: legacy, idp: 'google', linking: true })).toEqual({ ok: true, pinned_now: false });
  });

  it('recordLinkIdp is idempotent and rejects unknown providers at the database', async () => {
    const t = await tenant({ enforced: false });
    const u = await member(t, ORG_ADMIN_ROLE);
    const link = await repo.linkExternalIdentity({ user_id: u, provider: 'cognito', provider_subject: `g-${u}`, email_snapshot: null });
    await policy.recordLinkIdp(link.id, 'google');
    await policy.recordLinkIdp(link.id, 'google');
    expect(await policy.recordedIdpsOf(u)).toEqual(['google']);
    await expect(db.query(`INSERT INTO identity."ExternalIdentityIdp" (external_identity_id, idp) VALUES ($1, 'facebook')`, [uuidv7()])).rejects.toThrow();
  });
});
