import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ARAMO_POSTGRES_TEST_IMAGE, CommonModule, resolveAuthStorageMigrations, resolveIdentityMigrations } from '@aramo/common';
import {
  IdentityCoreModule,
  IdentityProviderPolicyService,
  IdentityService,
  TenantEntitlementReader,
  TenantUserLifecycleService,
} from '@aramo/identity';
import { AuthStorageModule } from '@aramo/auth-storage';
import { AUDIT_SINK, JwtIssuerService, PRINCIPAL_DIRECTORY, RefreshOrchestratorService } from '@aramo/auth-core';
import type { MailerPort } from '@aramo/mailer';
import { Client } from 'pg';

import { IdentityAuditSinkAdapter } from '../app/auth/identity-audit-sink.adapter.js';
import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';

import { generateTestKeyPair } from './test-keys.js';

// Aramo-Sign-Mobile-Amendment-M-A8 §2.3 + §2.4 on real Postgres 17: the REAL removal
// (TenantUserLifecycleService → IdentityService → repository) followed by the REAL refresh
// path (RefreshOrchestratorService → IdentityPrincipalDirectoryAdapter → RoleService over
// the seeded Role/Scope/RoleScope rows → RefreshTokenService). Only the entitlement read
// (the tenant holds core + sign + ats) and the provider policy are stubbed.
//   - the Sign refresh token revoked by the removal can no longer refresh;
//   - defence in depth: a Sign token that escaped revocation is refused
//     (sign_access_removed) and revoked by the refresh itself;
//   - the member's ATS (recruiter) session keeps refreshing — ATS access is preserved.

const ROOT = resolve(__dirname, '../../../..');
const sha = (s: string): string => createHash('sha256').update(s).digest('base64url');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('M-A8 §2.4 — Sign refresh after an administrator removed Sign access (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let lifecycle: TenantUserLifecycleService;
  const saved: Record<string, string | undefined> = {};
  const TENANT = randomUUID();
  const OWNER = randomUUID();
  const MEMBER = randomUUID();

  async function member(user: string, roles: string[]): Promise<void> {
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat',$3, now())`, [user, `u-${user}@acme.test`, TENANT]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, TENANT]);
    for (const r of roles) {
      await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, id FROM identity."Role" WHERE key = $2`, [m, r]);
    }
  }

  async function token(consumer: string): Promise<string> {
    const plain = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO auth_storage."RefreshToken" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at) VALUES ($1,$2,$3,$4,$5, now(), now() + interval '30 days')`, [
      randomUUID(),
      MEMBER,
      TENANT,
      consumer,
      sha(plain),
    ]);
    return plain;
  }

  const refresh = (consumer: 'sign' | 'recruiter', refreshCookie: string) => module.get(RefreshOrchestratorService).handleRefresh({ consumer, refreshCookie });
  const revoked = async (plain: string): Promise<boolean> =>
    (await db.query(`SELECT revoked_at IS NOT NULL AS r FROM auth_storage."RefreshToken" WHERE token_hash = $1`, [sha(plain)])).rows[0]?.r === true;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of [...resolveIdentityMigrations(ROOT), ...resolveAuthStorageMigrations(ROOT)]) await db.query(readFileSync(m, 'utf8'));
    const scopes: Record<string, string[]> = {
      tenant_owner: ['sign:envelope:read', 'tenant:admin:user-manage'],
      recruiter: ['talent:read'],
      sign_sender: ['sign:envelope:read', 'sign:envelope:send'],
    };
    for (const [role, keys] of Object.entries(scopes)) {
      await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1,$2,$2,true, now()) ON CONFLICT (key) DO UPDATE SET is_active = true`, [randomUUID(), role]);
      for (const k of keys) {
        await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), k]);
        await db.query(
          `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = $1 AND s.key = $2 ON CONFLICT (role_id, scope_id) DO NOTHING`,
          [role, k],
        );
      }
    }
    await db.query(`INSERT INTO identity."Tenant" (id, name, status, kind, is_active, updated_at) VALUES ($1,'Acme','ACTIVE','BUSINESS',true, now())`, [TENANT]);
    await member(OWNER, ['tenant_owner']);
    await member(MEMBER, ['recruiter', 'sign_sender']);

    const { privatePem, publicPem } = generateTestKeyPair();
    const env: Record<string, string> = {
      DATABASE_URL: url,
      AUTH_AUDIENCE: 'aramo-m-a8-int',
      AUTH_PRIVATE_KEY: privatePem,
      AUTH_PUBLIC_KEY: publicPem,
      AUTH_REFRESH_GRACE_SECONDS: '0',
    };
    for (const k of [...Object.keys(env), 'AUTH_HOST_TENANT_BINDING', 'REDIS_URL']) saved[k] = process.env[k];
    Object.assign(process.env, env);
    // Host binding in its default `log` mode: the refresh carries no host here.
    delete process.env['AUTH_HOST_TENANT_BINDING'];
    delete process.env['REDIS_URL'];

    module = await Test.createTestingModule({
      imports: [CommonModule, IdentityCoreModule, AuthStorageModule],
      providers: [
        JwtIssuerService,
        RefreshOrchestratorService,
        { provide: PRINCIPAL_DIRECTORY, useClass: IdentityPrincipalDirectoryAdapter },
        { provide: AUDIT_SINK, useClass: IdentityAuditSinkAdapter },
      ],
    })
      .overrideProvider(TenantEntitlementReader)
      .useValue({ getCapabilities: vi.fn(async () => new Set(['core', 'sign', 'ats'])) })
      .overrideProvider(IdentityProviderPolicyService)
      .useValue({ evaluate: vi.fn(async () => ({ ok: true, pinned_now: false })), recordLinkIdp: vi.fn(async () => undefined) })
      .compile();
    await module.init();
    lifecycle = new TenantUserLifecycleService(
      module.get(IdentityService),
      { adminCreateUser: vi.fn(), adminDeleteUser: vi.fn(), adminDisableUser: vi.fn(), adminEnableUser: vi.fn() },
      { isFinancialsAuditEnabled: vi.fn(async () => false) },
      { send: vi.fn() } as unknown as MailerPort,
    );
  }, 300_000);

  afterAll(async () => {
    await module?.close();
    await db?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60_000);

  it('before removal a Sign session refreshes; after removal the revoked token, and a token that escaped revocation, are both refused; the ATS session keeps refreshing', async () => {
    const before = await token('sign');
    const ok = await refresh('sign', before);
    expect(ok.kind).toBe('success');

    const signPlain = await token('sign');
    const atsPlain = await token('recruiter');
    const res = await lifecycle.removeSignAccess({ tenant_id: TENANT, user_id: MEMBER, actor_user_id: OWNER, request_id: 'rq-m-a8-int' });
    expect(res).toMatchObject({ removed_role_keys: ['sign_sender'], after_role_keys: ['recruiter'], changed: true });
    expect(res.refresh_tokens_revoked).toBe(2); // the rotated session from `before` + signPlain

    expect(await refresh('sign', signPlain)).toEqual({ kind: 'token_invalid', reason: 'explicitly_revoked' });

    // Defence in depth (§2.4): a Sign token issued outside the removal transaction.
    const escaped = await token('sign');
    expect(await refresh('sign', escaped)).toEqual({ kind: 'token_invalid', reason: 'sign_access_removed' });
    expect(await revoked(escaped)).toBe(true);

    const ats = await refresh('recruiter', atsPlain);
    expect(ats.kind).toBe('success');
  });
});
