import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';

import { AuthorizationVersionService } from '../lib/authorization-version.service.js';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '../lib/dto/esign-permissions.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PrivacySubjectService } from '../lib/privacy/privacy-subject.service.js';
import { IdentityEffectiveAuthorizationResolver } from '../lib/authorization/identity-effective-authorization-resolver.js';
import { InMemoryScopeCache } from '../lib/authorization/in-memory-scope-cache.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import { SignCustomRoleService, type SignCustomRoleActor } from '../lib/sign-custom-role/sign-custom-role.service.js';

// Aramo Sign Feature-Parity Program Directive v1.0 (LOCKED) §1.21 — custom Sign roles on REAL
// PostgreSQL 17 with the full identity migration set (incl. 20261101150000_sign_custom_roles):
// anti-escalation, cross-tenant isolation (service, resolver and database), deletion of a role
// in use, immediate revocation (authorization-version bumps), audit rows, Sign-access removal.

const ROOT = resolve(__dirname, '../../../..');
const splitDdl = (sql: string) => sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
const S = ESIGN_SCOPE;
const ADMIN_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign custom roles (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let svc: SignCustomRoleService;
  let roles: RoleRepository;
  let versions: AuthorizationVersionService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    for (const p of resolveIdentityMigrations(ROOT)) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) if (stmt.trim().length > 0) await prisma.$executeRawUnsafe(stmt.trim());
    }
    svc = new SignCustomRoleService(prisma);
    roles = new RoleRepository(prisma);
    versions = new AuthorizationVersionService(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  async function org(): Promise<string> {
    const id = randomUUID();
    await prisma.tenant.create({ data: { id, name: `Org ${id.slice(0, 6)}`, status: 'ACTIVE' } });
    return id;
  }
  async function member(tenant_id: string, opts: { site_id?: string } = {}): Promise<{ user_id: string; membership_id: string }> {
    const user_id = randomUUID();
    await prisma.user.create({ data: { id: user_id, email: `u-${user_id.slice(0, 8)}@org.test`, tenant_id } });
    const m = await prisma.userTenantMembership.create({ data: { id: randomUUID(), user_id, tenant_id, ...(opts.site_id !== undefined ? { site_id: opts.site_id } : {}) } });
    return { user_id, membership_id: m.id };
  }
  const actor = (tenant_id: string, user_id: string, scopes: readonly string[] = ADMIN_SCOPES): SignCustomRoleActor => ({ tenant_id, user_id, scopes, request_id: 'rq-test' });
  // The member's Sign authority as a `sign` session resolves it: built-in sign:* ∪ custom.
  const signScopes = async (user_id: string, tenant_id: string) =>
    [...new Set([...(await roles.findScopeKeysForUserInTenant({ user_id, tenant_id })).filter((k) => k.startsWith('sign:')), ...(await roles.findSignCustomRoleScopeKeys({ user_id, tenant_id }))])].sort();

  it('create → assign → the member resolves the custom scopes in that tenant only; audited; version bumped', async () => {
    const t = await org();
    const admin = await member(t);
    const m = await member(t);
    expect(await signScopes(m.user_id, t)).toEqual([]);
    const role = await svc.create(actor(t, admin.user_id), { name: '  Contracts   desk ', description: 'Reads and sends', scope_keys: [S.ENVELOPE_SEND, S.ENVELOPE_READ, S.ENVELOPE_CREATE, S.ENVELOPE_READ] });
    expect(role).toMatchObject({ name: 'Contracts desk', description: 'Reads and sends', scope_keys: [S.ENVELOPE_CREATE, S.ENVELOPE_READ, S.ENVELOPE_SEND], member_count: 0 });
    const v0 = await versions.getCurrentVersion({ tenant_id: t, principal_id: m.user_id });
    expect(await svc.assign(actor(t, admin.user_id), role.id, m.user_id)).toEqual({ assigned: true });
    expect(await svc.assign(actor(t, admin.user_id), role.id, m.user_id)).toEqual({ assigned: false });
    expect(await versions.getCurrentVersion({ tenant_id: t, principal_id: m.user_id })).toBeGreaterThan(v0);
    expect(await signScopes(m.user_id, t)).toEqual([S.ENVELOPE_CREATE, S.ENVELOPE_READ, S.ENVELOPE_SEND]);
    // The built-in readers (every non-sign consumer) never see custom role scopes.
    expect(await roles.findScopeKeysForUserInTenant({ user_id: m.user_id, tenant_id: t })).toEqual([]);
    // End to end: the effective-authorization resolver gives them to the `sign` consumer only,
    // and a later unassign makes the already-issued token stale on its next request.
    const resolver = new IdentityEffectiveAuthorizationResolver(
      new RoleService(roles),
      versions,
      new InMemoryScopeCache(),
      { portalScopes: [], scopeCacheTtlSeconds: 300 },
      { getCapabilities: async () => new Set(['core', 'sign', 'ats']) } as unknown as TenantEntitlementReader,
    );
    const tokenVersion = await versions.getCurrentVersion({ tenant_id: t, principal_id: m.user_id });
    const req = (consumer_type: 'sign' | 'recruiter') => ({ tenant_id: t, principal_id: m.user_id, consumer_type, actor_kind: 'user' as const, token_authz_version: tokenVersion });
    const signRes = await resolver.resolve(req('sign'));
    expect(signRes.status === 'ok' ? [...signRes.scopes].sort() : signRes).toEqual([S.ENVELOPE_CREATE, S.ENVELOPE_READ, S.ENVELOPE_SEND]);
    expect(await resolver.resolve(req('recruiter'))).toEqual({ status: 'ok', scopes: [] });
    // Another tenant id for the same principal resolves nothing.
    expect(await signScopes(m.user_id, await org())).toEqual([]);
    expect((await svc.list(t)).map((r) => [r.name, r.member_count])).toEqual([['Contracts desk', 1]]);
    expect((await svc.listMembers(t)).find((x) => x.user_id === m.user_id)?.custom_role_ids).toEqual([role.id]);
    const events = await prisma.identityAuditEvent.findMany({ where: { tenant_id: t, event_type: { startsWith: 'identity.sign_custom_role.' } }, orderBy: { created_at: 'asc' } });
    expect(events.map((e) => [e.event_type, e.actor_id])).toEqual([
      ['identity.sign_custom_role.created', admin.user_id],
      ['identity.sign_custom_role.assigned', admin.user_id],
    ]);
    expect(events[1]?.subject_id).toBe(m.user_id);
  });

  it('anti-escalation: never a scope the creator lacks; never billing, platform, ATS or organization scopes', async () => {
    const t = await org();
    const a = await member(t);
    const sender = actor(t, a.user_id, ESIGN_ROLE_PERMISSIONS.sign_sender);
    await expect(svc.create(sender, { name: 'Wider', scope_keys: [S.ENVELOPE_READ, S.ENVELOPE_MANAGE_ALL] })).rejects.toMatchObject({
      statusCode: 403,
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { reason: 'scope_exceeds_actor', scopes: [S.ENVELOPE_MANAGE_ALL] } },
    });
    // Even a holder of every scope cannot compose a non-composable one.
    const everything = actor(t, a.user_id, [...ADMIN_SCOPES, S.BILLING_MANAGE, 'platform:tenant:read', 'talent:read', 'tenant:user:manage', 'document_template:read']);
    for (const bad of [S.BILLING_MANAGE, 'platform:tenant:read', 'talent:read', 'tenant:user:manage', 'document_template:read', 'sign:*', 'sign:envelope:delete']) {
      await expect(svc.create(everything, { name: `Bad ${bad}`, scope_keys: [S.ENVELOPE_READ, bad] }), bad).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'scope_not_composable' } } });
    }
    await expect(svc.create(everything, { name: 'Empty', scope_keys: [] })).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'scope_keys_required' } } });
    await expect(svc.create(everything, { name: 'NotArray', scope_keys: 'sign:envelope:read' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.create(everything, { name: ' ', scope_keys: [S.ENVELOPE_READ] })).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'name_invalid' } } });
    expect(await prisma.signCustomRole.count({ where: { tenant_id: t } })).toBe(0);
  });

  it('anti-escalation on edit, assign, unassign and delete: the actor must hold everything the role grants', async () => {
    const t = await org();
    const admin = await member(t);
    const limited = await member(t);
    const target = await member(t);
    const wide = await svc.create(actor(t, admin.user_id), { name: 'Org manager', scope_keys: [S.ENVELOPE_READ, S.ENVELOPE_MANAGE_ALL, S.MEMBER_MANAGE] });
    // A member manager holding fewer scopes cannot hand the wider role out, edit it, or remove it.
    const lim = actor(t, limited.user_id, [S.MEMBER_MANAGE, S.ENVELOPE_READ]);
    await expect(svc.assign(lim, wide.id, target.user_id)).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'scope_exceeds_actor', scopes: [S.ENVELOPE_MANAGE_ALL] } } });
    await expect(svc.assign(lim, wide.id, limited.user_id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.update(lim, wide.id, { scope_keys: [S.ENVELOPE_READ] })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.update(lim, wide.id, { name: 'Renamed' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.remove(lim, wide.id)).rejects.toMatchObject({ statusCode: 403 });
    await svc.assign(actor(t, admin.user_id), wide.id, target.user_id);
    await expect(svc.unassign(lim, wide.id, target.user_id)).rejects.toMatchObject({ statusCode: 403 });
    // Editing to add a scope the editor lacks is refused even by an otherwise-capable editor.
    await expect(svc.update(actor(t, admin.user_id, [S.ENVELOPE_READ, S.ENVELOPE_MANAGE_ALL, S.MEMBER_MANAGE]), wide.id, { scope_keys: [S.ENVELOPE_READ, S.SETTINGS_MANAGE] })).rejects.toMatchObject({
      statusCode: 403,
      context: { details: { scopes: [S.SETTINGS_MANAGE] } },
    });
    expect(await signScopes(target.user_id, t)).toEqual([S.ENVELOPE_MANAGE_ALL, S.MEMBER_MANAGE, S.ENVELOPE_READ].sort());
  });

  it('edit takes effect for every holder (version bump) and is audited with the before state', async () => {
    const t = await org();
    const admin = await member(t);
    const h1 = await member(t);
    const h2 = await member(t);
    const r = await svc.create(actor(t, admin.user_id), { name: 'Viewer plus', scope_keys: [S.ENVELOPE_READ, S.REPORT_READ] });
    await svc.assign(actor(t, admin.user_id), r.id, h1.user_id);
    await svc.assign(actor(t, admin.user_id), r.id, h2.user_id);
    const before = [await versions.getCurrentVersion({ tenant_id: t, principal_id: h1.user_id }), await versions.getCurrentVersion({ tenant_id: t, principal_id: h2.user_id })];
    // A rename alone changes no one's scopes: no bump.
    await svc.update(actor(t, admin.user_id), r.id, { name: 'Viewer+' });
    expect(await versions.getCurrentVersion({ tenant_id: t, principal_id: h1.user_id })).toBe(before[0]);
    const updated = await svc.update(actor(t, admin.user_id), r.id, { scope_keys: [S.ENVELOPE_READ] });
    expect(updated).toMatchObject({ name: 'Viewer+', scope_keys: [S.ENVELOPE_READ], member_count: 2 });
    expect(await versions.getCurrentVersion({ tenant_id: t, principal_id: h1.user_id })).toBeGreaterThan(before[0]!);
    expect(await versions.getCurrentVersion({ tenant_id: t, principal_id: h2.user_id })).toBeGreaterThan(before[1]!);
    expect(await signScopes(h1.user_id, t)).toEqual([S.ENVELOPE_READ]);
    const last = await prisma.identityAuditEvent.findFirst({ where: { tenant_id: t, event_type: 'identity.sign_custom_role.updated' }, orderBy: { created_at: 'desc' } });
    expect(last?.event_payload).toMatchObject({ name: 'Viewer+', scope_keys: [S.ENVELOPE_READ], before: { name: 'Viewer+', scope_keys: [S.ENVELOPE_READ, S.REPORT_READ] } });
  });

  it('deleting a role in use is refused; after unassigning it is deleted, its scopes stop resolving and the name is reusable', async () => {
    const t = await org();
    const admin = await member(t);
    const m = await member(t);
    const r = await svc.create(actor(t, admin.user_id), { name: 'Temp', scope_keys: [S.CONTACT_READ] });
    await svc.assign(actor(t, admin.user_id), r.id, m.user_id);
    await expect(svc.remove(actor(t, admin.user_id), r.id)).rejects.toMatchObject({ statusCode: 409, code: 'SIGN_CUSTOM_ROLE_CONFLICT', context: { details: { reason: 'custom_role_in_use', assigned_count: 1 } } });
    expect(await signScopes(m.user_id, t)).toEqual([S.CONTACT_READ]);
    const v = await versions.getCurrentVersion({ tenant_id: t, principal_id: m.user_id });
    expect(await svc.unassign(actor(t, admin.user_id), r.id, m.user_id)).toEqual({ unassigned: true });
    expect(await svc.unassign(actor(t, admin.user_id), r.id, m.user_id)).toEqual({ unassigned: false });
    expect(await versions.getCurrentVersion({ tenant_id: t, principal_id: m.user_id })).toBeGreaterThan(v);
    expect(await signScopes(m.user_id, t)).toEqual([]);
    // A token minted before the unassign is stale on its next request (immediate revocation).
    const resolver = new IdentityEffectiveAuthorizationResolver(new RoleService(roles), versions, new InMemoryScopeCache(), { portalScopes: [], scopeCacheTtlSeconds: 300 }, {
      getCapabilities: async () => new Set(['sign']),
    } as unknown as TenantEntitlementReader);
    expect(await resolver.resolve({ tenant_id: t, principal_id: m.user_id, consumer_type: 'sign', actor_kind: 'user', token_authz_version: v })).toEqual({ status: 'stale' });
    await svc.remove(actor(t, admin.user_id), r.id);
    expect(await svc.list(t)).toEqual([]);
    await expect(svc.assign(actor(t, admin.user_id), r.id, m.user_id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.remove(actor(t, admin.user_id), r.id)).rejects.toMatchObject({ statusCode: 404 });
    // Soft-deleted: the row stays for history; a live role may take the name again.
    expect(await prisma.signCustomRole.count({ where: { id: r.id } })).toBe(1);
    await expect(svc.create(actor(t, admin.user_id), { name: 'TEMP', scope_keys: [S.CONTACT_READ] })).resolves.toMatchObject({ name: 'TEMP' });
    await expect(svc.create(actor(t, admin.user_id), { name: 'temp', scope_keys: [S.CONTACT_READ] })).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'name_taken' } } });
    expect((await prisma.identityAuditEvent.findMany({ where: { tenant_id: t, subject_id: r.id, event_type: 'identity.sign_custom_role.deleted' } })).length).toBe(1);
  });

  it('cross-tenant isolation: a tenant can neither see, change, assign nor delete another tenant’s role, nor assign to another tenant’s member', async () => {
    const a = await org();
    const b = await org();
    const adminA = await member(a);
    const adminB = await member(b);
    const memberB = await member(b);
    const roleA = await svc.create(actor(a, adminA.user_id), { name: 'Shared name', scope_keys: [S.ENVELOPE_READ] });
    // Same name in another tenant is fine (uniqueness is per tenant).
    const roleB = await svc.create(actor(b, adminB.user_id), { name: 'Shared name', scope_keys: [S.ENVELOPE_READ] });
    expect((await svc.list(b)).map((r) => r.id)).toEqual([roleB.id]);
    for (const op of [
      () => svc.update(actor(b, adminB.user_id), roleA.id, { name: 'Hijack' }),
      () => svc.remove(actor(b, adminB.user_id), roleA.id),
      () => svc.assign(actor(b, adminB.user_id), roleA.id, memberB.user_id),
      () => svc.unassign(actor(b, adminB.user_id), roleA.id, memberB.user_id),
      // Tenant A's admin assigning A's role to tenant B's member.
      () => svc.assign(actor(a, adminA.user_id), roleA.id, memberB.user_id),
    ]) {
      await expect(op()).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await prisma.signCustomRole.findUnique({ where: { id: roleA.id } }))?.name).toBe('Shared name');
    expect(await signScopes(memberB.user_id, b)).toEqual([]);
    // The database itself refuses a cross-tenant assignment row (composite foreign keys).
    await expect(
      prisma.signCustomRoleAssignment.create({ data: { id: randomUUID(), tenant_id: b, custom_role_id: roleA.id, membership_id: memberB.membership_id, created_by: adminB.user_id } }),
    ).rejects.toThrow();
    await expect(
      prisma.signCustomRoleAssignment.create({ data: { id: randomUUID(), tenant_id: a, custom_role_id: roleA.id, membership_id: memberB.membership_id, created_by: adminA.user_id } }),
    ).rejects.toThrow();
    expect(await svc.listMembers(a)).toEqual([expect.objectContaining({ user_id: adminA.user_id })]);
  });

  it('database guards: non-Sign or billing scope keys are refused even written directly; a tampered resolver input is filtered', async () => {
    const t = await org();
    const admin = await member(t);
    for (const keys of [['platform:tenant:read'], ['sign:billing:manage'], ['talent:read'], []]) {
      await expect(
        prisma.signCustomRole.create({ data: { id: randomUUID(), tenant_id: t, name: `X${keys.length}${randomUUID().slice(0, 4)}`, scope_keys: keys, created_by: admin.user_id } }),
        JSON.stringify(keys),
      ).rejects.toThrow();
    }
    await expect(prisma.signCustomRole.create({ data: { id: randomUUID(), tenant_id: randomUUID(), name: 'No tenant', scope_keys: [S.ENVELOPE_READ], created_by: admin.user_id } })).rejects.toThrow();
  });

  it('inactive membership, site-scoped tokens and Sign-access removal: custom scopes never outlive access', async () => {
    const t = await org();
    const admin = await member(t);
    const m = await member(t);
    const r = await svc.create(actor(t, admin.user_id), { name: 'Senders', scope_keys: [S.ENVELOPE_READ, S.ENVELOPE_SEND] });
    await svc.assign(actor(t, admin.user_id), r.id, m.user_id);
    await prisma.userTenantMembership.update({ where: { id: m.membership_id }, data: { is_active: false } });
    expect(await signScopes(m.user_id, t)).toEqual([]);
    expect((await svc.list(t))[0]?.member_count).toBe(0);
    await expect(svc.assign(actor(t, admin.user_id), r.id, m.user_id)).rejects.toMatchObject({ statusCode: 404 });
    await prisma.userTenantMembership.update({ where: { id: m.membership_id }, data: { is_active: true } });
    expect(await signScopes(m.user_id, t)).toEqual([S.ENVELOPE_READ, S.ENVELOPE_SEND]);

    // A site-scoped membership contributes only under its own site's token.
    const site = randomUUID();
    await prisma.site.create({ data: { id: site, tenant_id: t, name: 'Branch' } });
    const sm = await member(t, { site_id: site });
    await svc.assign(actor(t, admin.user_id), r.id, sm.user_id);
    expect(await roles.findSignCustomRoleScopeKeys({ user_id: sm.user_id, tenant_id: t })).toEqual([]);
    expect(await roles.findSignCustomRoleScopeKeys({ user_id: sm.user_id, tenant_id: t, site_id: site })).toEqual([S.ENVELOPE_READ, S.ENVELOPE_SEND]);
    expect(await roles.findSignCustomRoleScopeKeys({ user_id: sm.user_id, tenant_id: t, site_id: randomUUID() })).toEqual([]);

    // M-A8 removeProductAccess('sign') removes the custom roles too (and bumps, and audits).
    const identity = new IdentityRepository(prisma);
    const res = await identity.removeProductAccess({
      membership_id: m.membership_id,
      tenant_id: t,
      user_id: m.user_id,
      product: 'sign',
      role_keys: ['sign_admin', 'sign_sender', 'sign_viewer'],
      refresh_consumers: ['sign'],
      native_consumer: 'sign_native',
      actor_user_id: admin.user_id,
      request_id: 'rq',
    });
    expect(res.changed).toBe(true);
    expect(await signScopes(m.user_id, t)).toEqual([]);
    const ev = await prisma.identityAuditEvent.findFirst({ where: { tenant_id: t, subject_id: m.user_id, event_type: 'identity.tenant_user.product_access_removed' } });
    expect(ev?.event_payload).toMatchObject({ custom_roles_removed: 1 });

    // Privacy subject removeSignAccess (M-A8 §3.3) removes them as well.
    const p = await member(t);
    await svc.assign(actor(t, admin.user_id), r.id, p.user_id);
    expect(await new PrivacySubjectService(prisma).removeSignAccess(p.user_id, t)).toEqual({ roles_removed: 1, remaining_role_keys: [] });
    expect(await signScopes(p.user_id, t)).toEqual([]);
  });
});
