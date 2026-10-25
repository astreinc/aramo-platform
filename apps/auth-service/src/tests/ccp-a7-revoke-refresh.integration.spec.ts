import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveEntitlementMigrations } from '@aramo/common';
import { EntitlementModule, EntitlementRepository, grantCapabilitiesInTx, revokeCapabilitiesInTx } from '@aramo/entitlement';
import {
  type AuthorizationVersionService,
  type IdentityAuditService,
  type IdentityProviderPolicyService,
  type IdentityService,
  type RoleService,
  TenantEntitlementReader,
  type TenantService,
} from '@aramo/identity';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';

// CCP-A7 (PBD §5.1 row A7 "refresh denied"; Charter D1; IC-2 PR-6) on real Postgres 17: the REAL
// mint/refresh gate (IdentityPrincipalDirectoryAdapter.resolveScopes) over the REAL live
// entitlement read (TenantEntitlementReader → EntitlementRepository, the re-pointed reader) and
// the real entitlement migrations. Identity reads are stubbed (they are not under test). A
// governed revoke of `sign` denies the next sign-consumer refresh (consumer_not_entitled); a
// governed re-grant allows it again. Test IDs are cited by doc/ccp/slices/CCP-A7-acceptance.md.

const REPO_ROOT = resolve(__dirname, '../../../..');
const USER_ID = '0190a7a7-0000-7000-8000-0000000000b1';
const OPERATOR = '0190a7a7-0000-7000-8000-0000000000f1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A7 revoke → refresh denied (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let moduleRef: TestingModule;
  let adapter: IdentityPrincipalDirectoryAdapter;
  const raw = () => ({ $queryRawUnsafe: async <T>(q: string, ...v: unknown[]) => (await pg.query(q, v)).rows as T });
  let TENANT: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const m of resolveEntitlementMigrations(REPO_ROOT)) await pg.query(readFileSync(m, 'utf8'));
    const prior = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = url;
    try {
      moduleRef = await Test.createTestingModule({ imports: [EntitlementModule] }).compile();
    } finally {
      if (prior === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = prior;
    }
    const reader = new TenantEntitlementReader(moduleRef.get(EntitlementRepository));
    TENANT = randomUUID();
    const identity = { findUserById: async () => ({ id: USER_ID, is_active: true }) } as unknown as IdentityService;
    const tenant = { getTenantsByUser: async () => [{ id: TENANT, name: 'A7 Tenant', status: 'ACTIVE' }] } as unknown as TenantService;
    const role = {
      findActiveMembershipSite: async () => null,
      getScopesByUserAndTenant: async () => ['sign:envelope:send'],
      getScopesByUserTenantAndSite: async () => ['sign:envelope:send'],
    } as unknown as RoleService;
    const audit = { writeGlobalEvent: async () => undefined } as unknown as IdentityAuditService;
    const versions = { getCurrentVersion: async () => 1 } as unknown as AuthorizationVersionService;
    const idp = { evaluate: async () => ({ ok: true, pinned_now: false }), recordLinkIdp: async () => undefined } as unknown as IdentityProviderPolicyService;
    adapter = new IdentityPrincipalDirectoryAdapter(identity, tenant, role, audit, versions, reader, idp);
    await moduleRef.get(EntitlementRepository).grantCapabilities({ tenant_id: TENANT, capabilities: ['core', 'sign'], granted_source: 'SIGNUP' });
  }, 300_000);

  afterAll(async () => {
    await moduleRef?.close();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const refresh = () => adapter.resolveScopes({ principal_id: USER_ID, context_id: TENANT, consumer: 'sign' });

  it('A7-AUTH-1 refresh denied: after a governed revoke of `sign` the sign-consumer refresh is denied consumer_not_entitled; a governed re-grant allows it again; the token is never the evidence', async () => {
    expect((await refresh()).kind).toBe('resolved');
    expect(await revokeCapabilitiesInTx(raw(), { tenant_id: TENANT, capabilities: ['sign'], revoked_by: OPERATOR, change_request_id: randomUUID() })).toEqual(['sign']);
    expect(await refresh()).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    // An ungoverned grant (signup / provisioning) cannot bring it back.
    await moduleRef.get(EntitlementRepository).grantCapabilities({ tenant_id: TENANT, capabilities: ['sign'], granted_source: 'PROVISIONING' });
    expect(await refresh()).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect(await grantCapabilitiesInTx(raw(), { tenant_id: TENANT, capabilities: ['sign'], granted_source: 'MANUAL', granted_by: OPERATOR, change_request_id: randomUUID() })).toEqual(['sign']);
    expect((await refresh()).kind).toBe('resolved');
  });
});
