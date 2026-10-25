import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveIdentityMigrations } from '@aramo/common';
import type { Client } from 'pg';

import { libMigrations } from '../support/ccp-a3-database.js';

// CCP-A11 (PBD §5.1 row A11 "dry-run on a production-like fixture") — the production shape,
// seeded on the PRE-CCP schema (production today runs it), then carried through every CCP
// migration exactly as a release would:
//
//   ASTRE  the known production facts (PO read-only check 2026-10-25): 1 open subscription,
//          MANUAL, ACTIVE, aramo-sign-included-v1, started 2026-10-19, no Stripe link;
//          entitlements core, ats, portal, sign; Sign usage in the current period.
//   STRIPE a second tenant with a Stripe-linked SELF_SERVICE row (business plan) and the ended
//          MANUAL row it replaced (the pre-CCP self-service behaviour, Conv. H5).
//   REVOKED a pre-CCP MANUAL tenant whose `sign` is revoked AFTER the migrations, through the
//          governed ENTITLEMENT_REVOKE (CCP-A7).
//   ATS_ONLY entitlements only (core, ats), no subscription.
// The GOVERNED tenant (opened through a governed SUBSCRIPTION_OPEN after the migrations) is
// created by the spec, on the A6 harness.
//
// Every value is fixed so the dry-run report is byte-stable. The `created_by` values look like
// operator e-mails on purpose: the reports must never print them.

const REPO_ROOT = resolve(__dirname, '../../../../..');

export const A11_T0 = new Date('2026-10-25T12:00:00.000Z');
export const A11 = {
  ASTRE: '0190a11a-0000-7000-8000-00000000a57e',
  STRIPE: '0190a11a-0000-7000-8000-0000000005e1',
  REVOKED: '0190a11a-0000-7000-8000-00000000e70c',
  ATS_ONLY: '0190a11a-0000-7000-8000-0000000000a7',
} as const;
export const A11_SUB = {
  ASTRE: '0190a11b-0000-7000-8000-00000000a57e',
  STRIPE: '0190a11b-0000-7000-8000-0000000005e1',
  STRIPE_ENDED_MANUAL: '0190a11b-0000-7000-8000-0000000005e0',
  REVOKED: '0190a11b-0000-7000-8000-00000000e70c',
} as const;
/** Strings that must never appear in any report (PII-shaped fixture values). */
export const A11_PII = ['po.operator@astre.example', 'billing.owner@stripe-tenant.example', 'cus_A11secret', 'sub_A11secret'] as const;

const ENTITLEMENT_A7 = '20261026000000_ccp_a7_entitlement_revoke_provenance';
const SUBSCRIPTION_A2 = '20261024180000_ccp_a2_commercial_audit_policy';

const entitlementChain = libMigrations('entitlement');
const subscriptionChain = libMigrations('subscription');
const cut = (chain: string[], first: string): [string[], string[]] => {
  const i = chain.findIndex((p) => p.includes(`/${first}/`));
  if (i < 0) throw new Error(`migration ${first} not found`);
  return [chain.slice(0, i), chain.slice(i)];
};
const [ENT_PRE, ENT_CCP] = cut(entitlementChain, ENTITLEMENT_A7);
const [SUB_PRE, SUB_CCP] = cut(subscriptionChain, SUBSCRIPTION_A2);

async function run(pg: Client, files: readonly string[]): Promise<void> {
  for (const f of files) await pg.query(readFileSync(f, 'utf8'));
}

/** The pre-CCP schema (production today): identity, metering, entitlement and subscription before CCP. */
export async function applyPreCcpSchema(pg: Client): Promise<void> {
  for (const s of ['subscription', 'metering', 'entitlement', 'identity']) await pg.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await run(pg, resolveIdentityMigrations(REPO_ROOT));
  await run(pg, ENT_PRE);
  await run(pg, libMigrations('metering'));
  await run(pg, SUB_PRE);
}

/** Every CCP migration (subscription A2…A7 and entitlement A7), whole-file, in order. */
export async function applyCcpMigrations(pg: Client): Promise<void> {
  await run(pg, ENT_CCP);
  await run(pg, SUB_CCP);
}

const planId = `(SELECT id FROM subscription."Plan" WHERE key = $3)`;

async function subscription(
  pg: Client,
  o: { id: string; tenant: string; plan: string; source: string; status: string; anchor: string; ended_at?: string; created_by: string; stripe?: boolean },
): Promise<void> {
  await pg.query(
    `INSERT INTO subscription."TenantSubscription"
       (id, tenant_id, plan_id, period_anchor, source, started_at, ended_at, created_by, status, billing_provider, billing_account_ref, billing_subscription_ref,
        current_period_end, provider_state_at, activated_by)
     VALUES ($1::uuid, $2::uuid, ${planId}, $4::timestamptz, $5, $4::timestamptz, $6::timestamptz, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14)`,
    [
      o.id,
      o.tenant,
      o.plan,
      o.anchor,
      o.source,
      o.ended_at ?? null,
      o.created_by,
      o.status,
      o.stripe === true ? 'STRIPE' : null,
      o.stripe === true ? 'cus_A11secret' : null,
      o.stripe === true ? 'sub_A11secret' : null,
      o.stripe === true ? '2026-11-05T00:00:00Z' : null,
      o.stripe === true ? '2026-10-05T00:00:00Z' : null,
      o.stripe === true ? '0190a11c-0000-7000-8000-0000000005e1' : null,
    ],
  );
}

