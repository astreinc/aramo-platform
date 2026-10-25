import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveIdentityMigrations } from '@aramo/common';
import type { Client } from 'pg';

// CCP-A3 shared real-Postgres test support (one helper for the libs/subscription A3 spec
// and the apps/platform-admin route spec): applies the identity chain, the subscription
// chain (with the metering init it depends on), A2 and A3 as whole files (dollar-quoted
// trigger bodies), and builds a platform operator roster in the identity RBAC tables.
//
// The CCP role bundles are restated from the CCP-A1 §4.1 matrix (as the A1/A2 specs do,
// TD-A1-7 / TD-A2-10); libs/identity pins the seed to the same matrix.

const REPO_ROOT = resolve(__dirname, '../../../../..');
const SUB = (p: string): string => resolve(REPO_ROOT, 'libs/subscription/prisma/migrations', p, 'migration.sql');

export const SUBSCRIPTION_CHAIN: readonly string[] = [
  resolve(REPO_ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
  SUB('20261018120000_init_subscription_allowance'),
  SUB('20261019100000_subscription_lifecycle_billing'),
  SUB('20261019140000_sign_commercial_catalog_a1'),
  SUB('20261020130300_sign_naming_keys'),
  SUB('20261022100100_billing_account_country_guard'),
  SUB('20261022110100_billing_flag_domain_reason'),
  SUB('20261023100000_sign_personal_free'),
  SUB('20261023120000_legal_acceptance_in_app'),
  SUB('20261024180000_ccp_a2_commercial_audit_policy'),
];
export const CCP_A3_MIGRATION = SUB('20261025120000_ccp_a3_change_request_approval');

export const PLATFORM_TENANT = '01900000-0000-7000-8000-000000000100';
export const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';
export const TENANT_1 = '0190dddd-0000-7000-8000-0000000000a1';
export const TENANT_2 = '0190dddd-0000-7000-8000-0000000000a2';

const ENTRY = 'platform:tenant:read';
export const CCP_BUNDLES: Readonly<Record<string, readonly string[]>> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};

