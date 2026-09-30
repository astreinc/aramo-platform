import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import { runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';

// PX-V1 PX-3 — proves the E-Sign sender identity resolves through the SHARED
// identity substrate: a user assigned ONLY esign_sender receives EXACTLY the
// esign:* scopes and ZERO ATS scopes. At baseline 130bfb65 the esign_* roles and
// esign:* scopes did not exist, so this authority was unreachable. The role-scope
// partition is what keeps esign_sender an E-Sign product role, never an ATS role.

const MIGRATION_PATHS = resolveIdentityMigrations(resolve(__dirname, '../../../..'));

function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments.split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('PX-V1 PX-3 esign_sender scope resolution — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let roleSvc: RoleService;

  // Fresh, valid, deterministic uuids well above every seeded id range (0xf000+).
  let seq = 0xf000;
  const nextId = (): string => `01900000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

  async function assignRoleToFreshUser(label: string, roleId: string): Promise<string> {
    const userId = nextId();
    const membershipId = nextId();
    const assignId = nextId();
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email: `px3-${label}@aramo.dev`, display_name: `px3 ${label}`, is_active: true } });
    await prisma.userTenantMembership.upsert({
      where: { user_id_tenant_id: { user_id: userId, tenant_id: SEED_IDS.tenant } },
      update: {},
      create: { id: membershipId, user_id: userId, tenant_id: SEED_IDS.tenant, is_active: true },
    });
    await prisma.userTenantMembershipRole.upsert({
      where: { membership_id_role_id: { membership_id: membershipId, role_id: roleId } },
      update: {},
      create: { id: assignId, membership_id: membershipId, role_id: roleId },
    });
    return userId;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    const setup = new PrismaService(url);
    await setup.$connect();
    for (const p of MIGRATION_PATHS) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
        const t = stmt.trim();
        if (t.length > 0) await setup.$executeRawUnsafe(t);
      }
    }
    await setup.$disconnect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    await runIdentitySeed(prisma);
    roleSvc = new RoleService(new RoleRepository(prisma));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it('esign_sender resolves EXACTLY the esign:* scopes — no ATS scope leaks', async () => {
    const userId = await assignRoleToFreshUser('e1', SEED_IDS.roles.esign_sender);
    const scopes = await roleSvc.getScopesByUserAndTenant({ user_id: userId, tenant_id: SEED_IDS.tenant });
    expect([...scopes].sort()).toEqual(['esign:envelope:create', 'esign:envelope:read', 'esign:envelope:send']);
    // The decisive partition: every resolved scope is in the esign namespace.
    expect([...scopes].every((s) => s.startsWith('esign:'))).toBe(true);
  });

  it('esign_viewer resolves read-only within the esign namespace', async () => {
    const userId = await assignRoleToFreshUser('e2', SEED_IDS.roles.esign_viewer);
    const scopes = await roleSvc.getScopesByUserAndTenant({ user_id: userId, tenant_id: SEED_IDS.tenant });
    expect([...scopes].sort()).toEqual(['esign:envelope:read']);
  });
});
