import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ARAMO_POSTGRES_TEST_IMAGE,
  createAramoLogger,
  resolveAuthStorageMigrations,
  resolveIdentityMigrations,
} from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { MailerPort } from '@aramo/mailer';
import { Client } from 'pg';

import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';
import { TenantUserManagementController } from '../lib/tenant-user/tenant-user-management.controller.js';
import type { TenantCognitoPort } from '../lib/tenant-user/tenant-cognito.port.js';
import type { AuditFinancialsGate } from '../lib/tenant-user/audit-financials-gate.port.js';

// Aramo-Sign-Mobile-Amendment-M-A8 §2.3 / §5 (Business) — an organization administrator
// removes a member's Aramo Sign access (DELETE /v1/tenant/users/:user_id/products/sign)
// through the REAL controller → lifecycle service → IdentityService → repository on real
// Postgres 17 (identity + auth_storage + sign migrations). The Cognito port is a recording
// stub. Proves:
//   - only the Sign role keys go; ATS roles, the membership, the user and a completed
//     agreement stay; Cognito is never called;
//   - the member's Sign refresh tokens (sign, sign_native) and native device sessions in
//     this tenant are revoked in the same transaction; a recruiter token is untouched;
//   - principal_version is bumped and ONE audit row product_access_removed {product:'sign'};
//   - a Sign-only member can be removed (no role remains; the membership stays);
//   - a repeat is a no-op (no audit row, no bump);
//   - tenant isolation: another tenant's administrator gets 404 and changes nothing;
//   - the owner / last-owner invariant is unaffected: an organization-role holder is
//     refused (400 sign_access_via_organization_role) and keeps every role.