const uuidFrom = (s: string): string => {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export async function applyCcpA3Schema(pg: Client): Promise<void> {
  for (const s of ['subscription', 'metering', 'identity']) await pg.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  for (const f of resolveIdentityMigrations(REPO_ROOT)) await pg.query(readFileSync(f, 'utf8'));
  for (const f of SUBSCRIPTION_CHAIN) await pg.query(readFileSync(f, 'utf8'));
  await pg.query(readFileSync(CCP_A3_MIGRATION, 'utf8'));
  await seedCcpCatalog(pg);
}

/** Every migration of a lib, whole-file, in order (never a hand-kept list). */
export function libMigrations(lib: string): string[] {
  const dir = resolve(REPO_ROOT, 'libs', lib, 'prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

/**
 * CCP-A6 — the full chain an APPLY touches: identity, entitlement (the in-transaction grant),
 * metering and EVERY subscription migration (A4 product dimension, A5 plan versions, A6 apply,
 * and any later one), whole-file, then the same platform roster catalog as applyCcpA3Schema.
 * The seeded plans and their PUBLISHED v1 come from the migrations themselves.
 */
export async function applyCcpA6Schema(pg: Client): Promise<void> {
  for (const s of ['subscription', 'metering', 'entitlement', 'identity']) await pg.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  for (const f of resolveIdentityMigrations(REPO_ROOT)) await pg.query(readFileSync(f, 'utf8'));
  for (const f of libMigrations('entitlement')) await pg.query(readFileSync(f, 'utf8'));
  for (const f of [...libMigrations('metering'), ...libMigrations('subscription')]) await pg.query(readFileSync(f, 'utf8'));
  await seedCcpCatalog(pg);
}

export async function seedCcpCatalog(pg: Client): Promise<void> {
  // The platform sentinel tenant, one commercial tenant, and the role/scope catalog.
  await pg.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1, 'Aramo Platform', now()), ($2, 'Tenant One', now()), ($3, 'Tenant Two', now())`, [
    PLATFORM_TENANT,
    TENANT_1,
    TENANT_2,
  ]);
  const scopes = new Set(Object.values(CCP_BUNDLES).flat());
  for (const key of scopes) await pg.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1, $2)`, [uuidFrom(`scope:${key}`), key]);
  for (const [role, keys] of Object.entries(CCP_BUNDLES)) {
    await pg.query(`INSERT INTO identity."Role" (id, key, updated_at) VALUES ($1, $2, now())`, [uuidFrom(`role:${role}`), role]);
    for (const key of keys) {
      await pg.query(`INSERT INTO identity."RoleScope" (id, role_id, scope_id) VALUES ($1, $2, $3)`, [uuidFrom(`rs:${role}:${key}`), uuidFrom(`role:${role}`), uuidFrom(`scope:${key}`)]);
    }
  }
}

/** Creates a platform operator holding `roles`; attests them (D9) unless `attested: false`. */
export async function addOperator(pg: Client, roles: readonly string[], opts: { attested?: boolean; id?: string; human?: string } = {}): Promise<string> {
  const id = opts.id ?? randomUUID();
  await pg.query(`INSERT INTO identity."User" (id, email, tenant_id, updated_at) VALUES ($1, $2, $3, now())`, [id, `${id}@ops.test`, PLATFORM_TENANT]);
  const membership = uuidFrom(`m:${id}`);
  await pg.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1, $2, $3, now())`, [membership, id, PLATFORM_TENANT]);
  for (const r of roles) await grantRole(pg, id, r);
  if (opts.attested !== false) await attest(pg, id, opts.human ?? `human:${id}`);
  return id;
}

export async function grantRole(pg: Client, user_id: string, role: string): Promise<void> {
  await pg.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidFrom(`mr:${user_id}:${role}`), uuidFrom(`m:${user_id}`), uuidFrom(`role:${role}`)]);
}

export async function revokeRole(pg: Client, user_id: string, role: string): Promise<void> {
  await pg.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE membership_id = $1 AND role_id = $2`, [uuidFrom(`m:${user_id}`), uuidFrom(`role:${role}`)]);
}

export function humanRef(human: string): string {
  return createHash('sha256').update(human).digest('hex');
}

/** A fixed fixture attester (method PLATFORM_OWNER needs a distinct attester; not a roster member). */
export const FIXTURE_ATTESTER = '0190dddd-0000-7000-8000-0000000000af';

// CCP-A9: fixture attestations use method PLATFORM_OWNER (a distinct attester). The A9
// migration admits ONE BOOTSTRAP attestation ever (the D7 command's own), so fixtures no
// longer use BOOTSTRAP.
export async function attest(pg: Client, user_id: string, human: string): Promise<void> {
  await pg.query(
    `INSERT INTO subscription."CommercialOperatorAttestation" (id, user_id, human_ref_hash, statement_version, method, attested_by, attested_at) VALUES ($1, $2, $3, 'D9-v1', 'PLATFORM_OWNER', $4, now())`,
    [randomUUID(), user_id, humanRef(human), FIXTURE_ATTESTER],
  );
}

export async function revokeAttestation(pg: Client, user_id: string): Promise<void> {
  await pg.query(`UPDATE subscription."CommercialOperatorAttestation" SET revoked_at = now(), revoked_by = $1, revoke_reason = 'test' WHERE user_id = $1 AND revoked_at IS NULL`, [user_id]);
}

/** A second policy version (ACTIVE), retiring v1 — same shape, different thresholds. */
export async function activatePolicyV2(pg: Client, content: Record<string, unknown>, checksum: string): Promise<string> {
  const id = '019a0000-0000-7000-8000-0000000cc299';
  await pg.query(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES ($1, 2, 'DRAFT', $2::jsonb, $3)`, [id, JSON.stringify(content), checksum]);
  await pg.query('BEGIN');
  await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE'`);
  await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [id]);
  await pg.query('COMMIT');
  return id;
}