async function usage(pg: Client, tenant: string, prefix: string, n: number, state: 'CONSUMED' | 'RELEASED' | 'RESERVED', period_start: string, at: string, until: string): Promise<void> {
  await pg.query(
    `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until, finalized_at)
     SELECT md5($1 || $3 || g)::uuid, $1::uuid, 'sign.envelopes', 'aramo-sign:envelope:' || $3 || ':' || g, $4::timestamptz, $2, 'SEND', $5::timestamptz, $6::timestamptz,
            CASE WHEN $2 = 'RESERVED' THEN NULL ELSE $5::timestamptz END
       FROM generate_series(1, $7::int) g`,
    [tenant, state, prefix, period_start, at, until, n],
  );
}

/** Seeds the production shape on the PRE-CCP schema (no CCP column is named). */
export async function seedProductionLike(pg: Client): Promise<void> {
  const tenants: Array<[string, string]> = [
    [A11.ASTRE, 'Astre (fixture)'],
    [A11.STRIPE, 'Stripe tenant (fixture)'],
    [A11.REVOKED, 'Revoked tenant (fixture)'],
    [A11.ATS_ONLY, 'ATS-only tenant (fixture)'],
  ];
  for (const [id, name] of tenants) await pg.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1, $2, '2026-10-01T00:00:00Z')`, [id, name]);
  // ASTRE — the production facts.
  await subscription(pg, { id: A11_SUB.ASTRE, tenant: A11.ASTRE, plan: 'aramo-sign-included-v1', source: 'MANUAL', status: 'ACTIVE', anchor: '2026-10-19T00:00:00Z', created_by: 'po.operator@astre.example' });
  // STRIPE — an ended MANUAL row, then the Stripe-linked SELF_SERVICE row.
  await subscription(pg, {
    id: A11_SUB.STRIPE_ENDED_MANUAL,
    tenant: A11.STRIPE,
    plan: 'aramo-sign-included-v1',
    source: 'MANUAL',
    status: 'CANCELED',
    anchor: '2026-09-01T00:00:00Z',
    ended_at: '2026-10-05T00:00:00Z',
    created_by: 'po.operator@astre.example',
  });
  await subscription(pg, { id: A11_SUB.STRIPE, tenant: A11.STRIPE, plan: 'aramo-sign-standard-business-v1', source: 'SELF_SERVICE', status: 'ACTIVE', anchor: '2026-10-05T00:00:00Z', created_by: 'billing.owner@stripe-tenant.example', stripe: true });
  // REVOKED — a pre-CCP MANUAL row (its `sign` is revoked after the migrations, by the spec).
  await subscription(pg, { id: A11_SUB.REVOKED, tenant: A11.REVOKED, plan: 'aramo-sign-included-v1', source: 'MANUAL', status: 'ACTIVE', anchor: '2026-10-01T00:00:00Z', created_by: 'po.operator@astre.example' });
  // Entitlements (pre-A7: tenant, capability, granted_at).
  const grants: Array<[string, string[]]> = [
    [A11.ASTRE, ['core', 'ats', 'portal', 'sign']],
    [A11.STRIPE, ['core', 'sign']],
    [A11.REVOKED, ['core', 'sign']],
    [A11.ATS_ONLY, ['core', 'ats']],
  ];
  for (const [t, caps] of grants) {
    for (const c of caps) await pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_at) VALUES ($1, $2::entitlement."Capability", '2026-10-19T00:00:00Z')`, [t, c]);
  }
  // Usage. ASTRE: 42 consumed + 2 released in the period from 2026-10-19, 1 fresh reservation.
  await usage(pg, A11.ASTRE, 'cur', 42, 'CONSUMED', '2026-10-19T00:00:00Z', '2026-10-20T09:00:00Z', '2026-10-20T09:10:00Z');
  await usage(pg, A11.ASTRE, 'rel', 2, 'RELEASED', '2026-10-19T00:00:00Z', '2026-10-21T09:00:00Z', '2026-10-21T09:10:00Z');
  await usage(pg, A11.ASTRE, 'res', 1, 'RESERVED', '2026-10-19T00:00:00Z', '2026-10-25T11:58:00Z', '2026-10-25T12:30:00Z');
  await usage(pg, A11.STRIPE, 'cur', 7, 'CONSUMED', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', '2026-10-06T00:10:00Z');
  await usage(pg, A11.REVOKED, 'cur', 3, 'CONSUMED', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-02T00:10:00Z');
  await pg.query(
    `INSERT INTO subscription."CapacityUsage" (id, tenant_id, capacity_key, ref, quantity, state, created_at, released_at) VALUES
       ('0190a11d-0000-7000-8000-000000000001', $1::uuid, 'sign.storage_bytes', 'doc:astre-1', 1048576, 'ACTIVE', '2026-10-20T00:00:00Z', NULL),
       ('0190a11d-0000-7000-8000-000000000002', $1::uuid, 'sign.storage_bytes', 'doc:astre-2', 2048, 'RELEASED', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'),
       ('0190a11d-0000-7000-8000-000000000003', $2::uuid, 'sign.storage_bytes', 'doc:stripe-1', 4096, 'ACTIVE', '2026-10-06T00:00:00Z', NULL)`,
    [A11.ASTRE, A11.STRIPE],
  );
}

/**
 * The whole-database fingerprint: one md5 per table of the four schemas (every row, ordered by
 * its text). Equal fingerprints = byte-identical rows.
 */
export async function databaseFingerprint(pg: Client): Promise<Record<string, string>> {
  const tables = (await pg.query(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_schema IN ('identity', 'entitlement', 'metering', 'subscription') AND table_type = 'BASE TABLE' ORDER BY 1, 2`,
  )).rows as Array<{ s: string; t: string }>;
  const out: Record<string, string> = {};
  for (const { s, t } of tables) {
    const r = await pg.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM "${s}"."${t}" x`);
    out[`${s}.${t}`] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}