const ROOT = resolve(__dirname, '../../../..');
const signMigrations = (): string[] => {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const ROLE_KEYS = ['tenant_owner', 'tenant_admin', 'recruiter', 'sign_admin', 'sign_sender', 'sign_viewer'] as const;
type RoleKey = (typeof ROLE_KEYS)[number];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('M-A8 §2.3 — remove Sign access (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let ctl: TenantUserManagementController;
  const cognitoCalls: string[] = [];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
  const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: number }>(sql, params))[0]?.n ?? 0);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of [...resolveIdentityMigrations(ROOT), ...resolveAuthStorageMigrations(ROOT), ...signMigrations()]) {
      await db.query(readFileSync(m, 'utf8'));
    }
    for (const key of ROLE_KEYS) {
      await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1,$2,$2,true, now()) ON CONFLICT (key) DO UPDATE SET is_active = true`, [randomUUID(), key]);
    }
    prisma = new PrismaService(url);
    await prisma.$connect();
    const audit = new IdentityAuditService(new IdentityAuditRepository(prisma), createAramoLogger('m-a8-spec'));
    const svc = new IdentityService(
      new IdentityRepository(prisma),
      audit,
      new RoleBundleValidator(prisma),
      { getCapabilities: async () => new Set<string>(['core', 'ats', 'sign']) } as unknown as TenantEntitlementReader,
    );
    const record = (name: string) => async () => {
      cognitoCalls.push(name);
      return undefined as never;
    };
    const cognito: TenantCognitoPort = {
      adminCreateUser: record('create'),
      adminDeleteUser: record('delete'),
      adminDisableUser: record('disable'),
      adminEnableUser: record('enable'),
    };
    const gate: AuditFinancialsGate = { isFinancialsAuditEnabled: async () => false };
    const mailer: MailerPort = { send: async () => ({ message_id: 'm' }) };
    const lifecycle = new TenantUserLifecycleService(svc, cognito, gate, mailer);
    ctl = new TenantUserManagementController(lifecycle, audit, svc);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  async function tenant(): Promise<{ tenant: string; owner: string }> {
    const id = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, status, kind, is_active, updated_at) VALUES ($1,$2,'ACTIVE','BUSINESS',true, now())`, [id, `T ${id}`]);
    const owner = await member(id, ['tenant_owner']);
    return { tenant: id, owner };
  }

  async function member(tenant_id: string, roles: readonly RoleKey[]): Promise<string> {
    const user = randomUUID();
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat',$3, now())`, [user, `u-${user}@acme.test`, tenant_id]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, tenant_id]);
    for (const r of roles) {
      await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, id FROM identity."Role" WHERE key = $2`, [m, r]);
    }
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant_id, user]);
    return user;
  }

  /** A browser `sign` token, a native `sign_native` token with its device session, and an ATS `recruiter` token. */
  async function sessions(tenant_id: string, user_id: string): Promise<void> {
    const token = async (consumer: string): Promise<string> => {
      const id = randomUUID();
      await db.query(`INSERT INTO auth_storage."RefreshToken" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at) VALUES ($1,$2,$3,$4,$5, now(), now() + interval '30 days')`, [
        id,
        user_id,
        tenant_id,
        consumer,
        `h-${id}`,
      ]);
      return id;
    };
    await token('sign');
    await token('recruiter');
    const native = await token('sign_native');
    await db.query(
      `INSERT INTO auth_storage."NativeDeviceSession" (id, user_id, tenant_id, consumer_type, client_id, installation_id, platform, app_version, refresh_family_root_id, current_refresh_token_id)
       VALUES ($1,$2,$3,'sign','aramo-sign-native','inst','ios','1.0.0',$4,$4)`,
      [randomUUID(), user_id, tenant_id, native],
    );
  }

  const roleKeys = async (user_id: string): Promise<string[]> =>
    (
      await q<{ key: string }>(
        `SELECT r.key FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id JOIN identity."Role" r ON r.id = mr.role_id WHERE m.user_id = $1 ORDER BY r.key`,
        [user_id],
      )
    ).map((r) => r.key);
  const liveTokens = (user_id: string, consumer: string) =>
    n(`SELECT count(*)::int AS n FROM auth_storage."RefreshToken" WHERE user_id = $1 AND consumer_type = $2 AND revoked_at IS NULL`, [user_id, consumer]);
  const liveNative = (user_id: string) => n(`SELECT count(*)::int AS n FROM auth_storage."NativeDeviceSession" WHERE user_id = $1 AND revoked_at IS NULL`, [user_id]);
  const version = (tenant_id: string, user_id: string) => n(`SELECT version AS n FROM identity."AuthorizationVersion" WHERE tenant_id = $1 AND principal_id = $2`, [tenant_id, user_id]);
  const auditRows = (user_id: string) =>
    q<{ tenant_id: string; actor_id: string; event_payload: Record<string, unknown> }>(
      `SELECT tenant_id, actor_id, event_payload FROM identity."IdentityAuditEvent" WHERE event_type = 'identity.tenant_user.product_access_removed' AND subject_id = $1`,
      [user_id],
    );
  const membershipActive = async (user_id: string) => (await q<{ is_active: boolean }>(`SELECT is_active FROM identity."UserTenantMembership" WHERE user_id = $1`, [user_id]))[0]?.is_active;
  const admin = (tenant_id: string, sub: string): AuthContextType => ({ sub, tenant_id, scopes: ['tenant:admin:user-manage'], consumer_type: 'org' }) as unknown as AuthContextType;

  it('ATS + Sign member: only Sign roles go; ATS role, membership, user and the completed agreement stay; Sign sessions revoked in one transaction; no Cognito call; one audit row', async () => {
    const t = await tenant();
    const u = await member(t.tenant, ['recruiter', 'sign_sender', 'sign_viewer']);
    await sessions(t.tenant, u);
    const envelope = randomUUID();
    await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, completed_at) VALUES ($1,$2,'Signed NDA','COMPLETED','SINGLE_SIGNATURE',$3, now())`, [
      envelope,
      t.tenant,
      u,
    ]);
    const before = await version(t.tenant, u);

    const res = await ctl.removeSignAccess(admin(t.tenant, t.owner), u, 'rq-m-a8-1');
    expect(res).toMatchObject({
      product: 'sign',
      removed_role_keys: ['sign_sender', 'sign_viewer'],
      after_role_keys: ['recruiter'],
      refresh_tokens_revoked: 2,
      device_sessions_revoked: 1,
      changed: true,
    });

    expect(await roleKeys(u)).toEqual(['recruiter']);
    expect(await membershipActive(u)).toBe(true);
    expect((await q<{ is_active: boolean }>(`SELECT is_active FROM identity."User" WHERE id = $1`, [u]))[0]?.is_active).toBe(true);
    expect(await liveTokens(u, 'sign')).toBe(0);
    expect(await liveTokens(u, 'sign_native')).toBe(0);
    expect(await liveNative(u)).toBe(0);
    expect(await liveTokens(u, 'recruiter')).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignatureEnvelope" WHERE id = $1 AND status = 'COMPLETED' AND deleted_at IS NULL`, [envelope])).toBe(1);
    expect(await version(t.tenant, u)).toBe(before + 1);
    expect(cognitoCalls).toEqual([]);
    const rows = await auditRows(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: t.tenant, actor_id: t.owner });
    expect(rows[0]!.event_payload).toMatchObject({ product: 'sign', removed_role_keys: ['sign_sender', 'sign_viewer'], after_role_keys: ['recruiter'], refresh_tokens_revoked: 2, device_sessions_revoked: 1 });
    // The owner (and so the last-owner invariant) is untouched.
    expect(await roleKeys(t.owner)).toEqual(['tenant_owner']);

    // A repeat is a no-op: nothing removed or revoked, no bump, no second audit row.
    const again = await ctl.removeSignAccess(admin(t.tenant, t.owner), u, 'rq-m-a8-1b');
    expect(again).toMatchObject({ removed_role_keys: [], refresh_tokens_revoked: 0, device_sessions_revoked: 0, changed: false });
    expect(await version(t.tenant, u)).toBe(before + 1);
    expect(await auditRows(u)).toHaveLength(1);
  });

  it('a Sign-only member can have Sign removed: no role remains, the membership stays', async () => {
    const t = await tenant();
    const u = await member(t.tenant, ['sign_admin']);
    await sessions(t.tenant, u);
    const res = await ctl.removeSignAccess(admin(t.tenant, t.owner), u, 'rq-m-a8-2');
    expect(res).toMatchObject({ removed_role_keys: ['sign_admin'], after_role_keys: [], changed: true });
    expect(await roleKeys(u)).toEqual([]);
    expect(await membershipActive(u)).toBe(true);
    expect(await liveNative(u)).toBe(0);
    expect(cognitoCalls).toEqual([]);
  });

  it('tenant isolation: another organization’s administrator gets 404 and nothing changes', async () => {
    const a = await tenant();
    const b = await tenant();
    const u = await member(a.tenant, ['recruiter', 'sign_sender']);
    await sessions(a.tenant, u);
    await expect(ctl.removeSignAccess(admin(b.tenant, b.owner), u, 'rq-m-a8-3')).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(await roleKeys(u)).toEqual(['recruiter', 'sign_sender']);
    expect(await liveTokens(u, 'sign')).toBe(1);
    expect(await liveNative(u)).toBe(1);
    expect(await auditRows(u)).toHaveLength(0);
  });

  it('organization roles are never touched: the last owner and an organization admin are refused (400 sign_access_via_organization_role) and keep every role', async () => {
    const t = await tenant();
    await sessions(t.tenant, t.owner);
    await expect(ctl.removeSignAccess(admin(t.tenant, t.owner), t.owner, 'rq-m-a8-4')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { reason: 'sign_access_via_organization_role', role_keys: ['tenant_owner'] } },
    });
    expect(await roleKeys(t.owner)).toEqual(['tenant_owner']);
    expect(await liveTokens(t.owner, 'sign')).toBe(1);

    const orgAdmin = await member(t.tenant, ['tenant_admin', 'sign_sender']);
    await expect(ctl.removeSignAccess(admin(t.tenant, t.owner), orgAdmin, 'rq-m-a8-5')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await roleKeys(orgAdmin)).toEqual(['sign_sender', 'tenant_admin']);
    expect(await auditRows(orgAdmin)).toHaveLength(0);
    expect(cognitoCalls).toEqual([]);
  });
});
