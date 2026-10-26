import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { commercialPolicyChecksum } from '../../lib/commercial/commercial-policy.js';
import { seededPolicyV1 } from '../fixtures/commercial-policy-seed.js';

// CCP-DG (Charter Amendment A2 RX-1…RX-11) — ONE shared test helper for the refund dual gate: the test
// refund-policy identity, and raw activation of a policy version (DRAFT insert, then ACTIVE → RETIRED and
// DRAFT/RETIRED → ACTIVE in one transaction, the transitions the A2 guard admits). Test fixtures only:
// production activation is the governed POLICY_ACTIVATE apply. The C4 / C4-R / C4-P suites use it to
// release refunds for their flag-on paths; the DG suites use it for the gate matrix.

/** A test-only refund-policy identity (no LOCKED document carries it). */
export const TEST_REFUND_POLICY_REF = 'ARAMO-COM-REFUND-POL-TEST@1.0';
export const TEST_REFUND_POLICY_SHA256 = 'a'.repeat(64);
export const TEST_REFUND_KEYS = { refund_execution_enabled: true, refund_policy_ref: TEST_REFUND_POLICY_REF, refund_policy_sha256: TEST_REFUND_POLICY_SHA256 } as const;

/** The seeded v1 document plus `extra` (v1 itself declares no refund key). */
export function v1With(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(seededPolicyV1().content as Record<string, unknown>), ...extra };
}

let nextVersion = 100;

/** Inserts `content` as a new version (a fresh version number from 100 up) and makes it the ONE ACTIVE version. */
export async function activatePolicyContent(pg: Client, content: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const n = (await pg.query(`SELECT COALESCE(MAX(version_number), 0)::int AS n FROM subscription."CommercialPolicyVersion"`)).rows[0].n as number;
  nextVersion = Math.max(nextVersion, n + 1);
  await pg.query(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES ($1, $2, 'DRAFT', $3::jsonb, $4)`, [
    id,
    nextVersion++,
    JSON.stringify(content),
    commercialPolicyChecksum(content),
  ]);
  await reactivatePolicy(pg, id);
  return id;
}

/** Makes an existing (DRAFT or RETIRED) version the ACTIVE one again; the current ACTIVE is RETIRED. */
export async function reactivatePolicy(pg: Client, id: string): Promise<void> {
  await pg.query('BEGIN');
  try {
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE' AND id <> $1`, [id]);
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1 AND status <> 'ACTIVE'`, [id]);
    await pg.query('COMMIT');
  } catch (e) {
    await pg.query('ROLLBACK');
    throw e;
  }
}

/** The id of the ACTIVE version. */
export async function activePolicyId(pg: Client): Promise<string> {
  return (await pg.query(`SELECT id::text AS id FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].id as string;
}
