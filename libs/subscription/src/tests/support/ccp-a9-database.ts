import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from 'pg';

import { PLATFORM_TENANT, applyCcpA3Schema, grantRole } from './ccp-a3-database.js';

// CCP-A9 shared real-Postgres test support (the libs/subscription A9 spec and the
// apps/platform-admin A9 route spec): the CCP-A3 schema (whose identity chain now carries the
// A9 last-owner trigger through IDENTITY_MIGRATIONS) plus the A9 subscription migration, and
// the T2-F1-H3 :28 operator (purush@aramo.ai, super_admin on the sentinel, no attestation).

const REPO_ROOT = resolve(__dirname, '../../../../..');
export const CCP_A9_MIGRATION = resolve(REPO_ROOT, 'libs/subscription/prisma/migrations/20261025180100_ccp_a9_role_change_apply_bootstrap/migration.sql');
export const BOOTSTRAP_OPERATOR_ID = '0190dddd-0000-7000-8000-0000000000b0';
export const BOOTSTRAP_OPERATOR_EMAIL = 'purush@aramo.ai';

/** deploy/seed-prod.sh:224 — the :28 assertion, verbatim (byte-unchanged; counts super_admin by role id). */
export const SEED_PROD_SUPER_ADMIN_ASSERTION = `SELECT count(*) FROM identity."User" u JOIN identity."UserTenantMembership" m ON m.user_id=u.id JOIN identity."UserTenantMembershipRole" mr ON mr.membership_id=m.id WHERE u.email='purush@aramo.ai' AND m.tenant_id='01900000-0000-7000-8000-000000000100' AND mr.role_id='01900000-0000-7000-8000-00000000001d';`;

const uuidFrom = (s: string): string => {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export async function applyCcpA9Schema(pg: Client): Promise<void> {
  await applyCcpA3Schema(pg);
  await pg.query(readFileSync(CCP_A9_MIGRATION, 'utf8'));
}

/**
 * The seed-prod :28 assertion with the fixture's super_admin role id in place of the seed id
 * (the A3 fixture keys roles by a hash id). Everything else is the deploy/seed-prod.sh:224 text.
 */
export function seedProdAssertionForFixture(): string {
  return SEED_PROD_SUPER_ADMIN_ASSERTION.replace("'01900000-0000-7000-8000-00000000001d'", `'${uuidFrom('role:super_admin')}'`);
}

/** The T2-F1-H3 :28 operator: purush@aramo.ai, sentinel membership, super_admin. No attestation. */
export async function addBootstrapOperator(pg: Client): Promise<string> {
  const id = BOOTSTRAP_OPERATOR_ID;
  await pg.query(`INSERT INTO identity."User" (id, email, tenant_id, updated_at) VALUES ($1, $2, $3, now())`, [id, BOOTSTRAP_OPERATOR_EMAIL, PLATFORM_TENANT]);
  await pg.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1, $2, $3, now())`, [uuidFrom(`m:${id}`), id, PLATFORM_TENANT]);
  await grantRole(pg, id, 'super_admin');
  return id;
}

export async function count(pg: Client, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await pg.query(sql, params)).rows[0].n);
}

/** Row counts of every table a role change or the bootstrap could touch. */
export async function footprint(pg: Client): Promise<Record<string, number>> {
  const tables = [
    'identity."User"',
    'identity."UserTenantMembership"',
    'identity."UserTenantMembershipRole"',
    'identity."Tenant"',
    'identity."AuthorizationVersion"',
    'subscription."CommercialOperatorAttestation"',
    'subscription."CommercialAuditEvent"',
    'subscription."CommercialChangeRequest"',
    'subscription."CommercialApproval"',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await count(pg, `SELECT count(*)::int AS n FROM ${t}`);
  return out;
}
